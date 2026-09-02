/**
 * Reflection selectors —— 反思列表的分组与统计。
 *
 * 纯函数（不碰 Dexie、不异步），与其余域的 selectors 一致。
 * 日期一律用 YYYY-MM-DD 字符串比较，避免时区问题。
 */

import type { Mood, Reflection } from '@/types'

/** 与 sync schema 中 reflection.mood 的枚举一致。 */
export const MOODS: readonly Mood[] = ['great', 'good', 'normal', 'bad', 'terrible']

export interface ReflectionMonthGroup {
  /** YYYY-MM */
  month: string
  reflections: Reflection[]
}

/** 取 YYYY-MM（直接切字符串，不构造 Date）。 */
export function monthOf(dateKey: string): string {
  return dateKey.slice(0, 7)
}

/** 按月份分组，新月份在前；组内按日期倒序。 */
export function groupReflectionsByMonth(
  reflections: readonly Reflection[],
): ReflectionMonthGroup[] {
  const buckets = new Map<string, Reflection[]>()
  for (const reflection of reflections) {
    const key = monthOf(reflection.date)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(reflection)
    else buckets.set(key, [reflection])
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, group]) => ({
      month,
      reflections: [...group].sort((a, b) => b.date.localeCompare(a.date)),
    }))
}

/** 各心情的篇数，按 MOODS 顺序返回（含 0 的项，便于画完整图例）。 */
export function countMoods(
  reflections: readonly Reflection[],
): Array<{ mood: Mood; count: number }> {
  const counts = new Map<Mood, number>()
  for (const reflection of reflections) {
    if (reflection.mood == null) continue
    counts.set(reflection.mood, (counts.get(reflection.mood) ?? 0) + 1)
  }
  return MOODS.map((mood) => ({ mood, count: counts.get(mood) ?? 0 }))
}

/**
 * 连续记录天数：从今天（或最近有记录的一天）往前数。
 * 与习惯的 streak 不同 —— 反思是「有写就算」，没有目标次数。
 * 今天还没写不算断，从昨天开始数。
 */
export function computeReflectionStreak(
  reflections: readonly Reflection[],
  today: string,
): number {
  const days = new Set(reflections.map((r) => r.date))
  if (days.size === 0) return 0

  const shift = (dateKey: string, delta: number): string => {
    const [y, m, d] = dateKey.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    date.setDate(date.getDate() + delta)
    const yy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yy}-${mm}-${dd}`
  }

  let cursor = days.has(today) ? today : shift(today, -1)
  let streak = 0

  for (let guard = 0; guard < 3650 && days.has(cursor); guard++) {
    streak++
    cursor = shift(cursor, -1)
  }

  return streak
}

/** 摘要：优先用 content 首行，空则回退为占位。 */
export function reflectionExcerpt(reflection: Reflection, maxLength = 80): string {
  const firstLine = reflection.content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return '(空白)'
  const plain = firstLine.replace(/^[#>\-\*\s]+/, '')
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain
}
