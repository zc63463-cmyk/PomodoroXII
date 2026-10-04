/**
 * 每日导图投影的 **IO 编排** —— 从 Dexie 取当日会话与计划，交给纯函数 + 读图。
 *
 * 与 `daily-evidence-provider.ts` 同一范式：IO 只做取数与形状适配，
 * 口径全在 `daily-map.ts` 的纯函数里。
 *
 * ## 为什么计划行要读 `sessionWorkItemPlans` 而不能从归因推
 * 归因只到 **L2**（`level2WorkItemId`），而**图 key 是 L3**（一个 L3 = 一份 `.mm.md`，
 * 见 `session-island-launch.ts` 头注规则 1）。两者不是一回事：
 * 一次会话可以同时计划多个 L3（D3），此时它会在**每张图**上各建一个岛。
 * 故图 key 只能从计划行拿。
 *
 * ## 取数范围纪律
 * 只取当日会话**涉及**的计划行（`sessionId` 定点过滤），不扫全表。
 * 导图本身走 HTTP（不进同步账本），**懒读**：只有走到 Phase 2 的用户才会发这些请求。
 */
import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'
import { readWorkMap } from '@/lib/work-map/work-map-api'

import {
  DEFAULT_DAY_BOUNDARY,
  emptyDailyEvidence,
  type DailyEvidenceSnapshot,
} from './daily-evidence'
import { readDailyEvidence } from './daily-evidence-provider'
import {
  groupFactsByWorkItem,
  readDailyMapProjection,
  type DailyMapProjection,
} from './daily-map'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

function guard(): PomodoroXIDB | null {
  try {
    return (spaceDBManager.current as PomodoroXIDB | undefined) ?? null
  } catch {
    return null
  }
}

export interface DailyMapBundle {
  evidence: DailyEvidenceSnapshot
  map: DailyMapProjection
}

/**
 * 一次读完「当日事实 + 当日导图投影」。
 *
 * ## 为什么合并成一个入口
 * 抽屉是**一个视觉单元**，分两个 effect 会各自 setState、闪两次。
 * 合并后单次 loading、原子呈现。
 *
 * ## 单 L2 口径下的额外短路
 * 计划行显示当日会话都只关联同一个 L2 时，只读**一张图**——多读就是白等。
 */
export async function readDailyMapBundle(
  dateKey: string,
  dayBoundaryHour: number = DEFAULT_DAY_BOUNDARY,
): Promise<DailyMapBundle> {
  const emptyMap: DailyMapProjection = { primary: null, slices: [], hanging: [], level2Count: 0 }

  const database = guard()
  if (database === null) {
    return { evidence: emptyDailyEvidence(dateKey), map: emptyMap }
  }

  let evidence: DailyEvidenceSnapshot
  try {
    evidence = await readDailyEvidence(dateKey, [], dayBoundaryHour)
  } catch (cause) {
    console.warn(
      `[daily-map] 会话事实读取失败（fail-soft）: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    return { evidence: emptyDailyEvidence(dateKey), map: emptyMap }
  }

  if (evidence.isEmpty) return { evidence, map: emptyMap }

  try {
    // 取当日会话涉及的计划行（sessionId 定点，不是全表）
    const sessionIds = new Set(evidence.sessions.map((fact) => fact.sessionId))
    const rawPlans = (await database.sessionWorkItemPlans.toArray()) as Record<string, unknown>[]
    const rawAttributions = (await database.sessionAttributionRevisions.toArray()) as Record<
      string,
      unknown
    >[]

    // 会话 → L3 计划项 id 列表（保留顺序，便于确定 primary）
    const planWorkItemIds = new Map<string, string[]>()
    // L3 → { 标题快照, 归属 L2 }（取该 L3 首次出现的计划行快照）
    const titleByWorkItem = new Map<string, string>()
    const level2ByWorkItem = new Map<string, string>()

    // 归因（会话 → L2）用于给 L3 反查归属
    const level2BySession = new Map<string, string>()
    for (const row of rawAttributions) {
      if (row.effective !== true) continue
      const sessionId = str(row.sessionId)
      const level2 = str(row.level2WorkItemId)
      if (sessionId !== '' && level2 !== '') level2BySession.set(sessionId, level2)
    }

    for (const row of rawPlans) {
      const sessionId = str(row.sessionId)
      if (!sessionIds.has(sessionId)) continue
      const workItemId = str(row.workItemId)
      if (workItemId === '') continue
      const titleSnapshot = str(row.titleSnapshot)

      const list = planWorkItemIds.get(sessionId)
      if (list === undefined) planWorkItemIds.set(sessionId, [workItemId])
      else if (!list.includes(workItemId)) list.push(workItemId)

      if (!titleByWorkItem.has(workItemId) && titleSnapshot !== '') {
        titleByWorkItem.set(workItemId, titleSnapshot)
      }
      if (!level2ByWorkItem.has(workItemId)) {
        level2ByWorkItem.set(workItemId, level2BySession.get(sessionId) ?? '')
      }
    }

    const grouped = groupFactsByWorkItem(
      evidence.sessions,
      planWorkItemIds,
      level2ByWorkItem,
      titleByWorkItem,
    )
    if (grouped.size === 0) return { evidence, map: emptyMap }

    const map = await readDailyMapProjection(grouped, readWorkMap)
    return { evidence, map }
  } catch (cause) {
    // 导图侧整体失败：会话事实仍然有用，不能一起丢掉
    console.warn(
      `[daily-map] 导图投影失败（fail-soft，保留会话事实）: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    return { evidence, map: emptyMap }
  }
}
