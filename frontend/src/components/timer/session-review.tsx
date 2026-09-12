'use client'

import { createElement, useMemo, type ChangeEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { CommandReceiptList, type CommandReceipt, type CommandReceiptEnvelope } from './command-receipt-list'
import { cn } from '@/lib/utils'
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
  /**
   * ★ 2026-09-11：复盘完成态（readOnly）的出口。复盘成功后用户此前被留在只读
   * 面板上，只能靠浏览器后退离开；由页面注入「选中本会话二级项 + 回任务页」。
   * 只在 readOnly 分支渲染，待复盘（可写）态没有回跳入口。
   */
  onReturnToTasks?: () => void
  onDraftChange: (draft: SessionReviewDraft) => void | Promise<void>
  onSubmit: (draft: SessionReviewDraft) => void | Promise<void>
  onReconcile: (commandId: string, requestedReplaySafe: boolean) => void | boolean | Promise<void | boolean>
  onAbandon: (commandId: string) => void | Promise<void>
}

export function isReviewableEndedSession(session: Pick<SessionReviewProps['session'], 'clockState' | 'reviewState' | 'ownershipState' | 'validity'>): boolean {
  if (session.clockState !== 'ended' || session.ownershipState === 'activation_conflict') return false
  if (session.reviewState === 'pending') return true
  // ★ 2026-09-11 修复：在线结束曾落下 review_state='not_required' 的历史行
  // （见 backend policy `_clock_transition_after` 的 end 补丁）。这类会话
  // 已结束且 validity 未定 —— 时间已保存但有效性没人判，若不可复盘，投入
  // 投影（只累计 validity='valid'）将永远为 0。有效性命中即视为待复盘。
  return session.reviewState === 'not_required' && session.validity === 'pending'
}

export function selectReviewSession<T extends Pick<SessionReviewProps['session'], 'clockState' | 'reviewState' | 'ownershipState' | 'validity'>>(
  sessions: readonly T[],
): T | undefined {
  return sessions.find((candidate) => isReviewableEndedSession(candidate)) ??
    sessions.find((candidate) => candidate.clockState === 'ended')
}

type ReviewOutcome = SessionReviewDraft['outcomes'][number]

const formatFocused = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} focused`

/** 原生 select 的统一外观，与 ui/input 的视觉语言一致。 */
const SELECT_CLASS = cn(
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm',
  'outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
  'disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30',
)

const CHECKBOX_CLASS = 'size-3.5 shrink-0 rounded border-input accent-primary'

const FIELD_LABEL_CLASS = 'grid gap-1.5'
const FIELD_CAPTION_CLASS = 'text-xs font-medium text-muted-foreground'

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

/** 复用同一张卡片外壳，保证三个分支（冲突 / 只读 / 可写）视觉一致。 */
function reviewCard(children: ReactNode, opts: { title?: string; description?: string } = {}) {
  return createElement(Card, {
    size: 'sm', 'aria-label': 'Session review',
    className: 'mx-auto w-full max-w-xl gap-3',
  },
    createElement(CardHeader, null,
      createElement(CardTitle, null, opts.title ?? 'Session review'),
      opts.description ? createElement(CardDescription, { className: 'font-mono tabular-nums' }, opts.description) : null,
    ),
    children,
  )
}

export function SessionReview({ session, plans, envelopes, receipts, draft, readOnly = false,
  onReturnToTasks, onDraftChange, onSubmit, onReconcile, onAbandon }: SessionReviewProps) {
  const focusedLabel = useMemo(() => formatFocused(session.focusedSeconds), [session.focusedSeconds])

  if (session.ownershipState === 'activation_conflict') {
    return reviewCard(createElement(CardContent, { className: 'grid gap-3' },
      createElement('p', {
        role: 'alert',
        className: 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
      }, 'Review is blocked while this Session has an activation conflict.'),
      createElement('p', { className: 'font-mono text-sm text-muted-foreground tabular-nums' }, focusedLabel),
    ))
  }

  if (readOnly) {
    return reviewCard([
      createElement(CardContent, { key: 'content', className: 'grid gap-3' },
        createElement('p', { className: 'text-sm text-muted-foreground' }, `Review ${session.reviewState}.`),
        createElement(CommandReceiptList, { envelopes, receipts, onReconcile, onAbandon }),
      ),
      // ★ 2026-09-11：复盘完成态此前没有出口（面板只读，只能靠浏览器后退）。
      // 这里补上「返回任务空间」——选中/回跳的具体动作由页面注入。
      onReturnToTasks
        ? createElement(CardFooter, { key: 'footer', className: 'flex-col items-stretch gap-3' },
          createElement(Button, {
            type: 'button', variant: 'outline', onClick: onReturnToTasks,
            className: 'self-stretch sm:self-end',
          }, '返回任务空间'),
        )
        : null,
    ], { description: focusedLabel })
  }

  if (!draft) {
    return reviewCard(createElement(CardContent, { className: 'grid gap-3' },
      createElement('p', { className: 'text-sm text-muted-foreground' }, 'Preparing review…'),
    ), { description: focusedLabel })
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

  return reviewCard(
    [
      createElement(CardContent, { key: 'fields', className: 'grid gap-4' },
        createElement('div', { className: 'grid gap-3 sm:grid-cols-2' },
          createElement('label', { className: FIELD_LABEL_CLASS },
            createElement('span', { className: FIELD_CAPTION_CLASS }, 'Validity'),
            createElement('select', {
              'aria-label': 'Review validity', className: SELECT_CLASS,
              value: draft.validity, onChange: setValidity,
            }, createElement('option', { value: 'valid' }, 'Valid'), createElement('option', { value: 'invalid' }, 'Invalid')),
          ),
          createElement('label', { className: FIELD_LABEL_CLASS },
            createElement('span', { className: FIELD_CAPTION_CLASS }, 'Review state'),
            createElement('select', {
              'aria-label': 'Review state', className: SELECT_CLASS,
              value: draft.reviewState, onChange: setReviewState,
            }, createElement('option', { value: 'completed' }, 'Completed'), createElement('option', { value: 'skipped' }, 'Skipped')),
          ),
        ),
        plans.map((plan) => {
          const outcome = outcomeFor(draft, plan)
          return createElement('fieldset', {
            key: plan.id,
            className: 'grid gap-3 rounded-lg border bg-muted/30 p-3',
          },
            createElement('legend', { className: 'px-1 text-xs font-medium text-muted-foreground' }, plan.titleSnapshot),
            createElement('div', { className: 'grid gap-3 sm:grid-cols-2' },
              createElement('label', { className: FIELD_LABEL_CLASS },
                createElement('span', { className: FIELD_CAPTION_CLASS }, 'Result'),
                createElement('select', {
                  'aria-label': `Result ${plan.titleSnapshot}`, className: SELECT_CLASS,
                  value: outcome.result,
                  onChange: (event: ChangeEvent<HTMLSelectElement>) => commit(updateOutcome(draft, plan, {
                    result: event.target.value as ReviewOutcome['result'],
                    touched: event.target.value !== 'untouched',
                  })),
                }, ['completed', 'progressed', 'stuck', 'untouched', 'cancelled'].map((value) => createElement('option', { key: value, value }, value))),
              ),
              createElement('label', { className: FIELD_LABEL_CLASS },
                createElement('span', { className: FIELD_CAPTION_CLASS }, 'State command'),
                createElement('select', {
                  'aria-label': `State command ${plan.titleSnapshot}`, className: SELECT_CLASS,
                  value: outcome.stateCommand,
                  onChange: (event: ChangeEvent<HTMLSelectElement>) => commit(updateOutcome(draft, plan, {
                    stateCommand: event.target.value as ReviewOutcome['stateCommand'],
                  })),
                }, ['none', 'complete', 'cancel'].map((value) => createElement('option', { key: value, value }, value))),
              ),
            ),
            createElement('div', { className: 'grid gap-2 sm:grid-cols-2' },
              createElement('label', { className: 'flex items-center gap-2 text-xs text-muted-foreground' },
                createElement('input', {
                  type: 'checkbox', className: CHECKBOX_CLASS,
                  'aria-label': `Completion draft ${plan.titleSnapshot}`,
                  checked: outcome.stateCommand === 'complete',
                  onChange: (event: ChangeEvent<HTMLInputElement>) => commit(updateOutcome(draft, plan, {
                    stateCommand: event.target.checked ? 'complete' : 'none',
                  })),
                }), 'Completion draft',
              ),
              createElement('label', { className: 'flex items-center gap-2 text-xs text-muted-foreground' },
                createElement('input', {
                  type: 'checkbox', className: CHECKBOX_CLASS,
                  'aria-label': `Persona switched ${plan.titleSnapshot}`,
                  checked: outcome.personaSwitched ?? false,
                  disabled: outcome.executionPersona === null,
                  onChange: (event: ChangeEvent<HTMLInputElement>) => commit(updateOutcome(draft, plan, {
                    personaSwitched: event.target.checked,
                  })),
                }), 'Persona switched',
              ),
            ),
            createElement('div', { className: 'grid gap-3 sm:grid-cols-2' },
              createElement('label', { className: FIELD_LABEL_CLASS },
                createElement('span', { className: FIELD_CAPTION_CLASS }, 'Execution persona'),
                createElement('select', {
                  'aria-label': `Execution persona ${plan.titleSnapshot}`, className: SELECT_CLASS,
                  value: outcome.executionPersona ?? '',
                  onChange: (event: ChangeEvent<HTMLSelectElement>) => commit(updateOutcome(draft, plan, {
                    executionPersona: event.target.value === '' ? null : event.target.value as ReviewOutcome['executionPersona'],
                    personaSwitched: event.target.value === '' ? null : outcome.personaSwitched ?? false,
                    personaNote: event.target.value === '' ? null : outcome.personaNote ?? null,
                  })),
                }, createElement('option', { value: '' }, 'No persona'), ['ox', 'pig', 'hajimi', 'wukong'].map((value) => createElement('option', { key: value, value }, value))),
              ),
              createElement('label', { className: FIELD_LABEL_CLASS },
                createElement('span', { className: FIELD_CAPTION_CLASS }, 'Persona note'),
                createElement('input', {
                  'aria-label': `Persona note ${plan.titleSnapshot}`,
                  className: cn(
                    'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm',
                    'outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                    'disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30',
                  ),
                  value: outcome.personaNote ?? '', disabled: outcome.executionPersona === null,
                  onChange: (event: ChangeEvent<HTMLInputElement>) => commit(updateOutcome(draft, plan, {
                    personaNote: event.target.value === '' ? null : event.target.value,
                  })),
                }),
              ),
            ),
          )
        }),
      ),
      createElement(CardFooter, { key: 'footer', className: 'flex-col items-stretch gap-3' },
        envelopes.length > 0 || receipts.length > 0
          ? createElement(CommandReceiptList, { envelopes, receipts, onReconcile, onAbandon })
          : null,
        createElement(Button, { type: 'button', onClick: submit, className: 'self-stretch sm:self-end' }, 'Submit review'),
      ),
    ],
    { description: focusedLabel },
  )
}
