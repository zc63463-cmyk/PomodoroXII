/**
 * 统计窗口起始点 —— 「今日」口径的单一实现（工单 A2 2026-09-14）。
 *
 * ★ 背景：服务端 /stats/focus-summary 原先只接受 `days`，窗口起点 =
 *   `utc_now() - days` 再取 **UTC 零点**（backend/app/services/stats.py）。
 *   days=1 因此实际覆盖「昨天 UTC 零点至今」——既不是本地「今日」，也不读
 *   用户日界。工单 A1 给服务端加了显式 `start` 之后，本地日界窗口才第一次
 *   可以表达。本模块负责把「本地日界」翻译成服务端要的 UTC 串。
 *
 * ★ 日界语义不在这里定义：复用 `toDateKeyWithBoundary`（habits 域的日界
 *   单一事实源，见 habit-selectors.ts:41-46「往前推 cutoff 小时再取本地
 *   日期键」）。**禁止另写一套日界算法** —— 语义漂移的教训（两处各自实现
 *   日界，凌晨时段两边会差一天）。
 *
 * ★ 输出格式必须与服务端 `pattern` 逐字对齐：
 *   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`（Z 后缀 UTC、秒精度）——
 *   服务端过滤是 SQLite 字符串比较，格式不同构会静默比错（不进 422，直接
 *   算错窗口），比格式校验失败更危险。
 */

import { toDateKeyWithBoundary } from '@/lib/habits/habit-selectors'

/**
 * 「今日」窗口起点：日界调整后的本地零点，转成 Z 后缀 UTC 秒精度。
 *
 * 例：dayBoundaryHour=3 时，本地 01:00 属于昨天 —— 起点是**昨天**本地零点；
 * 本地 10:00 则是**今天**本地零点。`toISOString()` 天然输出 UTC，本地
 * 零点的 UTC 表示就是我们要的窗口起点（如 UTC+8 的 09-14 00:00 本地
 * = 09-13T16:00:00Z）。
 *
 * 毫秒裁掉：本地零点毫秒恒为 0，裁到秒是为了与服务端 pattern 同构。
 */
export function todayStartIso(now: Date, dayBoundaryHour: number): string {
  const dateKey = toDateKeyWithBoundary(now, dayBoundaryHour)
  const [year, month, day] = dateKey.split('-').map(Number)
  const localMidnight = new Date(year, month - 1, day)
  return `${localMidnight.toISOString().slice(0, 19)}Z`
}
