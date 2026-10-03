import { dateKeyOfISO } from '@/lib/schedules/schedule-selectors'
import type { CachedWorkItem } from '@/types'

/**
 * due_at 选择器 —— 「今日到期 / 逾期」的日期口径（工单③·space_018）。
 *
 * 纯函数（不碰 Dexie、不异步），组件只负责渲染 —— 日期口径全部在这里，
 * 这样跨日/时区行为能被单测钉死。
 *
 * ★ 日期口径（本仓三次踩坑的教训，勿回退）：
 *   - due_at 值 = 本地日期键 "YYYY-MM-DD"（UI 只写这个形态：用户语义是
 *     「哪天要」，不是时刻；纯日期字符串比较无时区坑）；
 *   - 「今天」必须取**本地**日期键 —— 禁止 toISOString().slice(0,10)
 *     （那是 UTC 日期，本地 23:30 会算成次日），统一走 dateKeyOfISO()
 *     （lib/schedules 的既有工具，内部用本地 getFullYear/getMonth/getDate）；
 *   - 一切比较 = "YYYY-MM-DD" 字符串比较，绝不 new Date() 再比。
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * due_at → 日期键。纯日期键原样返回；ISO 日期时间按**本地**时区取键
 * （容错：若未来有调用方写入完整时刻）。坏值返回 null —— 调用方把它当
 * 「无有效截止」处理，绝不让一条坏行炸掉整个视图。
 */
export function dueDateKeyOf(dueAt: string): string | null {
  if (DATE_KEY_RE.test(dueAt)) return dueAt
  const key = dateKeyOfISO(dueAt)
  return DATE_KEY_RE.test(key) ? key : null
}

/** 本地「今天」的日期键（YYYY-MM-DD）。 */
export function localTodayKey(now: Date = new Date()): string {
  return dateKeyOfISO(now.toISOString())
}

/** 开放类目：只有这些类目的工作项才算「还欠着」。终态（completed/cancelled）与
 * 归档行不进今日/逾期桶 —— 已完成的事不再催。 */
const OPEN_CATEGORIES = new Set(['not_started', 'in_progress', 'waiting'])

export interface DueDateBuckets {
  /** 到期日 = 本地今天。 */
  today: CachedWorkItem[]
  /** 到期日 < 本地今天（UI 对这个桶做高亮）。 */
  overdue: CachedWorkItem[]
}

/**
 * 把工作项分进「今日 / 逾期」两个桶。
 *
 * @param todayKey  本地今天的日期键（`localTodayKey()`）
 * @param categoryOf 工作项 → 状态类目（页面用 deriveStatusCategoryById 按
 *   Space 定义派生后传入 —— 绝不硬编码状态 id）。
 */
export function bucketDueDates(
  items: readonly CachedWorkItem[],
  todayKey: string,
  categoryOf?: (item: CachedWorkItem) => string | null | undefined,
): DueDateBuckets {
  const today: CachedWorkItem[] = []
  const overdue: CachedWorkItem[] = []
  for (const item of items) {
    if (!item.dueAt || item.archivedAt) continue
    if (categoryOf) {
      const category = categoryOf(item)
      // 类目未知（定义还没拉到）时**宁可展示**：漏掉逾期项比多显示一行
      // 更伤用户 —— 类目过滤只对明确命中的终态生效。
      if (category && !OPEN_CATEGORIES.has(category)) continue
    }
    const key = dueDateKeyOf(item.dueAt)
    if (key === null) continue
    if (key === todayKey) today.push(item)
    else if (key < todayKey) overdue.push(item)
    // 未来日期：本面板口径只有今日/逾期，其余留给后续的日历视图。
  }
  const byDueThenKey = (a: CachedWorkItem, b: CachedWorkItem): number => (
    (dueDateKeyOf(a.dueAt as string) ?? '').localeCompare(dueDateKeyOf(b.dueAt as string) ?? '')
    || a.displayKey.localeCompare(b.displayKey)
  )
  today.sort(byDueThenKey)
  overdue.sort(byDueThenKey)
  return { today, overdue }
}
