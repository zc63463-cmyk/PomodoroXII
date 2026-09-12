import type { CachedRelation } from '@/lib/contracts/task-space'
import { RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED } from '@/lib/contracts/task-space'

/**
 * Derived dependency state (依赖域合同 §13 / 修订版 §4.2).
 *
 * ★★ 纯函数、零 I/O、永不落库。后端在 ``queries.py`` 里有一份同名同语义的
 *    实现（``derive_relation_edge_state`` / ``derive_blocked_by_dependency``）；
 *    这里必须与它保持逐条对齐，否则服务端投影与本地派生会打架。
 *
 * ★ 孤儿边容错（Phase D）：网络乱序可能让"关系边先于它引用的工作项"到达
 *    客户端。此时 ``statusCategoryById`` 里查不到上游节点 —— 一律按
 *    **未完成**处理，绝不能因为查不到就把阻塞解除（那会让用户误以为可以开工）。
 *
 * ★ 2026-09-12（D2 / ADR-0004）：单条边的三态是**纯派生**（不落库）。
 *    - completed                        -> satisfied
 *    - cancelled 未确认                 -> broken_requires_resolution（仍阻塞）
 *    - cancelled + confirmed_not_required -> satisfied（保留审计边）
 *    - 行缺失（孤儿边）/ 其余活动类目    -> open（仍阻塞）
 *    `unknown_requires_resolution`（Project 归档 / 目标不可达）本期不做，
 *    仅在此保留取值域与判定入口（Q4 裁剪，见 ADR-0004）。
 */

export const BLOCKING_RELATION_TYPES = new Set(['depends_on', 'blocks'])

export type RelationEdgeState = 'satisfied' | 'broken_requires_resolution' | 'open'
// 预留（本版本不可达）：Project 归档 / 目标不可见的 Project 维度。
export type RelationEdgeStateReserved = 'unknown_requires_resolution'

export interface BlockedSignals {
  blockedByDependency: boolean
  isBlocked: boolean
}

/**
 * 单条阻塞边 D -> U 的三态（与后端 queries.py::derive_relation_edge_state 逐条对齐）。
 * ``upstreamCategory === undefined`` = 上游未水合（孤儿边）→ ``open``，绝不静默解除。
 */
export function deriveRelationEdgeState(
  edge: Pick<CachedRelation, 'resolution'>,
  upstreamCategory: string | undefined,
): RelationEdgeState {
  if (upstreamCategory === undefined) return 'open'
  if (upstreamCategory === 'completed') return 'satisfied'
  if (upstreamCategory === 'cancelled') {
    return edge.resolution === RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED
      ? 'satisfied'
      : 'broken_requires_resolution'
  }
  return 'open'
}

/**
 * AND semantics (D16): an item stays blocked while **any** blocking edge is
 * not satisfied —— ``blocked(D) = 存在任一边处于 {broken, open}``。
 * Completing one of two upstreams must NOT unblock it.
 */
export function deriveBlockedByDependency(
  relations: readonly CachedRelation[],
  statusCategoryById: Readonly<Record<string, string | undefined>>,
): Record<string, boolean> {
  const blocked: Record<string, boolean> = {}
  for (const edge of relations) {
    if (!BLOCKING_RELATION_TYPES.has(edge.relationType)) continue
    const state = deriveRelationEdgeState(edge, statusCategoryById[edge.toWorkItemId])
    if (state === 'satisfied') continue
    blocked[edge.fromWorkItemId] = true
  }
  return blocked
}

/**
 * ``isBlocked`` is only defined for level-2 items: level-1 are containers and
 * level-3 do not accumulate focus time, so blocking them is meaningless.
 */
export function computeIsBlocked(depth: number, blockedByDependency: boolean): boolean {
  return depth === 2 && blockedByDependency
}

export function deriveBlockedSignals(
  relations: readonly CachedRelation[],
  statusCategoryById: Readonly<Record<string, string | undefined>>,
  depthById: Readonly<Record<string, number | undefined>>,
): Record<string, BlockedSignals> {
  const blocked = deriveBlockedByDependency(relations, statusCategoryById)
  const result: Record<string, BlockedSignals> = {}
  for (const [id, isBlocked] of Object.entries(blocked)) {
    const depth = depthById[id]
    result[id] = {
      blockedByDependency: isBlocked,
      isBlocked: computeIsBlocked(depth ?? 1, isBlocked),
    }
  }
  return result
}

/**
 * The still-open upstreams of one item, as upstream ids.
 *
 * Same semantics as ``countOpenBlockers`` except deduplicated by upstream:
 * one pair may carry two blocking edges (depends_on + blocks) and the user is
 * blocked by **one** unfinished item, not two.  Orphan edges count as open,
 * and a cancelled upstream **without** confirmation counts as open
 * (broken_requires_resolution) — D2 / ADR-0004。
 * 会话启动判定与 BlockerAck 弹窗都消费这个列表。
 */
export function selectOpenBlockers(
  relations: readonly CachedRelation[],
  workItemId: string,
  statusCategoryById: Readonly<Record<string, string | undefined>>,
): string[] {
  const open: string[] = []
  const seen = new Set<string>()
  for (const edge of relations) {
    if (edge.fromWorkItemId !== workItemId) continue
    if (!BLOCKING_RELATION_TYPES.has(edge.relationType)) continue
    const upstream = edge.toWorkItemId
    if (seen.has(upstream)) continue
    if (deriveRelationEdgeState(edge, statusCategoryById[upstream]) === 'satisfied') continue
    seen.add(upstream)
    open.push(upstream)
  }
  return open
}

/**
 * Count the still-open upstreams of one item — used for the tree's hover hint
 * ("blocked by N unfinished dependencies").  Orphan edges count as open.
 */
export function countOpenBlockers(
  relations: readonly CachedRelation[],
  workItemId: string,
  statusCategoryById: Readonly<Record<string, string | undefined>>,
): number {
  return selectOpenBlockers(relations, workItemId, statusCategoryById).length
}

export interface WaitingResumeSuggestion {
  /** 已全部完成的上游数（提示文案用）。 */
  upstreamCount: number
}

/**
 * 「依赖解除 → 建议恢复」的派生判定（依赖域合同 §10 验收 9：所有依赖
 * satisfied 后提示恢复，但**不自动**切状态）。
 *
 * ★ 只在二级项判定：``isBlocked`` 本身只对二级定义，会话也只挂二级。
 * ★ satisfied 口径与真值表同源（逐边判定，D2 / ADR-0004）：
 *   - 上游 ``completed`` → satisfied；
 *   - 上游 ``cancelled`` → 必须**已确认** ``confirmed_not_required`` 才算
 *     satisfied（这是 D2 带来的新行为）；未确认仍属 broken_requires_resolution
 *     → 不提示（宁可不提示，也不给误导性的"已解除"）。
 * ★ 同一上游挂多条阻塞边（depends_on + blocks）时，每条边都必须 satisfied。
 * ★ 孤儿上游（未水合）按未完成处理 → 不提示（与 selectOpenBlockers 同源）。
 */
export function selectWaitingResumeSuggestion(input: {
  workItemId: string
  depth: number
  statusCategory: string | undefined
  relations: readonly CachedRelation[]
  statusCategoryById: Readonly<Record<string, string | undefined>>
}): WaitingResumeSuggestion | null {
  if (input.depth !== 2) return null
  if (input.statusCategory !== 'waiting') return null
  const edgesByUpstream = new Map<string, CachedRelation[]>()
  for (const edge of input.relations) {
    if (edge.fromWorkItemId !== input.workItemId) continue
    if (!BLOCKING_RELATION_TYPES.has(edge.relationType)) continue
    const group = edgesByUpstream.get(edge.toWorkItemId) ?? []
    group.push(edge)
    edgesByUpstream.set(edge.toWorkItemId, group)
  }
  // 没挂过依赖的 waiting 不是"因依赖进入"——没有可恢复的对象。
  if (edgesByUpstream.size === 0) return null
  for (const [upstreamId, edges] of edgesByUpstream) {
    for (const edge of edges) {
      if (deriveRelationEdgeState(edge, input.statusCategoryById[upstreamId]) !== 'satisfied') {
        return null
      }
    }
  }
  return { upstreamCount: edgesByUpstream.size }
}

/**
 * Candidate endpoints for a NEW edge from ``sourceId``.
 *
 * Excludes: the source itself, every descendant of the source (a dependency
 * on your own subtree is always a nonsense or a cycle), and endpoints that
 * already have this exact edge.
 *
 * ★ 项目作用域（options.projectId）：默认只列**同项目**候选 —— 跨项目的
 *   任务与本项几乎不可同债，全量罗列只会把选择器变成大海捞针。依赖域合同
 *   允许跨项目边（服务端用 5 字段最小投影防泄露），所以保留
 *   ``includeCrossProject`` 显式开关，而不是把能力砍掉。
 *   不传 projectId 时保持历史行为（不过滤）。
 */
export function selectRelationCandidates(
  workItems: ReadonlyArray<{
    id: string
    parentId: string | null
    archivedAt: string | null
    projectId?: string
  }>,
  sourceId: string | null,
  existingRelations: readonly CachedRelation[],
  options: { projectId?: string | null; includeCrossProject?: boolean } = {},
): string[] {
  if (!sourceId) return []
  const children = new Map<string | null, string[]>()
  for (const item of workItems) {
    const group = children.get(item.parentId) ?? []
    group.push(item.id)
    children.set(item.parentId, group)
  }
  const excluded = new Set<string>([sourceId])
  const frontier = [sourceId]
  while (frontier.length > 0) {
    const id = frontier.pop() as string
    for (const child of children.get(id) ?? []) {
      if (excluded.has(child)) continue
      excluded.add(child)
      frontier.push(child)
    }
  }
  const already = new Set(
    existingRelations
      .filter((edge) => edge.fromWorkItemId === sourceId || edge.toWorkItemId === sourceId)
      .map((edge) => (
        edge.fromWorkItemId === sourceId ? edge.toWorkItemId : edge.fromWorkItemId
      )),
  )
  return workItems
    .filter((item) => {
      if (excluded.has(item.id) || already.has(item.id) || item.archivedAt !== null) return false
      if (options.projectId != null && options.projectId !== '' && !options.includeCrossProject) {
        return item.projectId === options.projectId
      }
      return true
    })
    .map((item) => item.id)
}
