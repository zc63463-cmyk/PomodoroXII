/**
 * RealSyncEngine — 组装 S1-2 runPullLoop + pushAllPending（F1 §6.1）。
 *
 * 实现 F0 §8.1 全 12 方法 + withSyncLock 多 Tab 互斥。
 * - markDirty：pendingCountCache++ + scheduleSync debounce（DR-7）
 * - sync/fullSync：withSyncLock 包裹 runSyncCycle（复用 S1-2，禁止内联 HTTP）
 * - resolveConflict：outboxId<0 分支（S1-Hard-3）
 * - destroy：清 timer + 标志位（DR-4）
 */

import type { AxiosInstance } from 'axios'
import type { PomodoroXIDB } from '@/services/database'
import { spaceApi } from '@/services/api'
import { runPullLoop } from './pull-loop'
import { pushAllPending } from './push-batch'
import { loadSyncMeta, touchLastSyncAt } from './sync-meta'
import { countUnsyncedOutbox } from './outbox'
import { withSyncLock } from './sync-lock'
import { notifyRemoteWin, notifyCircularRef } from './toast'
import {
  ENTITY_TYPE_TO_TABLE,
  type SyncEngine,
  type SyncConflict,
  type SyncOp,
  type SyncStatus,
} from './types'

const SYNC_DEBOUNCE_MS = 5000
const RESYNC_DELAY_MS = 30_000

export class RealSyncEngine implements SyncEngine {
  private db: PomodoroXIDB
  private spaceId: string
  private api: AxiosInstance
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

  constructor(db: PomodoroXIDB, spaceId: string, api?: AxiosInstance) {
    this.db = db
    this.spaceId = spaceId
    this.api = api ?? spaceApi
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
    await withSyncLock(
      this.spaceId,
      async () => {
        if (this.destroyed) return
        const meta = await loadSyncMeta(this.db)
        const isFull = meta.since === ''
        await this.runSyncCycle(isFull)
      },
      () => this.scheduleSync(RESYNC_DELAY_MS),
    )
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
  ): Promise<void> {
    if (this.destroyed) return
    const conflict = this.conflicts.find((c) => c.outboxId === outboxId)
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
            await table.put({
              ...(conflict.remoteVersion as Record<string, unknown>),
              _dirty: false,
            })
          }
        }
        // 删匹配 outbox 行（若存在 pre-push 已入队但尚未 push 的 dirty 行）
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
      }
      // keep-local：保留 _dirty + outbox，no-op
    } else {
      // outboxId >= 0：post-push 冲突
      if (resolution === 'accept-remote') {
        await this.db.outbox.delete(outboxId)
      } else {
        await this.db.outbox.update(outboxId, { synced: false })
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
  }

  async fullSync(): Promise<void> {
    if (this.destroyed) return
    if (this.isSyncing) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    await withSyncLock(
      this.spaceId,
      async () => {
        if (this.destroyed) return
        await this.runSyncCycle(true)
      },
      () => this.scheduleSync(RESYNC_DELAY_MS),
    )
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
    if (newConflicts.length === 0) return
    this.conflicts.push(...newConflicts)
    this.listeners.conflict.forEach((cb) => cb(this.conflicts))
  }

  /** S1-4.1：触发 onSyncComplete 回调（每周期末 1 次，含 error 路径；destroy 后不触发） */
  private fireSyncComplete(): void {
    if (this.destroyed) return
    this.listeners.syncComplete.forEach((cb) => cb())
  }

  /** sync/fullSync 共用内核：runPullLoop → pushAllPending（禁止内联 HTTP） */
  private async runSyncCycle(isFull: boolean): Promise<void> {
    if (this.destroyed) return
    this.isSyncing = true
    this.setStatus('syncing')
    try {
      // 1. Pull（S1-2 runPullLoop 内部已分页 + merge + saveSyncMeta）
      const pullResult = await runPullLoop(this.db, this.api, { isFull })
      if (this.destroyed) return
      // S1-Hard-1：pull dirtyConflicts 统一进 addConflicts
      this.addConflicts(pullResult.dirtyConflicts)
      // DR-10：onPullComplete 每周期一次（循环外）
      this.listeners.pull.forEach((cb) => cb())

      // 2. Push（S1-2 pushAllPending 内部已分批 + 遇冲突停止）
      const pushResult = await pushAllPending(this.db, this.api)
      if (this.destroyed) return
      this.addConflicts(pushResult.conflicts)
      if (pushResult.remoteWinCount > 0) notifyRemoteWin(pushResult.remoteWinCount)
      if (pushResult.circularRefCount > 0) {
        notifyCircularRef(pushResult.circularRefCount)
      }
      // S1-Hard-2：onPushComplete 每周期一次（循环外）
      this.listeners.push.forEach((cb) => cb())

      // 3. 收尾
      await this.refreshPendingCount()
      this.lastSyncedAt = new Date().toISOString()
      await touchLastSyncAt(this.db, this.lastSyncedAt)
      this.setStatus(this.conflicts.length > 0 ? 'conflict' : 'idle')
      // S1-4.1：周期末触发 onSyncComplete（成功路径）
      this.fireSyncComplete()
    } catch (err) {
      // DR-8：5xx / Network → infra-error；其余 → error
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
