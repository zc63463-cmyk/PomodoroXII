'use client'

/**
 * useSync hook (F0 §5.4).
 *
 * Selector-only subscriptions to sync-store for the SyncStatusBar.
 * S0 stub: returns idle state; S1 replaces with real SyncEngine.
 */

import { useSyncStore } from '@/stores/sync-store'

export function useSync() {
  const status = useSyncStore((s) => s.status)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const pendingCount = useSyncStore((s) => s.pendingCount)
  return { status, lastSyncedAt, pendingCount }
}
