/**
 * 树形方向导航（PXII-FEAT-KEYMAP-FLOW）—— 纯函数穷举。
 *
 * fixture 形状刻意贴近真实会话岛：**岛根是会话节点（只读、有 cid）**，
 * 其下才是可编辑的思考节点，其中还混入一个**无 cid 的存量节点**（只读）。
 * 三条只读边界（岛根 / 无 cid / 越界）是导航语义的核心，必须逐条钉死。
 */
import { describe, expect, it } from 'vitest'

import type { MapTreeNode } from './island-layout'
import { findNextNavNode, findParentNode, isEditableNode } from './tree-navigation'

/** 造节点（默认：有 cid、非会话节点 = 可编辑）。 */
function node(
  text: string,
  cid: string | null,
  children: MapTreeNode[] = [],
  sessionId: string | null = null,
): MapTreeNode {
  return {
    id: `id-${text}`,
    text,
    thoughtType: null,
    sessionId,
    sessionNode: sessionId !== null,
    cid,
    comment: null,
    refId: null,
    refKind: null,
    depth: 0,
    box: { x: 0, y: 0, w: 100, h: 28 },
    children,
  }
}

/**
 * ```
 * 会话节点（岛根，c1，只读）
 *   ├─ A（c2）        ← 兄弟组 1
 *   │    ├─ A1（c4）
 *   │    └─ A2（无 cid，只读）
 *   ├─ B（c3）        ← 兄弟组 1
 *   └─ 存量（无 cid，只读）
 * ```
 */
const TREE: MapTreeNode = node('会话', 'c1', [
  node('A', 'c2', [node('A1', 'c4'), node('A2', null)]),
  node('B', 'c3'),
  node('存量', null),
], 'session-1')

describe('isEditableNode（可编辑判定 = D16-a）', () => {
  it('★ 有 cid 且非会话节点 → 可编辑；会话节点 / 无 cid → 只读', () => {
    const [a, b, legacy] = TREE.children
    expect(isEditableNode(a)).toBe(true)
    expect(isEditableNode(b)).toBe(true)
    expect(isEditableNode(legacy)).toBe(false)
    expect(isEditableNode(TREE)).toBe(false) // 会话节点恒只读
  })
})

describe('findNextNavNode（方向键导航）', () => {
  it('★ ↑ / ↓：同父兄弟组内上下移动一格', () => {
    expect(findNextNavNode(TREE, 'c2', 'down')).toBe('c3') // A → B
    expect(findNextNavNode(TREE, 'c3', 'up')).toBe('c2') // B → A
  })

  it('★ ↑ / ↓ 到边界即停（不跨父跳、不环绕）', () => {
    expect(findNextNavNode(TREE, 'c2', 'up')).toBeNull() // A 是首个可编辑兄弟
    // ↓ 的下一个兄弟是"存量"（无 cid，只读）→ 停住而不是跳过它
    expect(findNextNavNode(TREE, 'c3', 'down')).toBeNull()
    expect(findNextNavNode(TREE, 'c4', 'up')).toBeNull() // A1 是独子
    expect(findNextNavNode(TREE, 'c4', 'down')).toBeNull()
  })

  it('★ ← 回退到父节点（父可编辑时）', () => {
    expect(findNextNavNode(TREE, 'c4', 'left')).toBe('c2') // A1 → A
    expect(findNextNavNode(TREE, 'c2', 'left')).toBeNull() // A 的父是会话节点（只读）→ 原地
  })

  it('★ ← 的父节点只读（会话节点 / 无 cid）→ 原地不动（不让选中态落到没有入口的节点）', () => {
    expect(findNextNavNode(TREE, 'c3', 'left')).toBeNull()
  })

  it('★ → 深入第一个可编辑子节点；跳过只读子节点', () => {
    expect(findNextNavNode(TREE, 'c2', 'right')).toBe('c4') // A → A1
    expect(findNextNavNode(TREE, 'c4', 'right')).toBeNull() // A1 无子
    expect(findNextNavNode(TREE, 'c3', 'right')).toBeNull() // B 无子
  })

  it('★ → 首个可编辑子节点：只读子节点被跳过，但不会死路', () => {
    // A2（无 cid）排在前面时，→ 仍应落到 A1
    const tree = node('会话', 'c1', [
      node('A', 'c2', [node('只读子', null), node('A1', 'c4')]),
    ], 'session-1')
    expect(findNextNavNode(tree, 'c2', 'right')).toBe('c4')
  })

  it('★ 会话节点（岛根）不在导航起点：currentCid 指向只读节点 → 导航仍按树位算', () => {
    // 岛根是 c1：↓ 落到第一个可编辑兄弟？岛根无兄弟 → null；→ 落到 A
    expect(findNextNavNode(TREE, 'c1', 'down')).toBeNull()
    expect(findNextNavNode(TREE, 'c1', 'up')).toBeNull()
    expect(findNextNavNode(TREE, 'c1', 'left')).toBeNull()
    expect(findNextNavNode(TREE, 'c1', 'right')).toBe('c2')
  })

  it('★ cid 不在树中 → null（fail-soft：选中态与几何不同步时不炸）', () => {
    expect(findNextNavNode(TREE, 'c-not-exist', 'down')).toBeNull()
    expect(findNextNavNode(TREE, 'c-not-exist', 'right')).toBeNull()
  })
})

describe('findParentNode（同级生长的锚点）', () => {
  it('★ 取父节点，含**只读**父（会话节点）—— 同级生长正需要它作加子锚点', () => {
    expect(findParentNode(TREE, 'c2')?.cid).toBe('c1') // A 的父 = 会话节点（可作锚点）
    expect(findParentNode(TREE, 'c4')?.cid).toBe('c2') // A1 的父 = A
  })

  it('★ 根 / 不在树中 → null', () => {
    expect(findParentNode(TREE, 'c1')).toBeNull()
    expect(findParentNode(TREE, 'c-not-exist')).toBeNull()
  })
})
