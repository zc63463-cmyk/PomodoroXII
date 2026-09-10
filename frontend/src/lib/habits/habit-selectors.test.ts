import { describe, expect, it } from 'vitest'
import {
  computeStreak,
  countCompletedDays,
  countOnDate,
  isCompletedOn,
  isRestDay,
  lastNDateKeys,
  longestStreak,
  shiftDateKey,
  todayProgress,
  toDateKey,
  toDateKeyWithBoundary,
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

describe('longestStreak', () => {
  it('无任何打卡记录 → 0', () => {
    expect(longestStreak(habit(), [], '2026-09-02')).toBe(0)
  })

  it('单段连续三天 → 3', () => {
    const h = habit()
    const list = checkInsOn('h1', ['2026-08-31', '2026-09-01', '2026-09-02'])
    expect(longestStreak(h, list, '2026-09-02')).toBe(3)
  })

  it('★ 取最长的一段，而不是当前这一段', () => {
    const h = habit()
    // 8/20–8/21 连 2 天，中断，8/25–8/28 连 4 天，再中断，今天 9/2 单独 1 天
    const list = checkInsOn('h1', [
      '2026-08-20',
      '2026-08-21',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-09-02',
    ])
    expect(longestStreak(h, list, '2026-09-02')).toBe(4)
    // 对照：当前连续只有今天这一天
    expect(computeStreak(h, list, '2026-09-02')).toBe(1)
  })

  it('★ 当前连续已断，历史最长仍然保留', () => {
    const h = habit()
    // 8/30–9/1 连 3 天，9/2（今天）没打
    const list = checkInsOn('h1', ['2026-08-30', '2026-08-31', '2026-09-01'])
    expect(computeStreak(h, list, '2026-09-02')).toBe(3) // 今天未打卡不算断
    expect(longestStreak(h, list, '2026-09-02')).toBe(3)
    // 再空一天后：当前连续归零，但历史最长不变
    expect(computeStreak(h, list, '2026-09-04')).toBe(0)
    expect(longestStreak(h, list, '2026-09-04')).toBe(3)
  })

  it('★ 休息日跳过而非中断（需开启 rest_day_protection）', () => {
    // 2026-09-06 是周日
    const h = habit({ rest_day_protection: true, rest_days: [0] })
    const list = checkInsOn('h1', ['2026-09-04', '2026-09-05', '2026-09-07'])
    expect(longestStreak(h, list, '2026-09-07')).toBe(3)
  })

  it('未开启保护时，休息日照样中断', () => {
    const h = habit({ rest_day_protection: false, rest_days: [0] })
    const list = checkInsOn('h1', ['2026-09-04', '2026-09-05', '2026-09-07'])
    expect(longestStreak(h, list, '2026-09-07')).toBe(2)
  })

  it('★ 未来日期的记录不计入（上界是 today）', () => {
    const h = habit()
    const list = checkInsOn('h1', ['2026-09-10', '2026-09-11', '2026-09-12'])
    expect(longestStreak(h, list, '2026-09-02')).toBe(0)
  })

  it('target_count 未达标算断，达标才算数', () => {
    const h = habit({ target_count: 3 })
    const list = [
      { ...checkInsOn('h1', ['2026-08-31'])[0], count: 3 },
      { ...checkInsOn('h1', ['2026-09-01'])[0], id: 'cx', count: 2 },
      { ...checkInsOn('h1', ['2026-09-02'])[0], id: 'cy', count: 3 },
    ]
    // 9/1 只打了 2 次未达标 → 两段各 1 天
    expect(longestStreak(h, list, '2026-09-02')).toBe(1)
  })

  it('同一天多次打卡会累加，达标即计入', () => {
    const h = habit({ target_count: 3 })
    const list = [
      { ...checkInsOn('h1', ['2026-09-01'])[0], count: 1 },
      { ...checkInsOn('h1', ['2026-09-01'])[0], id: 'cx', count: 2 },
      { ...checkInsOn('h1', ['2026-09-02'])[0], id: 'cy', count: 3 },
    ]
    expect(longestStreak(h, list, '2026-09-02')).toBe(2)
  })

  it('★ 全是休息日且从未打卡 → 能停下来（上限保护）', () => {
    const h = habit({ rest_day_protection: true, rest_days: [0, 1, 2, 3, 4, 5, 6] })
    expect(longestStreak(h, [], '2026-09-07')).toBe(0)
  })
})

describe('toDateKeyWithBoundary（跨午夜日界）', () => {
  it('cutoff=0 时与 toDateKey 完全等价（默认行为不变）', () => {
    const date = new Date('2026-09-15T01:00:00.000Z')
    expect(toDateKeyWithBoundary(date)).toBe(toDateKey(date))
    expect(toDateKeyWithBoundary(date, 0)).toBe('2026-09-15')
  })

  it('★ 凌晨 1 点在 cutoff=3 下归入前一天', () => {
    // 01:00 往前推 3 小时 = 昨晚 22:00 → 昨天的日期键
    expect(toDateKeyWithBoundary(new Date('2026-09-15T01:00:00.000Z'), 3)).toBe('2026-09-14')
  })

  it('过了日界就算新的一天', () => {
    // 04:00 往前推 3 小时 = 01:00，仍在今天
    expect(toDateKeyWithBoundary(new Date('2026-09-15T04:00:00.000Z'), 3)).toBe('2026-09-15')
  })

  it('★ 跨月边界正确（不用手工算日期）', () => {
    // 10/01 凌晨 1 点，cutoff=3 → 退到 9/30
    expect(toDateKeyWithBoundary(new Date('2026-10-01T01:00:00.000Z'), 3)).toBe('2026-09-30')
  })

  it('★ 跨年边界正确', () => {
    expect(toDateKeyWithBoundary(new Date('2027-01-01T02:00:00.000Z'), 3)).toBe('2026-12-31')
  })

  it('超出取值范围会被 clamp', () => {
    const date = new Date('2026-09-15T01:00:00.000Z')
    expect(toDateKeyWithBoundary(date, 99)).toBe(toDateKeyWithBoundary(date, 6))
    expect(toDateKeyWithBoundary(date, -5)).toBe(toDateKeyWithBoundary(date, 0))
  })

  it('★ 日界只影响日期键的生成，streak 逻辑无需感知', () => {
    // 凌晨 1 点打卡，cutoff=3 → 记到昨天；昨天 + 前天都打了 → 连续 2 天
    const h = habit()
    const earlyMorning = toDateKeyWithBoundary(new Date('2026-09-15T01:00:00.000Z'), 3)
    expect(earlyMorning).toBe('2026-09-14')

    const list = checkInsOn('h1', ['2026-09-13', '2026-09-14'])
    expect(computeStreak(h, list, earlyMorning)).toBe(2)
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
