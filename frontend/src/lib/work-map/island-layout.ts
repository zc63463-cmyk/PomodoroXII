/**
 * 工作导图几何层（读）—— ADR-0008 D15 步 3-1：**树形渲染的数据源**。
 *
 * ## 链路（在 `island-view` 的结构层之上补一段几何）
 * ```
 * parseMm → astToEditable → resolveCenters（自持）→ projectIslands
 *   → layoutIslands(projection, measure, ∅)   ← kernel：一行布局算法不自己写
 *       ↳ nodes[]: LayoutNode{node, box{x,y,w,h}, depth, parentId, children}
 *       ↳ links[]: LinkGeometry{path(SVG 路径串), fromId, toId}
 * ```
 *
 * ## 为什么「度量」自持（不引 @mindcanvas/react 的 createNodeMeasure）
 * react 的度量基于 canvas 精确字符宽度 + 三档字号 + 实体表，是给**完整 MapView** 用的；
 * 端口/编辑区只需要"盒不溢出、宽度相近"的**估算**（D13 最小集纪律：运输量随模块走）。
 * 自持估算 = 全角/半角分档 × 字号 + 内边距，并**夹在 [minW, maxW]**（超长标题靠渲染层
 * 省略号兜底）。与 MindCanvas 的精确度量分叉属预期：本层是**特化端口的呈现几何**，
 * 不是导图事实（协议里没有盒尺寸）。
 *
 * ## 边界
 * - fail-soft：解析失败/无根 → `null`（调用方渲染占位）
 * - 不产生任何写入；布局不进事实源（ADR-0008 不变量 1/2）
 */
import { astToEditable, layoutIslands, parseMm, projectIslands } from '@mindcanvas/kernel'
import type {
  EditableNode,
  IslandProjection,
  IslandSourceKind,
} from '@mindcanvas/kernel'

import { displayTextOf, resolveCenters } from './island-view'
import { isThoughtType, THOUGHT_TYPE_KEY, type ThoughtType } from './thought-types'

export interface MapBox {
  x: number
  y: number
  w: number
  h: number
}

export interface MapTreeNode {
  id: string
  text: string
  thoughtType: ThoughtType | null
  /** 该节点携带的 `session_id`（会话节点 = 岛根；其它节点为 null） */
  sessionId: string | null
  /** 会话节点便捷判定（= `sessionId !== null`） */
  sessionNode: boolean
  depth: number
  box: MapBox
  children: MapTreeNode[]
}

export interface MapIslandLayout {
  rootId: string
  sourceKind: IslandSourceKind
  /** 岛内任一节点的 `session_id`（会话岛）；非会话岛为 null */
  sessionId: string | null
  /** 岛根（会话节点）的树 */
  tree: MapTreeNode
  /** 前序展开（含 box），便于计数/筛选 */
  nodes: MapTreeNode[]
  /** 岛内连线（SVG path，来自 kernel；已按所属岛过滤） */
  links: { fromId: string; toId: string; path: string }[]
  /** 岛内包围盒（世界坐标，来自节点盒） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface WorkMapLayout {
  islands: MapIslandLayout[]
  diagnostics: { code: string; message: string }[]
}

const NODE_H = 28
const MIN_W = 76
const MAX_W = 240
/** 三档字号（root / branch / leaf）：与端口渲染层同一视觉档口径 */
const fontOf = (depth: number): number => (depth === 0 ? 12.5 : depth === 1 ? 12 : 11)

/** 全角判定（CJK/假名/全角标点等，按 2 倍半角宽估算） */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

function estimateTextWidth(text: string, size: number): number {
  let units = 0
  for (const ch of text) units += WIDE_CHAR.test(ch) ? 1 : 0.55
  return units * size
}

/** 节点度量（kernel `MeasureFn` 口径）：盒 = 文本估算 + 内边距，夹紧到 [MIN_W, MAX_W]。 */
export function measureWorkMapNode(node: EditableNode, depth = 0): { w: number; h: number } {
  const text = displayTextOf(node)
  const raw = estimateTextWidth(text === '' ? '　' : text, fontOf(depth)) + 24
  return { w: Math.max(MIN_W, Math.min(MAX_W, Math.round(raw))), h: NODE_H }
}

/** 与度量同一把尺子的文字截断（SVG 没有 ellipsis，超出部分自行补 `…`）。 */
export function fitTextToBox(text: string, boxW: number, depth = 0): string {
  const budget = boxW - 24
  if (budget <= 0 || text === '') return text
  if (estimateTextWidth(text, fontOf(depth)) <= budget) return text
  const ellipsis = estimateTextWidth('…', fontOf(depth))
  let out = ''
  let used = 0
  for (const ch of text) {
    const width = estimateTextWidth(ch, fontOf(depth))
    if (used + width + ellipsis > budget) break
    out += ch
    used += width
  }
  return `${out}…`
}

/** 节点树 → 视图树（box 取自布局结果；缺 box 时回退度量，保证始终可渲染）。 */
function toTreeNode(
  node: EditableNode,
  depth: number,
  boxById: Map<string, MapBox>,
): MapTreeNode {
  const note = (node.note ?? {}) as Record<string, unknown>
  const rawType = note[THOUGHT_TYPE_KEY]
  const rawSession = note.session_id
  const sessionId = typeof rawSession === 'string' && rawSession !== '' ? rawSession : null
  const fallback = measureWorkMapNode(node, depth)
  return {
    id: node.id,
    text: displayTextOf(node),
    thoughtType: isThoughtType(rawType) ? rawType : null,
    sessionId,
    sessionNode: sessionId !== null,
    depth,
    box: boxById.get(node.id) ?? { x: 0, y: 0, w: fallback.w, h: fallback.h },
    children: node.children.map((child) => toTreeNode(child, depth + 1, boxById)),
  }
}

function flatten(node: MapTreeNode, out: MapTreeNode[] = []): MapTreeNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

/** 岛内包围盒（由节点盒推导；kernel 的岛级包围盒留给多岛全览用）。 */
function boundsOf(nodes: MapTreeNode[]): MapIslandLayout['bounds'] {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    minX = Math.min(minX, node.box.x)
    minY = Math.min(minY, node.box.y)
    maxX = Math.max(maxX, node.box.x + node.box.w)
    maxY = Math.max(maxY, node.box.y + node.box.h)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 读一份工作导图并计算几何（fail-soft）。
 *
 * @returns 解析成功 → 布局视图；失败 → `null`（只记 warn）
 */
export function readWorkMapLayout(text: string): WorkMapLayout | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const parsed = parseMm(text)
    if (parsed.root === null) return null
    const editable = astToEditable(parsed.root)
    if (editable === null) return null

    const { specs, diagnostics: centerDiagnostics } = resolveCenters(editable)
    const projection: IslandProjection = projectIslands(editable, specs)
    const layout = layoutIslands(projection, measureWorkMapNode, new Set())

    const boxById = new Map<string, MapBox>()
    for (const layoutNode of layout.nodes) {
      boxById.set(layoutNode.node.id, {
        x: Math.round(layoutNode.box.x),
        y: Math.round(layoutNode.box.y),
        w: Math.round(layoutNode.box.w),
        h: Math.round(layoutNode.box.h),
      })
    }

    const islands = projection.islands.map((island) => {
      const members = new Set(island.memberIds)
      const tree = toTreeNode(island.projectedRoot, 0, boxById)
      const nodes = flatten(tree)
      const links = layout.links
        .filter((link) => members.has(link.fromId) && members.has(link.toId))
        .map((link) => ({ fromId: link.fromId, toId: link.toId, path: link.path }))
      // 会话 id：取岛内首个携带 session_id 的节点（本项目建岛时写在岛根上）
      const sessionId = nodes.find((node) => node.sessionId !== null)?.sessionId ?? null
      return {
        rootId: island.rootId,
        sourceKind: island.sourceKind,
        sessionId,
        tree,
        nodes,
        links,
        bounds: boundsOf(nodes),
      } satisfies MapIslandLayout
    })

    return {
      islands,
      diagnostics: [
        ...centerDiagnostics,
        ...projection.diagnostics.map((d) => ({ code: d.code, message: d.message })),
      ],
    }
  } catch (cause) {
    console.warn(
      `[work-map] 布局失败（fail-soft）: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return null
  }
}

/** 按会话定位其岛布局（编辑区/小视图的主查询）。 */
export function findSessionIslandLayout(
  layout: WorkMapLayout,
  sessionId: string,
): MapIslandLayout | null {
  if (sessionId === '') return null
  return layout.islands.find((island) => island.sessionId === sessionId) ?? null
}
