/**
 * Stats API —— 服务端聚合统计的只读封装。
 *
 * ★ 本域最大的一个坑（2026-09-02 核对）
 *   stats-store 原本的 stub 接口是 loadOverview / loadFocusTrend /
 *   loadTaskDistribution，但**后端根本没有这些端点**。
 *   `GET /api/v1/stats/*` 实际只有三个：habit-summary / schedule-summary /
 *   note-summary，分别是习惯打卡率、日程完成率、笔记与文件夹计数。
 *
 *   所以这里照**真实端点**建模，不去凑那个 stub 的形状 ——
 *   否则前端会去请求一个不存在的路径，或在本地伪造后端给不出的指标。
 *
 * 只读：这些端点背后只有 SELECT，前端不做任何本地聚合，也不缓存到 Dexie
 * （缓存统计值会引入与源数据不一致的第二个真相）。
 */

import { spaceApi } from '@/services/api'

/** GET /stats/habit-summary —— 单个习惯的打卡统计。 */
export interface HabitSummaryItem {
  habit_id: string
  title: string
  total_check_ins: number
  check_in_days: number
  current_streak: number
  /** 0..1 */
  completion_rate: number
}

export interface HabitSummary {
  habits: HabitSummaryItem[]
  period_days: number
}

/** GET /stats/schedule-summary —— 日程完成情况。 */
export interface ScheduleSummary {
  total: number
  completed: number
  pending: number
  overdue: number
  period_days: number
  /** 0..1 */
  completion_rate: number
}

/** GET /stats/note-summary —— 笔记与文件夹计数。 */
export interface NoteSummary {
  notes: number
  folders: number
  trashed_notes: number
  trashed_folders: number
}

export async function fetchHabitSummary(
  days = 30,
  signal?: AbortSignal,
): Promise<HabitSummary> {
  const res = await spaceApi.get<HabitSummary>('/stats/habit-summary', {
    params: { days },
    ...(signal ? { signal } : {}),
  })
  return res.data
}

export async function fetchScheduleSummary(
  days = 30,
  signal?: AbortSignal,
): Promise<ScheduleSummary> {
  const res = await spaceApi.get<ScheduleSummary>('/stats/schedule-summary', {
    params: { days },
    ...(signal ? { signal } : {}),
  })
  return res.data
}

export async function fetchNoteSummary(signal?: AbortSignal): Promise<NoteSummary> {
  const res = await spaceApi.get<NoteSummary>('/stats/note-summary', {
    ...(signal ? { signal } : {}),
  })
  return res.data
}
