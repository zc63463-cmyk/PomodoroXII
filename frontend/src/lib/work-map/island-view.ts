/**
 * 工作导图读取（最小数据层）—— ADR-0008 集成特化的第一切片。
 *
 * ## 职责与边界
 * 读 `.mm.md` → 可编辑树 → **岛投影**，产出端口渲染所需的结构化数据：
 * ```
 * parseMm(text)            kernel：.mm.md → MindNode AST（协议 v1.3.1）
 *   → astToEditable(node)  kernel：AST → 带稳定 id 的编辑树
 *   → resolveCenters(tree) ★ 本模块自持：centers 条目 → ValidatedCenterSpec
 *   → projectIslands(...)  kernel：岛投影（根岛 + 升格岛 + 边界边 + 诊断）
 * ```
 * 渲染不在本模块（S3 端口按集成特化形态实现）；布局（layoutForest/layoutIslands）
 * 也不在——行式/岛卡端口不需要几何排布，需要时再按需接入。
 *
 * ## 为什么「读数」自持而不是接 `@mindcanvas/react` 的 collectCenters
 * 1. ADR-0008 D10：**按功能模块接入**——投影只需要"条目 → nodeId"这一步，
 *    而 react 包带 `workspace:*` 依赖不可安装，且其渲染器不在 S3 最小集内；
 * 2. D11 已有同类先例（建岛自持精简实现）：**两处实现以协议为准**，
 *    测试锚在协议可观察行为上（cid 优先 / 路径锚 / 三态 / 坐标成对）。
 *
 * ## 已知限制（有意为之的最小面，按需再补）
 * - 路径锚只做**严格全路径**匹配（空名节点不占路径段）；同名多命中判 `stale`
 *   （宁可不写也不错写）；**未**实现实体锚的 `#N` 序号消歧（`@kind:id` 解析为 dangling）
 * - `dir` 缺省按 `right`（协议缺省航向；本项目写出侧恒显式写 dir）
 * - 坐标 `x`/`y` 必须**成对**且可转有限数（协议口径：单个不认）
 * - **单键 centers 条目不兼容**（实测 2026-09-30）：kernel 的 note 解析把
 *   "只有一个 `k: v` 行"的列表项解析成**标量字符串**（`- at: "…"` →
 *   `"at: \"…\""`），多键条目才是记录。本项目写出侧恒写 `at`+`cid`+`dir`
 *   故不受影响；若未来要兼容"只写 at"的外部文档，需先与 MindCanvas 侧
 *   对齐该解析口径（属协议交互，不在本模块内私自补偿）。
 *
 * ## fail-soft（ADR-0008 不变量 4 的读侧对应）
 * 解析失败 / 无根 / 空文本 → 返回 `null` 并记一条 warn；**绝不抛**。
 * 调用方（端口组件）据此渲染"暂无导图"而不是炸掉页面。
 */
import { astToEditable, parseMm, projectIslands } from '@mindcanvas/kernel'
import type {
  EditableNode,
  IslandProjection,
  IslandSourceKind,
  ValidatedCenterSpec,
} from '@mindcanvas/kernel'

/** 端口渲染用的节点视图（kernel 内部 id 原样带出，作稳定 key）。 */
export interface WorkMapNode {
  id: string
  /** 展示文本：text 节点取文本；entity 节点降级为 `kind:id`；image 取 url */
  text: string
  /** 该节点的协议 note（cid / session_id / note 列表等，原样带出，不解释） */
  note: Record<string, unknown> | null
  children: WorkMapNode[]
}

/** 一个岛（会话岛或根岛）的渲染视图。 */
export interface WorkMapIsland {
  rootId: string
  sourceKind: IslandSourceKind
  /** 岛内任一节点带 `session_id` 时取其值（会话岛）；否则 null */
  sessionId: string | null
  /** 岛内节点（岛根在首位，前序展开） */
  nodes: WorkMapNode[]
}

export interface WorkMapView {
  /** 文档根（= 工作项标题所在的 H1 节点） */
  root: WorkMapNode
  islands: WorkMapIsland[]
  diagnostics: { code: string; message: string }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 岛生长方向（协议值域；非法值按缺省 right 处理） */
const growDirOf = (value: unknown): 'left' | 'right' => (value === 'left' ? 'left' : 'right')

/**
 * 坐标读数：`x`/`y` 必须成对出现且可转有限数（协议口径：单个不认）。
 *
 * ⚠ 实测（2026-09-30 spike）：kernel 的 note 解析把标量保留为**字符串**
 * （`x: 900` 读出 `"900"`）——必须显式强转，否则坐标静默丢失。
 */
function positionOf(raw: Record<string, unknown>): { x: number; y: number } | null {
  if (raw.x === undefined || raw.y === undefined) return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/** 节点展示文本（与 kernel 侧 `anchorName` 同口径的展示降级）。 */
export function displayTextOf(node: EditableNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'entity' && node.ref) return `${node.ref.kind}:${node.ref.id}`
  if (node.type === 'image') return node.url ?? ''
  return ''
}

/** 深度优先展开（前序），映射成端口视图。 */
function toWorkMapNode(node: EditableNode): WorkMapNode {
  return {
    id: node.id,
    text: displayTextOf(node),
    note: node.note ? { ...(node.note as Record<string, unknown>) } : null,
    children: node.children.map(toWorkMapNode),
  }
}

/** 路径锚反查：严格全路径匹配；0 命中 dangling、多命中 stale（宁可不写也不错写）。 */
function nodeIdForPath(
  root: EditableNode,
  target: string,
): { nodeId: string | null; state: 'well-formed' | 'dangling' | 'stale' } {
  const want = target.startsWith('node:') ? target.slice('node:'.length) : target
  const hits: string[] = []
  const walk = (node: EditableNode, segments: string[]): void => {
    const name = node.type === 'text' ? (node.text ?? '') : ''
    const next = name === '' ? segments : [...segments, name]
    if (name !== '' && next.join('/') === want) hits.push(node.id)
    for (const child of node.children) walk(child, next)
  }
  walk(root, [])
  if (hits.length === 0) return { nodeId: null, state: 'dangling' }
  if (hits.length > 1) return { nodeId: null, state: 'stale' }
  return { nodeId: hits[0], state: 'well-formed' }
}

/** cid → nodeId 索引（首次出现优先，与协议 first-wins 一致）。 */
function buildCidIndex(root: EditableNode): Map<string, string> {
  const index = new Map<string, string>()
  const walk = (node: EditableNode): void => {
    const cid = (node.note as Record<string, unknown> | undefined)?.cid
    if (typeof cid === 'string' && cid !== '' && !index.has(cid)) index.set(cid, node.id)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return index
}

/**
 * centers 条目 → `ValidatedCenterSpec[]`（自持读数，协议可观察行为见文件头注）。
 *
 * 解析优先级：**cid 优先，`at` 兜底**（协议：带 cid 的条目改名/移动不 dangling）。
 * 非记录条目跳过并产出诊断。
 */
export function resolveCenters(documentRoot: EditableNode): {
  specs: ValidatedCenterSpec[]
  diagnostics: { code: string; message: string }[]
} {
  const raw = (documentRoot.note as Record<string, unknown> | undefined)?.centers
  const diagnostics: { code: string; message: string }[] = []
  if (!Array.isArray(raw) || raw.length === 0) return { specs: [], diagnostics }

  const cidIndex = buildCidIndex(documentRoot)
  const specs: ValidatedCenterSpec[] = []
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      diagnostics.push({
        code: 'center-entry-invalid',
        message:
          `centers[${index}] 不是记录，已跳过` +
          `（实测口径：只有单个 k: v 行的条目会被 kernel 解析成标量）`,
      })
      return
    }
    const cid = typeof item.cid === 'string' && item.cid !== '' ? item.cid : undefined
    const at = typeof item.at === 'string' ? item.at : ''
    let nodeId: string | null = null
    let state: ValidatedCenterSpec['state'] = 'dangling'
    if (cid !== undefined) {
      const hit = cidIndex.get(cid)
      if (hit !== undefined) {
        nodeId = hit
        state = 'well-formed'
      }
    }
    if (nodeId === null && at.startsWith('node:')) {
      const resolved = nodeIdForPath(documentRoot, at)
      nodeId = resolved.nodeId
      state = resolved.state
    }
    specs.push({ nodeId, at, dir: growDirOf(item.dir), pos: positionOf(item), state })
  })
  return { specs, diagnostics }
}

/** 岛投影结果 → 端口视图（会话岛带上 session_id 以便按会话定位）。 */
function toWorkMapIsland(
  byId: Map<string, EditableNode>,
  island: IslandProjection['islands'][number],
): WorkMapIsland {
  let sessionId: string | null = null
  for (const memberId of island.memberIds) {
    const sid = (byId.get(memberId)?.note as Record<string, unknown> | undefined)?.session_id
    if (typeof sid === 'string' && sid !== '') {
      sessionId = sid
      break
    }
  }
  return {
    rootId: island.rootId,
    sourceKind: island.sourceKind,
    sessionId,
    nodes: island.memberIds.flatMap((id) => {
      const node = byId.get(id)
      return node ? [toWorkMapNode(node)] : []
    }),
  }
}

/**
 * 读一份工作导图（fail-soft）。
 *
 * @returns 解析成功 → 视图；解析失败 / 无根 / 空文本 → `null`（只记 warn，不抛）
 */
export function readWorkMapView(text: string): WorkMapView | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const parsed = parseMm(text)
    if (parsed.root === null) {
      console.warn(
        `[work-map] 解析无根，按"暂无导图"处理（diagnostics=${parsed.diagnostics.length}）`,
      )
      return null
    }
    const editable = astToEditable(parsed.root)
    if (editable === null) return null

    const { specs, diagnostics: centerDiagnostics } = resolveCenters(editable)
    const projection = projectIslands(editable, specs)

    const byId = new Map<string, EditableNode>()
    const walk = (node: EditableNode): void => {
      byId.set(node.id, node)
      for (const child of node.children) walk(child)
    }
    walk(editable)

    return {
      root: toWorkMapNode(editable),
      islands: projection.islands.map((island) => toWorkMapIsland(byId, island)),
      diagnostics: [
        ...centerDiagnostics,
        ...projection.diagnostics.map((d) => ({ code: d.code, message: d.message })),
      ],
    }
  } catch (cause) {
    console.warn(
      `[work-map] 解析失败（fail-soft）: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return null
  }
}

/** 按会话定位其岛（运行态端口的主查询）。找不到返回 `null`。 */
export function findSessionIsland(view: WorkMapView, sessionId: string): WorkMapIsland | null {
  if (sessionId === '') return null
  return view.islands.find((island) => island.sessionId === sessionId) ?? null
}
