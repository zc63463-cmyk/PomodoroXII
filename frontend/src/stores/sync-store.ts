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
import { syncEngine } from '@/lib/sync'

interface SyncState {
  status: SyncStatus
  lastSyncedAt: string | null
  pendingCount: number
  error: string | null
  conflicts: SyncConflict[]
}

interface SyncActions {
  triggerSync: () => Promise<void>
  resolveConflict: (outboxId: number, resolution: 'accept-remote' | 'keep-local') => Promise<void>
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
          const status = syncEngine.getStatus()
          set({
            status,
            lastSyncedAt: syncEngine.getLastSyncedAt(),
            pendingCount: syncEngine.getPendingCount(),
            conflicts: syncEngine.getConflicts(),
            error:
              status === 'infra-error' ? '网络异常，同步暂停' :
              status === 'error' ? '同步出错' : null,
          })
        } catch (e) {
          set({ status: 'error', error: (e as Error).message })
        }
      },

      resolveConflict: async (outboxId, resolution) => {
        await syncEngine.resolveConflict(outboxId, resolution)
        set({
          status: syncEngine.getStatus(),
          conflicts: syncEngine.getConflicts(),
          pendingCount: syncEngine.getPendingCount(),
        })
      },

      setStatus: (status) => set({ status }),
      reset: () => set({ status: 'idle', lastSyncedAt: null, pendingCount: 0, error: null, conflicts: [] }),
    }),
    { name: 'sync-store' },
  ),
)
