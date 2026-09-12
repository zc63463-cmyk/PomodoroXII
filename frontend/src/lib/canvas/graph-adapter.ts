import { MarkerType, type Edge, type Node } from '@xyflow/react'

import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  layoutDependencyGraph,
  type DependencyGraph,
} from '@/lib/task-space/dependency-graph'
import type { EdgeSide } from './edge-routing'
import { distributeAnchors } from './edge-routing'
import { loadCanvasLayout } from './layout-storage'

/**
 * 依赖域数据 → React Flow 画布适配层。
 *
 * ★ 初始坐标来自 ``layoutDependencyGraph``（最短路径分层 + 重心法减交叉），
 *   之后画布上的**手动拖拽即权威**（经 layout-storage 持久化）。
 *   自动布局只负责「第一次打开不难看」，不与手动位置对抗。
 */

export interface DependencyCanvasNodeData extends Record<string, unknown> {
  /** 层级编码（图构建时已写入 displayKey 槽位）。 */
  code: string
  title: string
  blocked: boolean
  cyclic: boolean
  isFocus: boolean
  statusCategory: string | undefined
  effortActualSeconds: number | null
  effortEstimateLowerSeconds: number | null
  effortEstimateUpperSeconds: number | null
  /** 沿下游传递可达的节点数 ——「完成它能解锁多少」。 */
  unlocks: number
}

export type DependencyCanvasNode = Node<DependencyCanvasNodeData, 'workItem'>

/** 节点解析结果：多带了状态类目与投入，用于节点信息密度。 */
export interface ResolvedCanvasItem {
  displayKey: string
  title: string
  statusCategory?: string
  effortActualSeconds?: number | null
  effortEstimateLowerSeconds?: number | null
  effortEstimateUpperSeconds?: number | null
}

export interface DependencyEdgeData extends Record<string, unknown> {
  cyclic: boolean
  /** ★ D2 / ADR-0004：上游已取消且未确认（broken_requires_resolution）—— 只读标注。 */
  broken: boolean
  /** 每个候选侧的锚点比例 —— 边组件按**实时几何**选侧后取用。 */
  sourceFractions: Record<string, number>
  targetFractions: Record<string, number>
  /** 障碍查询：两端点之间可能挡路的节点矩形（画布注入，用于通道避让）。 */
  obstaclesFor?: (sourceId: string, targetId: string) => Array<{
    x: number
    y: number
    width: number
    height: number
  }>
  onRemoveEdge?: (input: { from: string; to: string }) => void
}

export type DependencyEdge = Edge<DependencyEdgeData, 'dependency'>

export interface DependencyCanvasGraph {
  nodes: DependencyCanvasNode[]
  edges: DependencyEdge[]
}

export interface ToCanvasGraphOptions {
  direction?: 'LR' | 'TB'
  hideCategories?: string[]
  onRemoveEdge?: (input: { from: string; to: string }) => void
  resolve?: (id: string) => ResolvedCanvasItem | undefined
}

/**
 * @param focusId null = 全项目视图。
 * @param layoutKey 布局持久化键；**键必须包含方向与范围**，否则不同视图的
 *        手动位置会互相污染。命中已保存位置时覆盖自动布局。
 */
export function toCanvasGraph(
  graph: DependencyGraph,
  focusId: string | null,
  layoutKey?: string | null,
  options: ToCanvasGraphOptions = {},
): DependencyCanvasGraph {
  const { direction = 'LR', onRemoveEdge } = options
  const layout = layoutDependencyGraph(graph, { direction })
  const saved = layoutKey ? loadCanvasLayout(layoutKey) : null

  const nodes: DependencyCanvasNode[] = graph.nodes.map((node) => {
    const resolved = options.resolve?.(node.id)
    const automatic = layout.positions[node.id] ?? { x: 0, y: 0 }
    const manual = saved?.[node.id]
    return {
      id: node.id,
      type: 'workItem' as const,
      position: manual ?? { x: automatic.x, y: automatic.y },
      data: {
        code: node.displayKey,
        title: node.title,
        blocked: node.blocked,
        cyclic: node.cyclic,
        isFocus: node.id === focusId,
        statusCategory: resolved?.statusCategory,
        effortActualSeconds: resolved?.effortActualSeconds ?? null,
        effortEstimateLowerSeconds: resolved?.effortEstimateLowerSeconds ?? null,
        effortEstimateUpperSeconds: resolved?.effortEstimateUpperSeconds ?? null,
        unlocks: node.unlocks,
      },
    }
  })

  // ---- 连线锚点分布：按「节点 × 候选侧」预先分好比例 ----------------------
  // ★ 选侧不在适配层做死 —— 节点可被拖动，几何是活的。适配层只按
  //   「对端位于该侧方向」为每个（节点, 侧）预先分好锚点比例；
  //   边组件按**实时几何**选侧后取对应比例（见 dependency-edge.tsx）。
  const rectOf = (id: string) => {
    const position = layout.positions[id] ?? { x: 0, y: 0 }
    return { x: position.x, y: position.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }
  }

  const centerOf = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  })

  // ★ 防御：自环边与重复 (from,to) 对（同对可挂 depends_on + blocks 两条
  //   阻塞边）都会产生重复的 edge id —— React Flow 对重复 id 的行为是未定义
  //   的（告警 + 交互错乱）。渲染上两条同对边完全等价，去重是无损的。
  const routed: Array<{ edge: (typeof graph.edges)[number]; edgeKey: string }> = []
  {
    const seenEdge = new Set<string>()
    for (const edge of graph.edges) {
      if (edge.from === edge.to) continue
      const edgeKey = `${edge.from}->${edge.to}`
      if (seenEdge.has(edgeKey)) continue
      seenEdge.add(edgeKey)
      routed.push({ edge, edgeKey })
    }
  }

  const sideFractions = new Map<string, Record<string, number>>() // `${nodeId}:${side}` → edgeKey → fraction
  for (const node of graph.nodes) {
    const nodeRect = rectOf(node.id)
    const selfCenter = centerOf(nodeRect)
    for (const side of ['left', 'right', 'top', 'bottom'] as EdgeSide[]) {
      // 左右侧沿高度分布（对端按 y 排序），上下侧沿宽度分布（按 x 排序）。
      const axis: 'x' | 'y' = side === 'left' || side === 'right' ? 'y' : 'x'
      const entries: Array<{ edgeKey: string; otherCenter: number }> = []
      for (const { edge, edgeKey } of routed) {
        const otherId = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : null
        if (!otherId) continue
        const otherCenter = centerOf(rectOf(otherId))
        const inDirection =
          side === 'left' ? otherCenter.x < selfCenter.x
          : side === 'right' ? otherCenter.x > selfCenter.x
          : side === 'top' ? otherCenter.y < selfCenter.y
          : otherCenter.y > selfCenter.y
        if (inDirection) entries.push({ edgeKey, otherCenter: otherCenter[axis] })
      }
      if (entries.length > 0) {
        sideFractions.set(`${node.id}:${side}`, distributeAnchors(entries))
      }
    }
  }

  const fractionsFor = (edgeKey: string, nodeId: string): Record<string, number> => {
    const out: Record<string, number> = { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 }
    for (const side of ['left', 'right', 'top', 'bottom'] as EdgeSide[]) {
      const fraction = sideFractions.get(`${nodeId}:${side}`)?.[edgeKey]
      if (fraction !== undefined) out[side] = fraction
    }
    return out
  }

  const edges: DependencyEdge[] = routed.map(({ edge, edgeKey }) => ({
    id: edgeKey,
    source: edge.from,
    target: edge.to,
    type: 'dependency' as const,
    // ★ 箭头必须有：markerEnd 缺失时 BaseEdge 不画箭头，依赖方向（
    //   被阻塞方 → 上游阻塞方）就完全不可读。
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      // 优先级：环（红）> 待解决（橙）> 常规（灰）。
      color: edge.cyclic ? '#dc2626' : edge.broken ? '#d97706' : '#94a3b8',
    },
    // ★ 环边红虚线：第一版 SVG 有，重写 React Flow 时随 markerEnd 一起丢了，
    //   导致图例「红色虚线 = 依赖环」与实现不符。style 放在边对象上，
    //   边组件透传给 BaseEdge —— 适配层可测，组件零逻辑。
    // ★ D2（ADR-0004）：broken 边橙色短虚线 —— 只是**只读标注**，画布不加写动作。
    style: edge.cyclic
      ? { stroke: '#dc2626', strokeDasharray: '6 4' }
      : edge.broken
        ? { stroke: '#d97706', strokeDasharray: '2 3' }
        : { stroke: '#94a3b8' },
    data: {
      cyclic: edge.cyclic,
      broken: edge.broken,
      sourceFractions: fractionsFor(edgeKey, edge.from),
      targetFractions: fractionsFor(edgeKey, edge.to),
      onRemoveEdge,
    },
  }))

  return { nodes, edges }
}
