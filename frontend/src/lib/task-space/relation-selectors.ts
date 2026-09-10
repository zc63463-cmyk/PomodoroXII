import type { CachedRelation } from '@/lib/contracts/task-space'

/**
 * Derived dependency state (依赖域合同 §13).
 *
 * ★★ 纯函数、零 I/O、永不落库。后端在 ``queries.py`` 里有一份同名同语义的
 *    实现（``derive_blocked_by_dependency`` / ``compute_is_blocked``）；
 *    这里必须与它保持逐条对齐，否则服务端投影与本地派生会打架。
 *
 * ★ 孤儿边容错（Phase D）：网络乱序可能让"关系边先于它引用的工作项"到达
 *    客户端。此时 ``statusCategoryById`` 里查不到上游节点 —— 一律按
 *    **未完成**处理，绝不能因为查不到就把阻塞解除（那会让用户误以为可以开工）。
 */

export const BLOCKING_RELATION_TYPES = new Set(['depends_on', 'blocks'])
export const TERMINAL_STATUS_CATEGORIES = new Set(['completed', 'cancelled'])

export interface BlockedSignals {
  blockedByDependency: boolean
  isBlocked: boolean
}

/**
 * AND semantics (D16): an item stays blocked while **any** upstream blocker
 * is still open.  Completing one of two upstreams must NOT unblock it.
 */
export function deriveBlockedByDependency(
  relations: readonly CachedRelation[],
  statusCategoryById: Readonly<Record<string, string | undefined>>,
): Record<string, boolean> {
  const blocked: Record<string, boolean> = {}
  for (const edge of relations) {
    if (!BLOCKING_RELATION_TYPES.has(edge.relationType)) continue
    const upstream = edge.toWorkItemId
    const category = statusCategoryById[upstream]
    if (category !== undefined && TERMINAL_STATUS_CATEGORIES.has(category)) continue
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
 * Count the still-open upstreams of one item — used for the tree's hover hint
 * ("blocked by N unfinished dependencies").  Orphan edges count as open.
 */
export function countOpenBlockers(
  relations: readonly CachedRelation[],
  workItemId: string,
  statusCategoryById: Readonly<Record<string, string | undefined>>,
): number {
  let count = 0
  for (const edge of relations) {
    if (edge.fromWorkItemId !== workItemId) continue
    if (!BLOCKING_RELATION_TYPES.has(edge.relationType)) continue
    const category = statusCategoryById[edge.toWorkItemId]
    if (category !== undefined && TERMINAL_STATUS_CATEGORIES.has(category)) continue
    count += 1
  }
  return count
}

/**
 * Candidate endpoints for a NEW edge from ``sourceId``.
 *
 * Excludes: the source itself, every descendant of the source (a dependency
 * on your own subtree is always a nonsense or a cycle), and endpoints that
 * already have this exact edge.
 */
export function selectRelationCandidates(
  workItems: ReadonlyArray<{ id: string; parentId: string | null; archivedAt: string | null }>,
  sourceId: string | null,
  existingRelations: readonly CachedRelation[],
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
    .filter((item) => !excluded.has(item.id) && !already.has(item.id) && item.archivedAt === null)
    .map((item) => item.id)
}
