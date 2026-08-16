'use client'

import { createElement, useState } from 'react'

interface PlanItem {
  id: string
  workItemId: string
  titleSnapshot: string
  currentDuringSession: boolean
  completionDraft: boolean
}

interface AvailableItem { id: string; title: string }

interface SessionWorkspaceProps {
  session: { sessionNote?: string }
  plans: PlanItem[]
  availableLevel3?: AvailableItem[]
  onSetCurrent?: (workItemId: string | null) => void | Promise<void>
  onSetCompletionDraft?: (planItemId: string, completionDraft: boolean) => void | Promise<void>
  onAddPlanItem?: (workItemId: string) => void | Promise<void>
  onRemovePlanItem?: (planItemId: string) => void | Promise<void>
  onUpdateSessionNote?: (value: string) => void | Promise<void>
  onUpdateWorkItemNote?: (value: string) => void | Promise<void>
  onFlushWorkItemNote?: (reason: 'current-item-change') => Promise<void>
  onSwitchWorkItemNote?: (workItemId: string) => Promise<void | (() => Promise<void>)>
  onAllocateMinutes?: (seconds: number) => void
}

export function SessionWorkspace({
  session, plans, availableLevel3 = [], onSetCurrent, onSetCompletionDraft,
  onAddPlanItem, onRemovePlanItem, onUpdateSessionNote, onUpdateWorkItemNote: _onUpdateWorkItemNote,
  onFlushWorkItemNote, onSwitchWorkItemNote,
}: SessionWorkspaceProps) {
  const [sessionNote, setSessionNote] = useState(session.sessionNote ?? '')
  const [switchError, setSwitchError] = useState<string | null>(null)
  const selectCurrent = (workItemId: string) => {
    if (!onSwitchWorkItemNote && !onFlushWorkItemNote) {
      void onSetCurrent?.(workItemId)
      return
    }
    setSwitchError(null)
    void (async () => {
      let rollback: (() => Promise<void>) | void = undefined
      try {
        if (onSwitchWorkItemNote) rollback = await onSwitchWorkItemNote(workItemId)
        else await onFlushWorkItemNote?.('current-item-change')
        await onSetCurrent?.(workItemId)
      } catch (cause) {
        await rollback?.().catch(() => undefined)
        setSwitchError(cause instanceof Error ? cause.message : 'Unable to switch current WorkItem')
      }
    })()
  }
  return createElement(
    'section', { 'aria-label': 'Session workspace', className: 'grid gap-6' },
    createElement('section', { 'aria-label': 'Session plan', className: 'grid gap-2' },
      createElement('h2', null, 'Current plan'),
      plans.map((plan) => createElement('div', { key: plan.id, className: 'flex items-center gap-2' },
        createElement('input', {
          type: 'radio', name: 'current-session-plan',
          'aria-label': `Work on ${plan.titleSnapshot}`,
          checked: plan.currentDuringSession,
          onChange: () => void selectCurrent(plan.workItemId),
        }),
        createElement('button', { type: 'button', onClick: () => void selectCurrent(plan.workItemId) }, `Work on ${plan.titleSnapshot}`),
        createElement('label', null,
          createElement('input', {
            type: 'checkbox', 'aria-label': `Mark ${plan.titleSnapshot} complete`, checked: plan.completionDraft,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => void onSetCompletionDraft?.(plan.id, event.target.checked),
          }),
        ),
        createElement('button', { type: 'button', onClick: () => void onRemovePlanItem?.(plan.id) }, `Remove ${plan.titleSnapshot} from plan`),
      )),
      availableLevel3.map((item) => createElement('button', { key: item.id, type: 'button', onClick: () => void onAddPlanItem?.(item.id) }, `Add ${item.title} to plan`)),
    ),
    switchError ? createElement('p', { role: 'alert' }, switchError) : null,
    createElement('label', { className: 'grid gap-2', htmlFor: 'session-note' },
      'Session note',
      createElement('textarea', {
        id: 'session-note', value: sessionNote,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
          setSessionNote(event.target.value)
          void onUpdateSessionNote?.(event.target.value)
        },
      }),
    ),
  )
}
