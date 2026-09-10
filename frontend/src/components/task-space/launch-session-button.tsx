'use client'

import { createElement } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { CachedWorkItem } from '@/types'

interface LaunchSessionButtonProps {
  workItem: CachedWorkItem | null
  /**
   * Derived dependency signal.  When true the click is intercepted and
   * reported through ``onBlocked`` instead of navigating — starting focus on
   * a blocked item is allowed, but only after an explicit acknowledgement.
   */
  blocked?: boolean
  onBlocked?: (workItem: CachedWorkItem) => void
}

/**
 * Entry point that carries the currently selected WorkItem from the Task
 * Space page into the Focus Session launcher on /timer. The selection itself
 * stays in the shared task-space store (selectedWorkItemId), so switching
 * pages does not lose the space context.
 */
export function LaunchSessionButton({
  workItem,
  blocked = false,
  onBlocked,
}: LaunchSessionButtonProps) {
  const router = useRouter()
  const label = workItem
    ? `Start focus session for ${workItem.displayKey} ${workItem.title}`
    : 'Start focus session'
  return createElement(Button, {
    type: 'button',
    variant: 'outline',
    size: 'sm',
    disabled: workItem === null,
    'aria-label': label,
    onClick: () => {
      if (workItem === null) return
      if (blocked && onBlocked) {
        onBlocked(workItem)
        return
      }
      router.push('/timer')
    },
    // Tasks-page shortcut (`s`) clicks this button programmatically.  The
    // spread bypasses Button's excess-property check for data attributes.
    ...({ 'data-launch-session': 'true' } as unknown as Record<string, never>),
  }, 'Start focus session')
}
