'use client'

import { createElement, useState } from 'react'

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
  return createElement('ul', { 'aria-label': 'Work item command results', className: 'divide-y' },
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
      return createElement('li', { key: commandId, className: 'flex min-h-12 items-center gap-3 py-2' },
        createElement('span', { className: 'min-w-0 flex-1 truncate' }, envelope.targetTransition ?? commandId),
        createElement('span', { className: 'text-sm' }, label),
        (state === 'unknown' || state === 'pending') ? createElement('span', { className: 'flex items-center gap-2' },
          createElement('button', {
            type: 'button', 'aria-label': `Query ${commandId}`,
            onClick: query,
          }, 'Query original result'),
          envelope.replaySafe && queried.has(commandId) ? createElement('button', {
            type: 'button', 'aria-label': `Retry ${commandId}`,
            onClick: () => void onReconcile(commandId, true),
          }, 'Retry original command') : null,
        ) : null,
        (state === 'unknown' || state === 'pending') && queried.has(commandId) ? createElement('button', {
          type: 'button', 'aria-label': `Abandon ${commandId}`,
          onClick: () => void onAbandon(commandId),
        }, 'Abandon command') : null,
      )
    }),
  )
}
