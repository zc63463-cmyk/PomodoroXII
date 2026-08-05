'use client'

import { createElement, useMemo, type ChangeEvent } from 'react'
import { CommandReceiptList, type CommandReceipt, type CommandReceiptEnvelope } from './command-receipt-list'
import type { SessionReviewDraft } from '@/lib/focus-session/session-review-draft-registry'

export interface SessionReviewPlan {
  id: string
  workItemId: string
  titleSnapshot: string
  workItemVersionSnapshot: number
  completionDraft?: boolean
}

export interface SessionReviewProps {
  session: {
    sessionId?: string
    id?: string
    focusedSeconds: number
    validity: string
    reviewState: string
    clockState: string
    ownershipState: string
  }
  plans: SessionReviewPlan[]
  outcomes?: Array<Record<string, unknown>>
  envelopes: CommandReceiptEnvelope[]
  receipts: CommandReceipt[]
  draft: SessionReviewDraft | null
  readOnly?: boolean
  onDraftChange: (draft: SessionReviewDraft) => void | Promise<void>
  onSubmit: (draft: SessionReviewDraft) => void | Promise<void>
  onReconcile: (commandId: string, requestedReplaySafe: boolean) => void | boolean | Promise<void | boolean>
  onAbandon: (commandId: string) => void | Promise<void>
}

export function isReviewableEndedSession(session: Pick<SessionReviewProps['session'], 'clockState' | 'reviewState' | 'ownershipState'>): boolean {
  return session.clockState === 'ended' && session.reviewState === 'pending' &&
    session.ownershipState !== 'activation_conflict'
}

export function selectReviewSession<T extends Pick<SessionReviewProps['session'], 'clockState' | 'reviewState' | 'ownershipState'>>(
  sessions: readonly T[],
): T | undefined {
  return sessions.find((candidate) => isReviewableEndedSession(candidate)) ??
    sessions.find((candidate) => candidate.clockState === 'ended')
}

type ReviewOutcome = SessionReviewDraft['outcomes'][number]

const formatFocused = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} focused`

function defaultOutcome(plan: SessionReviewPlan): ReviewOutcome {
  return {
    workItemId: plan.workItemId,
    touched: plan.completionDraft ?? false,
    result: 'progressed',
    stateCommand: plan.completionDraft ? 'complete' : 'none',
    expectedWorkItemVersion: plan.workItemVersionSnapshot,
    executionPersona: null,
    personaSwitched: null,
    personaNote: null,
  }
}

function outcomeFor(draft: SessionReviewDraft, plan: SessionReviewPlan): ReviewOutcome {
  return draft.outcomes.find((outcome) => outcome.workItemId === plan.workItemId) ?? defaultOutcome(plan)
}

function updateOutcome(
  draft: SessionReviewDraft,
  plan: SessionReviewPlan,
  patch: Partial<ReviewOutcome>,
): SessionReviewDraft {
  const base = draft.reviewState === 'skipped' ? { ...draft, reviewState: 'completed' as const } : draft
  const nextOutcome = { ...outcomeFor(base, plan), ...patch }
  const hasExisting = base.outcomes.some((outcome) => outcome.workItemId === plan.workItemId)
  return {
    ...base,
    outcomes: hasExisting
      ? base.outcomes.map((outcome) => outcome.workItemId === plan.workItemId ? nextOutcome : outcome)
      : [...base.outcomes, nextOutcome],
  }
}

export function SessionReview({ session, plans, envelopes, receipts, draft, readOnly = false,
  onDraftChange, onSubmit, onReconcile, onAbandon }: SessionReviewProps) {
  const focusedLabel = useMemo(() => formatFocused(session.focusedSeconds), [session.focusedSeconds])

  if (session.ownershipState === 'activation_conflict') {
    return createElement('section', { 'aria-label': 'Session review', className: 'grid gap-4' },
      createElement('h2', null, 'Session review'),
      createElement('p', { role: 'alert' }, 'Review is blocked while this Session has an activation conflict.'),
      createElement('p', null, focusedLabel),
    )
  }

  if (readOnly) {
    return createElement('section', { 'aria-label': 'Session review', className: 'grid gap-4' },
      createElement('h2', null, 'Session review'),
      createElement('p', null, focusedLabel),
      createElement('p', null, `Review ${session.reviewState}.`),
      createElement(CommandReceiptList, { envelopes, receipts, onReconcile, onAbandon }),
    )
  }

  if (!draft) {
    return createElement('section', { 'aria-label': 'Session review', className: 'grid gap-4' },
      createElement('h2', null, 'Session review'),
      createElement('p', null, 'Preparing review…'),
      createElement('p', null, focusedLabel),
    )
  }

  const commit = (next: SessionReviewDraft) => void onDraftChange(next)
  const setValidity = (event: ChangeEvent<HTMLSelectElement>) => {
    commit({ ...draft, validity: event.target.value as SessionReviewDraft['validity'] })
  }
  const setReviewState = (event: ChangeEvent<HTMLSelectElement>) => {
    const reviewState = event.target.value as SessionReviewDraft['reviewState']
    commit({ ...draft, reviewState, outcomes: reviewState === 'skipped' ? [] : plans.map((plan) => outcomeFor(draft, plan)) })
  }
  const submit = () => void onSubmit(draft)

  return createElement('section', { 'aria-label': 'Session review', className: 'grid gap-4' },
    createElement('h2', null, 'Session review'),
    createElement('p', null, focusedLabel),
    createElement('label', null, 'Validity', createElement('select', {
      'aria-label': 'Review validity', value: draft.validity, onChange: setValidity,
    }, createElement('option', { value: 'valid' }, 'Valid'), createElement('option', { value: 'invalid' }, 'Invalid'))),
    createElement('label', null, 'Review state', createElement('select', {
      'aria-label': 'Review state', value: draft.reviewState, onChange: setReviewState,
    }, createElement('option', { value: 'completed' }, 'Completed'), createElement('option', { value: 'skipped' }, 'Skipped'))),
    plans.map((plan) => {
      const outcome = outcomeFor(draft, plan)
      return createElement('fieldset', { key: plan.id, className: 'grid gap-2' },
        createElement('legend', null, plan.titleSnapshot),
        createElement('label', null, 'Result', createElement('select', {
          'aria-label': `Result ${plan.titleSnapshot}`, value: outcome.result,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => commit(updateOutcome(draft, plan, {
            result: event.target.value as ReviewOutcome['result'],
            touched: event.target.value !== 'untouched',
          })),
        }, ['completed', 'progressed', 'stuck', 'untouched', 'cancelled'].map((value) => createElement('option', { key: value, value }, value)))),
        createElement('label', null, 'State command', createElement('select', {
          'aria-label': `State command ${plan.titleSnapshot}`, value: outcome.stateCommand,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => commit(updateOutcome(draft, plan, {
            stateCommand: event.target.value as ReviewOutcome['stateCommand'],
          })),
        }, ['none', 'complete', 'cancel'].map((value) => createElement('option', { key: value, value }, value)))),
        createElement('label', null,
          createElement('input', {
            type: 'checkbox', 'aria-label': `Completion draft ${plan.titleSnapshot}`,
            checked: outcome.stateCommand === 'complete',
            onChange: (event: ChangeEvent<HTMLInputElement>) => commit(updateOutcome(draft, plan, {
              stateCommand: event.target.checked ? 'complete' : 'none',
            })),
          }), 'Completion draft',
        ),
        createElement('label', null, 'Execution persona', createElement('select', {
          'aria-label': `Execution persona ${plan.titleSnapshot}`,
          value: outcome.executionPersona ?? '',
          onChange: (event: ChangeEvent<HTMLSelectElement>) => commit(updateOutcome(draft, plan, {
            executionPersona: event.target.value === '' ? null : event.target.value as ReviewOutcome['executionPersona'],
            personaSwitched: event.target.value === '' ? null : outcome.personaSwitched ?? false,
            personaNote: event.target.value === '' ? null : outcome.personaNote ?? null,
          })),
        }, createElement('option', { value: '' }, 'No persona'), ['ox', 'pig', 'hajimi', 'wukong'].map((value) => createElement('option', { key: value, value }, value)))),
        createElement('label', null,
          createElement('input', {
            type: 'checkbox', 'aria-label': `Persona switched ${plan.titleSnapshot}`,
            checked: outcome.personaSwitched ?? false,
            disabled: outcome.executionPersona === null,
            onChange: (event: ChangeEvent<HTMLInputElement>) => commit(updateOutcome(draft, plan, {
              personaSwitched: event.target.checked,
            })),
          }), 'Persona switched',
        ),
        createElement('label', null, 'Persona note', createElement('input', {
          'aria-label': `Persona note ${plan.titleSnapshot}`, value: outcome.personaNote ?? '', disabled: outcome.executionPersona === null,
          onChange: (event: ChangeEvent<HTMLInputElement>) => commit(updateOutcome(draft, plan, {
            personaNote: event.target.value === '' ? null : event.target.value,
          })),
        })),
      )
    }),
    createElement('button', { type: 'button', onClick: submit }, 'Submit review'),
    createElement(CommandReceiptList, { envelopes, receipts, onReconcile, onAbandon }),
  )
}
