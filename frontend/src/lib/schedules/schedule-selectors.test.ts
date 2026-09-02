import { describe, expect, it } from 'vitest'
import {
  completionRate,
  dateKeyOfISO,
  groupSchedulesByDate,
  isOverdue,
  sortByPriority,
  splitByStatus,
  timeRangesOverlap,
} from './schedule-selectors'
import type { Schedule } from '@/types'

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 's1',
    title: '会议',
    due_at: '2026-09-10T10:00:00.000Z',
    completed_at: null,
    priority: 'medium',
    color: '#3b82f6',
    all_day: false,
    start_time: null,
    end_time: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('dateKeyOfISO', () => {
  it('用本地日期，不用 UTC', () => {
    // 本地 23:30，UTC 已是次日 —— 用 toISOString().slice(0,10) 会偏一天
    const local = new Date(2026, 8, 2, 23, 30)
    expect(dateKeyOfISO(local.toISOString())).toBe('2026-09-02')
  })
})

describe('groupSchedulesByDate', () => {
  it('按日期分组，日期升序', () => {
    const groups = groupSchedulesByDate([
      schedule({ id: 'b', due_at: '2026-09-20T10:00:00.000Z' }),
      schedule({ id: 'a', due_at: '2026-09-01T10:00:00.000Z' }),
      schedule({ id: 'c', due_at: '2026-09-01T15:00:00.000Z' }),
    ])

    expect(groups.map((g) => g.date)).toEqual(['2026-09-01', '2026-09-20'])
    expect(groups[0].schedules.map((s) => s.id)).toEqual(['a', 'c'])
  })

  it('同一天按开始时间升序，无开始时间的排最前', () => {
    const groups = groupSchedulesByDate([
      schedule({ id: 'late', due_at: '2026-09-01T10:00:00.000Z', start_time: '14:00' }),
      schedule({ id: 'none', due_at: '2026-09-01T10:00:00.000Z', start_time: null }),
      schedule({ id: 'early', due_at: '2026-09-01T10:00:00.000Z', start_time: '09:00' }),
    ])

    expect(groups[0].schedules.map((s) => s.id)).toEqual(['none', 'early', 'late'])
  })
})

describe('isOverdue', () => {
  it('未完成的截止已过 → 逾期', () => {
    expect(
      isOverdue(schedule({ due_at: '2026-09-01T10:00:00.000Z' }), '2026-09-05T10:00:00.000Z'),
    ).toBe(true)
  })

  it('已完成的即使截止已过也不算逾期', () => {
    expect(
      isOverdue(
        schedule({
          due_at: '2026-09-01T10:00:00.000Z',
          completed_at: '2026-09-01T09:00:00.000Z',
        }),
        '2026-09-05T10:00:00.000Z',
      ),
    ).toBe(false)
  })

  it('未完成但截止未到 → 不逾期', () => {
    expect(
      isOverdue(schedule({ due_at: '2026-09-10T10:00:00.000Z' }), '2026-09-05T10:00:00.000Z'),
    ).toBe(false)
  })
})

describe('splitByStatus', () => {
  it('分三组：已完成 / 待办 / 逾期', () => {
    const now = '2026-09-05T10:00:00.000Z'
    const result = splitByStatus(
      [
        schedule({ id: 'done', completed_at: '2026-09-01T10:00:00.000Z' }),
        schedule({ id: 'future', due_at: '2026-09-20T10:00:00.000Z' }),
        schedule({ id: 'late', due_at: '2026-09-01T10:00:00.000Z' }),
      ],
      now,
    )

    expect(result.completed.map((s) => s.id)).toEqual(['done'])
    expect(result.pending.map((s) => s.id)).toEqual(['future'])
    expect(result.overdue.map((s) => s.id)).toEqual(['late'])
  })
})

describe('completionRate', () => {
  it('正常计算', () => {
    const rate = completionRate([
      schedule({ id: 'a', completed_at: '2026-09-01T10:00:00.000Z' }),
      schedule({ id: 'b' }),
      schedule({ id: 'c' }),
      schedule({ id: 'd' }),
    ])
    expect(rate).toBe(0.25)
  })

  it('★ 空列表返回 0 而不是 NaN', () => {
    expect(completionRate([])).toBe(0)
  })
})

describe('timeRangesOverlap', () => {
  it('完全重叠 → true', () => {
    expect(timeRangesOverlap('09:00', '11:00', '10:00', '12:00')).toBe(true)
  })

  it('★ 首尾相接不算重叠（半开区间）', () => {
    expect(timeRangesOverlap('09:00', '10:00', '10:00', '11:00')).toBe(false)
  })

  it('完全分离 → false', () => {
    expect(timeRangesOverlap('09:00', '10:00', '14:00', '15:00')).toBe(false)
  })

  it('任一端缺失 → false（无法判定）', () => {
    expect(timeRangesOverlap(null, '10:00', '09:00', '11:00')).toBe(false)
    expect(timeRangesOverlap('09:00', null, '09:00', '11:00')).toBe(false)
  })

  it('ISO datetime 也能正确取时间部分', () => {
    expect(
      timeRangesOverlap(
        '2026-09-01T09:00:00Z',
        '2026-09-01T11:00:00Z',
        '2026-09-01T10:00:00Z',
        '2026-09-01T12:00:00Z',
      ),
    ).toBe(true)
  })
})

describe('sortByPriority', () => {
  it('high 优先，同优先级按截止时间升序', () => {
    const sorted = sortByPriority([
      schedule({ id: 'low', priority: 'low', due_at: '2026-09-01T10:00:00.000Z' }),
      schedule({ id: 'high2', priority: 'high', due_at: '2026-09-20T10:00:00.000Z' }),
      schedule({ id: 'high1', priority: 'high', due_at: '2026-09-02T10:00:00.000Z' }),
      schedule({ id: 'mid', priority: 'medium', due_at: '2026-09-01T10:00:00.000Z' }),
    ])

    expect(sorted.map((s) => s.id)).toEqual(['high1', 'high2', 'mid', 'low'])
  })
})
