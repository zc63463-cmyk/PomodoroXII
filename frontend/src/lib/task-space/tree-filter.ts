import type { CachedWorkItem } from '@/types'

/**
 * Work-item tree filtering (纯函数，保留层级)。
 *
 * ★ 过滤**永远不会隐藏命中节点的祖先**：树上必须始终能看到一条从根到命中项
 *    的完整路径，否则命中项会凭空出现、父子关系不可读。
 *
 * ★ 过滤激活时，树组件会忽略手工折叠状态（见 WorkItemTree.filterActive），
 *    保证命中的深层节点直接可见，而不是被折叠的父级藏住。
 */

export type TreeStatusFilter = 'all' | 'open' | 'completed'

export interface WorkItemTreeFilter {
  /** 按标题 / displayKey 的不区分大小写包含匹配。 */
  query: string
  /** `open` = 未完成也未取消；`completed` = 已完成。 */
  status: TreeStatusFilter
  /** 只看被依赖阻塞的二级任务。 */
  blockedOnly: boolean
  /**
   * ★ P3（2026-10-04）：按标签筛选，**AND 语义**（须同时具备全部选中标签）。
   *
   * 为什么是 AND 而不是 OR：① 与本文件既有的 query / status / blockedOnly
   * 是同一套「全部条件都要满足」的叠加口径，不一致会让用户以为是两套规则；
   * ② 主流工具（Todoist / Jira）搜多标签都是 AND（"同时打 #A #B"）。
   *
   * 为什么**归档标签仍参与**匹配：归档是软删除，标签还挂在工作项上；
   * 若归档后立刻筛不到，那些行就成了"有数据但捞不出来"的孤儿。
   */
  labelIds: string[]
}

export const EMPTY_TREE_FILTER: WorkItemTreeFilter = {
  query: '',
  status: 'all',
  blockedOnly: false,
  labelIds: [],
}

export interface TreeFilterContext {
  categoryById: Record<string, string | undefined>
  isBlockedById: Record<string, boolean>
  /** 层级编码（`1.2.3`）—— 命中前缀即命中整棵子树，是依赖筛选的主入口。 */
  codeById?: Record<string, string>
}

export function isTreeFilterActive(filter: WorkItemTreeFilter): boolean {
  return (
    filter.query.trim() !== '' ||
    filter.status !== 'all' ||
    filter.blockedOnly ||
    filter.labelIds.length > 0
  )
}

function matchesFilter(
  item: CachedWorkItem,
  filter: WorkItemTreeFilter,
  context: TreeFilterContext,
): boolean {
  const needle = filter.query.trim().toLowerCase()
  if (needle !== '') {
    const code = context.codeById?.[item.id] ?? ''
    const haystack = `${code} ${item.displayKey} ${item.title}`.toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  const category = context.categoryById[item.id]
  if (filter.status === 'open' && (category === 'completed' || category === 'cancelled')) {
    return false
  }
  if (filter.status === 'completed' && category !== 'completed') return false
  if (filter.blockedOnly && context.isBlockedById[item.id] !== true) return false
  // ★ P3：标签 AND 匹配。空数组时跳过（isTreeFilterActive 已保证不进这里）。
  if (filter.labelIds.length > 0) {
    const owned = new Set(item.labelIds ?? [])
    for (const wanted of filter.labelIds) {
      if (!owned.has(wanted)) return false
    }
  }
  return true
}

/**
 * 返回过滤后仍应渲染的工作项（保持入参顺序）。
 * 命中项 + 命中项的全部祖先；无命中时返回空数组。
 */
export function filterWorkItemTree(
  items: readonly CachedWorkItem[],
  filter: WorkItemTreeFilter,
  context: TreeFilterContext,
): CachedWorkItem[] {
  if (!isTreeFilterActive(filter)) return [...items]

  const matches = new Set<string>()
  for (const item of items) {
    if (matchesFilter(item, filter, context)) matches.add(item.id)
  }
  if (matches.size === 0) return []

  const byId = new Map(items.map((item) => [item.id, item]))
  const kept = new Set<string>()
  for (const id of matches) {
    let cursor: string | null | undefined = id
    while (cursor != null && cursor !== '' && !kept.has(cursor)) {
      kept.add(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
  }
  return items.filter((item) => kept.has(item.id))
}

/** 每个父项下未完成（未完成且未取消）的直接子项数。 */
export function countOpenChildren(
  items: readonly CachedWorkItem[],
  categoryById: Record<string, string | undefined>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const parentId = item.parentId
    if (parentId == null || parentId === '') continue
    const category = categoryById[item.id]
    if (category === 'completed' || category === 'cancelled') continue
    counts[parentId] = (counts[parentId] ?? 0) + 1
  }
  return counts
}
