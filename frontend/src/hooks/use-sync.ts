'use client'

/**
 * useSync hook (F0 §5.4 / S1-4 扩展).
 *
 * Selector-only subscriptions to sync-store for the SyncStatusBar
 * and ConflictPanel.
 */

import { useSyncStore } from '@/stores/sync-store'

export function useSync() {
  const status = useSyncStore((s) => s.status)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const pendingCount = useSyncStore((s) => s.pendingCount)
  const error = useSyncStore((s) => s.error)
  const conflicts = useSyncStore((s) => s.conflicts)
  const triggerSync = useSyncStore((s) => s.triggerSync)
  const resolveConflict = useSyncStore((s) => s.resolveConflict)
  return {
    status,
    lastSyncedAt,
    pendingCount,
    error,
    conflicts,
    sync: triggerSync,
    resolveConflict,
  }
}
