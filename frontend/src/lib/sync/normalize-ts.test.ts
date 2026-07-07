import { describe, it, expect } from 'vitest'
import { normalizeTs } from './normalize-ts'

describe('normalizeTs', () => {
  it('NT1: 空串/null/undefined → 空串', () => {
    expect(normalizeTs('')).toBe('')
    expect(normalizeTs(null)).toBe('')
    expect(normalizeTs(undefined)).toBe('')
  })

  it('NT2: 合法毫秒 ISO 原样返回', () => {
    expect(normalizeTs('2026-07-06T12:00:00.123Z')).toBe('2026-07-06T12:00:00.123Z')
  })

  it('NT3: 非法字符串 → 空串', () => {
    expect(normalizeTs('not-a-date')).toBe('')
  })

  it('NT4: 等价输入归一且时间序可比较', () => {
    expect(normalizeTs('2026-01-01')).toBe(normalizeTs('2026-01-01T00:00:00.000Z'))
    expect(
      normalizeTs('2026-07-06T12:00:00.000Z') > normalizeTs('2026-01-01T00:00:00.000Z'),
    ).toBe(true)
  })
})
