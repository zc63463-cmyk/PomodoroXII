/**
 * 「继续上次」三栏分桶 —— 准备态的快捷入口数据（用户 2026-09-30 确认口径）。
 *
 * ## 规则（三条，均已确认）
 * 1. **判定按工作项**：有会话历史 **且** 未完成/未取消
 * 2. **时间窗 7 天内**，按**本地日界**分三层：
 *    - 最近打开（今日有会话）
 *    - 昨日未完成（昨日有会话且未完成）
 *    - 七天内堆积（2–7 天前有会话且未完成）
 * 3. **去重**：同一工作项**只出现在最贴近的一层**（今日 > 昨日 > 2–7 天）
 *
 * ## 日界：复用 habits 域的单一事实源（**禁止另写**）
 * `toDateKeyWithBoundary` 是全项目日界的单一实现（见 `lib/stats/day-window.ts`
 * 头注：「禁止另写一套日界算法——语义漂移的教训」）。本模块**不再自持
 * localDayStart**，分桶与时间显示全部走同一把尺子。
 *
 * ## 为什么纯函数 + IO 包装分离
 * 分桶/排序/过滤是纯逻辑，对数组做，单测不需要 mock Dexie；
 * 只有 `readContinuePrevious` 负责读表。
 */
import { shiftDateKey, toDateKeyWithBoundary } from '@/lib/habits/habit-selectors'
import type { PomodoroXIDB } from '@/services/database'

/** 某工作项的一次会话关联（来自 `sessionTaskContexts`）。 */
export interface SessionContextRow {
  sessionId?: string
  level2WorkItemId?: string
}

/** 会话行（只取分桶需要的字段）。 */
export interface SessionRow {
  id?: string
  startedAt?: string
  focusedSeconds?: number
}

/** 聚合后的单条记录（纯函数输入）。 */
export interface ContinuePreviousEntry {
  workItemId: string
  /** 最近一次会话开始时间（ISO） */
  lastSessionAt: string
  sessionCount: number
  focusedSeconds: number
}

/** 分桶结果。 */
export interface ContinuePreviousBuckets {
  today: ContinuePreviousEntry[]
  yesterday: ContinuePreviousEntry[]
  withinWeek: ContinuePreviousEntry[]
}

/** 工作项的最小引用（只用到这几个字段，避免耦合完整 View 类型）。 */
export interface WorkItemRef {
  id: string
  priority?: string | null
  statusDefinitionId?: string | null
  completedAt?: string | null
  cancelledAt?: string | null
}

export interface BucketOptions {
  /** 本地日界小时（如 4 = 凌晨 4 点前的时段归属前一天） */
  dayBoundaryHour: number
  now: Date
  maxToday?: number
  maxYesterday?: number
  maxWeek?: number
}

/** 终态类目：这些状态的工作项不再出现在快捷入口。 */
const TERMINAL_CATEGORIES = new Set(['completed', 'cancelled'])

/** 工作项是否应被排除（有终态时间戳 / 状态类目为终态 / 不存在）。 */
export function isExcluded(
  item: WorkItemRef | undefined,
  categoryById: Record<string, string | undefined>,
): boolean {
  if (!item) return true
  if (item.completedAt != null || item.cancelledAt != null) return true
  const category = item.statusDefinitionId ? categoryById[item.statusDefinitionId] : undefined
  return category !== undefined && TERMINAL_CATEGORIES.has(category)
}

/**
 * 把「工作项 + 会话聚合」分到三层。
 *
 * 分桶依据是 **日期键**（`toDateKeyWithBoundary` 的产物），不是时间戳比较——
 * 这样"显示为今日"与"分到今日栏"共用同一把尺子（见 `formatSessionTime`）。
 */
export function bucketContinuePrevious(
  entries: readonly ContinuePreviousEntry[],
  workItems: readonly WorkItemRef[],
  categoryById: Record<string, string | undefined>,
  options: BucketOptions,
): ContinuePreviousBuckets {
  const todayKey = toDateKeyWithBoundary(options.now, options.dayBoundaryHour)
  const yesterdayKey = shiftDateKey(todayKey, -1)
  const weekStartKey = shiftDateKey(todayKey, -7)

  const byId = new Map(workItems.map((item) => [item.id, item]))

  const today: ContinuePreviousEntry[] = []
  const yesterday: ContinuePreviousEntry[] = []
  const withinWeek: ContinuePreviousEntry[] = []

  for (const entry of entries) {
    const item = byId.get(entry.workItemId)
    if (isExcluded(item, categoryById)) continue
    const at = new Date(entry.lastSessionAt)
    if (Number.isNaN(at.getTime())) continue
    const key = toDateKeyWithBoundary(at, options.dayBoundaryHour)
    if (key === todayKey) today.push(entry)
    else if (key === yesterdayKey) yesterday.push(entry)
    else if (key > weekStartKey && key < todayKey) withinWeek.push(entry)
    // 更早 / 未来 → 丢弃
  }

  const byLastSessionDesc = (a: ContinuePreviousEntry, b: ContinuePreviousEntry): number =>
    Date.parse(b.lastSessionAt) - Date.parse(a.lastSessionAt)

  // 今日 / 昨日：按最近会话时间倒序
  today.sort(byLastSessionDesc)
  yesterday.sort(byLastSessionDesc)

  // 七天内堆积：**按优先级排布**（用户指定，高 > 中 > 低 > 未设），同档按时间倒序。
  // 口径待细化（ADR 未决项），此处取最简可解释实现。
  const priorityRank = (value: string | null | undefined): number => {
    if (value === 'high') return 0
    if (value === 'medium' || value === 'mid') return 1
    if (value === 'low') return 2
    return 3
  }
  withinWeek.sort((a, b) => {
    const ra = priorityRank(byId.get(a.workItemId)?.priority)
    const rb = priorityRank(byId.get(b.workItemId)?.priority)
    return ra !== rb ? ra - rb : byLastSessionDesc(a, b)
  })

  return {
    today: today.slice(0, options.maxToday ?? 3),
    yesterday: yesterday.slice(0, options.maxYesterday ?? 2),
    withinWeek: withinWeek.slice(0, options.maxWeek ?? 4),
  }
}

/** 把「会话关联行 + 会话行」聚合成每工作项的最近会话事实。 */
export function aggregateEntries(
  contexts: readonly SessionContextRow[],
  sessions: readonly SessionRow[],
): ContinuePreviousEntry[] {
  const sessionById = new Map<string, SessionRow>()
  for (const row of sessions) {
    const id = row.id
    if (typeof id === 'string' && id !== '') sessionById.set(id, row)
  }

  const acc = new Map<string, ContinuePreviousEntry>()
  for (const ctx of contexts) {
    const workItemId = ctx.level2WorkItemId
    const sessionId = ctx.sessionId
    if (typeof workItemId !== 'string' || workItemId === '') continue
    if (typeof sessionId !== 'string' || sessionId === '') continue
    const session = sessionById.get(sessionId)
    const startedAt = session?.startedAt
    if (typeof startedAt !== 'string' || startedAt === '') continue

    const prev = acc.get(workItemId)
    const seconds = typeof session?.focusedSeconds === 'number' ? session.focusedSeconds : 0
    if (!prev) {
      acc.set(workItemId, {
        workItemId,
        lastSessionAt: startedAt,
        sessionCount: 1,
        focusedSeconds: seconds,
      })
    } else {
      prev.sessionCount += 1
      prev.focusedSeconds += seconds
      if (Date.parse(startedAt) > Date.parse(prev.lastSessionAt)) prev.lastSessionAt = startedAt
    }
  }
  return [...acc.values()]
}

export interface ReadContinuePreviousInput {
  database: PomodoroXIDB
  workItems: readonly WorkItemRef[]
  categoryById: Record<string, string | undefined>
  dayBoundaryHour: number
  now?: Date
  maxToday?: number
  maxYesterday?: number
  maxWeek?: number
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 会话时间显示：今天/昨天用「今日 HH:MM」/「昨日 HH:MM」，更早用「MM-DD HH:MM」。
 *
 * 与分桶共用**同一个日期键**（`toDateKeyWithBoundary`），保证"显示为今日"与
 * "分到今日栏"永远不会互相矛盾。
 */
export function formatSessionTime(
  iso: string,
  options: { now: Date; dayBoundaryHour: number },
): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const todayKey = toDateKeyWithBoundary(at, options.dayBoundaryHour)
  const hhmm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  if (todayKey === toDateKeyWithBoundary(options.now, options.dayBoundaryHour)) {
    return `今日 ${hhmm}`
  }
  if (todayKey === shiftDateKey(toDateKeyWithBoundary(options.now, options.dayBoundaryHour), -1)) {
    return `昨日 ${hhmm}`
  }
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${hhmm}`
}

export interface ReadWorkMapsInput {
  database: PomodoroXIDB
}

/**
 * 读本地会话镜像并分桶（IO 包装）。
 *
 * 会话语料量级为「本地单机历史」，直接 `toArray()` 全量读取足够；
 * 若将来跨到万级，应改为按 `focusSessions.startedAt` 索引取近 7 天窗口。
 */
export async function readContinuePrevious(
  input: ReadContinuePreviousInput,
): Promise<ContinuePreviousBuckets> {
  const contexts = (await input.database.sessionTaskContexts.toArray()) as SessionContextRow[]
  const sessions = (await input.database.focusSessions.toArray()) as SessionRow[]
  const entries = aggregateEntries(contexts, sessions)
  return bucketContinuePrevious(entries, input.workItems, input.categoryById, {
    dayBoundaryHour: input.dayBoundaryHour,
    now: input.now ?? new Date(),
    maxToday: input.maxToday,
    maxYesterday: input.maxYesterday,
    maxWeek: input.maxWeek,
  })
}
