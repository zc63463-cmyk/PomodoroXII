'use client'

import { createElement, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { CachedWorkItem } from '@/types'

/**
 * Session-start blocker acknowledgement (依赖域 v1 §Session 确认流).
 *
 * Starting a focus session on a blocked item is allowed, but never silent:
 * the user must consciously override the plan.  The decision is reported back
 * so the caller can record a BlockerAck event.
 */

export interface BlockerAckModalProps {
  open: boolean
  workItem: CachedWorkItem | null
  /** Unfinished upstream items, already resolved to cached rows when possible. */
  blockers: CachedWorkItem[]
  /** Fallback labels for blockers that have not hydrated locally yet. */
  blockerLabels?: Record<string, string>
  onProceed?: () => void
  onCancel?: () => void
}

function blockerName(
  blocker: CachedWorkItem,
  blockerLabels: Record<string, string> | undefined,
): string {
  const fallback = blockerLabels?.[blocker.id]
  return fallback ?? `${blocker.displayKey} ${blocker.title}`.trim()
}

export function BlockerAckModal({
  open,
  workItem,
  blockers,
  blockerLabels,
  onProceed,
  onCancel,
}: BlockerAckModalProps): ReactNode {
  if (!open || !workItem) return null

  return createElement(
    'div',
    {
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'blocker-ack-title',
      'data-blocker-ack': true,
      className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4',
    },
    createElement(
      'div',
      { className: 'grid w-full max-w-md gap-4 rounded-lg border bg-background p-5 shadow-lg' },
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement(
          'h2',
          { id: 'blocker-ack-title', className: 'text-base font-semibold' },
          '该工作项仍被阻塞',
        ),
        createElement(
          'p',
          { className: 'text-sm text-muted-foreground' },
          createElement('span', null, '「'),
          createElement('span', null, `${workItem.displayKey} ${workItem.title}`.trim()),
          createElement('span', null, '」被以下未完成项阻塞：'),
        ),
      ),
      createElement(
        'ul',
        { className: 'grid gap-1 rounded-md border p-2 text-sm', 'data-blocker-list': true },
        blockers.length === 0
          ? createElement('li', { className: 'text-muted-foreground' }, '存在未完成的依赖项')
          : blockers.map((blocker) => createElement(
              'li',
              { key: blocker.id },
              blockerName(blocker, blockerLabels),
            )),
      ),
      createElement(
        'p',
        { className: 'text-sm text-muted-foreground' },
        '按照规划，建议先完成上游工作。是否仍要强制开启专注？',
      ),
      createElement(
        'div',
        { className: 'flex justify-end gap-2' },
        createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            ...({ 'data-resolution': 'cancel' } as unknown as Record<string, never>),
            onClick: () => onCancel?.(),
          },
          '返回处理上游',
        ),
        createElement(
          Button,
          {
            type: 'button',
            ...({ 'data-resolution': 'proceed' } as unknown as Record<string, never>),
            onClick: () => onProceed?.(),
          },
          '强制继续',
        ),
      ),
    ),
  )
}
