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

/** 日界小时的取值范围。0 = 午夜分界；6 = 凌晨 6 点前都算前一天。 */
export const DAY_BOUNDARY_MIN = 0
export const DAY_BOUNDARY_MAX = 6

/**
 * 取「有效日期键」—— 跨午夜日界（day boundary）。
 *
 * `dayBoundaryHour = 3` 表示凌晨 3 点才算新的一天：
 * 凌晨 1 点打卡会被归入**昨天**的日期键。番茄钟/夜猫子场景的刚需 ——
 * 过了午夜还在工作，不该因为跨了零点就被判成「昨天没打卡」。
 *
 * 实现：把时间往前推 cutoff 小时再取本地日期键，而不是去改日期的加减，
 * 这样跨月、跨年、闰年由 Date 自己处理。
 *
 * ★ 关键设计：只要**日期键的生成**应用了日界，下游全部逻辑
 *   （computeStreak / isCompletedOn / countOnDate / lastNDateKeys）自动正确，
 *   它们只做字符串比较，不需要知道日界的存在。
 *
 * cutoff = 0 时与 toDateKey 完全等价（默认行为不变，向后兼容）。
 */
export function toDateKeyWithBoundary(date: Date, dayBoundaryHour = 0): string {
  const clamped = Math.min(Math.max(dayBoundaryHour, DAY_BOUNDARY_MIN), DAY_BOUNDARY_MAX)
  if (clamped === 0) return toDateKey(date)
  // 往前推 cutoff 小时：凌晨 1 点 - 3h = 昨晚 22 点 → 昨天的日期键
  return toDateKey(new Date(date.getTime() - clamped * 3600 * 1000))
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

/**
 * 历史最长连续达标天数。
 *
 * 与 computeStreak 的两点区别：
 * 1. **不看「今天」** —— 扫的是该习惯从最早打卡日到 today 的全区间，
 *    找其中最长的一段。今天是断点也不影响历史成绩。
 * 2. 因此不存在「今天还没打卡」的宽容逻辑，那段判断只属于当前连续。
 *
 * 休息日规则与 computeStreak 保持一致：开启保护时休息日跳过、不断链。
 *
 * 性能：先把打卡按日期聚合再线性扫描。若直接对每个日期调 countOnDate
 * 会是 O(天数 × 记录数)，记录多了会明显变慢。
 */
export function longestStreak(
  habit: Habit,
  checkIns: readonly HabitCheckIn[],
  today: string,
): number {
  // 日期 → 当天累计次数。先聚合，扫描时就是 O(1) 查询。
  const perDate = new Map<string, number>()
  for (const checkIn of checkIns) {
    if (checkIn.habit_id !== habit.id) continue
    perDate.set(checkIn.date, (perDate.get(checkIn.date) ?? 0) + checkIn.count)
  }
  if (perDate.size === 0) return 0

  const target = Math.max(1, habit.target_count)
  const met = (dateKey: string): boolean => (perDate.get(dateKey) ?? 0) >= target

  // 上界是 today：未来的打卡记录（如误填日期）不该计入历史成绩
  const earliest = [...perDate.keys()].sort()[0]
  if (earliest > today) return 0

  let best = 0
  let current = 0

  // 上限保护：与 computeStreak 同理，脏日期不应导致死循环
  for (let cursor = earliest, guard = 0; cursor <= today && guard < 36_500; guard++) {
    if (met(cursor)) {
      current += 1
      if (current > best) best = current
    } else if (habit.rest_day_protection && isRestDay(habit, cursor)) {
      // 休息日：跳过，既不计数也不断链
    } else {
      current = 0
    }
    cursor = shiftDateKey(cursor, 1)
  }

  return best
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
