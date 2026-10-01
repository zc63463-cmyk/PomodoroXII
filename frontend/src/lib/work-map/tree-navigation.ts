/**
 * 导图**树形方向导航**（PXII-FEAT-KEYMAP-FLOW）—— 纯函数、无 IO。
 *
 * ## 语义（与 MindCanvas 原生「方向键 = 就近节点导航」同款心智）
 * 树在屏幕上是**横向生长**的（`dir: right` 落到几何），故方向键与树结构一一对应：
 *
 * | 键 | 结构语义 | 落点 |
 * |---|---|---|
 * | ↑ / ↓ | 同层游走 | 同父兄弟列表里上/下**一个**（到边界即停，不跨父跳） |
 * | ← | 向根回退 | 父节点（**父不可编辑则原地不动**，见下） |
 * | → | 深入分支 | 第一个**可编辑**子节点（无则原地不动） |
 *
 * ## 为什么「不可编辑就原地不动」而不是「跳到最近的可编辑祖先」
 * 会话节点（岛根）与存量无 `cid` 节点是**只读**的（ADR-0008 D16-a）。若 ← 落到
 * 只读父节点，选中态会挂到一个**没有任何操作入口**的节点上 —— 用户看到选中环却
 * 按 F2 无反应，比"没反应"更困惑。故导航**只在可编辑节点间移动**：到只读边界即停。
 * 这条规则同时保证了「导航不会把选中态带出当前会话岛」（岛根恒不可编辑）。
 *
 * ## 为什么 ↑/↓ 不跨父跳（不做"就近节点"）
 * MindCanvas 原生的 ↑/↓ 是**就近节点**（可跨父），因为它是全图自由编辑。本项目编辑区
 * 的 ↑/↓ 是**同层游走**：会话岛内节点层级浅、同层条目多（一次专注记 5~10 条），
 * "同层上下"可预测；跨父跳会让"按三下 ↓"的落点依赖各父节点的子数，无法形成肌肉记忆。
 */
import type { MapTreeNode } from './island-layout'

/** 可编辑判定（ADR-0008 D16-a）：有稳定编辑键 `cid` 且非会话节点。 */
export function isEditableNode(node: MapTreeNode): boolean {
  return node.cid !== null && !node.sessionNode
}

/** 父节点 + 同层兄弟（`parent === null` 表示 `target` 是树的根）。 */
interface NodeLocation {
  parent: MapTreeNode | null
  siblings: readonly MapTreeNode[]
  index: number
}

/** 深度优先定位 `cid` 节点（同时带回其父与兄弟列表，避免调用方再走一遍）。 */
function locate(root: MapTreeNode, cid: string): NodeLocation | null {
  const walk = (
    node: MapTreeNode,
    parent: MapTreeNode | null,
    siblings: readonly MapTreeNode[],
    index: number,
  ): NodeLocation | null => {
    if (node.cid !== null && node.cid === cid) return { parent, siblings, index }
    for (let i = 0; i < node.children.length; i += 1) {
      const hit = walk(node.children[i], node, node.children, i)
      if (hit !== null) return hit
    }
    return null
  }
  return walk(root, null, [root], 0)
}

/**
 * 定位 `cid` 节点的**父节点**（无父 → `null`）。
 *
 * 与方向键 ← 的区别：← 要求父节点**可编辑**（否则选中态会落到没有操作入口的
 * 只读节点上），而「新建同级」只需要父节点**有 cid 可作加子锚点** —— 最常见的
 * 情形恰恰是父节点 = 会话节点（岛根只读、但有 cid），此时同级生长 = 给岛根加子。
 */
export function findParentNode(root: MapTreeNode, cid: string): MapTreeNode | null {
  return locate(root, cid)?.parent ?? null
}

/**
 * 方向键 → 目标节点 cid；无可移动目标 → `null`（调用方保持当前选中）。
 *
 * @param root 岛树根（`MapIslandLayout.tree`；岛根 = 会话节点）
 * @param currentCid 当前选中节点的 cid
 * @param dir 方向
 */
export function findNextNavNode(
  root: MapTreeNode,
  currentCid: string,
  dir: 'up' | 'down' | 'left' | 'right',
): string | null {
  const here = locate(root, currentCid)
  if (here === null) return null

  switch (dir) {
    case 'up':
    case 'down': {
      const step = dir === 'up' ? -1 : 1
      const target = here.siblings[here.index + step]
      if (target === undefined || !isEditableNode(target)) return null
      return target.cid
    }
    case 'left': {
      // 到只读父节点（会话节点 / 无 cid 存量节点）即停 —— 见文件头注
      if (here.parent === null || !isEditableNode(here.parent)) return null
      return here.parent.cid
    }
    case 'right': {
      // 第一个**可编辑**子节点：跳过只读子节点（存量无 cid）而不是死路
      for (const child of here.siblings[here.index].children) {
        if (isEditableNode(child)) return child.cid
      }
      return null
    }
  }
}
