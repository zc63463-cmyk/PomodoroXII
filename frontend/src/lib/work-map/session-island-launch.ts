/**
 * 会话启动后的建岛编排 —— ADR-0008 S2 收口（D1 × D3 × D4 的最后一里）。
 *
 * ## 接线规则（本文是唯一权威表述，改行为先改这里）
 *
 * 1. **图 key = 启动器选中的三级工作项**（D1：一个 L3 = 一份 `.mm.md`）。
 *    会话归因仍只挂父 L2 —— 导图绑定与会话归因是两条独立关系，互不约束。
 * 2. 一次会话在**每个**被选中的 L3 的图上各建一个岛：这次会话确实同时投入了
 *    这些 L3，回到任一 L3 都应看到"历次会话干了什么"（D3 岛与会话 1:1，
 *    以**图**为单位）。各岛的 `level3Titles` 一致（本次全部计划项）。
 * 3. 未选任何 L3（如休息接续 `startFromRestCycle`）→ **不建岛**：图只锚 L3，
 *    没有绑定目标。这是有意的（对空锚建图会造出无主的图）。
 * 4. **只在会话 start 成功后调用**（D4）：调用方拿到真实 sessionId 后再走，
 *    不在用户点击时预建，避免"有岛无会话"的空壳事实。
 * 5. **幂等键 = sessionId**：`buildSessionIsland` 检测到同会话的 `centers`
 *    条目即不写（重试/双触发都不会产生第二个岛）。
 *
 * ## 失败策略（ADR-0008 不变量 4 的最后一道闸）
 * 任何一步失败（读/建/写/编排自身）都 **fail-soft**：记录原因、继续下一张图、
 * 绝不抛回调用方、绝不回滚会话。导图是辅助能力，会话闭环优先。
 *
 * ## 关于"不读回校验"
 * 写前读回（GET）只用于拿到现有原文做增量拼接；写后**不做**读回比对 ——
 * 冲突检测留给 S3+ 的串行化方案（规划 §6 风险 4 已登记）。当前单用户单标签页，
 * 写前读 + sessionId 幂等已覆盖重试与双触发两类重复写。
 */
import { buildSessionIsland } from './session-island'
import { readWorkMap, writeWorkMap } from './work-map-api'

export interface LaunchSessionIslandInput {
  /** 客户端生成的会话 id（与 coordinator.start 上行的同一枚，幂等键） */
  sessionId: string
  /** 会话开始时间（ISO；用于会话节点标题 `MM-DD HH:mm 会话`） */
  startedAt: string
  /** 本会话勾选的三级计划项（图 key；空数组 = 不建岛） */
  level3WorkItemIds: readonly string[]
  /** 标题解析源（工作项列表快照）；查不到标题就跳过该图 —— 不编造 */
  workItems: readonly { id: string; title: string }[]
}

export interface LaunchSessionIslandDeps {
  readWorkMap?: (workItemId: string) => Promise<string | null>
  writeWorkMap?: (workItemId: string, text: string) => Promise<unknown>
  onWarn?: (message: string) => void
}

export interface LaunchSessionIslandOutcome {
  /** 本次真正写了盘的图（workItemId） */
  created: string[]
  /** 无需变更或前置缺失的图（带原因） */
  skipped: { workItemId: string; reason: string }[]
  /** 读/写失败的图（带原因；已 fail-soft） */
  failed: { workItemId: string; reason: string }[]
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 会话节点标题：`09-30 21:50 会话`（本地时间；buildSessionIsland 头注口径）。 */
export function formatSessionIslandTitle(at: Date): string {
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())} 会话`
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 为一次刚启动的会话在其选中的每个 L3 图上建岛。
 *
 * 本函数**不抛异常**（见头注失败策略），返回结构化结果供日志/测试断言。
 */
export async function createLaunchSessionIslands(
  input: LaunchSessionIslandInput,
  deps: LaunchSessionIslandDeps = {},
): Promise<LaunchSessionIslandOutcome> {
  const read = deps.readWorkMap ?? readWorkMap
  const write = deps.writeWorkMap ?? writeWorkMap
  const warn = deps.onWarn ?? ((message: string) => console.warn(message))

  const outcome: LaunchSessionIslandOutcome = {
    created: [],
    skipped: [],
    failed: [],
  }

  try {
    const sessionId = input.sessionId?.trim() ?? ''
    if (sessionId === '') {
      outcome.skipped.push({ workItemId: '', reason: 'missing_session_id' })
      return outcome
    }

    // 去重保持顺序：重复勾选/列表脏数据不应造成双写
    const workItemIds = [...new Set(input.level3WorkItemIds)]
      .map((id) => id?.trim() ?? '')
      .filter((id) => id !== '')
    if (workItemIds.length === 0) return outcome // 规则 3：没有绑定目标，不建岛

    const titleById = new Map(input.workItems.map((item) => [item.id, item.title]))
    const level3Titles = workItemIds
      .map((id) => titleById.get(id))
      .filter((title): title is string => typeof title === 'string' && title.trim() !== '')

    const at = new Date(input.startedAt)
    const sessionTitle = formatSessionIslandTitle(
      Number.isNaN(at.getTime()) ? new Date() : at,
    )

    for (const workItemId of workItemIds) {
      try {
        const workItemTitle = titleById.get(workItemId)
        if (workItemTitle === undefined || workItemTitle.trim() === '') {
          outcome.skipped.push({ workItemId, reason: 'work_item_title_missing' })
          continue
        }

        // null = 尚无导图 → 空字符串走 buildFreshDocument（新建含 H1 的文档）
        const existing = await read(workItemId)
        const result = buildSessionIsland(existing ?? '', {
          sessionId,
          workItemTitle,
          sessionTitle,
          level3Titles,
          dir: 'right',
        })

        if (!result.changed) {
          outcome.skipped.push({
            workItemId,
            reason: result.reason ?? 'unchanged',
          })
          continue
        }

        await write(workItemId, result.text)
        outcome.created.push(workItemId)
      } catch (error) {
        const reason = reasonOf(error)
        outcome.failed.push({ workItemId, reason })
        warn(`[work-map] 会话 ${sessionId} 在图 ${workItemId} 建岛失败（不阻断会话）: ${reason}`)
      }
    }
  } catch (error) {
    // 编排自身的兜底：连"整理输入"都异常时也不许把异常抛回会话启动路径
    warn(`[work-map] 建岛编排异常（不阻断会话）: ${reasonOf(error)}`)
  }

  return outcome
}
