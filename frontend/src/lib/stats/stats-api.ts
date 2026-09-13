/**
 * Stats API —— 服务端聚合统计的只读封装。
 *
 * ★ 本域最大的一个坑（2026-09-02 核对）
 *   stats-store 原本的 stub 接口是 loadOverview / loadFocusTrend /
 *   loadTaskDistribution，但**后端根本没有这些端点**。
 *   `GET /api/v1/stats/*` 当时只有三个：habit-summary / schedule-summary /
 *   note-summary，分别是习惯打卡率、日程完成率、笔记与文件夹计数。
 *
 *   所以这里照**真实端点**建模，不去凑那个 stub 的形状 ——
 *   否则前端会去请求一个不存在的路径，或在本地伪造后端给不出的指标。
 *
 * ★ 2026-09-04 新增第四个端点 focus-summary（番茄钟统计）：
 *   在此之前，一个叫 PomodoroXII 的产品，统计页看不到任何番茄数据。
 *   它的核心输出是按小时的分布，而不是会话总数 —— 理由见下面 FocusSummary 的注释。
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

/**
 * GET /stats/focus-summary —— 番茄钟（专注会话）统计。
 *
 * ★ 刻意不把「总会话数」当作核心指标：那是最容易被刷、也最没信息量的数字
 *   （同样是 8 个会话，可能全是深度工作，也可能全是碎片）。
 *   真正有用的是 **by_hour**：哪个时段产出的是完整无中断的会话 ——
 *   它接近一份个人 chronotype map，能直接指导「把最难的工作排在什么时候」。
 */
export interface FocusHourBucket {
  /** 0..23 */
  hour: number
  sessions: number
  /** validity == 'valid' 的会话数 */
  valid: number
  /** 有过暂停（paused_seconds > 0）的会话数 */
  interrupted: number
  focused_seconds: number
}

export interface FocusSummary {
  period_days: number
  total_sessions: number
  valid_sessions: number
  interrupted_sessions: number
  focused_seconds: number
  planned_seconds: number
  /** focused / planned。1.0 = 估得准；>1 超时，<1 提前结束。 */
  estimate_accuracy: number
  /** 固定 24 项（含全零的小时），便于直接画热力图 */
  by_hour: FocusHourBucket[]
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

export async function fetchFocusSummary(
  days = 30,
  signal?: AbortSignal,
): Promise<FocusSummary> {
  const res = await spaceApi.get<FocusSummary>('/stats/focus-summary', {
    params: { days },
    ...(signal ? { signal } : {}),
  })
  return res.data
}

/**
 * 「今日」窗口（工单 A2 2026-09-14）：显式起点 = 本地日界零点（见 day-window.ts）。
 *
 * ★ 为什么单独一个函数而不是给 fetchFocusSummary 加可选参数：
 *   两个调用面表达的是**不同口径** ——「最近 N 天」（服务端按 days 推导
 *   UTC 零点起点）与「本地日界起的今日」（起点由客户端显式给出）。
 *   混进同一个签名会诱导调用方以为它们可以互相替代（实测教训：
 *   days=1 曾被当成"今日"，实际覆盖 24–48h）。
 *
 * days=1 固定传递：服务端在提供 start 时**忽略** days 推导，仅用于回显
 * period_days —— 保持与既有「单日窗口」的回显数值一致。
 */
export async function fetchFocusSummaryWindow(
  { start }: { start: string },
  signal?: AbortSignal,
): Promise<FocusSummary> {
  const res = await spaceApi.get<FocusSummary>('/stats/focus-summary', {
    params: { days: 1, start },
    ...(signal ? { signal } : {}),
  })
  return res.data
}
