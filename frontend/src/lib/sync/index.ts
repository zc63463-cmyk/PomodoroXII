/**
 * Sync 模块聚合 — 单例 + bootstrap + wire（F1 §6.3b / §7.1 ⑥）。
 *
 * - syncEngine: 可变单例；bootstrap 时替换引用（F1-D15，ES live binding）
 * - bootstrapSyncEngine: 创建/替换 RealSyncEngine，调用方为 SpaceSwitchProvider ④ 之后
 *   或 SpaceBootstrap hydrate 成功之后
 * - wireSyncEngineToStore: 注册 onPull/onPush/onConflict 回调到 sync-store + Query invalidate
 */

import { queryClient } from '@/lib/query-client'
import { spaceDBManager } from '@/services/space-db'
import { useSyncStore } from '@/stores/sync-store'
import { RealSyncEngine } from './engine'
import { syncEngineStub, type SyncEngine } from './types'

export let syncEngine: SyncEngine = syncEngineStub

export { syncEngineStub } from './types'
export type { SyncEngine, SyncConflict, SyncStatus, SyncOp } from './types'

/** 引擎事件 → sync-store 状态 + Query invalidate（F1 §6.3b / F1-D6b） */
export function wireSyncEngineToStore(
  engine: RealSyncEngine,
  spaceId: string,
): void {
  // 初始 pendingCount
  useSyncStore.setState({ pendingCount: engine.getPendingCount() })

  engine.onPullComplete(() => {
    useSyncStore.setState({
      status: engine.getStatus(),
      lastSyncedAt: engine.getLastSyncedAt(),
      pendingCount: engine.getPendingCount(),
      conflicts: engine.getConflicts(),
      error: null,
    })
    queryClient.invalidateQueries({ queryKey: ['pxii', spaceId] })
  })

  engine.onPushComplete(() => {
    useSyncStore.setState({ pendingCount: engine.getPendingCount() })
  })

  engine.onConflict((conflicts) => {
    useSyncStore.setState({ status: 'conflict', conflicts })
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
