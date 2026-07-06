'use client'

/**
 * Sync status bar (F0 §5.4).
 *
 * S0-4: Connected to useSync() hook (reads from sync-store).
 * S1: Replace stub with real SyncEngine status.
 */

import { useSync } from '@/hooks/use-sync'
import { CheckIcon } from 'lucide-react'

export function SyncStatusBar() {
  const { status } = useSync()
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckIcon className="size-3 text-green-500" />
      <span>Sync: {status}</span>
    </span>
  )
}
