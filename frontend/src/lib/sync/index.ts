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
import { spaceDBManager } from '@/services/space-db'
import { useQuickNoteStore } from '@/stores/quick-note-store'
import { useSyncStore } from '@/stores/sync-store'
import { RealSyncEngine } from './engine'
import { syncEngineStub, type SyncEngine } from './types'

export let syncEngine: SyncEngine = syncEngineStub

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
  })
}

/**
 * 创建/替换 RealSyncEngine（F1 §7.1 ⑥）。
 * 调用方：SpaceSwitchProvider ④ reset 之后；SpaceBootstrap hydrate 成功之后。
 */
export function bootstrapSyncEngine(spaceId: string): void {
  // 1. 旧引擎（含 stub）清 timer/listeners
  syncEngine.destroy()

  // 2. db 必须已就绪（switchTo 在前）
  if (!spaceDBManager.hasSpace) return

  // 3. 新引擎
  const engine = new RealSyncEngine(spaceDBManager.current, spaceId)
  syncEngine = engine

  // 4. 接线 store + Query
  wireSyncEngineToStore(engine, spaceId)

  // 5. 首周期 sync（fire-and-forget；engine 内 since==='' → full）
  void engine.sync()
}
