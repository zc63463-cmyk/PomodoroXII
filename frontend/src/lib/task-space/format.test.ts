import { describe, expect, it } from 'vitest'

import {
  formatEffortEstimate,
  formatEffortSeconds,
  formatRelativeTime,
  formatTimestamp,
} from './format'

describe('formatTimestamp', () => {
  it('renders a stable Shanghai-local string regardless of machine timezone', () => {
    expect(formatTimestamp('2026-09-10T12:41:29.874Z')).toBe('2026-09-10 20:41')
  })

  it('returns null for missing or unparseable input', () => {
    expect(formatTimestamp(null)).toBeNull()
    expect(formatTimestamp('')).toBeNull()
    expect(formatTimestamp('not-a-date')).toBeNull()
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z')

  it('buckets the delta into coarse human units', () => {
    expect(formatRelativeTime('2026-09-10T11:59:30.000Z', now)).toBe('刚刚')
    expect(formatRelativeTime('2026-09-10T11:30:00.000Z', now)).toBe('30 分钟前')
    expect(formatRelativeTime('2026-09-10T09:00:00.000Z', now)).toBe('3 小时前')
    expect(formatRelativeTime('2026-09-08T12:00:00.000Z', now)).toBe('2 天前')
  })

  it('falls back to the absolute timestamp beyond a month', () => {
    expect(formatRelativeTime('2026-07-01T12:00:00.000Z', now)).toBe('2026-07-01 20:00')
  })
})

describe('formatEffortSeconds', () => {
  it('renders human-readable durations', () => {
    expect(formatEffortSeconds(0)).toBe('0 秒')
    expect(formatEffortSeconds(90)).toBe('1 分钟 30 秒')
    expect(formatEffortSeconds(3600)).toBe('1 小时')
    expect(formatEffortSeconds(3660)).toBe('1 小时 1 分钟')
    expect(formatEffortSeconds(7320)).toBe('2 小时 2 分钟')
  })

  it('degrades gracefully for missing or invalid input', () => {
    expect(formatEffortSeconds(null)).toBe('—')
    expect(formatEffortSeconds(Number.NaN)).toBe('—')
    expect(formatEffortSeconds(-5)).toBe('0 秒')
  })
})

describe('formatEffortEstimate', () => {
  it('renders a range when both bounds exist', () => {
    expect(formatEffortEstimate(3600, 7200)).toBe('1 小时 – 2 小时')
  })

  it('renders a single bound and null when both are missing', () => {
    expect(formatEffortEstimate(null, 1800)).toBe('30 分钟')
    expect(formatEffortEstimate(null, null)).toBeNull()
  })
})
