'use client'

import { createElement } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { CachedWorkItem } from '@/types'

interface LaunchSessionButtonProps {
  workItem: CachedWorkItem | null
}

/**
 * Entry point that carries the currently selected WorkItem from the Task
 * Space page into the Focus Session launcher on /timer. The selection itself
 * stays in the shared task-space store (selectedWorkItemId), so switching
 * pages does not lose the space context.
 */
export function LaunchSessionButton({ workItem }: LaunchSessionButtonProps) {
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
    onClick: () => router.push('/timer'),
  }, 'Start focus session')
}
