import { describe, expect, it } from 'vitest'
import {
  computeStreak,
  countCompletedDays,
  countOnDate,
  isCompletedOn,
  isRestDay,
  lastNDateKeys,
  shiftDateKey,
  todayProgress,
  toDateKey,
  weekdayOf,
} from './habit-selectors'
import type { Habit, HabitCheckIn } from '@/types'

function habit(overrides: Partial<Habit> = {}): Habit {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'h1',
    title: '读书',
    description: '',
    color: '#3b82f6',
    icon: '',
    target_count: 1,
    rest_day_protection: false,
    rest_days: [],
    sort_order: 0,
    archived: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

/** 在给定日期各打一次卡。 */
function checkInsOn(habitId: string, dates: string[]): HabitCheckIn[] {
  const now = '2026-09-02T00:00:00.000Z'
  return dates.map((date, i) => ({
    id: `c${i}`,
    habit_id: habitId,
    date,
    count: 1,
    note: '',
    created_at: now,
    updated_at: now,
  }))
}

describe('日期工具', () => {
  it('toDateKey 用本地时区，不用 UTC', () => {
    // 本地时间 23:30，UTC 会是次日 —— 用 toISOString 就偏一天
    expect(toDateKey(new Date(2026, 8, 2, 23, 30))).toBe('2026-09-02')
  })

  it('shiftDateKey 跨月正确', () => {
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('weekdayOf：0=周日', () => {
    // 2026-09-06 是周日
    expect(weekdayOf('2026-09-06')).toBe(0)
    expect(weekdayOf('2026-09-02')).toBe(3) // 周三
  })

  it('lastNDateKeys 含今天且升序', () => {
    expect(lastNDateKeys(3, '2026-03-01')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ])
  })
})

describe('打卡计数', () => {
  it('同一天多次打卡累加 count', () => {
    const list: HabitCheckIn[] = [
      ...checkInsOn('h1', ['2026-09-02']),
      { ...checkInsOn('h1', ['2026-09-02'])[0], id: 'c2', count: 2 },
    ]
    expect(countOnDate(list, 'h1', '2026-09-02')).toBe(3)
  })

  it('按 habit_id 与 date 隔离', () => {
    const list = [
      ...checkInsOn('h1', ['2026-09-02']),
      ...checkInsOn('h2', ['2026-09-02']),
    ]
    expect(countOnDate(list, 'h1', '2026-09-02')).toBe(1)
    expect(countOnDate(list, 'h1', '2026-09-01')).toBe(0)
  })

  it('isCompletedOn 按 target_count 判定', () => {
    const h = habit({ target_count: 3 })
    const list = [{ ...checkInsOn('h1', ['2026-09-02'])[0], count: 2 }]
    expect(isCompletedOn(h, list, '2026-09-02')).toBe(false)

    const done = [{ ...checkInsOn('h1', ['2026-09-02'])[0], count: 3 }]
    expect(isCompletedOn(h, done, '2026-09-02')).toBe(true)
  })
})

describe('computeStreak', () => {
  it('连续三天打卡 → 3', () => {
    const h = habit()
    const list = checkInsOn('h1', ['2026-08-31', '2026-09-01', '2026-09-02'])
    expect(computeStreak(h, list, '2026-09-02')).toBe(3)
  })

  it('★ 今天还没打卡不算断链', () => {
    const h = habit()
    // 昨天与前天打了，今天还没打
    const list = checkInsOn('h1', ['2026-08-31', '2026-09-01'])
    expect(computeStreak(h, list, '2026-09-02')).toBe(2)
  })

  it('中断一天则归零', () => {
    const h = habit()
    // 9/2 与 8/31 打了，9/1 没打
    const list = checkInsOn('h1', ['2026-08-31', '2026-09-02'])
    expect(computeStreak(h, list, '2026-09-02')).toBe(1)
  })

  it('★ 休息日跳过而非中断（需开启 rest_day_protection）', () => {
    // 2026-09-06 是周日
    const h = habit({ rest_day_protection: true, rest_days: [0] })
    const list = checkInsOn('h1', ['2026-09-04', '2026-09-05', '2026-09-07'])
    // 今天 9/7 达标 → 1；9/6 周日休息跳过；9/5 → 2；9/4 → 3
    expect(computeStreak(h, list, '2026-09-07')).toBe(3)
  })

  it('未开启保护时，休息日照样中断', () => {
    const h = habit({ rest_day_protection: false, rest_days: [0] })
    const list = checkInsOn('h1', ['2026-09-04', '2026-09-05', '2026-09-07'])
    expect(computeStreak(h, list, '2026-09-07')).toBe(1)
  })

  it('★ 休息日只在末尾跳过，不会无限回退', () => {
    // 全部都是休息日，且从未打卡 —— 必须能停下来
    const h = habit({ rest_day_protection: true, rest_days: [0, 1, 2, 3, 4, 5, 6] })
    expect(computeStreak(h, [], '2026-09-07')).toBe(0)
  })

  it('无任何打卡记录 → 0', () => {
    expect(computeStreak(habit(), [], '2026-09-02')).toBe(0)
  })

  it('只差一次未达标也算断（target_count=3 但只打了 2）', () => {
    const h = habit({ target_count: 3 })
    const list = [{ ...checkInsOn('h1', ['2026-09-01'])[0], count: 2 }]
    expect(computeStreak(h, list, '2026-09-02')).toBe(0)
  })
})

describe('统计与进度', () => {
  it('countCompletedDays 去重同一天', () => {
    const h = habit()
    const list = [
      ...checkInsOn('h1', ['2026-09-01']),
      { ...checkInsOn('h1', ['2026-09-01'])[0], id: 'cx', count: 2 },
      ...checkInsOn('h1', ['2026-09-02']),
    ]
    expect(countCompletedDays(h, list)).toBe(2)
  })

  it('todayProgress 反映今日进度', () => {
    const h = habit({ target_count: 3 })
    const list = [{ ...checkInsOn('h1', ['2026-09-02'])[0], count: 1 }]

    expect(todayProgress(h, list, '2026-09-02')).toEqual({
      done: 1,
      target: 3,
      completed: false,
    })
  })

  it('isRestDay 按 rest_days 判定', () => {
    const h = habit({ rest_days: [0, 6] })
    expect(isRestDay(h, '2026-09-06')).toBe(true) // 周日
    expect(isRestDay(h, '2026-09-02')).toBe(false) // 周三
  })
})
