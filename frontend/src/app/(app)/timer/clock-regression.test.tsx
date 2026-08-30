import { createElement, useMemo, useState } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveSessionClock } from '@/lib/focus-session/clock'
import { useTimerStore } from '@/stores/timer-store'

/**
 * Wave 2C Task B regression guard.
 *
 * The timer page previously subscribed with
 * `useTimerStore((state) => selectDerivedClock(state))`.  Once a session
 * existed the selector returned a FRESH object on every call, so
 * useSyncExternalStore treated every read as a changed snapshot →
 * "The result of getSnapshot should be cached to avoid an infinite loop" →
 * React "Maximum update depth exceeded" on Start (reproduced in a real
 * browser in Wave 2B).  The fix subscribes to the primitive inputs
 * (`session` reference + `nowMs`) and memoizes the derivation.
 *
 * ClockProbe mirrors exactly that fixed pattern.
 */
function ClockProbe({ onClock }: { onClock: (clock: unknown) => void }): React.ReactNode {
  const session = useTimerStore((s) => s.session)
  const nowMs = useTimerStore((s) => s.nowMs)
  const clock = useMemo(
    () => (session ? deriveSessionClock(session, nowMs) : null),
    [session, nowMs],
  )
  onClock(clock)
  return createElement('output', { 'data-testid': 'probe' }, clock ? String(clock.elapsedSeconds) : 'none')
}

const running = {
  sessionId: 'session-a',
  startedAt: '2026-07-15T08:00:00Z',
  endedAt: null,
  pauseStartedAt: null,
  plannedSeconds: 1500,
  pausedSeconds: 0,
  focusedSeconds: 0,
  clockState: 'running',
} as never

describe('timer page derived clock (Wave 2C regression)', () => {
  beforeEach(() => {
    useTimerStore.getState().reset()
  })

  it('ticking setNow does not loop infinitely and the clock advances', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      useTimerStore.setState({ session: running, nowMs: Date.parse('2026-07-15T08:00:00Z') })
      const seen: unknown[] = []
      render(createElement(ClockProbe, { onClock: (clock) => seen.push(clock) }))
      expect(seen.at(-1)).not.toBeNull()

      const first = seen.at(-1) as { elapsedSeconds: number }
      // Simulate the 250ms repaint ticker a few times.
      act(() => useTimerStore.getState().setNow(Date.parse('2026-07-15T08:00:05Z')))
      act(() => useTimerStore.getState().setNow(Date.parse('2026-07-15T08:00:06Z')))
      act(() => useTimerStore.getState().setNow(Date.parse('2026-07-15T08:00:07Z')))
      const last = seen.at(-1) as { elapsedSeconds: number }

      expect(last.elapsedSeconds).toBeGreaterThan(first.elapsedSeconds)
      // The old unstable-selector pattern would log this and then crash with
      // "Maximum update depth exceeded"; neither may appear after the fix.
      const logs = errorSpy.mock.calls.flat().join('\n')
      expect(logs).not.toMatch(/getSnapshot should be cached|Maximum update depth exceeded/)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('the derived clock reference is stable when inputs are unchanged', () => {
    useTimerStore.setState({ session: running, nowMs: 100 })
    const seen: unknown[] = []
    function Harness(): React.ReactNode {
      const [, setTick] = useState(0)
      return createElement(
        'div',
        null,
        createElement('button', { 'data-bump': true, onClick: () => setTick((value) => value + 1) }, 'bump'),
        createElement(ClockProbe, { onClock: (clock) => seen.push(clock) }),
      )
    }
    render(createElement(Harness))
    expect(seen.at(-1)).not.toBeNull()
    const before = seen.at(-1)
    // Force a re-render with identical store inputs: the memoized clock
    // object must be reused (reference-stable), which is what prevents the
    // useSyncExternalStore infinite-update loop.
    act(() => {
      const button = document.querySelector('[data-bump]') as HTMLElement
      button.click()
    })
    const after = seen.at(-1)
    expect(after).toBe(before)
  })

  it('Start makes the clock visible (non-null derived clock)', () => {
    useTimerStore.setState({ session: running, nowMs: Date.parse('2026-07-15T08:00:00Z') })
    const seen: unknown[] = []
    render(createElement(ClockProbe, { onClock: (clock) => seen.push(clock) }))
    const clock = seen.at(-1)
    expect(clock).not.toBeNull()
    expect((clock as { elapsedSeconds: number }).elapsedSeconds).toBe(0)
  })
})
