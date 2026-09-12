import type { CachedRelation } from '@/lib/contracts/task-space'
import { BLOCKING_RELATION_TYPES, deriveRelationEdgeState } from './relation-selectors'

/**
 * 依赖关系图（只读视图）—— 纯数据构建与分层布局，零 I/O、零第三方依赖。
 *
 * ★ 为什么不引入图引擎：这里的依赖图是**稀疏 DAG**（三层树 + 少量显式边），
 *   单项目节点量级是几十到几百。力导向 / WebGL 引擎解决的是「数千节点、
 *   动态增删、自由拖拽」，那在个人量级是伪需求。布局采用**最短路径分层 +
 *   列内排序**，确定性强、可快照测试、可无头渲染。
 *
 * 方向约定与依赖域一致：边的 ``from`` 是被阻塞方，``to`` 是上游阻塞方。
 * 画布上 **左侧是上游（我等的）**，focus 居中，**右侧是下游（等我的）**。
 */

/** 超过该规模不再继续扩展闭包 —— 防御性上限，个人量级远达不到。 */
export const MAX_GRAPH_NODES = 300

export interface DependencyGraphNode {
  id: string
  displayKey: string
  title: string
  /** 有未完成的上游（blockedByDependency，孤儿边按阻塞算）。 */
  blocked: boolean
  /** 位于依赖环上（所属强连通分量 > 1，或自环）。 */
  cyclic: boolean
  side: 'upstream' | 'focus' | 'downstream'
  /** 相对 focus 的列：上游为负，focus 为 0，下游为正。 */
  column: number
  /** 沿下游方向传递可达的节点数（不含自身）——「完成它能解锁多少」。 */
  unlocks: number
}

export interface DependencyGraphEdge {
  /** 被阻塞方。 */
  from: string
  /** 上游阻塞方。 */
  to: string
  cyclic: boolean
  /**
   * ★ 2026-09-12（D2 / ADR-0004）：上游已取消而**未确认** —— 边处于
   * broken_requires_resolution；画布以只读样式 / 角标区分（画布零 I/O，
   * 不用它做任何写动作）。
   */
  broken: boolean
}

export interface DependencyGraph {
  nodes: DependencyGraphNode[]
  edges: DependencyGraphEdge[]
  /** 因超出 MAX_GRAPH_NODES 而未展开的部分（不计入本图）。 */
  truncated: boolean
}

export interface DependencyGraphInput {
  /** null = 全项目视图（不做焦点闭包，纳入全部有依赖关系的节点）。 */
  focusId: string | null
  relations: readonly CachedRelation[]
  categoryById: Record<string, string | undefined>
  resolve: (id: string) => { displayKey: string; title: string } | undefined
  /** 隐藏指定状态类目的节点（completed / cancelled …）。 */
  hideCategories?: string[]
}

function isBlocking(relation: CachedRelation): boolean {
  return BLOCKING_RELATION_TYPES.has(relation.relationType)
}

/** Tarjan 强连通分量（迭代式，避免深链爆栈）。返回每个节点所属分量 id。 */
function stronglyConnectedComponents(
  nodeIds: ReadonlySet<string>,
  forward: ReadonlyMap<string, string[]>,
): Map<string, number> {
  const indexOf = new Map<string, number>()
  const lowOf = new Map<string, number>()
  const componentOf = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let index = 0
  let component = 0

  for (const root of nodeIds) {
    if (indexOf.has(root)) continue
    const call: Array<{ id: string; edgeIndex: number }> = [{ id: root, edgeIndex: 0 }]
    indexOf.set(root, index)
    lowOf.set(root, index)
    index += 1
    stack.push(root)
    onStack.add(root)

    while (call.length > 0) {
      const frame = call[call.length - 1]
      const next = forward.get(frame.id) ?? []
      if (frame.edgeIndex < next.length) {
        const target = next[frame.edgeIndex]
        frame.edgeIndex += 1
        if (!nodeIds.has(target)) continue
        if (!indexOf.has(target)) {
          indexOf.set(target, index)
          lowOf.set(target, index)
          index += 1
          stack.push(target)
          onStack.add(target)
          call.push({ id: target, edgeIndex: 0 })
        } else if (onStack.has(target)) {
          lowOf.set(frame.id, Math.min(lowOf.get(frame.id)!, indexOf.get(target)!))
        }
        continue
      }
      call.pop()
      const parent = call[call.length - 1]
      if (parent) lowOf.set(parent.id, Math.min(lowOf.get(parent.id)!, lowOf.get(frame.id)!))
      if (lowOf.get(frame.id) === indexOf.get(frame.id)) {
        let member = stack.pop()
        while (member !== undefined) {
          onStack.delete(member)
          componentOf.set(member, component)
          if (member === frame.id) break
          member = stack.pop()
        }
        component += 1
      }
    }
  }
  return componentOf
}

export function buildDependencyGraph(input: DependencyGraphInput): DependencyGraph {
  const { focusId, categoryById, resolve, hideCategories = [] } = input
  const blocking = input.relations.filter(isBlocking)

  const forward = new Map<string, string[]>()
  const backward = new Map<string, string[]>()
  for (const edge of blocking) {
    if (edge.fromWorkItemId === edge.toWorkItemId) continue
    forward.set(edge.fromWorkItemId, [...(forward.get(edge.fromWorkItemId) ?? []), edge.toWorkItemId])
    backward.set(edge.toWorkItemId, [...(backward.get(edge.toWorkItemId) ?? []), edge.fromWorkItemId])
  }

  const hidden = (id: string) => hideCategories.includes(categoryById[id] ?? '')

  // 连通闭包：邻域模式从 focus 双向 BFS；全项目模式纳入全部关系端点。
  const closure = new Set<string>()
  let frontier: string[] = []
  if (focusId !== null && !hidden(focusId)) {
    closure.add(focusId)
    frontier = [focusId]
  } else if (focusId === null) {
    for (const edge of blocking) {
      if (!hidden(edge.fromWorkItemId)) closure.add(edge.fromWorkItemId)
      if (!hidden(edge.toWorkItemId)) closure.add(edge.toWorkItemId)
    }
    frontier = [...closure]
  }
  const expand = (nextOf: (id: string) => string[]) => {
    while (frontier.length > 0) {
      const batch = frontier
      frontier = []
      for (const id of batch) {
        for (const next of nextOf(id)) {
          if (closure.has(next) || hidden(next)) continue
          if (closure.size >= MAX_GRAPH_NODES) return
          closure.add(next)
          frontier.push(next)
        }
      }
    }
  }
  expand((id) => forward.get(id) ?? [])
  frontier = [...closure]
  expand((id) => backward.get(id) ?? [])
  const truncated = closure.size >= MAX_GRAPH_NODES

  // ★ 解锁分析：沿下游方向传递可达的节点数 —— 「完成它能解锁多少」。
  const unlockCounts = new Map<string, number>()
  for (const id of closure) {
    const seen = new Set<string>()
    let batch: string[] = [id]
    while (batch.length > 0) {
      const nextBatch: string[] = []
      for (const current of batch) {
        for (const next of forward.get(current) ?? []) {
          if (next === id || seen.has(next) || !closure.has(next)) continue
          seen.add(next)
          nextBatch.push(next)
        }
      }
      batch = nextBatch
    }
    unlockCounts.set(id, seen.size)
  }

  // 最短路径分层（BFS，天然免疫环）。
  const upstreamDistance = new Map<string, number>()
  const downstreamDistance = new Map<string, number>()
  if (focusId !== null) {
    upstreamDistance.set(focusId, 0)
    downstreamDistance.set(focusId, 0)
    frontier = [focusId]
    while (frontier.length > 0) {
      const batch = frontier
      frontier = []
      for (const id of batch) {
        for (const next of forward.get(id) ?? []) {
          if (upstreamDistance.has(next)) continue
          upstreamDistance.set(next, upstreamDistance.get(id)! + 1)
          frontier.push(next)
        }
      }
    }
    frontier = [focusId]
    while (frontier.length > 0) {
      const batch = frontier
      frontier = []
      for (const id of batch) {
        for (const next of backward.get(id) ?? []) {
          if (downstreamDistance.has(next)) continue
          downstreamDistance.set(next, downstreamDistance.get(id)! + 1)
          frontier.push(next)
        }
      }
    }
  } else {
    // 全项目模式：最长路径分层 —— 阻塞方靠左，被阻塞方靠右。
    const columns = new Map<string, number>()
    for (const id of closure) columns.set(id, 0)
    for (let round = 0; round < closure.size; round += 1) {
      let changed = false
      for (const edge of blocking) {
        if (!closure.has(edge.fromWorkItemId) || !closure.has(edge.toWorkItemId)) continue
        const next = (columns.get(edge.toWorkItemId) ?? 0) + 1
        if (next > (columns.get(edge.fromWorkItemId) ?? 0)) {
          columns.set(edge.fromWorkItemId, next)
          changed = true
        }
      }
      if (!changed) break
    }
    for (const [id, column] of columns) downstreamDistance.set(id, column)
  }

  const componentOf = stronglyConnectedComponents(closure, forward)
  const componentSizes = new Map<number, number>()
  for (const component of componentOf.values()) {
    componentSizes.set(component, (componentSizes.get(component) ?? 0) + 1)
  }

  const blockedByDependency = new Set<string>()
  for (const edge of blocking) {
    // 与真值表同源（D2 / ADR-0004）：未确认的 cancelled 上游**不再**视为
    // terminal —— 它处于 broken_requires_resolution，仍计入阻塞。
    if (deriveRelationEdgeState(edge, categoryById[edge.toWorkItemId]) === 'satisfied') continue
    blockedByDependency.add(edge.fromWorkItemId)
  }

  const nodes: DependencyGraphNode[] = []
  for (const id of closure) {
    const resolved = resolve(id) ?? { displayKey: id, title: id }
    const upstream = upstreamDistance.get(id)
    const downstream = downstreamDistance.get(id)
    const side: DependencyGraphNode['side'] = id === focusId
      ? 'focus'
      : (upstream ?? 0) > 0 && (downstream ?? 0) === 0
          ? 'upstream'
          : 'downstream'
    // 上游列向左（负），下游列向右（正）；两侧都通的罕见节点按下游处理。
    const column = id === focusId
      ? 0
      : side === 'upstream'
          ? -(upstreamDistance.get(id) ?? 1)
          : (downstreamDistance.get(id) ?? upstreamDistance.get(id) ?? 1)
    nodes.push({
      id,
      displayKey: resolved.displayKey,
      title: resolved.title,
      blocked: blockedByDependency.has(id),
      // focus 也可能位于环上 —— 这正是用户最需要被告知的情况，不做豁免。
      cyclic: (componentSizes.get(componentOf.get(id) ?? -1) ?? 0) > 1,
      side,
      column,
      unlocks: unlockCounts.get(id) ?? 0,
    })
  }
  nodes.sort((left, right) => left.column - right.column || left.displayKey.localeCompare(right.displayKey))

  const cyclicNodes = new Set(nodes.filter((node) => node.cyclic).map((node) => node.id))
  const edges: DependencyGraphEdge[] = blocking
    .filter((edge) => closure.has(edge.fromWorkItemId) && closure.has(edge.toWorkItemId))
    .map((edge) => ({
      from: edge.fromWorkItemId,
      to: edge.toWorkItemId,
      cyclic: edge.fromWorkItemId === edge.toWorkItemId
        || (cyclicNodes.has(edge.fromWorkItemId) && cyclicNodes.has(edge.toWorkItemId)),
      broken: deriveRelationEdgeState(edge, categoryById[edge.toWorkItemId])
        === 'broken_requires_resolution',
    }))

  return { nodes, edges, truncated }
}

/** 节点尺寸与间距 —— 布局与渲染共用同一组常量，保证不重叠。 */
export const GRAPH_NODE_WIDTH = 150
export const GRAPH_NODE_HEIGHT = 42
export const GRAPH_COLUMN_GAP = 48
export const GRAPH_ROW_GAP = 14
export const GRAPH_MARGIN = 16

export interface GraphPosition {
  x: number
  y: number
  column: number
  row: number
}

/** 边两端在节点边缘上的锚点：起点靠 from 左缘，终点靠 to 右缘。 */
export interface GraphEdgeAnchor {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface DependencyGraphLayout {
  width: number
  height: number
  positions: Record<string, GraphPosition>
  /** `from->to` → 锚点。同侧多条边扇出分布，不会全部挤在节点中点。 */
  anchors: Record<string, GraphEdgeAnchor>
}

export function graphEdgeKey(edge: { from: string; to: string }): string {
  return `${edge.from}->${edge.to}`
}

/**
 * 列 = x；行序 = 列内按 displayKey 初始化后，再做两轮**重心法**（barycenter）
 * 扫描 —— 每个节点按相邻列邻居的平均行高重排，显著减少连线交叉。
 * 各列相对中轴垂直居中。
 */
export interface DependencyGraphLayoutOptions {
  /** LR：上游在左（默认）；TB：上游在上。 */
  direction?: 'LR' | 'TB'
}

export function layoutDependencyGraph(
  graph: DependencyGraph,
  options: DependencyGraphLayoutOptions = {},
): DependencyGraphLayout {
  const columns = new Map<number, DependencyGraphNode[]>()
  for (const node of graph.nodes) {
    columns.set(node.column, [...(columns.get(node.column) ?? []), node])
  }
  for (const group of columns.values()) {
    group.sort((left, right) => left.displayKey.localeCompare(right.displayKey) || left.id.localeCompare(right.id))
  }

  const columnOf = new Map(graph.nodes.map((node) => [node.id, node.column]))
  const sortedColumns = [...columns.keys()].sort((left, right) => left - right)
  const columnIndex = new Map(sortedColumns.map((column, index) => [column, index]))

  // 邻接（跨列）：node → 相邻列里的邻居 id 列表。
  const neighbours = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (columnOf.get(edge.from) === columnOf.get(edge.to)) continue
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to])
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from])
  }

  const rows = new Map<string, number>()
  const assignRows = (): void => {
    for (const column of sortedColumns) {
      const group = columns.get(column) ?? []
      group.forEach((node, index) => rows.set(node.id, index))
    }
  }
  assignRows()

  const sweep = (order: number[]): void => {
    for (const column of order) {
      const group = columns.get(column) ?? []
      const scored = group.map((node, fallback) => {
        const neighbourRows = (neighbours.get(node.id) ?? [])
          .map((id) => rows.get(id))
          .filter((row): row is number => row !== undefined)
        const barycenter = neighbourRows.length > 0
          ? neighbourRows.reduce((sum, row) => sum + row, 0) / neighbourRows.length
          : (rows.get(node.id) ?? fallback)
        return { id: node.id, barycenter }
      })
      scored.sort((left, right) => left.barycenter - right.barycenter)
      scored.forEach((entry, index) => rows.set(entry.id, index))
    }
  }
  sweep(sortedColumns)
  sweep([...sortedColumns].reverse())
  sweep(sortedColumns)

  const maxRows = Math.max(1, ...sortedColumns.map((column) => (columns.get(column) ?? []).length))
  const totalHeight = maxRows * GRAPH_NODE_HEIGHT + (maxRows - 1) * GRAPH_ROW_GAP + GRAPH_MARGIN * 2

  const positions: Record<string, GraphPosition> = {}
  sortedColumns.forEach((column, index) => {
    const group = columns.get(column) ?? []
    const groupHeight = group.length * GRAPH_NODE_HEIGHT + (group.length - 1) * GRAPH_ROW_GAP
    const topOffset = (totalHeight - groupHeight) / 2 - GRAPH_MARGIN
    group.forEach((node, row) => {
      positions[node.id] = {
        x: GRAPH_MARGIN + index * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
        y: GRAPH_MARGIN + topOffset + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
        column,
        row: rows.get(node.id) ?? row,
      }
    })
  })

  const widthLR = sortedColumns.length * GRAPH_NODE_WIDTH
    + Math.max(0, sortedColumns.length - 1) * GRAPH_COLUMN_GAP
    + GRAPH_MARGIN * 2

  // ★ 锚点扇出：同一节点同一侧若挂 k 条边，按对端行序把锚点均分到节点高度上。
  //   没有这一步，所有连线都从节点中点出发，视觉上纠缠成一束（首版最被诟病处）。
  const leftSide = new Map<string, string[]>() // X 是 from → 锚在 X 左缘
  const rightSide = new Map<string, string[]>() // X 是 to → 锚在 X 右缘
  for (const edge of graph.edges) {
    leftSide.set(edge.from, [...(leftSide.get(edge.from) ?? []), graphEdgeKey(edge)])
    rightSide.set(edge.to, [...(rightSide.get(edge.to) ?? []), graphEdgeKey(edge)])
  }
  const anchorYs = (map: Map<string, string[]>, nodeId: string): Map<string, number> => {
    const keys = map.get(nodeId) ?? []
    const ordered = [...keys].sort((left, right) => {
      const otherOf = (key: string) => key.startsWith(`${nodeId}->`) ? key.slice(nodeId.length + 2) : key.slice(0, key.indexOf('->'))
      return (positions[otherOf(left)]?.row ?? 0) - (positions[otherOf(right)]?.row ?? 0)
    })
    const out = new Map<string, number>()
    ordered.forEach((key, index) => {
      out.set(key, GRAPH_NODE_HEIGHT * ((index + 1) / (ordered.length + 1)))
    })
    return out
  }

  // TB 模式：转置坐标 —— 原「列」变纵向带（上游在上），原「行」变横向带。
  if ((options.direction ?? 'LR') === 'TB') {
    for (const node of graph.nodes) {
      const position = positions[node.id]
      positions[node.id] = {
        ...position,
        x: GRAPH_MARGIN + position.row * (GRAPH_NODE_WIDTH + GRAPH_ROW_GAP),
        y: GRAPH_MARGIN + (columnIndex.get(position.column) ?? 0)
            * (GRAPH_NODE_HEIGHT + GRAPH_COLUMN_GAP),
      }
    }
  }

  const anchors: Record<string, GraphEdgeAnchor> = {}
  for (const edge of graph.edges) {
    const from = positions[edge.from]
    const to = positions[edge.to]
    if (!from || !to) continue
    const fromKey = graphEdgeKey(edge)
    const fromLeftY = anchorYs(leftSide, edge.from).get(fromKey)
    const toRightY = anchorYs(rightSide, edge.to).get(fromKey)
    // from（被阻塞方）列更大 → 锚其左缘；to（上游）→ 锚其右缘。
    const backward = from.column < to.column
    const x1 = backward ? from.x + GRAPH_NODE_WIDTH : from.x
    const x2 = backward ? to.x : to.x + GRAPH_NODE_WIDTH
    anchors[graphEdgeKey(edge)] = {
      x1,
      y1: from.y + (fromLeftY ?? GRAPH_NODE_HEIGHT / 2),
      x2,
      y2: to.y + (toRightY ?? GRAPH_NODE_HEIGHT / 2),
    }
  }

  const width = (options.direction ?? 'LR') === 'TB'
    ? maxRows * (GRAPH_NODE_WIDTH + GRAPH_ROW_GAP) + GRAPH_MARGIN * 2
    : widthLR
  const height = (options.direction ?? 'LR') === 'TB'
    ? sortedColumns.length * (GRAPH_NODE_HEIGHT + GRAPH_COLUMN_GAP) + GRAPH_MARGIN * 2
    : totalHeight

  return { width, height, positions, anchors }
}
