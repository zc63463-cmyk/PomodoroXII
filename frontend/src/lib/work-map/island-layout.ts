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
 * - 近 N 展开（D19-a）：默认只展开最新 5 个会话岛，更早的历史会话聚合成一个
 *   **虚拟归档岛**（`isArchive` + `archivedCount`）—— 纯视图层投影切片，
 *   绝不改写 `.mm.md`（历史节点 / cid / session_id / centers 原样保留）
 * - **幕布描述块（PXII-FEAT-DESC-BLOCK）**：节点盒高度随 `note:` 列表行数动态增长
 *   （`NODE_H_BASE` + 可见行数 × `DESC_LINE_H`），宽度同向扩宽 —— 垂直空间必须在
 *   度量阶段就预留，否则描述文字会画出盒外压住下方节点（见 `measureWorkMapNode`）
 */
import { astToEditable, layoutIslands, parseMm, projectIslands } from '@mindcanvas/kernel'
import type {
  EditableNode,
  IslandSourceKind,
  LayoutIsland,
} from '@mindcanvas/kernel'

import { displayTextOf, resolveCenters } from './island-view'
import { isThoughtType, THOUGHT_TYPE_KEY, type ThoughtType } from './thought-types'

/**
 * 近 N 展开的默认阈值（ADR-0008 D19-a 实测黄金点）：N=5 时世界高恒定 868px、
 * k≈0.83（字号 10px）、布局 <1ms，覆盖用户半日专注心流；全平铺在 50 岛时 k 跌至 0.086。
 */
export const WORK_MAP_DEFAULT_ACTIVE_LIMIT = 5

/** 读图选项（ADR-0008 D19-a：近 N 展开 + 历史归档岛）。 */
export interface WorkMapLayoutOptions {
  /**
   * 展开的最近会话岛数（默认 5）。只统计携带 `session_id` 的会话岛；
   * 根岛与非会话升格中心不受限，恒展开。
   */
  activeLimit?: number
  /** 全量展开（归档岛卡片 / 「全部展开」切换的目标态）；默认 false */
  expandAll?: boolean
}

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
  /**
   * 节点笔记块里的稳定编辑键 `cid`（ADR-0008 D16-a）。
   * 缺失 / 脏值 → `null`（**只读**：存量无 cid 节点不提供编辑入口）。
   */
  cid: string | null
  /** 块内 `note:` 列表（S0 形状，一行一条）；缺失 / 脏值 → `null` */
  comment: string[] | null
  /**
   * 实体引用 id（D19-b 依赖徽章锚点）：entity 节点取 `ref.id`（如 work_item UUID），
   * 其余节点为 null。徽章按此键对位（``@work_item:<id>`` 的 ``<id>``）。
   */
  refId: string | null
  /** 实体引用 kind（如 `work_item`）；非 entity 节点为 null */
  refKind: string | null
  depth: number
  box: MapBox
  children: MapTreeNode[]
}

export interface MapSubIsland {
  id: string
  title: string
  cid: string | null
  rootNode: MapTreeNode
  nodes: MapTreeNode[]
  links: { fromId: string; toId: string; path: string }[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface MapIslandLayout {
  rootId: string
  /**
   * 岛来源；`'archive'` = 虚拟的**历史会话归档岛**（ADR-0008 D19-a：纯视图层投影切片，
   * 不对应任何真实节点，渲染层画成卡片）。
   */
  sourceKind: IslandSourceKind | 'archive'
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
  /** 嵌套子岛（L3 任务及其后代思考形成的子岛列表） */
  subIslands?: MapSubIsland[]
  /** 是否为归档岛（真岛缺省 false / 无此字段） */
  isArchive?: boolean
  /** 是否为方案 A 横向群岛排布 */
  isArchipelago?: boolean
  /** 归档岛收纳的历史会话数 M（仅归档岛有） */
  archivedCount?: number
}

export interface WorkMapLayout {
  islands: MapIslandLayout[]
  diagnostics: { code: string; message: string }[]
}

/** 节点盒基础高度（无描述时的高度；= 渲染层单行文字盒） */
export const NODE_H_BASE = 28
/**
 * **会话发端枢纽（Anchor Hub）**边长（PXII-FEAT-SESSION-HUB）——
 * 会话岛根不再画成宽矩形卡片，而是收拢为紧凑的圆形发端枢纽；会话标题上浮到
 * 地标卡顶栏（渲染层 `wm-island-title`），画布内不再有被截断的 `10-01 14:29 会…`。
 *
 * 尺寸是**几何不变量**：kernel `layoutIslands` 按 measure 返回的 `w/h` 排布，
 * 岛根盒缩小 → 子节点整列向左紧凑平移（`placeSubtree` 取 `xEdge + H_GAP`），
 * 连线由 `islandLinks` 按平移后的世界坐标重建 —— 两端自动贴合新盒缘。
 */
export const SESSION_HUB_SIZE = 28

/**
 * 地标卡顶栏会话标题字号（PXII-FEAT-SESSION-HUB）—— 会话标题从画布节点**上浮**
 * 到岛地标卡顶栏后，用的是"岛级"字号档，与节点三档字号（root/branch/leaf）无关。
 *
 * 渲染层用 `fontSize={ISLAND_TITLE_FONT_SIZE}` 显式给定、截断估算用同一档
 * （`fitIslandTitleToWidth` 缺省值）—— 两处同源，标题才不会画出卡外压住角标。
 */
export const ISLAND_TITLE_FONT_SIZE = 11.5
/**
 * 描述行高与节点盒内边距（对齐 MindCanvas `DescBlock` 的世界 px 口径：
 * `DESC_LINE_H = 15` / `DESC_PAD = 5`，此处按本项目 SVG 盒略收窄）。
 *
 * ⚠️ 行高**不随层级差分**（同 DescBlock 的裁决）：度量拿不到渲染层的字号档，
 * 若行高随 depth 变而度量不变，预留高度就会与画出的文字错位。
 */
export const DESC_LINE_H = 14
/** 描述区上内边距（标题行与描述首行之间的呼吸） */
export const DESC_PAD_TOP = 4
/** 描述区下内边距 */
export const DESC_PAD_BOTTOM = 4
/**
 * 盒内可见描述行数上限：超出部分**不撑高节点**，靠原生 `<title>` tooltip
 * 与「选中后的操作行列表」给全文（同 DescBlock 的「软上限 + 滚动」语义，
 * 这里用 SVG 无法内滚，故以 tooltip 兜底）。
 */
export const DESC_MAX_VISIBLE_LINES = 3
/** 节点盒最小与最大宽度（调整为更紧凑优雅的比例） */
export const NODE_MIN_W = 64
export const NODE_MAX_W = 200
const MIN_W = NODE_MIN_W
const MAX_W = NODE_MAX_W

/** 嵌套子岛安全内边距（全局多岛流默认态：垂直仅留 3px，确保 14px 行距下相邻卡片保持 8px 绝对间隙） */
export const SUB_ISLAND_PAD = {
  left: 8,
  top: 3,
  right: 8,
  bottom: 3,
}

/** 嵌套子岛聚焦态安全内边距（单岛聚焦态，预留顶栏地标标题与底部返回按钮空间） */
export const SUB_ISLAND_FOCUSED_PAD = {
  left: 16,
  top: 32,
  right: 18,
  bottom: 32,
}

/** 计算子岛视觉呈现包围盒（含内边距与微标签/地标顶栏空间，聚焦态保底 340×140 避免挤压） */
export function subIslandVisualBounds(
  subIsland: MapSubIsland,
  isFocused = false,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (isFocused) {
    const pad = SUB_ISLAND_FOCUSED_PAD
    const naturalW = subIsland.bounds.maxX - subIsland.bounds.minX + pad.left + pad.right
    const naturalH = subIsland.bounds.maxY - subIsland.bounds.minY + pad.top + pad.bottom
    const w = Math.max(340, naturalW)
    const h = Math.max(140, naturalH)
    const minX = subIsland.bounds.minX - pad.left
    const minY = subIsland.bounds.minY - pad.top
    return {
      minX,
      minY,
      maxX: minX + w,
      maxY: minY + h,
    }
  }
  const pad = SUB_ISLAND_PAD
  const extraRight = subIsland.nodes.length === 1 ? 64 : pad.right
  return {
    minX: subIsland.bounds.minX - pad.left,
    minY: subIsland.bounds.minY - pad.top,
    maxX: subIsland.bounds.maxX + extraRight,
    maxY: subIsland.bounds.maxY + pad.bottom,
  }
}

/** 三档字号（root / branch / leaf）：与端口渲染层同一视觉档口径 */
const fontOf = (depth: number): number => (depth === 0 ? 12.5 : depth === 1 ? 12 : 11)

/**
 * 描述字号：比节点正文小一档（10px），**不随层级差分** ——
 * 与 `DESC_LINE_H` 同源，保证「度量预留 = 渲染占用」逐 px 对齐。
 */
export const DESC_FONT_SIZE = 10
/** 描述块左内边距（引用竖线的落点） */
export const DESC_INSET_X = 10
/** 引用竖线宽 + 文字缩进（竖线画在 `DESC_INSET_X`，文字从 `DESC_INSET_X + DESC_INDENT` 起） */
export const DESC_BAR_W = 2
export const DESC_INDENT = 8

/** 全角判定（CJK/假名/全角标点等，按 2 倍半角宽估算） */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

function estimateTextWidth(text: string, size: number): number {
  let units = 0
  for (const ch of text) units += WIDE_CHAR.test(ch) ? 1 : 0.55
  return units * size
}

/** 宽度夹紧（标题与描述共用一把尺子：`[MIN_W, MAX_W]`）。 */
function clampWidth(raw: number): number {
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(raw)))
}

/**
 * 节点笔记块里的 `note:` 列表（S0 形状，一行一条）；缺失 / 脏值 → `null`。
 *
 * **度量与渲染共用本函数**（D16 读侧 fail-closed 口径）：两处若各读各的，
 * 「预留高度」与「实际画出的行数」会分叉 → 文字画出盒外。
 */
export function commentOf(node: EditableNode): string[] | null {
  const raw = (node.note as Record<string, unknown> | undefined)?.note
  return Array.isArray(raw) && raw.every((item) => typeof item === 'string')
    ? (raw as string[])
    : null
}

/**
 * 会话岛根判定（度量专用）：岛根（`depth === 0`）且携带**良构** `session_id`。
 *
 * 与 `toTreeNode` 的 `sessionNode` **逐字同判据**（`typeof raw === 'string' && raw !== ''`）——
 * 度量与渲染必须同源：度量把盒收成 28×28 而渲染按普通节点画宽盒（或反之），
 * 就会出现"文字画出盒外/盒子空一大块"的硬分叉。脏值（非字符串）两侧一致按普通节点处理。
 */
function isSessionIslandRoot(node: EditableNode, depth: number): boolean {
  if (depth !== 0) return false
  const raw = (node.note as Record<string, unknown> | undefined)?.session_id
  return typeof raw === 'string' && raw !== ''
}

/**
 * 节点度量（kernel `MeasureFn` 口径）：盒 = 文本估算 + 内边距，夹紧到 [MIN_W, MAX_W]。
 *
 * **动态高度（幕布描述块）**：有描述时节点盒按可见描述行数加高 —— 这是布局的
 * **几何不变量**：`layoutIslands` 只按 measure 返回的 `h` 分配垂直槽位，
 * 度量不预留 → 描述文字会画出盒外、压住下方节点（`mindmap.ts` 的
 * `subtreeHeightOf` 逐节点取 `measure(node, depth).h` 后按 `V_GAP` 堆叠）。
 *
 * 宽度同向扩宽（描述**不折行**，长了撑宽盒，同 `DescBlock.estimateDescWidth`），
 * 但两轴都受 `MAX_W` / 可见行数上限约束 —— 长描述不撑成巨盒，全文走 tooltip。
 *
 * **会话发端枢纽（PXII-FEAT-SESSION-HUB）**：会话岛根恒返回
 * `SESSION_HUB_SIZE × SESSION_HUB_SIZE`（方形，渲染层画成圆环 + 中心亮点），
 * 会话标题由地标卡顶栏承载 —— 岛根不再占用 ~150px 横向空间。
 */
export function measureWorkMapNode(node: EditableNode, depth = 0): { w: number; h: number } {
  // 会话岛根 → 紧凑发端枢纽（标题上浮到地标卡，画布内不再有截断文本）
  if (isSessionIslandRoot(node, depth)) {
    return { w: SESSION_HUB_SIZE, h: SESSION_HUB_SIZE }
  }
  const text = displayTextOf(node)
  const titleW = estimateTextWidth(text === '' ? '　' : text, fontOf(depth)) + 24
  const comment = commentOf(node)
  const geo = descBlockGeometry(comment, NODE_H_BASE)
  if (geo === null) {
    return { w: clampWidth(titleW), h: NODE_H_BASE }
  }
  // 最长一行决定宽度（不折行语义）；+8 是竖线右侧到盒边的呼吸位
  let descW = 0
  for (const line of visibleDescLines(comment)) {
    descW = Math.max(descW, estimateTextWidth(line, DESC_FONT_SIZE))
  }
  const descBoxW = descW + DESC_INSET_X + DESC_BAR_W + DESC_INDENT + 8
  return { w: clampWidth(Math.max(titleW, descBoxW)), h: geo.height }
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

/**
 * 地标卡顶栏会话标题的截断（PXII-FEAT-SESSION-HUB）—— **与度量同一把尺子**。
 *
 * 会话标题从画布节点上浮到岛地标卡顶栏后，可写宽度 = 角标左缘 − 起点 − 呼吸位
 * （渲染层算 `maxW`）；超长时补 `…`，全文由原生 `<title>` tooltip 兜底（信息不丢）。
 * 字号取 `ISLAND_TITLE_FONT_SIZE`（与渲染层 `fontSize` 同源），故截断宽度 = 绘制宽度。
 */
export function fitIslandTitleToWidth(
  text: string,
  maxW: number,
  fontSize = ISLAND_TITLE_FONT_SIZE,
): string {
  if (text === '') return text
  // 一个字符都放不下 → 不画（全文仍由渲染层的 <title> tooltip 兜底）
  if (maxW <= 0) return ''
  if (estimateTextWidth(text, fontSize) <= maxW) return text
  const ellipsis = estimateTextWidth('…', fontSize)
  let out = ''
  let used = 0
  for (const ch of text) {
    const width = estimateTextWidth(ch, fontSize)
    if (used + width + ellipsis > maxW) break
    out += ch
    used += width
  }
  return `${out}…`
}

/**
 * 描述行截断（与描述度量同一把尺子：`DESC_FONT_SIZE` + 同一 `estimateTextWidth`）。
 *
 * 幕布语义是「描述不折行、长了撑宽盒」（`DescBlock.estimateDescWidth`）——
 * 盒宽又被 `MAX_W` 夹住，故超长行在渲染层补 `…`；全文由原生 `<title>` tooltip
 * 与「选中后的操作行列表」兜底，**信息不丢**。
 */
export function fitDescLineToBox(text: string, boxW: number): string {
  const budget = boxW - (DESC_INSET_X + DESC_BAR_W + DESC_INDENT) - 8
  if (budget <= 0 || text === '') return text
  if (estimateTextWidth(text, DESC_FONT_SIZE) <= budget) return text
  const ellipsis = estimateTextWidth('…', DESC_FONT_SIZE)
  let out = ''
  let used = 0
  for (const ch of text) {
    const width = estimateTextWidth(ch, DESC_FONT_SIZE)
    if (used + width + ellipsis > budget) break
    out += ch
    used += width
  }
  return `${out}…`
}

/**
 * 描述块几何（**度量与渲染的唯一同源**）：盒高、首行基线、引用竖线两端。
 *
 * 度量侧只用 `height`（喂 kernel 的 `MeasureFn`），渲染侧只用基线/竖线坐标 ——
 * 两侧取自同一函数，改一处必然同时生效（分叉 = 文字画出盒外，是硬回归）。
 * 无描述 → `null`（节点回落到 `NODE_H_BASE`，不画竖线）。
 */
export function descBlockGeometry(
  comment: readonly string[] | null,
  boxH: number,
): { height: number; lineCount: number; barTop: number; barBottom: number; baselineOf: (index: number) => number } | null {
  if (comment === null || comment.length === 0) return null
  const lineCount = Math.min(DESC_MAX_VISIBLE_LINES, comment.length)
  const barTop = NODE_H_BASE + DESC_PAD_TOP
  return {
    height: barTop + lineCount * DESC_LINE_H + DESC_PAD_BOTTOM,
    lineCount,
    barTop,
    barBottom: Math.max(barTop, boxH - DESC_PAD_BOTTOM),
    // 基线落在 14px 行盒内（10px 字号视觉居中：≈ 0.72 × 行高）
    baselineOf: (index: number) => barTop + index * DESC_LINE_H + DESC_LINE_H * 0.72,
  }
}

/** 盒内可见的描述行（超出部分走 tooltip；与 `descBlockGeometry` 同一上限）。 */
export function visibleDescLines(comment: readonly string[] | null): string[] {
  return comment === null ? [] : comment.slice(0, DESC_MAX_VISIBLE_LINES)
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
  // 稳定编辑键与注释：脏值一律容忍为 null（读侧 fail-closed 口径，同 thoughtType）
  const rawCid = note.cid
  const cid = typeof rawCid === 'string' && rawCid !== '' ? rawCid : null
  // 与度量共用同一读数（`commentOf`）—— 预留高度与渲染行数同源，不会分叉
  const comment = commentOf(node)
  const ref = node.type === 'entity' ? node.ref : undefined
  const fallback = measureWorkMapNode(node, depth)
  return {
    id: node.id,
    text: displayTextOf(node),
    thoughtType: isThoughtType(rawType) ? rawType : null,
    sessionId,
    sessionNode: sessionId !== null,
    cid,
    comment,
    refId: typeof ref?.id === 'string' && ref.id !== '' ? ref.id : null,
    refKind: typeof ref?.kind === 'string' && ref.kind !== '' ? ref.kind : null,
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
 * 投影岛 → 会话 id（岛内前序首个携带 `session_id` 的成员；与 `toTreeNode` 读数同口径）。
 * `projectedRoot` 的 children 已剔除嵌套升格后代，前序遍历即 `memberIds` 顺序。
 */
function sessionIdOfProjection(island: LayoutIsland): string | null {
  const walk = (node: EditableNode): string | null => {
    const raw = (node.note as Record<string, unknown> | undefined)?.session_id
    if (typeof raw === 'string' && raw !== '') return raw
    for (const child of node.children) {
      const hit = walk(child)
      if (hit !== null) return hit
    }
    return null
  }
  return walk(island.projectedRoot)
}

/**
 * 从**运行时投影副本**中摘除目标子树（就地 splice；`editable` 是本次调用的私有副本，
 * 与 `.mm.md` 原文无关联 —— D19-a 红线：归档不触碰事实源）。
 *
 * @returns 被摘除的全部节点 id（含后代；用于过滤 centers 读数）
 */
function pruneSubtrees(root: EditableNode, subtreeRootIds: ReadonlySet<string>): Set<string> {
  const removed = new Set<string>()
  const collect = (node: EditableNode): void => {
    removed.add(node.id)
    for (const child of node.children) collect(child)
  }
  const walk = (node: EditableNode): void => {
    const keep: EditableNode[] = []
    for (const child of node.children) {
      if (subtreeRootIds.has(child.id)) collect(child)
      else {
        keep.push(child)
        walk(child)
      }
    }
    node.children = keep
  }
  walk(root)
  return removed
}

/** 归档岛卡片尺寸（宽与节点盒 MAX_W 同口径；高容纳标题 + 副标题两行）。 */
const ARCHIVE_CARD_W = 240
const ARCHIVE_CARD_H = 88
/** 归档岛与任何展开岛（含根岛）的最小间距（世界坐标 px）。 */
const ARCHIVE_GAP = 32
/** 归档岛合成 id（kernel `newId` 恒生成 `nd…` 前缀，不会撞车）。 */
const ARCHIVE_ROOT_ID = 'wm-archive'
const ARCHIVE_CARD_ID = 'wm-archive-card'

/**
 * 合成归档岛（虚拟岛）：一张收拢卡片，排布在全部展开岛（含根岛）的**左侧**且与其
 * 无重叠（派发示例「首个展开岛 X−450px」在无 pos 自动排开场景会与根岛相撞，故锚定
 * 最左内容的左侧再让出卡宽与间距，几何不变量是「在展开岛左侧」）。
 */
function buildArchiveIsland(laidIslands: readonly MapIslandLayout[], archivedCount: number): MapIslandLayout {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const island of laidIslands) {
    minX = Math.min(minX, island.bounds.minX)
    minY = Math.min(minY, island.bounds.minY)
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
  }
  const x = Math.round(minX - ARCHIVE_GAP - ARCHIVE_CARD_W)
  const y = Math.round(minY)
  const card: MapTreeNode = {
    id: ARCHIVE_CARD_ID,
    text: '早期会话',
    thoughtType: null,
    sessionId: null,
    sessionNode: false,
    cid: null,
    comment: null,
    refId: null,
    refKind: null,
    depth: 0,
    box: { x, y, w: ARCHIVE_CARD_W, h: ARCHIVE_CARD_H },
    children: [],
  }
  return {
    rootId: ARCHIVE_ROOT_ID,
    sourceKind: 'archive',
    sessionId: null,
    tree: card,
    nodes: [card],
    links: [],
    bounds: { minX: x, minY: y, maxX: x + ARCHIVE_CARD_W, maxY: y + ARCHIVE_CARD_H },
    subIslands: [],
    isArchive: true,
    archivedCount,
  }
}

/**
 * 读一份工作导图并计算几何（fail-soft）。
 *
 * 近 N 展开（ADR-0008 D19-a）：会话岛多于 `activeLimit` 时，只展开**最新** N 个；
 * 更早的历史会话在渲染层聚合为一个虚拟归档岛（`isArchive: true` + `archivedCount: M`）。
 * 切片是**纯视图层投影切片**：只摘除本次调用私有的运行时投影副本，`.mm.md` 原文的
 * 历史节点、cid、session_id 与 centers 条目**逐字节保留**。
 *
 * @returns 解析成功 → 布局视图；失败 → `null`（只记 warn）
 */
export function readWorkMapLayout(
  text: string,
  options: WorkMapLayoutOptions = {},
): WorkMapLayout | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const activeLimit = Math.max(1, Math.floor(options.activeLimit ?? WORK_MAP_DEFAULT_ACTIVE_LIMIT))
  const expandAll = options.expandAll ?? false
  try {
    const parsed = parseMm(text)
    if (parsed.root === null) return null
    const editable = astToEditable(parsed.root)
    if (editable === null) return null

    const { specs, diagnostics: centerDiagnostics } = resolveCenters(editable)

    // 规划遍：全量投影（单次结构 DFS，无度量/布局开销）确定会话岛的文档时序
    const fullProjection = projectIslands(editable, specs)
    const sessionRootIds: string[] = []
    for (const island of fullProjection.islands) {
      if (sessionIdOfProjection(island) !== null) sessionRootIds.push(island.rootId)
    }

    let projection = fullProjection
    let effectiveSpecs = specs
    let archivedCount = 0
    if (!expandAll && sessionRootIds.length > activeLimit) {
      // 最新 N 个保持活跃；其余 M = Total − N 收进归档岛
      const archivedRootIds = new Set(sessionRootIds.slice(0, sessionRootIds.length - activeLimit))
      archivedCount = archivedRootIds.size
      const prunedIds = pruneSubtrees(editable, archivedRootIds)
      // 指向已归档子树的 centers 条目不再激活 —— 属切片语义而非 dangling 错误，不产诊断
      effectiveSpecs = specs.filter((spec) => spec.nodeId === null || !prunedIds.has(spec.nodeId))
      projection = projectIslands(editable, effectiveSpecs)
    }

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

    const islands: MapIslandLayout[] = projection.islands.map((island) => {
      const members = new Set(island.memberIds)
      const tree = toTreeNode(island.projectedRoot, 0, boxById)
      const nodes = flatten(tree)
      const links = layout.links
        .filter((link) => members.has(link.fromId) && members.has(link.toId))
        .map((link) => ({ fromId: link.fromId, toId: link.toId, path: link.path }))
      // 会话 id：取岛内首个携带 session_id 的节点（本项目建岛时写在岛根上）
      const sessionId = nodes.find((node) => node.sessionId !== null)?.sessionId ?? null
      // 嵌套子岛：岛根直属一级子节点（depth === 1）每个为一个 L3 任务子岛及其思考分支
      const subIslands: MapSubIsland[] = tree.children.map((child, index) => {
        const subNodes = flatten(child)
        const subNodeIds = new Set(subNodes.map((n) => n.id))
        const subLinks = links.filter((l) => subNodeIds.has(l.fromId) && subNodeIds.has(l.toId))
        // 稳定身份（跨重新解析对齐）：优先 cid，其次子岛标题，兜底索引；避免 astToEditable 的随机 node.id 导致编辑后丢失聚焦
        const stableId =
          child.cid ?? (child.text.trim() !== '' ? `sub:${child.text.trim()}` : `sub:${index}`)
        return {
          id: stableId,
          title: child.text,
          cid: child.cid,
          rootNode: child,
          nodes: subNodes,
          links: subLinks,
          bounds: boundsOf(subNodes),
        }
      })
      return {
        rootId: island.rootId,
        sourceKind: island.sourceKind,
        sessionId,
        tree,
        nodes,
        links,
        bounds: boundsOf(nodes),
        subIslands,
      } satisfies MapIslandLayout
    })

    if (archivedCount > 0) islands.push(buildArchiveIsland(islands, archivedCount))

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

/** 方案 A（横向群岛卡片流）常量 */
export const ARCHIPELAGO_CARD_W = 270
export const ARCHIPELAGO_CARD_H = 200
export const ARCHIPELAGO_GAP_X = 24
export const ARCHIPELAGO_START_Y = 82
export const ARCHIPELAGO_TOTAL_H = 304

/**
 * 方案 A（横向群岛卡片流）：把包含 L3 嵌套子岛的会话岛投影为横向多卡片排布。
 *
 * 核心几何：
 * - 顶部会话发端总枢纽条：高 42px，横跨全岛，含发端 Anchor Hub + 会话标题 + 子岛与思考统计胶囊。
 * - 优雅贝塞尔引导线：从顶栏枢纽底部分支连到各子岛卡片顶缘中点。
 * - 下方各 L3 子任务独立成卡：每卡宽 270px、高 ~200px、间距 24px，横向平铺。
 *   卡内含子岛顶栏微地标、子岛根节点（可编辑）、放射状思考节点（可编辑/可加子/带类型颜色/带注释描述块）、底部「点击聚焦此岛 →」按钮。
 * - 整体世界高度仅 ~304px，在 320px 视区内 100% 原始比例呈现（零垂直缩放压缩，字号恒定 12px）。
 */
export function layoutArchipelagoIsland(
  island: MapIslandLayout,
  _currentPlanTitle?: string | null,
): MapIslandLayout {
  if (
    island.sessionId === null ||
    island.isArchive === true ||
    !island.subIslands ||
    island.subIslands.length === 0
  ) {
    return island
  }

  const subIslands = island.subIslands
  const n = subIslands.length
  const totalCardsW = n * ARCHIPELAGO_CARD_W + Math.max(0, n - 1) * ARCHIPELAGO_GAP_X
  const totalW = Math.max(780, totalCardsW + 32)
  const offsetX = Math.max(16, Math.round((totalW - totalCardsW) / 2))

  // 1. 顶栏会话发端总枢纽条与发端节点几何
  const hubBarW = Math.max(totalCardsW, 320)
  const rootBox: MapBox = {
    x: offsetX + 16,
    y: 23,
    w: SESSION_HUB_SIZE,
    h: SESSION_HUB_SIZE,
  }

  const nodeMap = new Map<string, MapTreeNode>()
  const newLinks: { fromId: string; toId: string; path: string }[] = []
  let maxCardBottom = ARCHIPELAGO_START_Y + ARCHIPELAGO_CARD_H

  // 2. 遍历各子岛，计算独立卡片内部几何与连线
  /** 收尾对齐用：先收集所有卡，齐底后统一回填 maxY */
  const pendingSubIslands: MapSubIsland[] = []
  const newSubIslands: MapSubIsland[] = subIslands.map((subStable, idx) => {
    const cardX = offsetX + idx * (ARCHIPELAGO_CARD_W + ARCHIPELAGO_GAP_X)
    const cardY = ARCHIPELAGO_START_Y
    const cardW = ARCHIPELAGO_CARD_W

    // 从顶栏枢纽底缘连到子岛卡片顶缘中点的优雅贝塞尔线
    const hubFromX = Math.round(
      offsetX + 24 + (idx + 0.5) * ((hubBarW - 48) / n),
    )
    const hubFromY = 58
    const cardTopMidX = Math.round(cardX + cardW / 2)
    const cardTopMidY = cardY
    const cpY = Math.round(hubFromY + (cardTopMidY - hubFromY) * 0.5)
    const hubToSubPath = `M ${hubFromX} ${hubFromY} C ${hubFromX} ${cpY}, ${cardTopMidX} ${cpY}, ${cardTopMidX} ${cardTopMidY}`
    newLinks.push({
      fromId: island.tree.id,
      toId: subStable.rootNode.id,
      path: hubToSubPath,
    })

    // 子岛根节点（L3 任务节点）：置于卡片上半部分
    const rootText = subStable.rootNode.text === '' ? '子任务' : subStable.rootNode.text
    const naturalRootW = subStable.rootNode.box
      ? Math.max(clampWidth(estimateTextWidth(rootText, 12) + 24), subStable.rootNode.box.w)
      : clampWidth(estimateTextWidth(rootText, 12) + 24)
    const rootW = Math.min(cardW - 32, naturalRootW)
    const rootH = subStable.rootNode.box ? Math.max(26, subStable.rootNode.box.h) : 26
    const subRootBox: MapBox = {
      x: cardX + 16,
      y: cardY + 42,
      w: rootW,
      h: rootH,
    }
    const newSubRoot: MapTreeNode = {
      ...subStable.rootNode,
      box: subRootBox,
      children: [],
    }
    nodeMap.set(newSubRoot.id, newSubRoot)

    /**
     * 子岛下属节点：**按真实层级缩进排开**（2026-10-03 真机回归修复）。
     *
     * ## 旧实现为什么错
     * 取 `subStable.nodes`（`flatten(child)` 的**前序扁平**列表）逐个竖排，并把每条连线
     * 都从**子岛根**发出 → 任意深度的后代都被拉平成子岛根的兄弟。
     * 真机症状：`.mm.md` 里 `xe`(H4) 带 3 个 H5 子节点，主图却把它们与 `xe` 并排。
     *
     * ## 现在的做法
     * 递归原树（`subStable.rootNode` 的 children 结构本身是完整的），
     * 深度只影响**x 缩进**，y 仍单序列出 —— 卡片是竖条不是树图。
     * 连线用**真实父节点**作 `fromId`。
     */
    const newSubNodes: MapTreeNode[] = [newSubRoot]
    const subInternalLinks: { fromId: string; toId: string; path: string }[] = []
    const NODE_GAP_Y = 8
    // 每层缩进量；最浅一级（子岛根的孩子）留出连线通道
    const INDENT_STEP = 14
    const baseIndentX = cardX + 44

    let currentY = subRootBox.y + subRootBox.h + 10
    const place = (node: MapTreeNode, parentPlaced: MapTreeNode, depth: number): void => {
      const nodeH = node.box ? Math.max(24, node.box.h) : 24
      const box: MapBox = {
        x: baseIndentX + depth * INDENT_STEP,
        y: currentY,
        w: cardW - 56 - depth * INDENT_STEP,
        h: nodeH,
      }
      const placed: MapTreeNode = { ...node, box, children: [] }
      currentY += nodeH + NODE_GAP_Y
      nodeMap.set(placed.id, placed)
      newSubNodes.push(placed)
      parentPlaced.children.push(placed)

      // 连线：**从真实父节点**出发
      const fromX = parentPlaced.box.x + 12
      const fromY = parentPlaced.box.y + parentPlaced.box.h
      const toX = box.x
      const toY = box.y + 12
      const pathD = `M ${fromX} ${fromY} C ${fromX} ${toY}, ${toX - 10} ${toY}, ${toX} ${toY}`
      const subLink = { fromId: parentPlaced.id, toId: placed.id, path: pathD }
      subInternalLinks.push(subLink)
      newLinks.push(subLink)

      for (const child of node.children) place(child, placed, depth + 1)
    }
    for (const child of subStable.rootNode.children) place(child, newSubRoot, 0)

    const cardH = Math.max(ARCHIPELAGO_CARD_H, currentY - cardY + 36)
    if (cardY + cardH > maxCardBottom) {
      maxCardBottom = cardY + cardH
    }

    // 卡片底边**尚未确定**（要等所有卡都排完才知道最高卡多高）。
    // 先把内部产物挂在一个可变对象上，收尾时统一回填 maxY ——
    // 否则矮卡片的 bounds 只到自己的内容底，渲染层按 bounds 画框就会
    // 出现「框比内容矮一截 / 底部留大片空白」（2026-10-03 真机发现）。
    const sub = {
      id: subStable.id,
      title: subStable.title,
      cid: subStable.cid,
      rootNode: newSubRoot,
      nodes: newSubNodes,
      links: subInternalLinks,
      bounds: {
        minX: cardX,
        minY: cardY,
        maxX: cardX + cardW,
        maxY: cardY + cardH,
      },
    }
    pendingSubIslands.push(sub)
    return sub
  })

  // 收尾：所有卡齐底 → 各自 bounds.maxY 抬到同一水平线
  const alignedBottom = maxCardBottom
  for (const sub of pendingSubIslands) {
    sub.bounds.maxY = alignedBottom
  }

  const newTree: MapTreeNode = {
    ...island.tree,
    box: rootBox,
    children: newSubIslands.map((s) => s.rootNode),
  }
  nodeMap.set(newTree.id, newTree)

  // 重构前序展平节点列表（维持原树遍历顺序）
  const newNodes = island.nodes.map((node) => nodeMap.get(node.id) ?? node)

  const overallBounds = {
    minX: 0,
    minY: 0,
    maxX: totalW,
    maxY: maxCardBottom + 16,
  }

  return {
    ...island,
    isArchipelago: true,
    tree: newTree,
    nodes: newNodes,
    links: newLinks,
    bounds: overallBounds,
    subIslands: newSubIslands,
  }
}
