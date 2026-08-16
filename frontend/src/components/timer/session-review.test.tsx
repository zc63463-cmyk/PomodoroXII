import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { selectReviewSession, SessionReview } from './session-review'

describe('selectReviewSession', () => {
  it('keeps an older pending review discoverable when a newer session is completed', () => {
    const sessions = [
      { id: 'newer', clockState: 'ended', reviewState: 'completed', ownershipState: 'authoritative' },
      { id: 'older', clockState: 'ended', reviewState: 'pending', ownershipState: 'authoritative' },
    ] as const

    expect(selectReviewSession(sessions)?.id).toBe('older')
  })
})

describe('SessionReview', () => {
  it('keeps terminal focused time visible while sibling command results differ', () => {
    render(createElement(SessionReview, {
      session: {
        sessionId: 'fs-1', focusedSeconds: 1350, validity: 'pending',
        reviewState: 'pending', clockState: 'ended', ownershipState: 'authoritative',
      },
      plans: [{ id: 'plan-a', workItemId: 'wi-a', titleSnapshot: 'A', workItemVersionSnapshot: 2 }],
      outcomes: [],
      envelopes: [{ commandId: 'cmd-a', targetTransition: 'complete', replaySafe: true }],
      receipts: [
        { commandId: 'cmd-a', attempt: 1, state: 'succeeded' },
        { commandId: 'cmd-b', attempt: 1, state: 'failed' },
      ],
      draft: null, readOnly: true, onDraftChange: vi.fn(),
      onSubmit: vi.fn(), onReconcile: vi.fn(), onAbandon: vi.fn(),
    }))
    expect(screen.getByText('22:30 focused')).toBeVisible()
    expect(screen.getByText('Succeeded')).toBeVisible()
    expect(screen.getByText('Failed')).toBeVisible()
  })

  it('hydrates the durable draft and preserves each planned WorkItem version on submit', () => {
    const onSubmit = vi.fn()
    const onDraftChange = vi.fn()
    const draft = {
      operationId: 'review-op-1', spaceId: 'space-a', sessionId: 'fs-1', expectedVersion: 7,
      validity: 'invalid' as const, reviewState: 'completed' as const,
      reviewedAt: '2026-07-15T09:00:00Z', outcomes: [{
        workItemId: 'wi-a', touched: true, result: 'stuck' as const,
        stateCommand: 'cancel' as const, expectedWorkItemVersion: 42,
        executionPersona: 'ox' as const, personaSwitched: true, personaNote: 'blocked',
      }],
    }
    render(createElement(SessionReview, {
      session: {
        sessionId: 'fs-1', focusedSeconds: 1350, validity: 'pending',
        reviewState: 'pending', clockState: 'ended', ownershipState: 'authoritative',
      },
      plans: [{
        id: 'plan-a', workItemId: 'wi-a', titleSnapshot: 'A',
        workItemVersionSnapshot: 42, completionDraft: false,
      }],
      outcomes: [], envelopes: [], receipts: [], draft, onDraftChange,
      onSubmit, onReconcile: vi.fn(), onAbandon: vi.fn(),
    } as never))

    expect(screen.getByRole('combobox', { name: 'Review validity' })).toHaveValue('invalid')
    expect(screen.getByRole('combobox', { name: 'Result A' })).toHaveValue('stuck')
    expect(screen.getByRole('combobox', { name: 'State command A' })).toHaveValue('cancel')
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'review-op-1', expectedVersion: 7, validity: 'invalid',
      outcomes: [expect.objectContaining({
        workItemId: 'wi-a', expectedWorkItemVersion: 42, result: 'stuck', stateCommand: 'cancel',
      })],
    }))
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('updates the durable draft when a review field changes', () => {
    const onDraftChange = vi.fn()
    const draft = {
      operationId: 'review-op-2', spaceId: 'space-a', sessionId: 'fs-2', expectedVersion: 3,
      validity: 'valid' as const, reviewState: 'completed' as const,
      reviewedAt: '2026-07-15T09:00:00Z', outcomes: [{
        workItemId: 'wi-a', touched: true, result: 'progressed' as const,
        stateCommand: 'none' as const, expectedWorkItemVersion: 9,
      }],
    }
    render(createElement(SessionReview, {
      session: {
        sessionId: 'fs-2', focusedSeconds: 1, validity: 'pending',
        reviewState: 'pending', clockState: 'ended', ownershipState: 'authoritative',
      },
      plans: [{ id: 'plan-a', workItemId: 'wi-a', titleSnapshot: 'A', workItemVersionSnapshot: 9 }],
      outcomes: [], envelopes: [], receipts: [], draft, onDraftChange,
      onSubmit: vi.fn(), onReconcile: vi.fn(), onAbandon: vi.fn(),
    } as never))

    fireEvent.change(screen.getByRole('combobox', { name: 'Result A' }), { target: { value: 'completed' } })
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'review-op-2', outcomes: [expect.objectContaining({
        workItemId: 'wi-a', result: 'completed', expectedWorkItemVersion: 9,
      })],
    }))
  })

  it('does not render a writable review for an activation conflict', () => {
    render(createElement(SessionReview, {
      session: {
        sessionId: 'conflict-session', focusedSeconds: 1, validity: 'pending',
        reviewState: 'pending', clockState: 'ended', ownershipState: 'activation_conflict',
      },
      plans: [], outcomes: [], envelopes: [], receipts: [],
      draft: null, onDraftChange: vi.fn(), onSubmit: vi.fn(),
      onReconcile: vi.fn(), onAbandon: vi.fn(),
    } as never))

    expect(screen.getByText(/review is blocked while this session has an activation conflict/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Submit review' })).toBeNull()
  })
})
