/**
 * Sync store (F0 §7.3.17 / S1-4 委托 real engine).
 *
 * S1-4: triggerSync/resolveConflict 委托 syncEngine；
 * engine status → store error 文案映射（DR-8）。
 * Zustand v5 curried form: create<T>()(devtools(...))
 *
 * Note: 与 @/lib/sync 存在循环依赖（index.ts import useSyncStore，
 * sync-store import syncEngine），但双方均仅在运行时函数内访问对方导出，
 * 不在模块顶层使用，故安全。
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { SyncConflict, SyncStatus } from '@/lib/sync/types'
import { syncEngine, applyEngineStateToStore } from '@/lib/sync'

interface SyncState {
  status: SyncStatus
  lastSyncedAt: string | null
  pendingCount: number
  error: string | null
  conflicts: SyncConflict[]
}

interface SyncActions {
  triggerSync: () => Promise<void>
  resolveConflict: (
    outboxId: number,
    resolution: 'accept-remote' | 'keep-local',
    target?: { entityType: string; entityId: string },
  ) => Promise<void>
  setStatus: (status: SyncStatus) => void
  reset: () => void
}

type SyncStore = SyncState & SyncActions

export const useSyncStore = create<SyncStore>()(
  devtools(
    (set) => ({
      status: 'idle',
      lastSyncedAt: null,
      pendingCount: 0,
      error: null,
      conflicts: [],

      triggerSync: async () => {
        set({ status: 'syncing', error: null })
        try {
          await syncEngine.sync()
          // S1-4.2 兜底：sync() 早退（offline/isSyncing）时 onSyncComplete 不触发；
          // 成功路径 onSyncComplete 已写终态，此处幂等双写无害
          applyEngineStateToStore(syncEngine)
        } catch (e) {
          set({ status: 'error', error: (e as Error).message })
        }
      },

      resolveConflict: async (outboxId, resolution, target) => {
        await syncEngine.resolveConflict(outboxId, resolution, target)
        // S1-4.2：store 由 wire onSyncComplete 更新（resolveConflict 已 fireSyncComplete）
      },

      setStatus: (status) => set({ status }),
      reset: () => set({ status: 'idle', lastSyncedAt: null, pendingCount: 0, error: null, conflicts: [] }),
    }),
    { name: 'sync-store' },
  ),
)
