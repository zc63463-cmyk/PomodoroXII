import { describe, expect, it } from 'vitest'
import { bucketDueDates, dueDateKeyOf, localTodayKey } from './due-date-selectors'
import type { CachedWorkItem } from '@/types'

const item = (overrides: Partial<CachedWorkItem>): CachedWorkItem => ({
  id: 'w1', projectId: 'p1', displayKey: 'RM-1', title: 'Item',
  description: null, typeDefinitionId: 't1', statusDefinitionId: 'st1',
  priority: null, parentId: null, childRank: 0, depth: 1,
  completionWindowStart: null, completionWindowEnd: null, reviewPoint: null,
  hardDeadline: null, dueAt: null, effortEstimateLowerSeconds: null,
  effortEstimateUpperSeconds: null, effortActualSeconds: 0, confidence: null,
  completedAt: null, cancelledAt: null, archivedAt: null,
  markedAsAttention: false, labelIds: [], version: 1,
  createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z',
  ...overrides,
})

const openCategory = () => 'not_started'

describe('dueDateKeyOf', () => {
  it('把纯日期键原样返回', () => {
    expect(dueDateKeyOf('2026-10-05')).toBe('2026-10-05')
  })

  it('ISO 日期时间按本地时区取键 —— UTC 23:30 不得跨日（本仓三次踩坑）', () => {
    // 2026-10-03T23:30:00+08:00 的**本地**日期是 10-03（UTC 日期是 10-03，
    // 但若实现错误地先转 UTC 再取日期，2026-10-03T15:30:00Z 这类输入就会漂移）。
    expect(dueDateKeyOf('2026-10-03T23:30:00+08:00')).toBe('2026-10-03')
    expect(dueDateKeyOf('2026-10-03T23:30:00-05:00')).toBe('2026-10-04')
  })

  it('坏值返回 null（不入桶，绝不让整页崩掉）', () => {
    expect(dueDateKeyOf('not-a-date')).toBeNull()
  })
})

describe('localTodayKey', () => {
  it('从时刻取本地日期键，而不是 UTC 日期键', () => {
    // 2026-10-03T20:00:00-05:00 = 2026-10-04T01:00Z；本机时区下取本地键。
    const instant = new Date('2026-10-03T20:00:00-05:00')
    const expected = new Intl.DateTimeFormat('sv-SE', {
      timeZone: undefined,
    }).format(instant)
    expect(localTodayKey(instant)).toBe(expected)
  })
})

describe('bucketDueDates', () => {
  it('due_at 为今天 → today 桶', () => {
    const buckets = bucketDueDates(
      [item({ dueAt: '2026-10-05' })],
      '2026-10-05',
      openCategory,
    )
    expect(buckets.today).toHaveLength(1)
    expect(buckets.overdue).toHaveLength(0)
  })

  it('due_at 为昨天 → overdue 桶（高亮的依据）', () => {
    const buckets = bucketDueDates(
      [item({ dueAt: '2026-10-04' })],
      '2026-10-05',
      openCategory,
    )
    expect(buckets.overdue).toHaveLength(1)
    expect(buckets.today).toHaveLength(0)
  })

  it('未来到期两个桶都不进（本面板口径只有今日/逾期）', () => {
    const buckets = bucketDueDates(
      [item({ dueAt: '2026-10-06' })],
      '2026-10-05',
      openCategory,
    )
    expect(buckets.today).toHaveLength(0)
    expect(buckets.overdue).toHaveLength(0)
  })

  it('归档/无 due_at 的行不入桶；终态由 category 判定（不是时间戳）', () => {
    const buckets = bucketDueDates(
      [
        item({ dueAt: '2026-10-04', archivedAt: '2026-10-04T00:00:00Z' }),
        item({ dueAt: null }),
        item({ dueAt: undefined }),
        // completedAt 时间戳存在、但类目仍是开放类目 → 仍入桶：
        // 类目（Space 定义派生）是唯一权威，时间戳只是它的投影。
        item({ id: 'stale-ts', dueAt: '2026-10-04', completedAt: '2026-10-04T00:00:00Z' }),
      ],
      '2026-10-05',
      openCategory,
    )
    expect(buckets.overdue.map((row) => row.id)).toEqual(['stale-ts'])
    expect(buckets.today).toHaveLength(0)
  })

  it('终态 category（completed/cancelled）不入桶 —— 按 Space 定义派生', () => {
    const buckets = bucketDueDates(
      [
        item({ id: 'done', dueAt: '2026-10-04' }),
        item({ id: 'cancelled', dueAt: '2026-10-04' }),
      ],
      '2026-10-05',
      (candidate) => (candidate.id === 'done' ? 'completed' : 'cancelled'),
    )
    expect(buckets.overdue).toHaveLength(0)
  })

  it('桶内按 due key 再 displayKey 排序，保持输出稳定', () => {
    const buckets = bucketDueDates(
      [
        item({ id: 'b', displayKey: 'RM-2', dueAt: '2026-10-04' }),
        item({ id: 'a', displayKey: 'RM-1', dueAt: '2026-10-05' }),
        item({ id: 'c', displayKey: 'RM-0', dueAt: '2026-10-04' }),
      ],
      '2026-10-05',
      openCategory,
    )
    expect(buckets.overdue.map((row) => row.displayKey)).toEqual(['RM-0', 'RM-2'])
    expect(buckets.today.map((row) => row.displayKey)).toEqual(['RM-1'])
  })
})
