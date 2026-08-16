import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionClock } from './session-clock'

const running = {
  sessionId: 'session-a', startedAt: '2026-07-15T08:00:00Z', endedAt: null,
  pauseStartedAt: null, plannedSeconds: 1500, pausedSeconds: 0,
  focusedSeconds: 0, clockState: 'running',
} as never

describe('SessionClock', () => {
  it('persists terminal clock facts even when Note flush rejects', async () => {
    const flushNote = vi.fn().mockRejectedValue(new Error('note conflict'))
    const end = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionClock, { session: running, nowMs: Date.parse('2026-07-15T08:10:00Z'),
      owner: true, onFlushNote: flushNote, onEnd: end }))

    fireEvent.click(screen.getByRole('button', { name: 'End session' }))

    await screen.findByText('Session ended; note needs attention')
    expect(end).toHaveBeenCalledOnce()
  })

  it('disables ownership controls in a read-only tab', () => {
    render(createElement(SessionClock, { session: running, nowMs: Date.parse('2026-07-15T08:10:00Z'),
      owner: false, onPause: vi.fn(), onResume: vi.fn(), onEnd: vi.fn() }))

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'End session' })).toBeDisabled()
    expect(screen.getByText('Read-only in this Tab')).toBeInTheDocument()
  })
})
