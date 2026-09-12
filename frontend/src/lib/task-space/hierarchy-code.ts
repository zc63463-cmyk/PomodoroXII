/**
 * 层级编码（`1` / `1.2` / `1.2.3`）—— **纯派生，不落库**。
 *
 * ★ 为什么不改服务端 displayKey：`display_key` 是依赖域合同的身份字段
 *   （最小投影、同步 post-image 都引用它），把编码方案换成层级制属于域变更
 *   （迁移 + 编译器 + 合同）。而客户端已经持有完整父子结构，完全可以按
 *   「派生不落库」的原则在本地算出层级编码，只用于**展示与筛选**。
 *
 * ★ 编码取每层内按 childRank（1 起）排序后的兄弟序号。父项移动/重排会让
 *   整棵子树重新编号 —— 这正是层级编码的本意：它反映**当前结构**，
 *   不是稳定身份（稳定身份仍然是 displayKey / id）。
 */

export interface HierarchyCodeInput {
  id: string
  parentId: string | null
  childRank: number
}

/**
 * 返回 `id → 层级编码`。孤儿节点（父项不在集合内）以自身兄弟序作为顶层
 * 编码，避免整条分支丢失编号。
 */
export function buildHierarchyCodes(
  items: readonly HierarchyCodeInput[],
): Record<string, string> {
  const byId = new Map(items.map((item) => [item.id, item]))
  const byParent = new Map<string, HierarchyCodeInput[]>()
  for (const item of items) {
    const key = item.parentId != null && byId.has(item.parentId) ? item.parentId : '__root__'
    byParent.set(key, [...(byParent.get(key) ?? []), item])
  }

  const codes: Record<string, string> = {}
  const visitChildren = (parentKey: string, prefix: string | null): void => {
    const siblings = [...(byParent.get(parentKey) ?? [])].sort(
      (left, right) => left.childRank - right.childRank || left.id.localeCompare(right.id),
    )
    siblings.forEach((child, index) => {
      const code = prefix == null ? String(index + 1) : `${prefix}.${index + 1}`
      codes[child.id] = code
      visitChildren(child.id, code)
    })
  }
  visitChildren('__root__', null)
  return codes
}
