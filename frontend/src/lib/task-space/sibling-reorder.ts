/** ★ 工单②：拖拽手势 → 服务端 reorder rank 语义的前端换算（纯函数）。
 *
 * 服务端（_compile_ReorderWorkItem）的 rank 定义：在**去掉被移动行之后**的
 * 同父兄弟序列（按 child_rank 升序、id 升序稳定排序 —— 与读侧 ORDER BY 一致）
 * 中的插入位次。本函数把「插到 target 前 / 后」的 UI 意图换算成该位次。
 *
 * 跨父场景：先 move（append 到目标父末尾），再调用本函数 —— 此时兄弟序列里
 * 被移动行排在末尾，去掉它不影响 target 的位次，换算结果与同父场景一致。
 */

export type SiblingPosition = 'before' | 'after'

export interface SiblingRow {
  id: string
  childRank: number
}

export function siblingReorderRank(
  siblings: readonly SiblingRow[],
  draggedId: string,
  targetId: string,
  position: SiblingPosition,
): number {
  const ordered = [...siblings].sort(
    (a, b) => a.childRank - b.childRank || a.id.localeCompare(b.id),
  )
  const withoutDragged = ordered.filter((item) => item.id !== draggedId)
  const targetIndex = withoutDragged.findIndex((item) => item.id === targetId)
  // target 不在兄弟序列里（或 target === dragged）：退化到 append 末尾。
  if (targetIndex < 0) return withoutDragged.length
  return position === 'before' ? targetIndex : targetIndex + 1
}
