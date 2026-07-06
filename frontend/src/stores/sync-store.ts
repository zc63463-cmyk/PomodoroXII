/**
 * Sync store (F0 §7.3.17).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { SyncConflict } from '@/types'

type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict' | 'infra-error'

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

      triggerSync: async () => { /* S0 stub */ },
      resolveConflict: async () => { /* S0 stub */ },
      setStatus: (status) => set({ status }),
      reset: () => set({ status: 'idle', lastSyncedAt: null, pendingCount: 0, error: null, conflicts: [] }),
    }),
    { name: 'sync-store' },
  ),
)
