/**
 * 依赖域上图适配器（ADR-0008 D19-b）—— 后端 ``GraphJsonPayload`` → MindCanvas 导图模型。
 *
 * ## 链路
 * ```
 * GET /relations/dependency-graph（后端只读派生投影，D19-b）
 *   → graphJsonToMindmap（@mindcanvas/kernel 既有适配器，零新依赖）
 *       ↳ root: EditableNode        合成根（text = "TASK_SPACE 知识拓扑"）
 *       ↳ centers: CenterSpec[]     入度 0 的源头母材自动升格为森林中心
 *       ↳ edges: DocEdgePayload[]   全部因果边收敛为文档级自由边（root.note.edges）
 *   → 本模块补三层**读侧统计**（供徽章 / 视图层消费，不改 kernel 产物）
 * ```
 *
 * ## 纪律（改动前先读）
 * - **不引 @mindcanvas/react**（D19-c）：自由边不走重型 Canvas 渲染器；紧凑态由
 *   自持树 ``WorkMapTree`` 的依赖状态 Badge 呈现（``.wm-dep-badge``），完整自由边
 *   保留在 ``root.note.edges``（导出 ``.mm.md`` 时由 kernel 协议写出）。
 * - **端点是实体引用**：kernel 把边端点写成 ``@work_item:<id>``（``@kind:id``
 *   协议标准实体锚），绝无脆弱的 ``node:`` 路径锚（红线 2）。
 * - 本模块**纯函数**：不改 payload、不请求、不落库。
 */
import { graphJsonToMindmap } from '@mindcanvas/kernel'
import type {
  CenterSpec,
  DocEdgePayload,
  EditableNode,
  GraphJsonPayload,
} from '@mindcanvas/kernel'

/** 单个节点的依赖计数（上游 = 等它的 blocker 数；下游 = 等它的被阻断数）。 */
export interface DependencyCounts {
  upstream: number
  downstream: number
}

export interface DependencyWorkMapResult {
  /** 合成导图根（``root.note.edges`` 携带全部自由边，可整树导出 ``.mm.md``） */
  root: EditableNode
  /** 森林多中心（入度 0 的源头母材；``graphJsonToMindmap`` 产出） */
  centers: CenterSpec[]
  /** 文档级自由边（端点为 ``@work_item:<id>`` 实体引用） */
  edges: DocEdgePayload[]
  /** 载荷 ``indices.in_degree``（= 上游 blocker 数）；缺省时按边结构回算 */
  inDegreeByNodeId: Map<string, number>
  /** 每节点 upstream / downstream 计数（按边结构统计，不信任 indices 缺省） */
  dependencyCounts: Map<string, DependencyCounts>
  /**
   * 上游**未完成**数（D19-b 徽章红/绿的驱动位）：对每条 ``上游→下游`` 边，
   * 上游节点 ``metadata.statusCategory !== 'completed'`` 记 1。
   * 解除确认（resolution）的服务端语义已由后端在入图前过滤，这里不复算。
   */
  blockedUpstreamByNodeId: Map<string, number>
}

/** 判定一个上游是否「未完成」（未 completed 即未完成：cancelled/waiting 均算）。 */
const isUnfinished = (payload: GraphJsonPayload, nodeId: string): boolean => {
  for (const node of payload.nodes) {
    if (node.id !== nodeId) continue
    const category = node.metadata?.statusCategory
    return typeof category === 'string' && category !== '' && category !== 'completed'
  }
  return true // 上游行缺失（未水合）按未完成 —— 与后端 derive 口径一致：绝不静默放行
}

/**
 * 依赖图载荷 → 导图模型 + 读侧统计。
 *
 * 环形输入的降级与容错交由 kernel 适配器（visited 剪枝防重入、无入度 0 节点时
 * 按拓扑序首元素兜底），本模块不额外解析图结构。
 */
export function convertDependencyGraphToWorkMap(
  payload: GraphJsonPayload,
): DependencyWorkMapResult {
  const adapted = graphJsonToMindmap(payload)

  // 载荷边方向恒为 上游 blocker → 下游 blocked（D19-b 后端归一）：
  // from 的下游 +1；to 的上游 +1（= in_degree 口径）
  const upstreamByNode = new Map<string, number>()
  const downstreamByNode = new Map<string, number>()
  for (const edge of payload.edges) {
    downstreamByNode.set(edge.from, (downstreamByNode.get(edge.from) ?? 0) + 1)
    upstreamByNode.set(edge.to, (upstreamByNode.get(edge.to) ?? 0) + 1)
  }

  const dependencyCounts = new Map<string, DependencyCounts>()
  const inDegreeByNodeId = new Map<string, number>()
  const indicesInDegree = payload.indices?.in_degree ?? {}
  for (const node of payload.nodes) {
    const upstream = upstreamByNode.get(node.id) ?? 0
    dependencyCounts.set(node.id, {
      upstream,
      downstream: downstreamByNode.get(node.id) ?? 0,
    })
    // indices 优先（后端 Kahn 口径）；缺该节点时按边结构回算
    const declared = indicesInDegree[node.id]
    inDegreeByNodeId.set(
      node.id,
      typeof declared === 'number' && Number.isFinite(declared) ? declared : upstream,
    )
  }

  const blockedUpstreamByNodeId = new Map<string, number>()
  for (const edge of payload.edges) {
    if (!isUnfinished(payload, edge.from)) continue
    blockedUpstreamByNodeId.set(edge.to, (blockedUpstreamByNodeId.get(edge.to) ?? 0) + 1)
  }

  return {
    root: adapted.root,
    centers: adapted.centers,
    edges: adapted.edges,
    inDegreeByNodeId,
    dependencyCounts,
    blockedUpstreamByNodeId,
  }
}
