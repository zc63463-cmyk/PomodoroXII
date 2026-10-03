/**
 * 每日导图投影（反思页 · Phase 2）—— 把「当日会话」换算成「当日导图思考」。
 *
 * ## 为什么必须走「会话 → L3 图 key」这条路（而不是直接看导图）
 * `.mm.md` **按 L3 工作项 id 存**（`GET /api/v1/work-maps/{workItemId}`），
 * 且导图里**没有任何时间维度** —— 会话岛只带 `session_id`，日期得由会话侧算。
 * 所以"今日导图"的唯一正确算法是：
 * ```
 * 当日会话 → 各会话的 L3 计划项（= 图 key）→ 读 .mm.md → 按 sessionId 定位岛 → 提思考
 * ```
 * 这也是本模块**不做**的事：给导图加时间过滤、跨多图合并成一张画布。
 *
 * ## 单 L2 口径（首期明确的取舍，不是偷懒）
 * 同一天跨两个 L2 意味着**两份独立 HTTP 文档 + N 份布局**，不是切标签。
 * 本模块取**第一个有导图的 L2** 作为呈现源，其余 L2 的思考仍会并入悬挂项
 * （思考本身不带 L2 归属，合并无损），但**只呈现一张图**。
 * 多图并显要等串行化方案（ADR-0008 S3+）落地后再做。
 *
 * ## 只提「今天记下的」思考
 * `harvestSessionThoughts(mapText, sessionId)` 按会话岛**精确定位**，
 * 故拿到的是"这次会话里记的东西"，天然完成时间限定 —— 不需要额外按日期过滤节点。
 *
 * ## fail-soft 三连（导图是辅助能力，任何一环失败都不许炸反思页）
 * 1. HTTP 404 → `null`（"尚无导图"是正常状态）
 * 2. HTTP 其他错误 / 解析失败 → `harvestSessionThoughts` 自返全空
 * 3. 本模块聚合层再包一层：任一图读失败只跳过该图，**不影响其它图与整页**
 */
import { harvestSessionThoughts } from '@/lib/work-map/harvest-thoughts'
import { readWorkMap } from '@/lib/work-map/work-map-api'
import type { ThoughtType } from '@/lib/work-map/thought-types'

import type { DailySessionFact, HangingThought } from './daily-evidence'

/** 需要从导图取出的思考类型（其余类型不进悬挂项）。 */
const HANGING_TYPES: ReadonlySet<ThoughtType> = new Set(['todo', 'problem'])

/** 一张导图的当日切片。 */
export interface DailyMapSlice {
  /** 图 key = L3 工作项 id */
  workItemId: string
  /** 呈现用的标题（取自会话计划快照，不另查工作项表 —— 省一次读且快照即当刻事实） */
  title: string
  /** `.mm.md` 原文；null = 尚无导图 / 读取失败 */
  mapText: string | null
  /** 归属的二级工作项 id（单 L2 口径的判定依据） */
  level2WorkItemId: string
  /** 本图内当日会话 id 集合（传给 TimerMapOverview 做「本次」高亮） */
  sessionIds: string[]
}

export interface DailyMapProjection {
  /** 呈现源（单 L2 口径：第一个有导图的切片）；无 → null */
  primary: DailyMapSlice | null
  /** 全部切片刻画（调试与多图并显的预备） */
  slices: DailyMapSlice[]
  /** 合并去重后的悬挂项 */
  hanging: HangingThought[]
  /** 涉及的二级工作项数（>1 时 UI 应显式说明"仅呈现其中一个"） */
  level2Count: number
}

/**
 * 按图分组会话事实 → 每会话的计划项 id。
 *
 * `SessionRow` 里没有 L3 计划项，调用方需要先从 `sessionWorkItemPlans` 拿到
 * 「会话 → L3 计划项」映射再传入（provider 层做）。这里只负责**分组**。
 */
export function groupFactsByWorkItem(
  facts: readonly DailySessionFact[],
  planWorkItemIds: ReadonlyMap<string, readonly string[]>,
  level2ByWorkItem: ReadonlyMap<string, string>,
  titleByWorkItem: ReadonlyMap<string, string>,
): Map<string, { level2WorkItemId: string; title: string; sessionIds: string[] }> {
  const grouped = new Map<string, { level2WorkItemId: string; title: string; sessionIds: string[] }>()
  for (const fact of facts) {
    const workItemIds = planWorkItemIds.get(fact.sessionId) ?? []
    for (const workItemId of workItemIds) {
      if (workItemId === '') continue
      const level2WorkItemId = level2ByWorkItem.get(workItemId) ?? fact.level2WorkItemId ?? ''
      const title = titleByWorkItem.get(workItemId) ?? fact.titleSnapshot ?? '未命名任务'
      const existing = grouped.get(workItemId)
      if (existing === undefined) {
        grouped.set(workItemId, { level2WorkItemId, title, sessionIds: [fact.sessionId] })
      } else if (!existing.sessionIds.includes(fact.sessionId)) {
        existing.sessionIds.push(fact.sessionId)
      }
    }
  }
  return grouped
}

/**
 * 读当日导图并提炼悬挂项。
 *
 * @param grouped 来自 {@link groupFactsByWorkItem} 的分组
 * @param readMap 读图函数（注入以便单测；生产传 `readWorkMap`）
 */
export async function readDailyMapProjection(
  grouped: ReadonlyMap<string, { level2WorkItemId: string; title: string; sessionIds: string[] }>,
  readMap: (workItemId: string) => Promise<string | null> = readWorkMap,
): Promise<DailyMapProjection> {
  const slices: DailyMapSlice[] = []
  const hanging: HangingThought[] = []
  const level2Seen = new Set<string>()

  // 逐图读（串行）：单 L2 口径下通常只有 1-2 张图，并发收益抵不过复杂度。
  // 顺序确定 → primary 的选择也确定，UI 不会在两次渲染间跳图。
  for (const [workItemId, meta] of grouped) {
    let mapText: string | null = null
    try {
      mapText = await readMap(workItemId)
    } catch (cause) {
      // 纪律③：单图读失败只跳过该图 —— 反思页与其它图都不受影响
      console.warn(
        `[daily-map] 导图读取失败（fail-soft，跳过该图）: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
      continue
    }

    if (meta.level2WorkItemId !== '') level2Seen.add(meta.level2WorkItemId)

    // 尚无导图（404 → null）：不产切片，但**不中断**（该会话可能本来就没建岛）
    if (mapText === null || mapText.trim() === '') continue

    slices.push({
      workItemId,
      title: meta.title,
      mapText,
      level2WorkItemId: meta.level2WorkItemId,
      sessionIds: meta.sessionIds,
    })

    // 逐会话提炼：精确定位该会话在图里的岛
    for (const sessionId of meta.sessionIds) {
      const thoughts = harvestSessionThoughts(mapText, sessionId)
      for (const item of thoughts.todos) {
        hanging.push({
          cid: item.cid,
          title: item.title,
          thoughtType: 'todo',
          sessionId,
        })
      }
      for (const problem of thoughts.problems) {
        // problems 是纯文本（无 cid），用「会话 + 文本」合成一个稳定的去重键；
        // 合成键只用于本模块内的合并去重，**不用于回写**（回写只认 todo 的 cid）
        hanging.push({
          cid: `problem:${sessionId}:${problem}`,
          title: problem,
          thoughtType: 'problem',
          sessionId,
        })
      }
    }
  }

  // 呈现源：单 L2 口径 —— 取第一个有导图的切片
  const primary = slices.length > 0 ? (slices[0] as DailyMapSlice) : null

  // 悬挂项按 cid 去重（`daily-evidence.ts` 内已有 dedupHanging，这里传原始集合
  // 让下游统一去重，避免同一份逻辑写两遍）
  return { primary, slices, hanging, level2Count: level2Seen.size }
}

/**
 * 从提炼结果里筛出「真悬挂项」。
 *
 * 已被升格的待办（标题以 `[PXII-102]` 开头）**不再悬挂** —— 它已经变成正式任务，
 * 再出现在"悬挂清单"里是重复计数、也是对用户的二次骚扰。
 */
export function filterHanging(items: readonly HangingThought[]): HangingThought[] {
  return items.filter((item) => {
    if (item.thoughtType === 'problem') return item.title !== ''
    if (item.cid === '') return false
    return !/^\[\s*[A-Za-z]+-\d+\s*\]/.test(item.title)
  })
}

/** 判断某类型是否应进入悬挂清单（供 UI 图例与说明文案共用同一口径）。 */
export function isHangingType(type: ThoughtType): boolean {
  return HANGING_TYPES.has(type)
}
