/**
 * 今日事实的 **IO 包装层** —— 读 Dexie，交给纯函数聚合。
 *
 * ## 与 `daily-evidence.ts` 的分工
 * 纯函数负责口径与聚合，本文件只干三件事：查表、**剥主键**、把结果传下去。
 * 口径改动一律改纯函数，不要往这里加 `if`。
 *
 * ## ★ 主键 rename 陷阱（本文件存在的首要理由）
 * `focusSessions` 表的**真实主键列名是 `id`**，但类型
 * `CachedFocusSession` 把它 rename 成了 `sessionId`（`types/index.ts:560`：
 * `Omit<FocusSessionView,'id'|'spaceId'> & { sessionId: string }`）。
 * 同样的行在 `readLocalAggregate`（`timer/page.tsx:81-83`）里也要剥：
 * ```ts
 * const { id: _id, ...session } = row
 * ```
 * 本文件统一在这一个点剥，**下游一律只见 `id`**。
 *
 * ## 为什么不用 `focusSessionRepository.listCached()`
 * 它是 `toArray()` **全表 + 按 `updatedAt` 排序**（`focus-session-repository.ts:1053`），
 * 反思页要的是**按 `startedAt` 收窄到当日**（该列**有索引**，
 * `dexie-v18-schema.ts:47`）。会话语料目前是"本地单机历史"，
 * `continue-previous.ts:226-231` 已把"跨到万级要改窗口查询"写成显式负债 ——
 * 反思页不重复这个技术债，走索引。
 *
 * ## 归因读法
 * 照抄 `timer/page.tsx:85-87` 的唯一既有范例：取 `effective` 那一条。
 * 这里**不做** `?? attributions[0]` 降级：反思页对归因缺失是 fail-soft 的
 * （会话仍进时间轴，只是没有二级归属），降级反而会引入不确定的归属。
 */
import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'

import {
  collectDailyEvidence,
  DEFAULT_DAY_BOUNDARY,
  emptyDailyEvidence,
  type AttributionRow,
  type DailyEvidenceSnapshot,
  type PlanRow,
  type SessionRow,
} from './daily-evidence'

/** 脏值 → 合法枚举的收窄（Dexie 声明为 `Record<string, unknown>`，无类型保证）。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

const SESSION_TYPES = ['work', 'short_break', 'long_break', 'free', 'countdown'] as const
const VALIDITY = ['pending', 'valid', 'invalid'] as const
const COMPLETION = ['completed', 'ended_early', 'interrupted'] as const
const PROGRESS = ['smooth', 'progressed', 'stuck', 'interrupted'] as const

/** Dexie 行（`Record<string, unknown>`）→ `SessionRow`。**主键在这里剥**。 */
function toSessionRow(row: Record<string, unknown>): SessionRow | null {
  const id = str(row.id) || str(row.sessionId)
  const startedAt = str(row.startedAt)
  if (id === '' || startedAt === '') return null
  const endedAtRaw = row.endedAt
  return {
    id,
    startedAt,
    endedAt: typeof endedAtRaw === 'string' && endedAtRaw !== '' ? endedAtRaw : null,
    focusedSeconds: num(row.focusedSeconds),
    pausedSeconds: num(row.pausedSeconds),
    validity: oneOf(row.validity, VALIDITY, 'pending'),
    timerCompletion: oneOf(row.timerCompletion, COMPLETION, 'completed' as (typeof COMPLETION)[number]),
    sessionType: oneOf(row.sessionType, SESSION_TYPES, 'work'),
    overallProgress: row.overallProgress === null || row.overallProgress === undefined
      ? null
      : oneOf(row.overallProgress, PROGRESS, 'smooth'),
  }
}

function toAttributionRow(row: Record<string, unknown>): AttributionRow | null {
  const sessionId = str(row.sessionId)
  const level2WorkItemId = str(row.level2WorkItemId)
  if (sessionId === '' || level2WorkItemId === '') return null
  return {
    sessionId,
    level2WorkItemId,
    projectId: str(row.projectId),
    effective: row.effective === true,
  }
}

function toPlanRow(row: Record<string, unknown>): PlanRow | null {
  const sessionId = str(row.sessionId)
  const titleSnapshot = str(row.titleSnapshot)
  if (sessionId === '' || titleSnapshot === '') return null
  const removedAtRaw = row.removedAt
  return {
    sessionId,
    workItemId: str(row.workItemId),
    titleSnapshot,
    planRank: num(row.planRank),
    removedAt: typeof removedAtRaw === 'string' && removedAtRaw !== '' ? removedAtRaw : null,
    currentDuringSession: row.currentDuringSession === true,
  }
}

/** 空库时（空间未打开）给一个 0 会话快照，绝不抛。 */
function guard(): PomodoroXIDB | null {
  try {
    return (spaceDBManager.current as PomodoroXIDB | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * 读某日的今日事实快照（fail-soft：任何异常 → 空快照）。
 *
 * @param dateKey 目标日期 `YYYY-MM-DD`
 * @param hanging 导图侧提炼出的悬挂项（Phase 2 才会有值；Phase 1 传空数组）
 * @param dayBoundaryHour 日界小时，默认 {@link DEFAULT_DAY_BOUNDARY}
 */
export async function readDailyEvidence(
  dateKey: string,
  hanging: DailyEvidenceSnapshot['hanging'] = [],
  dayBoundaryHour: number = DEFAULT_DAY_BOUNDARY,
): Promise<DailyEvidenceSnapshot> {
  const database = guard()
  // 注意：空库早退也要透传 `hanging`（与纯函数内同一纪律）——
  // 「当天没番茄但导图里有遗留思考」是真实场景，不能在 IO 层就丢掉。
  if (database === null) return { ...emptyDailyEvidence(dateKey), hanging }

  try {
    // 按 `startedAt` 索引取当日窗口（**上界多给 1 天**再由纯函数按日界精确过滤 ——
    // 日界偏移让 ISO 区间与本地日期键不是一对一，索引粗筛 + 纯函数细筛最稳）
    const from = new Date(`${dateKey}T00:00:00`)
    if (Number.isNaN(from.getTime())) return { ...emptyDailyEvidence(dateKey), hanging }
    const to = new Date(from.getTime() + 2 * 24 * 3600 * 1000)

    const rawSessions = (await database.focusSessions
      .where('startedAt')
      .between(from.toISOString(), to.toISOString(), true, true)
      .toArray()) as Record<string, unknown>[]

    const sessionRows: SessionRow[] = []
    for (const raw of rawSessions) {
      const row = toSessionRow(raw)
      if (row !== null) sessionRows.push(row)
    }
    if (sessionRows.length === 0) return { ...emptyDailyEvidence(dateKey), hanging }

    // 归因 / 计划：只捞当日会话涉及的，避免全表扫（N 会话 → N 次定点查）
    const sessionIds = new Set(sessionRows.map((row) => row.id))
    const [rawAttributions, rawPlans] = await Promise.all([
      database.sessionAttributionRevisions.toArray() as Promise<Record<string, unknown>[]>,
      database.sessionWorkItemPlans.toArray() as Promise<Record<string, unknown>[]>,
    ])

    const attributions: AttributionRow[] = []
    for (const raw of rawAttributions) {
      if (!sessionIds.has(str(raw.sessionId))) continue
      const row = toAttributionRow(raw)
      if (row !== null) attributions.push(row)
    }

    const plans: PlanRow[] = []
    for (const raw of rawPlans) {
      if (!sessionIds.has(str(raw.sessionId))) continue
      const row = toPlanRow(raw)
      if (row !== null) plans.push(row)
    }

    return collectDailyEvidence(
      dateKey,
      sessionRows,
      attributions,
      plans,
      hanging,
      dayBoundaryHour,
    )
  } catch (cause) {
    // 反思页是"辅助视图"，读不到事实不能变成打不开页面
    console.warn(
      `[daily-evidence] 读取失败（fail-soft，退化为空抽屉）: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    return { ...emptyDailyEvidence(dateKey), hanging }
  }
}
