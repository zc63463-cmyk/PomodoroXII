'use client'

import { createElement, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface CommandReceiptEnvelope {
  commandId: string
  targetTransition?: string
  replaySafe: boolean
}

export interface CommandReceipt {
  commandId: string
  attempt?: number
  state: string
  errorCode?: string | null
  detail?: Record<string, unknown> | null
  recordedAt?: string
}

interface Props {
  envelopes: CommandReceiptEnvelope[]
  receipts: CommandReceipt[]
  onReconcile: (commandId: string, requestedReplaySafe: boolean) => void | boolean | Promise<void | boolean>
  onAbandon: (commandId: string) => void | Promise<void>
}

const labels: Record<string, string> = {
  not_needed: 'Not needed', pending: 'Pending', succeeded: 'Succeeded',
  failed: 'Failed', conflict: 'Conflict', unknown: 'Unknown', abandoned: 'Abandoned',
}

/** 回执状态徽标配色（仅视觉，不参与语义判定）。 */
const STATE_CLASS: Record<string, string> = {
  succeeded: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  conflict: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  abandoned: 'border-border bg-muted text-muted-foreground line-through',
  unknown: 'border-border bg-muted text-muted-foreground',
  pending: 'border-border bg-muted text-muted-foreground',
  not_needed: 'border-border bg-muted text-muted-foreground',
}

const latestReceipt = (receipts: CommandReceipt[], commandId: string) => receipts
  .filter((receipt) => receipt.commandId === commandId)
  .sort((left, right) => (right.attempt ?? 0) - (left.attempt ?? 0))[0]

export function CommandReceiptList({ envelopes, receipts, onReconcile, onAbandon }: Props) {
  const [queried, setQueried] = useState<Set<string>>(() => new Set())
  const ids = [...new Set([
    ...envelopes.map((envelope) => envelope.commandId),
    ...receipts.map((receipt) => receipt.commandId),
  ])]
  const byId = new Map(envelopes.map((envelope) => [envelope.commandId, envelope]))
  return createElement('ul', {
    'aria-label': 'Work item command results',
    className: 'divide-y divide-border/60 rounded-lg border',
  },
    ids.map((commandId) => {
      const envelope = byId.get(commandId) ?? { commandId, targetTransition: commandId, replaySafe: false }
      const receipt = latestReceipt(receipts, commandId)
      const state = receipt?.state ?? 'pending'
      const label = labels[state] ?? state
      const query = () => {
        void Promise.resolve(onReconcile(commandId, false)).then((succeeded) => {
          if (succeeded !== false) setQueried((current) => new Set(current).add(commandId))
        }).catch(() => undefined)
      }
      const needsAction = state === 'unknown' || state === 'pending'
      return createElement('li', { key: commandId, className: 'flex min-h-11 flex-wrap items-center gap-2 px-3 py-2' },
        createElement('span', { className: 'min-w-0 flex-1 truncate text-sm' }, envelope.targetTransition ?? commandId),
        createElement('span', {
          className: cn(
            'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs',
            STATE_CLASS[state] ?? STATE_CLASS.unknown,
          ),
        }, label),
        needsAction ? createElement('span', { className: 'flex shrink-0 items-center gap-2' },
          createElement(Button, {
            type: 'button', variant: 'outline', size: 'xs',
            'aria-label': `Query ${commandId}`,
            onClick: query,
          }, 'Query original result'),
          envelope.replaySafe && queried.has(commandId) ? createElement(Button, {
            type: 'button', variant: 'outline', size: 'xs',
            'aria-label': `Retry ${commandId}`,
            onClick: () => void onReconcile(commandId, true),
          }, 'Retry original command') : null,
        ) : null,
        needsAction && queried.has(commandId) ? createElement(Button, {
          type: 'button', variant: 'ghost', size: 'xs',
          'aria-label': `Abandon ${commandId}`,
          onClick: () => void onAbandon(commandId),
        }, 'Abandon command') : null,
      )
    }),
  )
}
