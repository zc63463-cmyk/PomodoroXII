/**
 * Habit selectors —— 习惯的日期与连续天数计算。
 *
 * 刻意做成纯函数（不碰 Dexie、不异步）：连续天数（streak）是最容易写错
 * 又最好测的一段逻辑 —— 休息日保护、当天未打卡、跨月跨年等边界很多。
 *
 * 日期一律用 **YYYY-MM-DD 字符串**比较，不用 Date 对象：
 * 打卡记录存的就是这个格式，字符串比较既正确又免时区坑。
 */

import type { Habit, HabitCheckIn } from '@/types'

/** 取本地时区的 YYYY-MM-DD（不用 toISOString，那会转成 UTC 而偏一天）。 */
export function toDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + deltaDays)
  return toDateKey(date)
}

/** 0=周日 … 6=周六，与 Habit.rest_days 的约定一致。 */
export function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** 生成从今天往前 n 天的日期键（含今天），顺序为最早 → 今天。 */
export function lastNDateKeys(n: number, today: string): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(shiftDateKey(today, -i))
  return out
}

export function isRestDay(habit: Habit, dateKey: string): boolean {
  return habit.rest_days.includes(weekdayOf(dateKey))
}

/** 某天累计打卡次数（同一天可能打卡多次）。 */
export function countOnDate(
  checkIns: readonly HabitCheckIn[],
  habitId: string,
  dateKey: string,
): number {
  return checkIns
    .filter((c) => c.habit_id === habitId && c.date === dateKey)
    .reduce((sum, c) => sum + c.count, 0)
}

/** 某天是否达标（达到每日目标次数）。 */
export function isCompletedOn(
  habit: Habit,
  checkIns: readonly HabitCheckIn[],
  dateKey: string,
): boolean {
  return countOnDate(checkIns, habit.id, dateKey) >= Math.max(1, habit.target_count)
}

/**
 * 计算当前连续达标天数。
 *
 * 三条边界（都有测试覆盖）：
 * 1. **今天还没打卡不算断** —— 否则用户一大早打开就看到链条归零，体验很糟。
 *    从今天往前走，今天未达标时跳过它，从昨天开始数。
 * 2. **休息日跳过而非中断**（仅当 rest_day_protection 打开）。
 * 3. 遇到一个既未达标、又非休息日的日子就停。
 */
export function computeStreak(
  habit: Habit,
  checkIns: readonly HabitCheckIn[],
  today: string,
): number {
  let streak = 0
  let cursor = today

  // 今天未达标 → 不算断链，从昨天开始数
  if (!isCompletedOn(habit, checkIns, today)) cursor = shiftDateKey(today, -1)

  // 上限保护：脏数据（如某天重复记录）不应导致死循环
  for (let guard = 0; guard < 3650; guard++) {
    if (isCompletedOn(habit, checkIns, cursor)) {
      streak++
      cursor = shiftDateKey(cursor, -1)
      continue
    }
    if (habit.rest_day_protection && isRestDay(habit, cursor)) {
      cursor = shiftDateKey(cursor, -1)
      continue
    }
    break
  }

  return streak
}

/** 累计达标天数（不含今天是否已打卡的判断，纯粹数记录）。 */
export function countCompletedDays(
  habit: Habit,
  checkIns: readonly HabitCheckIn[],
): number {
  const dates = new Set<string>()
  for (const checkIn of checkIns) {
    if (checkIn.habit_id !== habit.id) continue
    if (countOnDate(checkIns, habit.id, checkIn.date) >= Math.max(1, habit.target_count)) {
      dates.add(checkIn.date)
    }
  }
  return dates.size
}

/** 今日进度，用于列表上的「3/5」之类展示。 */
export function todayProgress(
  habit: Habit,
  checkIns: readonly HabitCheckIn[],
  today: string,
): { done: number; target: number; completed: boolean } {
  const done = countOnDate(checkIns, habit.id, today)
  const target = Math.max(1, habit.target_count)
  return { done, target, completed: done >= target }
}
