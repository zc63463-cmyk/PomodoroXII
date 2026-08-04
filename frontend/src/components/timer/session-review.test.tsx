import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionReview } from './session-review'

describe('SessionReview', () => {
  it('keeps terminal focused time visible while sibling command results differ', () => {
    render(createElement(SessionReview, {
      session: {
        sessionId: 'fs-1', focusedSeconds: 1350, validity: 'pending',
        reviewState: 'pending', clockState: 'ended',
      },
      plans: [{ id: 'plan-a', workItemId: 'wi-a', titleSnapshot: 'A' }],
      outcomes: [],
      envelopes: [{ commandId: 'cmd-a', targetTransition: 'complete', replaySafe: true }],
      receipts: [
        { commandId: 'cmd-a', attempt: 1, state: 'succeeded' },
        { commandId: 'cmd-b', attempt: 1, state: 'failed' },
      ],
      onSubmit: vi.fn(), onReconcile: vi.fn(), onAbandon: vi.fn(),
    }))
    expect(screen.getByText('22:30 focused')).toBeVisible()
    expect(screen.getByText('Succeeded')).toBeVisible()
    expect(screen.getByText('Failed')).toBeVisible()
  })
})
