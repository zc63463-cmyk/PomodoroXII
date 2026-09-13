import { describe, expect, it } from 'vitest'
import { deriveRingProgress, deriveSessionClock } from './clock'

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

describe('deriveRingProgress（工单 B 计时环进度）', () => {
  const startedAt = '2026-07-15T08:00:00Z'
  const base = {
    startedAt,
    endedAt: null,
    pauseStartedAt: null,
    plannedSeconds: 1500,
    pausedSeconds: 0,
    focusedSeconds: 0,
    clockState: 'running' as const,
  }
  /** 相对 startedAt 的第 n 秒（避免手算 ISO 串）。 */
  const at = (secondsFromStart: number) => Date.parse(startedAt) + secondsFromStart * 1000

  it('0：刚起步 —— fraction 0、未超时', () => {
    expect(deriveRingProgress(base, at(0))).toEqual({ fraction: 0, overtime: false })
  })

  it('半程：750/1500 = 0.5', () => {
    expect(deriveRingProgress(base, at(750))).toEqual({ fraction: 0.5, overtime: false })
  })

  it('满程：1500/1500 = 1（此时尚未 overtime —— 越过才算）', () => {
    expect(deriveRingProgress(base, at(1500))).toEqual({ fraction: 1, overtime: false })
  })

  it('★ overtime：fraction 饱和在 1（1800/1500 = 1.2 不越环）、overtime=true', () => {
    expect(deriveRingProgress(base, at(1800))).toEqual({ fraction: 1, overtime: true })
  })

  it('planned=0：防除零 —— fraction 恒 0、不产生 NaN', () => {
    const degenerate = { ...base, plannedSeconds: 0 }
    expect(deriveRingProgress(degenerate, at(0))).toEqual({ fraction: 0, overtime: false })
    // 越过 0 计划点的退化语义按字面（elapsed > planned），同样不能是 NaN
    expect(deriveRingProgress(degenerate, at(10))).toEqual({ fraction: 0, overtime: true })
  })
})
