import { CheckIcon } from 'lucide-react'

/**
 * Sync status bar (F0 §5.4 — S0 stub).
 *
 * S0: static "Sync: idle".
 * F1: replace with useSync() hook showing syncing/error/idle/conflict.
 */

export function SyncStatusBar() {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckIcon className="size-3 text-green-500" />
      <span>Sync: idle</span>
    </span>
  )
}
