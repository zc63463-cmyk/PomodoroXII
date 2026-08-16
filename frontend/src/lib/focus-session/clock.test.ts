import { describe, expect, it } from 'vitest'
import { deriveSessionClock } from './clock'

describe('deriveSessionClock', () => {
  it('reconstructs running time from timestamps and persisted pause total', () => {
    const clock = deriveSessionClock({
      startedAt: '2026-07-15T08:00:00Z',
      endedAt: null,
      pauseStartedAt: null,
      plannedSeconds: 1500,
      pausedSeconds: 120,
      focusedSeconds: 0,
      clockState: 'running',
    }, Date.parse('2026-07-15T08:12:00Z'))

    expect(clock).toEqual({ elapsedSeconds: 600, remainingSeconds: 900, overtimeSeconds: 0 })
  })

  it('freezes focused time while paused and uses terminal persisted facts after end', () => {
    const paused = deriveSessionClock({
      startedAt: '2026-07-15T08:00:00Z',
      endedAt: null,
      pauseStartedAt: '2026-07-15T08:10:00Z',
      plannedSeconds: 1500,
      pausedSeconds: 60,
      focusedSeconds: 0,
      clockState: 'paused',
    }, Date.parse('2026-07-15T08:20:00Z'))
    expect(paused.elapsedSeconds).toBe(540)

    const ended = deriveSessionClock({
      startedAt: '2026-07-15T08:00:00Z',
      endedAt: '2026-07-15T08:25:00Z',
      pauseStartedAt: null,
      plannedSeconds: 1500,
      pausedSeconds: 150,
      focusedSeconds: 1350,
      clockState: 'ended',
    }, Date.parse('2026-07-15T09:00:00Z'))
    expect(ended.elapsedSeconds).toBe(1350)
  })
})
