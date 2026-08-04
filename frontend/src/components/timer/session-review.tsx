'use client'

import { createElement, useMemo, useState } from 'react'
import { CommandReceiptList, type CommandReceipt, type CommandReceiptEnvelope } from './command-receipt-list'

export interface SessionReviewPlan {
  id: string
  workItemId: string
  titleSnapshot: string
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
  }
  plans: SessionReviewPlan[]
  outcomes: Array<Record<string, unknown>>
  envelopes: CommandReceiptEnvelope[]
  receipts: CommandReceipt[]
  operationId?: string
  onSubmit: (draft: Record<string, unknown>) => void | Promise<void>
  onReconcile: (commandId: string, requestedReplaySafe: boolean) => void | Promise<void>
  onAbandon: (commandId: string) => void | Promise<void>
}

const formatFocused = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} focused`

export function SessionReview({ session, plans, outcomes: _outcomes, envelopes, receipts, operationId,
  onSubmit, onReconcile, onAbandon }: SessionReviewProps) {
  const [generatedOperationId] = useState(() => crypto.randomUUID())
  const [validity, setValidity] = useState<'valid' | 'invalid'>('valid')
  const [reviewState, setReviewState] = useState<'completed' | 'skipped'>('completed')
  const [results, setResults] = useState<Record<string, string>>(
    () => Object.fromEntries(plans.map((plan) => [plan.workItemId, 'progressed'])),
  )
  const [stateCommands, setStateCommands] = useState<Record<string, string>>(
    () => Object.fromEntries(plans.map((plan) => [plan.workItemId, plan.completionDraft ? 'complete' : 'none'])),
  )
  const [personas, setPersonas] = useState<Record<string, string>>(() => Object.fromEntries(plans.map((plan) => [plan.workItemId, ''])))
  const [personaNotes, setPersonaNotes] = useState<Record<string, string>>(() => Object.fromEntries(plans.map((plan) => [plan.workItemId, ''])))
  const [personaSwitched, setPersonaSwitched] = useState<Record<string, boolean>>(() => Object.fromEntries(plans.map((plan) => [plan.workItemId, false])))
  const [completionDrafts, setCompletionDrafts] = useState<Record<string, boolean>>(
    () => Object.fromEntries(plans.map((plan) => [plan.workItemId, plan.completionDraft ?? false])),
  )
  const focusedLabel = useMemo(() => formatFocused(session.focusedSeconds), [session.focusedSeconds])
  const submit = () => void onSubmit({
    operationId: operationId ?? generatedOperationId,
    spaceId: '', sessionId: session.sessionId ?? session.id ?? '', expectedVersion: 0,
    validity, reviewState, reviewedAt: new Date().toISOString(),
    outcomes: reviewState === 'skipped' ? [] : plans.map((plan) => ({
      workItemId: plan.workItemId, touched: results[plan.workItemId] !== 'untouched',
      result: results[plan.workItemId] ?? 'progressed', stateCommand: stateCommands[plan.workItemId] ?? 'none',
      expectedWorkItemVersion: 0,
      executionPersona: personas[plan.workItemId] || null,
      personaSwitched: personaSwitched[plan.workItemId] ?? false,
      personaNote: personaNotes[plan.workItemId] || null,
    })),
  })

  return createElement('section', { 'aria-label': 'Session review', className: 'grid gap-4' },
    createElement('h2', null, 'Session review'),
    createElement('p', null, focusedLabel),
    createElement('label', null, 'Validity', createElement('select', {
      'aria-label': 'Review validity', value: validity,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setValidity(event.target.value as 'valid' | 'invalid'),
    }, createElement('option', { value: 'valid' }, 'Valid'), createElement('option', { value: 'invalid' }, 'Invalid'))),
    createElement('label', null, 'Review state', createElement('select', {
      'aria-label': 'Review state', value: reviewState,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setReviewState(event.target.value as 'completed' | 'skipped'),
    }, createElement('option', { value: 'completed' }, 'Completed'), createElement('option', { value: 'skipped' }, 'Skipped'))),
    plans.map((plan) => createElement('fieldset', { key: plan.id, className: 'grid gap-2' },
      createElement('legend', null, plan.titleSnapshot),
      createElement('label', null, 'Result', createElement('select', {
        'aria-label': `Result ${plan.titleSnapshot}`, value: results[plan.workItemId] ?? 'progressed',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setResults((current) => ({ ...current, [plan.workItemId]: event.target.value })),
      }, ['completed', 'progressed', 'stuck', 'untouched', 'cancelled'].map((value) => createElement('option', { key: value, value }, value)))),
      createElement('label', null, 'State command', createElement('select', {
        'aria-label': `State command ${plan.titleSnapshot}`, value: stateCommands[plan.workItemId] ?? 'none',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setStateCommands((current) => ({ ...current, [plan.workItemId]: event.target.value })),
      }, ['none', 'complete', 'cancel'].map((value) => createElement('option', { key: value, value }, value)))),
      createElement('label', null,
        createElement('input', {
          type: 'checkbox', 'aria-label': `Completion draft ${plan.titleSnapshot}`,
          checked: completionDrafts[plan.workItemId] ?? false,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCompletionDrafts((current) => ({
            ...current, [plan.workItemId]: event.target.checked,
          })),
        }), 'Completion draft',
      ),
      createElement('label', null, 'Execution persona', createElement('select', {
        'aria-label': `Execution persona ${plan.titleSnapshot}`,
        value: personas[plan.workItemId] ?? '',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setPersonas((current) => ({ ...current, [plan.workItemId]: event.target.value })),
      }, createElement('option', { value: '' }, 'No persona'), ['ox', 'pig', 'hajimi', 'wukong'].map((value) => createElement('option', { key: value, value }, value)))),
      createElement('label', null,
        createElement('input', {
          type: 'checkbox', 'aria-label': `Persona switched ${plan.titleSnapshot}`,
          checked: personaSwitched[plan.workItemId] ?? false,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPersonaSwitched((current) => ({
            ...current, [plan.workItemId]: event.target.checked,
          })),
        }), 'Persona switched',
      ),
      createElement('label', null, 'Persona note', createElement('input', {
        'aria-label': `Persona note ${plan.titleSnapshot}`,
        value: personaNotes[plan.workItemId] ?? '',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPersonaNotes((current) => ({ ...current, [plan.workItemId]: event.target.value })),
      })),
    )),
    createElement('button', { type: 'button', onClick: submit }, 'Submit review'),
    createElement(CommandReceiptList, { envelopes, receipts, onReconcile, onAbandon }),
  )
}
