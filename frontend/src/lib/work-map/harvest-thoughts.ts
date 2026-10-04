/**
 * 会话复盘提炼（PXII-FEAT-REVIEW-HARVEST）—— 读侧纯函数层。
 *
 * ## 解决什么问题
 * 专注期间用「快速记录」写下的思考节点（D9 五类）只躺在 `.mm.md` 的会话岛里；
 * 结案复盘时面板是**只读**的，用户想把灵感变成正式待办得手动回导图逐个 `⇧P`，
 * 想写复盘笔记得手动誊抄 —— 「记了就扔在图里」的数据孤岛。本模块把"哪一条属于
 * 本次会话"这件事算清楚，交给 UI 去一键沉淀 / 一键注入。
 *
 * ## 只管提取，不落盘、不认识编辑命令
 * - 复用 `island-view` 的读链路（`parseMm` → `astToEditable` → `resolveCenters`
 *   → `projectIslands`），按 `island.sessionId === sessionId` **精确定位会话岛**
 *   （ADR-0008 D11：两处实现以协议为准，不在本模块重新解析 `.mm.md`）；
 * - 复用 `node-edits.normalizeNodeTitle` 压平标题 —— 与写侧同一把尺子，
 *   否则带换行的脏标题会撑破 Markdown 列表行；
 * - **不**生成 cid、**不**调编辑命令、**不**碰仓储层。
 *
 * ## fail-soft（ADR-0008 不变量 4 的读侧对应）
 * 无导图文本 / 空 sessionId / 解析失败 / 找不到该会话岛 / 任何异常 → 一律返回
 * **全空对象**，绝不抛。调用方据此"优雅收起"，回路面板照常渲染原有表单。
 *
 * ## 一条明确的取舍：无 `cid` 的思考节点**不进待办**
 * `HarvestedTodoItem.cid` 是"一键沉淀"回写导图编号的**唯一编辑键**（ADR-0008
 * D16-a：`EditableNode.id` 每次解析都重分配，跨渲染只认笔记块里的 `cid`）；
 * 手工写在导图里、没有 `cid` 的存量节点结构上无法安全改名，故**不**作为可沉淀
 * 待办出现（宁可不列，也不错写）。笔记类（洞察/决策/问题/复盘）只做文本搬运、
 * 不参与导图回写，故不受此限。
 */
import { findSessionIsland, readWorkMapView, type WorkMapNode } from './island-view'
import { normalizeNodeTitle } from './node-edits'
import type { ThoughtType } from './thought-types'

export interface HarvestedTodoItem {
  /** 节点在导图中的唯一键 cid */
  cid: string
  /** 原始/清洗后的标题 */
  title: string
  /** 所属子岛（= 最近一层祖先节点）或会话岛标题 */
  subIslandTitle: string
  /** 是否已被升格（标题以形如 `[PXII-102]` 开头） */
  alreadyPromoted: boolean
  /** 已经绑定的工作项 Key（例如 PXII-102），未绑定为 null */
  displayKey: string | null
}

export interface HarvestedThoughts {
  /** 待办思考项（含已升格与未升格，均带 cid） */
  todos: HarvestedTodoItem[]
  /** 洞察思考项（按导图顺序 = 记录先后顺序） */
  insights: string[]
  /** 决策思考项 */
  decisions: string[]
  /** 遇到的问题/卡点 */
  problems: string[]
  /** 历史复盘结论 */
  reviews: string[]
}

/**
 * 升格前缀 —— **与 `handlePromoteNode` 的回写格式严格对齐**：
 * 那条路径写的是 `` `[${created.displayKey}] ${title}` ``，本正则读取的正是它。
 * 容忍键里出现空白（`[ PXII-102 ]`），但要求 `字母-数字` 形状（displayKey 口径）。
 */
const PROMOTED_PREFIX = /^\[\s*([A-Za-z]+-\d+)\s*\]\s*/

/** 全部为空 —— fail-soft 的统一出口（每次新建对象，避免调用方互相污染）。 */
function emptyHarvest(): HarvestedThoughts {
  return { todos: [], insights: [], decisions: [], problems: [], reviews: [] }
}

/**
 * 纯函数：从导图文本中提取**指定会话岛**内的所有思考节点。
 *
 * @param mapText 已加载的 `.mm.md` 原文（`null`/空串 → 全空）
 * @param sessionId 本次会话 id（用于按 `centers` 条目精确定位会话岛）
 */
export function harvestSessionThoughts(
  mapText: string | null | undefined,
  sessionId: string,
): HarvestedThoughts {
  if (typeof mapText !== 'string' || mapText.trim() === '') return emptyHarvest()
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return emptyHarvest()

  try {
    const view = readWorkMapView(mapText)
    if (view === null) return emptyHarvest()
    const island = findSessionIsland(view, sid)
    if (island === null) return emptyHarvest()

    // 岛根 = 会话节点；`nodes` 是前序展开的**扁平**列表，故按 id 取根后自行下钻，
    // 才能同时拿到父子关系（`subIslandTitle` 需要最近一层祖先的标题）。
    const root = island.nodes.find((node) => node.id === island.rootId) ?? island.nodes[0]
    if (root === undefined) return emptyHarvest()

    const harvested = emptyHarvest()
    const visit = (nodes: readonly WorkMapNode[], parentTitle: string): void => {
      for (const node of nodes) {
        const title = normalizeNodeTitle(node.text)
        const type = node.thoughtType
        if (type !== null && title !== '') {
          collect(harvested, { type, title, cid: cidOf(node), parentTitle })
        }
        if (node.children.length > 0) {
          visit(node.children, title === '' ? parentTitle : title)
        }
      }
    }
    visit(root.children, normalizeNodeTitle(root.text))

    return harvested
  } catch {
    // 导图是辅助能力：解析异常绝不升级成复盘阻塞
    return emptyHarvest()
  }
}

/** 节点的 cid（笔记块未知键；缺失/非字符串/空白 → 空串）。 */
function cidOf(node: WorkMapNode): string {
  const raw = node.note?.cid
  return typeof raw === 'string' ? raw.trim() : ''
}

function collect(
  harvested: HarvestedThoughts,
  item: { type: ThoughtType; title: string; cid: string; parentTitle: string },
): void {
  if (item.type === 'todo') {
    // 无 cid 的存量节点不可安全改名（见文件头注的取舍）→ 不进待办列表
    if (item.cid === '') return
    const promoted = PROMOTED_PREFIX.exec(item.title)
    harvested.todos.push({
      cid: item.cid,
      title: item.title,
      subIslandTitle: item.parentTitle,
      alreadyPromoted: promoted !== null,
      displayKey: promoted === null ? null : promoted[1] ?? null,
    })
    return
  }
  switch (item.type) {
    case 'insight':
      harvested.insights.push(item.title)
      break
    case 'decision':
      harvested.decisions.push(item.title)
      break
    case 'problem':
      harvested.problems.push(item.title)
      break
    case 'review':
      harvested.reviews.push(item.title)
      break
  }
}

/** Markdown 笔记块的渲染顺序与图标（D9 五类中除 todo 外的四类）。 */
type HarvestNoteKey = 'decisions' | 'insights' | 'problems' | 'reviews'

const NOTE_SECTIONS: ReadonlyArray<{ key: HarvestNoteKey; icon: string; label: string }> = [
  { key: 'decisions', icon: '⚡', label: '决策' },
  { key: 'insights', icon: '💡', label: '洞察' },
  { key: 'problems', icon: '⚠️', label: '问题/卡点' },
  { key: 'reviews', icon: '🔁', label: '复盘' },
]

/**
 * 纯函数：把提取出的思考项格式化为可直接落进会话笔记的 Markdown 块。
 *
 * 输出形状（与设计规格逐字一致）：
 * ```
 * ### 💡 本轮专注思考提炼
 * - ⚡ **决策**：…
 * - 💡 **洞察**：…
 * - ⚠️ **问题/卡点**：…
 * ```
 * 某类为空则该类整体不渲染；四类皆空 → 返回**空串**（调用方据此收起入口）。
 */
export function formatHarvestedNoteMarkdown(
  thoughts: Pick<HarvestedThoughts, 'insights' | 'decisions' | 'problems' | 'reviews'>,
): string {
  const lines: string[] = []
  for (const section of NOTE_SECTIONS) {
    for (const raw of thoughts?.[section.key] ?? []) {
      const text = normalizeNodeTitle(typeof raw === 'string' ? raw : '')
      if (text === '') continue
      lines.push(`- ${section.icon} **${section.label}**：${text}`)
    }
  }
  if (lines.length === 0) return ''
  return ['### 💡 本轮专注思考提炼', ...lines].join('\n')
}
