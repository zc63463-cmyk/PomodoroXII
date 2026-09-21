/**
 * Sync 模块聚合 — 单例 + bootstrap + wire（F1 §6.3b / §7.1 ⑥ / S1-4.1 / S1-4.2）。
 *
 * - syncEngine: 可变单例；bootstrap 时替换引用（F1-D15，ES live binding）
 * - bootstrapSyncEngine: 创建/替换 RealSyncEngine，调用方为 SpaceSwitchProvider ④ 之后
 *   或 SpaceBootstrap hydrate 成功之后
 * - wireSyncEngineToStore: onPullComplete(invalidate) / onPushComplete / onConflict /
 *   onSyncComplete(applyEngineStateToStore)
 * - applyEngineStateToStore: DR-8 单一真相源（wire onSyncComplete 与 triggerSync 早退兜底共用）
 */

import { queryClient } from '@/lib/query-client'
import type { PomodoroXIDB } from '@/services/database'
import { spaceDBManager } from '@/services/space-db'
import { useQuickNoteStore } from '@/stores/quick-note-store'
import { useSyncStore } from '@/stores/sync-store'
import { useTaskSpaceStore } from '@/stores/task-space-store'
import { RealSyncEngine } from './engine'
import { loadSyncV2Meta } from './sync-meta'
import { withSpaceAuthorityFence } from './space-authority-fence'
import { startTaskSpaceChangeStream, type ChangeStreamHandle } from './change-stream'
import { syncEngineStub, type SyncEngine } from './types'

export let syncEngine: SyncEngine = syncEngineStub

/**
 * TS-04：当前 Space 的变更流句柄（每 Space 至多一条）。
 *
 * 生命周期与 engine 严格绑定：bootstrap 时启动，destroy/切换时关闭。关闭后
 * 手动、在线、引导与脏标记同步路径全部照常工作 —— 变更流只是「更快」，不是
 * 正确性来源（正确性由 visible watermark + Sync v2 recovery 兜底）。
 */
let changeStreamHandle: ChangeStreamHandle | null = null

/** 关闭当前变更流（幂等）。Space 切换与 engine destroy 都必须走到这里。 */
export function stopTaskSpaceChangeStream(): void {
  changeStreamHandle?.close()
  changeStreamHandle = null
}

function startChangeStreamFor(engine: RealSyncEngine, spaceId: string): void {
  stopTaskSpaceChangeStream()
  if (typeof window === 'undefined') return

  // 在权威围栏内取 token：围栏退出即失效，旧的迟到回调因此无法污染新 Space。
  void withSpaceAuthorityFence(spaceId, async (authority) => {
    // 围栏内的 engine 可能已被替换（bootstrap 竞态）：以 live binding 为准。
    if (syncEngine !== engine) return
    changeStreamHandle = startTaskSpaceChangeStream({
      spaceId,
      authority,
      sync: () => engine.sync(),
      onError: (error) => {
        // 仅诊断：通知失败不影响任何已有同步触发路径。
        console.warn('[sync] change stream error:', error)
      },
    })
  }).catch((error) => {
    console.warn('[sync] change stream unavailable:', error)
  })
}

export { syncEngineStub } from './types'
export type { SyncEngine, SyncConflict, SyncStatus, SyncOp } from './types'

/**
 * DR-8：engine 终态 → sync-store（S1-4.1 单一真相源）。
 *
 * 由 wireSyncEngineToStore 的 onSyncComplete 回调与 sync-store.triggerSync/
 * resolveConflict 共用，避免重复内联 DR-8 文案映射。
 */
export function applyEngineStateToStore(engine: SyncEngine): void {
  const status = engine.getStatus()
  useSyncStore.setState({
    status,
    lastSyncedAt: engine.getLastSyncedAt(),
    pendingCount: engine.getPendingCount(),
    conflicts: engine.getConflicts(),
    error:
      status === 'infra-error' ? '网络异常，同步暂停' :
      status === 'error' ? '同步出错' : null,
  })
}

function refreshQuickNotesAfterSync(): void {
  void useQuickNoteStore
    .getState()
    .refreshQuickNotesFromRepository()
    .catch((error) => {
      console.error('QuickNote sync refresh failed:', error)
    })
}

/**
 * 任务空间列表的同步后刷新。
 *
 * ★ 为什么必须有（2026-09-11 实测）：pull 把远端变更（另一台设备、服务端派生
 *   的「投入物化」effort_actual_seconds）写进本地 Dexie，但任务页的 workItems
 *   是挂载时 hydrate 的快照，同步不会重读 —— 数据已经进库、界面却永远显示旧值
 *   （复盘拿到 52 分钟投入，任务空间里仍是 0，用户只能靠手动刷新才发现）。
 *   QuickNote 很早就在 pull/push 后刷新了；这里对齐同一语义。
 *   只读缓存、不走网络；store 未 hydrate（无 repository）时是 no-op。
 */
function refreshTaskSpaceAfterSync(): void {
  void useTaskSpaceStore
    .getState()
    .refreshCachedOverview()
    .catch((error) => {
      console.error('Task space sync refresh failed:', error)
    })
}

/** 引擎事件 → sync-store 状态 + Query invalidate（F1 §6.3b / S1-4.1 重构） */
export function wireSyncEngineToStore(
  engine: RealSyncEngine,
  spaceId: string,
): void {
  // 初始 pendingCount
  useSyncStore.setState({ pendingCount: engine.getPendingCount() })

  engine.onPullComplete(() => {
    // F1 §6.4：pull 后仅 invalidate，不写终态（终态由 onSyncComplete 统一处理）
    queryClient.invalidateQueries({ queryKey: ['pxii', spaceId] })
    refreshQuickNotesAfterSync()
    refreshTaskSpaceAfterSync()
  })

  engine.onPushComplete(() => {
    useSyncStore.setState({ pendingCount: engine.getPendingCount() })
    refreshQuickNotesAfterSync()
  })

  engine.onConflict((conflicts) => {
    useSyncStore.setState({ status: 'conflict', conflicts })
  })

  engine.onSyncComplete(() => {
    // S1-4.1：周期末单一真相源 — 终态由 onSyncComplete 写
    applyEngineStateToStore(engine)
    refreshQuickNotesAfterSync()
    refreshTaskSpaceAfterSync()
  })
}

/**
 * 客户端"未初始化好"（cursor 为 null）时，清掉所有 push/admission 相关残留。
 * 这些状态只对"旧协议的 push 流程"有意义，一旦客户端需要从头 recover，它们是
 * 脏数据 —— `assertS4AdmissionReady` 等检查会持续抛错，状态栏卡在"同步出错"，
 * 反复 full recovery 也救不回来。把客户端当作"新设备"重新跑 recover + push。
 *
 * ★ 必须 fence 互斥：与 engine.sync() 用同一把 Web Lock，且在锁内**复查 cursor**。
 *   此前这是 fire-and-forget、与首轮周期并发跑 —— `syncMeta.clear()` 会删掉
 *   周期 1 正在使用的 client_id（以及刚装好的 cursor），而引擎拿着内存里的旧
 *   clientId 继续完成恢复并写入游标 → 持久化后 client 与 cursor 内嵌 client
 *   永久错位，之后每个 pull 都被 409 cursor_expired 拒绝。
 *   锁保证了两种交错顺序都安全：
 *   - wipe 先拿锁：清完再轮到周期 1，全新一致状态；
 *   - 周期 1 先拿锁：装好 cursor 后 wipe 在锁内复查到 cursor ≠ null，直接跳过。
 */
export async function wipeUninitializedSyncMeta(
  db: PomodoroXIDB,
  spaceId: string,
): Promise<void> {
  await withSpaceAuthorityFence(spaceId, async () => {
    const meta = await loadSyncV2Meta(db)
    if (meta.cursor !== null) return // 已初始化好，别乱清（锁内复查）
    await Promise.all([
      db.syncMeta.clear(),
      db.syncPushBatches.clear(),
      db.syncRecoveryState.clear(),
      db.syncRecoveryChunks.clear(),
    ])
  })
}

/**
 * 创建/替换 RealSyncEngine（F1 §7.1 ⑥）。
 * 调用方：SpaceSwitchProvider ④ reset 之后；SpaceBootstrap hydrate 成功之后。
 */
export function bootstrapSyncEngine(spaceId: string): void {
  // 1. 旧引擎（含 stub）清 timer/listeners；旧变更流必须先关，避免旧 Space 的
  //    迟到通知驱动新 Space。
  stopTaskSpaceChangeStream()
  syncEngine.destroy()

  // 2. db 必须已就绪（switchTo 在前）
  if (!spaceDBManager.hasSpace) return

  // 2b. 清理未初始化残留（fenced，见函数注释；尽力而为，失败不阻塞引导）
  wipeUninitializedSyncMeta(spaceDBManager.current, spaceId).catch((err) => {
    console.error('sync bootstrap wipe failed:', err)
  })

  // 3. 新引擎
  const engine = new RealSyncEngine(spaceDBManager.current, spaceId)
  syncEngine = engine

  // 4. 接线 store + Query
  wireSyncEngineToStore(engine, spaceId)

  // 5. 首周期 sync（fire-and-forget；engine 内 since==='' → full）
  void engine.sync()

  // 6. TS-04：接上已提交变更通知流（只作唤醒；失败不影响上面的首周期）。
  startChangeStreamFor(engine, spaceId)
}

// Wave 2C: reconnect trigger.  Offline edits are enqueued to the outbox with
// transportState 'awaiting_s4' (Note edits, FocusSession clock commands, …),
// and enqueueOutbox now marks the engine dirty — but a debounced sync that
// fires while offline is skipped by the engine.  Reconnecting must re-trigger
// a sync so those rows are admitted and pushed to the server.  The listener is
// registered once; `syncEngine` is a live binding, so it always drives the
// current per-space engine (or the no-op stub when no space is bootstrapped).
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void syncEngine.sync().catch((error) => {
      console.error('reconnect sync failed:', error)
    })
  })
}
