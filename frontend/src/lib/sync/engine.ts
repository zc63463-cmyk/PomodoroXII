/**
 * RealSyncEngine — coordinates the fenced Sync v2 recovery, pull, and push cycle.
 *
 * 实现 F0 §8.1 全 12 方法 + withSyncLock 多 Tab 互斥。
 * - markDirty：pendingCountCache++ + scheduleSync debounce（DR-7）
 * - sync/fullSync hold one Space Web Lock across all protocol and authority writes.
 * - resolveConflict：outboxId<0 分支（S1-Hard-3）
 * - destroy：清 timer + 标志位（DR-4）
 */

import type { AxiosInstance } from 'axios'
import type { PomodoroXIDB } from '@/services/database'
import { metaDB, type MetaDB } from '@/services/meta-database'
import { spaceApi } from '@/services/api'
import { runPullLoopV2 } from './pull-loop'
import { pushAllPendingUnderFence } from './push-batch'
import { admitTs3AwaitingS4 } from './admission'
import { loadSyncV2Meta, writeSyncV2Meta } from './sync-meta'
import { countUnsyncedOutbox } from './outbox'
import { getOrCreateClientId } from './client-registry'
import { runFullRecovery } from './recovery'
import { reconcileSpaceCommittedTerminalEvidence } from './terminal-application'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  withSpaceAuthorityFence,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import {
  ENTITY_TYPE_TO_TABLE,
  type SyncEngine,
  type SyncConflict,
  type SyncOp,
  type SyncStatus,
} from './types'
import { normalizeSyncEntityType } from './terminal-application'

const SYNC_DEBOUNCE_MS = 5000

/**
 * 服务端 canonical 409 拒绝（{code, message, retryable, request_id, details}）。
 * cursor_expired 表示客户端游标与服务端状态失配（catalog 变化 / retention 裁剪 /
 * client 与 cursor 内嵌 client 不一致），唯一出路是以当前 client 重新全量恢复。
 */
function isCursorExpiredRejection(err: unknown): boolean {
  const e = err as {
    response?: {
      status?: number
      data?: { code?: string; details?: { recovery_action?: string } }
    }
  }
  if (e?.response?.status !== 409) return false
  return e.response.data?.code === 'cursor_expired' ||
    e.response.data?.details?.recovery_action === 'full_recovery'
}

export class RealSyncEngine implements SyncEngine {
  private db: PomodoroXIDB
  private spaceId: string
  private api: AxiosInstance
  private meta: MetaDB
  private status: SyncStatus = 'idle'
  private lastSyncedAt: string | null = null
  private pendingCountCache = 0
  private conflicts: SyncConflict[] = []
  private destroyed = false
  private isSyncing = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: {
    pull: Set<() => void>
    push: Set<() => void>
    conflict: Set<(c: SyncConflict[]) => void>
    syncComplete: Set<() => void>
  } = { pull: new Set(), push: new Set(), conflict: new Set(), syncComplete: new Set() }

  constructor(db: PomodoroXIDB, spaceId: string, api?: AxiosInstance, meta: MetaDB = metaDB) {
    this.db = db
    this.spaceId = spaceId
    this.api = api ?? spaceApi
    this.meta = meta
    // 初始化 pendingCount 缓存（异步，不阻塞构造）
    void this.refreshPendingCount()
  }

  // ---- F0 §8.1 必须方法 ----

  markDirty(_entityType: string, _entityId: string, _op: SyncOp): void {
    if (this.destroyed) return
    this.pendingCountCache++
    this.scheduleSync(SYNC_DEBOUNCE_MS)
  }

  async sync(): Promise<void> {
    if (this.destroyed) return
    if (this.isSyncing) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    await withSpaceAuthorityFence(this.spaceId, async (token) => {
      if (this.destroyed) return
      await this.runSyncCycle(false, token)
    })
  }

  getStatus(): SyncStatus {
    return this.status
  }

  getLastSyncedAt(): string | null {
    return this.lastSyncedAt
  }

  getPendingCount(): number {
    return this.pendingCountCache
  }

  getConflicts(): SyncConflict[] {
    return this.conflicts
  }

  async resolveConflict(
    outboxId: number,
    resolution: 'accept-remote' | 'keep-local',
    target?: { entityType: string; entityId: string },
  ): Promise<void> {
    return withSpaceAuthorityFence(this.spaceId, async (token) => {
    requireSpaceAuthorityToken(token, this.spaceId)
    requireSpaceDatabaseBinding(this.db, this.spaceId)
    if (this.destroyed) return
    const conflict = this.conflicts.find(
      (candidate) =>
        candidate.outboxId === outboxId
        && (outboxId >= 0
          || !target
          || (
            candidate.entityType === target.entityType
            && candidate.entityId === target.entityId
          )),
    )
    if (!conflict) return

    if (outboxId < 0) {
      // S1-Hard-3：pre-push dirty 冲突（outboxId = -1）
      if (resolution === 'accept-remote') {
        const tableName =
          ENTITY_TYPE_TO_TABLE[
            conflict.entityType as keyof typeof ENTITY_TYPE_TO_TABLE
          ]
        if (tableName) {
          const table = (
            this.db as unknown as Record<
              string,
              { put: (row: Record<string, unknown>) => Promise<unknown> }
            >
          )[tableName]
          if (table) {
            await this.db.transaction('rw', [this.db.table(tableName), this.db.outbox], async () => {
              await table.put({
                ...(conflict.remoteVersion as Record<string, unknown>),
                _dirty: false,
              })
              const matches = await this.db.outbox
                .where('entityId')
                .equals(conflict.entityId)
                .and((e) => e.entityType === conflict.entityType && !e.synced)
                .toArray()
              if (matches.length > 0) {
                await this.db.outbox.bulkDelete(
                  matches.map((e) => e.id as number),
                )
              }
            })
          }
        }
      }
      // keep-local：保留 _dirty + outbox，no-op
    } else {
      // outboxId >= 0：post-push 冲突（QN-S7 / QN-S8b）
      if (resolution === 'accept-remote') {
        // QN-S8b：采纳远端——服务端回传权威快照时直接写入，立即收敛；
        // 无快照（老后端/tombstone/cycle）回退：删 outbox 行 + _dirty 收敛为 false，等后续 pull 覆盖
        const tableName =
          ENTITY_TYPE_TO_TABLE[
            conflict.entityType as keyof typeof ENTITY_TYPE_TO_TABLE
          ]
        const remote = conflict.remoteVersion as Record<string, unknown> | null | undefined
        await this.db.transaction(
          'rw',
          [tableName ? this.db.table(tableName) : this.db.outbox, this.db.outbox],
          async () => {
            await this.db.outbox.delete(outboxId)
            if (tableName) {
              if (remote) {
                await this.db.table(tableName).put({
                  ...remote,
                  id: String(remote.id ?? conflict.entityId),
                  _dirty: false,
                })
              } else {
                await this.db.table(tableName).update(conflict.entityId, { _dirty: false })
              }
            }
          },
        )
      } else {
        // keep-local：保留本地内容，outbox 行复位为可重试
        // （transportState ready + 清 terminal 诊断标记）
        await this.db.outbox.update(outboxId, {
          synced: false,
          transportState: 'ready',
          serverOutcomeCanonicalBase64: null,
          retryable: false,
          nextAttemptAt: null,
          lastError: null,
          lastErrorCode: null,
          failedAt: null,
        })
      }
    }

    // 移除该冲突（用复合键避免误删同 outboxId=-1 的其他冲突）+ 刷新计数 + 无冲突回 idle
    this.conflicts = this.conflicts.filter(
      (c) =>
        !(
          c.outboxId === outboxId &&
          c.entityType === conflict.entityType &&
          c.entityId === conflict.entityId
        ),
    )
    await this.refreshPendingCount()
    if (this.conflicts.length === 0) {
      this.setStatus('idle')
    }
    // S1-4.2：resolve 也走 wire（含仍 conflict 时 store 应仍为 conflict）
    this.fireSyncComplete()
    })
  }

  async fullSync(): Promise<void> {
    if (this.destroyed) return
    if (this.isSyncing) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    await withSpaceAuthorityFence(this.spaceId, async (token) => {
      if (this.destroyed) return
      await this.runSyncCycle(true, token)
    })
  }

  destroy(): void {
    this.destroyed = true
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    this.isSyncing = false
    this.pendingCountCache = 0
    this.conflicts = []
    this.listeners.pull.clear()
    this.listeners.push.clear()
    this.listeners.conflict.clear()
    this.listeners.syncComplete.clear()
    this.status = 'idle'
  }

  // ---- F1 扩展钩子 ----

  onPullComplete(cb: () => void): () => void {
    this.listeners.pull.add(cb)
    return () => this.listeners.pull.delete(cb)
  }

  onPushComplete(cb: () => void): () => void {
    this.listeners.push.add(cb)
    return () => this.listeners.push.delete(cb)
  }

  onConflict(cb: (conflicts: SyncConflict[]) => void): () => void {
    this.listeners.conflict.add(cb)
    return () => this.listeners.conflict.delete(cb)
  }

  onSyncComplete(cb: () => void): () => void {
    this.listeners.syncComplete.add(cb)
    return () => this.listeners.syncComplete.delete(cb)
  }

  // ---- 内部方法 ----

  private async refreshPendingCount(): Promise<void> {
    this.pendingCountCache = await countUnsyncedOutbox(this.db)
  }

  private scheduleSync(delayMs: number): void {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.sync().catch((err) => console.error('debounced sync failed:', err))
    }, delayMs)
  }

  private setStatus(status: SyncStatus): void {
    this.status = status
  }

  /** 追加冲突 + 触发 onConflict 回调 */
  private addConflicts(newConflicts: SyncConflict[]): void {
    // WorkItemNote conflicts are resolved through the dedicated in-editor
    // NoteConflictPanel (resolveReloadRemote / resolveOverwriteLocal), driven
    // by the workItemNoteConflicts table — NOT the generic accept-remote /
    // keep-local dialog.  Excluding them here keeps a single authority for Note
    // resolution and prevents the generic dialog from overlapping the editor.
    const surfaced = newConflicts.filter((conflict) =>
      normalizeSyncEntityType(conflict.entityType) !== 'workitemnote')
    if (surfaced.length === 0) return
    this.conflicts.push(...surfaced)
    this.listeners.conflict.forEach((cb) => cb(this.conflicts))
  }

  /** S1-4.1：触发 onSyncComplete 回调（每周期末 1 次，含 error 路径；destroy 后不触发） */
  private fireSyncComplete(): void {
    if (this.destroyed) return
    this.listeners.syncComplete.forEach((cb) => cb())
  }

  /**
   * Shared fenced kernel for incremental and full synchronization.
   *
   * `isHealRetry`：cursor_expired 自愈重试标记 —— 仅允许一次同周期重试，
   * 避免服务端持续 409 时形成无限循环（后续失败走正常 error 终态）。
   */
  private async runSyncCycle(
    isFull: boolean,
    token: SpaceAuthorityToken,
    isHealRetry = false,
  ): Promise<void> {
    if (this.destroyed) return
    this.isSyncing = true
    this.setStatus('syncing')
    try {
      const clientId = await getOrCreateClientId(this.db, this.spaceId, token)
      await reconcileSpaceCommittedTerminalEvidence(this.db, this.meta, this.spaceId, token)
      await admitTs3AwaitingS4(this.db, this.meta, this.spaceId, token)
      let v2Meta = await loadSyncV2Meta(this.db)
      if (isFull || v2Meta.requiresFullRecovery || v2Meta.cursor === null) {
        await runFullRecovery(this.db, this.api, this.spaceId, clientId, token)
        v2Meta = await loadSyncV2Meta(this.db)
      }
      // DORMANT（2026-09-10 审查）：per-scope 拉取游标已实现且有双向测试
      // （pull-loop.ts 的 per-scope 游标 + pull-loop.test.ts 的 scope 用例），
      // 但没有任何生产调用方传入 scope —— 因此这里仍走单一全局游标，
      // 按类型过滤从未发生，整个特性处于休眠状态。
      // 启用前必须先确认 per-scope 游标的首次 recover 时序，否则服务端会 409
      // （`scope cursor is not installed`）。
      const pullResult = await runPullLoopV2(this.db, this.api, this.spaceId, clientId, token)
      if (this.destroyed) return
      // S1-Hard-1：pull dirtyConflicts 统一进 addConflicts
      this.addConflicts(pullResult.dirtyConflicts)
      // DR-10：onPullComplete 每周期一次（循环外）
      this.listeners.pull.forEach((cb) => cb())

      // 2. Query and push each durable authority unit under the same fence.
      const pushResult = await pushAllPendingUnderFence(
        this.db, this.meta, this.spaceId, clientId, this.api, token,
      )
      if (this.destroyed) return
      if (pushResult.state === 'blocked') this.setStatus('syncing')
      // S1-Hard-2：onPushComplete 每周期一次（循环外）
      this.listeners.push.forEach((cb) => cb())
      // QN-S7：post-push 冲突（outboxId>=0）进入冲突面板；按 outboxId 去重避免跨周期重复
      const existingConflictKeys = new Set(this.conflicts.map((conflict) => conflict.outboxId))
      this.addConflicts(pushResult.conflicts.filter(
        (conflict) => !existingConflictKeys.has(conflict.outboxId),
      ))

      // 3. 收尾
      await this.refreshPendingCount()
      this.lastSyncedAt = new Date().toISOString()
      this.setStatus(this.conflicts.length > 0 ? 'conflict' : 'idle')
      // S1-4.1：周期末触发 onSyncComplete（成功路径）
      this.fireSyncComplete()
    } catch (err) {
      // DR-8：5xx / Network → infra-error；其余 → error
      // ★ 诊断：此前这里完全吞掉异常（无任何日志），状态栏只显示"同步出错"，
      //   无法定位真实失败点。任何非 5xx/非 Network 的异常（4xx 响应、zod 解析
      //   失败、S4 admission 断言、游标协议断言…）都会走到这里，必须留下证据。
      //   ZodError 的 issues 数组是多行的，console 工具会把换行压扁导致截断，
      //   因此单行结构化输出 path/code/message。
      // ★ 2026-09-12：cursor_expired 是**设计内的自愈条件**（目录 hash 变化 —— 例如
      //   加实体字段/改 registry —— 或 retention 裁剪会让老游标一次性失效），下面
      //   第 402 行会立即做全量恢复重试。首轮就按 error 记录会让 Next dev overlay
      //   把"正在自愈"渲染成故障红屏（实测：B′ 加 FieldSpec 后的第一次 pull）。
      //   分级：首轮自愈 → warn；自愈重试后仍失败 → error（真故障才留红）。
      const cursorExpired = isCursorExpiredRejection(err)
      if (err instanceof Error && 'issues' in err) {
        console.error('[sync] cycle failed ZodError:',
          JSON.stringify((err as unknown as { issues: Array<{ path: unknown[]; code: string; message: string }> })
            .issues?.map((issue) => ({
              path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path),
              code: issue.code,
              message: issue.message?.slice(0, 300),
            }))))
      } else if (cursorExpired && !isHealRetry) {
        console.warn('[sync] cursor expired → 全量恢复自愈（目录/保留策略变化，一次性）:',
          (err as { response?: { data?: unknown } })?.response?.data ?? err)
      } else {
        console.error('[sync] cycle failed:', err)
      }
      // ★ 自愈：被服务端以 409 cursor_expired 拒绝时，持久化 requiresFullRecovery=true，
      //   并**在同一周期内**以当前 client 立即重试一次（全量恢复 + 重新 ACK 收敛）。
      //   此前没有任何路径写这个标记 —— 一旦 client 与 cursor 内嵌 client 错位
      //   （如 bootstrap wipe 竞态换掉了 clientId），每个周期 pull 都 409，
      //   状态栏永久卡在"同步出错"。token 仍在 fence 内，可直接复用。
      if (cursorExpired) {
        try {
          await writeSyncV2Meta(this.db, this.spaceId, token, {
            requiresFullRecovery: true,
          })
        } catch (metaErr) {
          console.error('[sync] failed to flag requiresFullRecovery:', metaErr)
        }
        if (!isHealRetry && !this.destroyed) {
          return this.runSyncCycle(isFull, token, true)
        }
      }
      const axiosErr = err as { response?: { status?: number }; message?: string }
      const status = axiosErr?.response?.status
      const isInfra =
        (typeof status === 'number' && status >= 500) ||
        (axiosErr?.message?.includes('Network') ?? false)
      this.setStatus(isInfra ? 'infra-error' : 'error')
      // S1-4.1：周期末触发 onSyncComplete（错误路径）
      this.fireSyncComplete()
    } finally {
      this.isSyncing = false
    }
  }
}
