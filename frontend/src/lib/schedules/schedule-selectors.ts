/**
 * Schedule selectors —— 日程的日期分组、逾期判定与完成率。
 *
 * 纯函数（不碰 Dexie、不异步）。日历视图的定位逻辑全部放这里，
 * 组件只负责渲染 —— 这样日期计算能被单测覆盖，
 * 而日历布局本身（无法单测的部分）保持尽可能薄。
 *
 * 日期一律用 **YYYY-MM-DD 字符串**比较。
 */

import type { Schedule } from '@/types'

/**
 * 从 ISO datetime 取本地日期键（YYYY-MM-DD）。
 *
 * 注意：不能用 `toISOString().slice(0,10)` —— 那是 UTC 日期，
 * 本地时间 23:30 会被算成次日。反思与习惯域已踩过这个坑。
 */
export function dateKeyOfISO(iso: string): string {
  const date = new Date(iso)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface ScheduleDayGroup {
  /** YYYY-MM-DD */
  date: string
  schedules: Schedule[]
}

/** 按日期分组，组内开始时间升序；无开始时间的排在最前。 */
export function groupSchedulesByDate(
  schedules: readonly Schedule[],
): ScheduleDayGroup[] {
  const buckets = new Map<string, Schedule[]>()
  for (const schedule of schedules) {
    const key = dateKeyOfISO(schedule.due_at)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(schedule)
    else buckets.set(key, [schedule])
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, group]) => ({
      date,
      schedules: [...group].sort((a, b) => {
        // 无开始时间的（视为全天或仅截止）排在当天最前
        if (a.start_time == null && b.start_time == null) return 0
        if (a.start_time == null) return -1
        if (b.start_time == null) return 1
        return a.start_time.localeCompare(b.start_time)
      }),
    }))
}

/** 逾期 = 未完成的截止已过。 */
export function isOverdue(schedule: Schedule, nowISO: string): boolean {
  if (schedule.completed_at != null) return false
  return schedule.due_at < nowISO
}

export function splitByStatus(
  schedules: readonly Schedule[],
  nowISO: string,
): { completed: Schedule[]; pending: Schedule[]; overdue: Schedule[] } {
  const completed: Schedule[] = []
  const pending: Schedule[] = []
  const overdue: Schedule[] = []

  for (const schedule of schedules) {
    if (schedule.completed_at != null) completed.push(schedule)
    else if (isOverdue(schedule, nowISO)) overdue.push(schedule)
    else pending.push(schedule)
  }

  return { completed, pending, overdue }
}

/** 完成率 0..1。空列表返回 0（而非 NaN）。 */
export function completionRate(schedules: readonly Schedule[]): number {
  if (schedules.length === 0) return 0
  const done = schedules.filter((s) => s.completed_at != null).length
  return done / schedules.length
}

/**
 * 两个时段是否重叠。
 * `start_time` / `end_time` 可能是 'HH:mm' 或 ISO datetime —— 只取时间部分比较，
 * 因为时间块总落在同一天内（TimeBlock.date 单独存）。
 */
export function timeRangesOverlap(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return false

  const hhmm = (value: string): string => (value.includes('T') ? value.split('T')[1] : value)
  const a0 = hhmm(aStart).slice(0, 5)
  const a1 = hhmm(aEnd).slice(0, 5)
  const b0 = hhmm(bStart).slice(0, 5)
  const b1 = hhmm(bEnd).slice(0, 5)

  // 半开区间 [start, end)：首尾相接不算重叠
  return a0 < b1 && b0 < a1
}

/** 优先级排序权重：high 先，同优先级按截止时间升序。 */
export function sortByPriority(schedules: readonly Schedule[]): Schedule[] {
  const weight: Record<Schedule['priority'], number> = { high: 0, medium: 1, low: 2 }
  return [...schedules].sort(
    (a, b) => weight[a.priority] - weight[b.priority] || a.due_at.localeCompare(b.due_at),
  )
}
