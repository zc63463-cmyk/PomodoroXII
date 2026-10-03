/**
 * `layoutArchipelagoIsland` 的**层级保真**判别测试（2026-10-03 真机回归）。
 *
 * ## 缺陷现象
 * 主图「L3 子岛卡」把子树拍平：真机截图里 `xe`（H4）明明是 `测试一个测试`（H3）的
 * 子节点、自己还带 3 个 H5 孙节点，主图却把它们与 `xe` 并排成兄弟。
 * 岛内（聚焦态）渲染是正确的树 —— 说明**数据没错，是群岛布局的排布逻辑错了**。
 *
 * ## 根因
 * `island-layout.ts` 的 `layoutArchipelagoIsland` 取 `sub.nodes`
 * （`flatten(child)` 得到的**前序扁平**列表）逐个竖排，并把每条连线都从
 * **子岛根**发出 → 所有深度节点被拉平成兄弟。
 *
 * ## 本文件锁定的性质
 * 1. 子节点在 `children` 里保持**真实父子关系**（不被拍平）
 * 2. 连线的 `fromId` 是**真实父节点**，不是一律子岛根
 * 3. 节点**不重叠**、不出卡（几何不变量）
 * 4. 无子树的情形（只有一层）行为逐字节不变（向后兼容）
 */
import { describe, expect, it } from 'vitest'

import { layoutArchipelagoIsland, readWorkMapLayout } from './island-layout'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/**
 * 复刻真机那份文件的层级：L3 根下挂 4 个子节点，其中 `xe` 另有 3 个孙节点。
 * ```
 * ### 测试一个测试          ← L3 子岛根
 * #### xe                  ← 有子树的节点
 * ##### 测试               ← 孙
 * ##### 测试               ← 孙
 * ##### 测试               ← 孙
 * #### 测试                ← 叶子
 * #### 大测试              ← 叶子
 * #### 测试                ← 叶子
 * ```
 */
const NESTED = `<!--
next_cid: 30
centers:
  - at: "node:测试次一级的workitme/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SID}"
-->
# 测试次一级的workitme

<!--
cid: "c1"
session_id: "${SID}"
-->
## 09-30 19:55 会话

### 测试一个测试

<!--
cid: "c13"
-->
#### xe

<!--
cid: "c20"
-->
##### 测试

<!--
cid: "c21"
-->
##### 测试

<!--
cid: "c22"
-->
##### 测试

<!--
cid: "c14"
-->
#### 测试

<!--
cid: "c15"
-->
#### 大测试

<!--
cid: "c19"
-->
#### 测试
`

/**
 * 取**群岛布局**后的岛。
 *
 * 必须显式调 `layoutArchipelagoIsland`：`readWorkMapLayout` 只做 2D 投影，
 * 群岛卡片流是渲染层（`work-map-tree.tsx`）单岛模式下的二次投影。
 */
function archipelagoOf(text: string) {
  const layout = readWorkMapLayout(text, { expandAll: true })
  expect(layout).not.toBeNull()
  const island = layout?.islands.find((item) => item.sessionId === SID)
  expect(island).toBeDefined()
  return layoutArchipelagoIsland(island!)
}

function byText(island: ReturnType<typeof archipelagoOf>, text: string) {
  return island.nodes.find((node) => node.text === text)
}

describe('layoutArchipelagoIsland · 层级保真（2026-10-03 真机回归）', () => {
  it('★ 子树不被拍平：xe 的孙节点挂在 xe 下，不是挂在子岛根下', () => {
    const island = archipelagoOf(NESTED)
    expect(island.isArchipelago).toBe(true)

    const xe = byText(island, 'xe')
    const l3 = byText(island, '测试一个测试')
    expect(xe).toBeDefined()
    expect(l3).toBeDefined()

    // xe 的 children 必须是它自己的 3 个孙节点
    const grandChildren = xe!.children.map((node) => node.text)
    expect(grandChildren).toHaveLength(3)
    expect(grandChildren.every((text) => text === '测试')).toBe(true)

    // 而「测试一个测试」的直接孩子应是 4 个（xe + 3 个叶子），不含孙节点
    const directChildren = l3!.children.map((node) => node.text)
    expect(directChildren).toHaveLength(4)
    expect(directChildren).toContain('xe')
    expect(directChildren).toContain('大测试')
  })

  it('★ 连线从真实父节点发出，而不是一律从子岛根', () => {
    const island = archipelagoOf(NESTED)
    const xe = byText(island, 'xe')!
    const l3 = byText(island, '测试一个测试')!

    // 子岛根 → xe 的连线应当存在
    const rootToXe = island.links.find(
      (link) => link.fromId === l3.id && link.toId === xe.id,
    )
    expect(rootToXe).toBeDefined()

    // 关键：xe → 孙节点的连线，其 fromId 必须是 xe，**不是** l3
    const xeChildIds = new Set(xe.children.map((node) => node.id))
    const fromXe = island.links.filter((link) => xeChildIds.has(link.toId))
    expect(fromXe.length).toBe(3)
    for (const link of fromXe) {
      expect(link.fromId).toBe(xe.id)
      expect(link.fromId).not.toBe(l3.id)
    }
  })

  it('节点不重叠：所有盒两两不交（几何不变量）', () => {
    const island = archipelagoOf(NESTED)
    const boxes = island.nodes.map((node) => node.box)
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!
        const b = boxes[j]!
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(
          overlap,
          `节点 ${i}(${JSON.stringify(a)}) 与 ${j}(${JSON.stringify(b)}) 重叠`,
        ).toBe(false)
      }
    }
  })

  it('节点不出卡：所有盒都在子岛并集的 bounds 内', () => {
    const island = archipelagoOf(NESTED)
    for (const sub of island.subIslands ?? []) {
      for (const node of sub.nodes) {
        expect(node.box.x).toBeGreaterThanOrEqual(sub.bounds.minX)
        expect(node.box.y).toBeGreaterThanOrEqual(sub.bounds.minY)
        expect(node.box.x + node.box.w).toBeLessThanOrEqual(sub.bounds.maxX + 1)
        expect(node.box.y + node.box.h).toBeLessThanOrEqual(sub.bounds.maxY + 1)
      }
    }
  })

  it('★ 卡片齐底：所有子岛 bounds.maxY 相同（否则矮卡下方留大片空白）', () => {
    // NESTED 只有一个子岛 → 补一个「矮卡」子岛，制造高度差
    const withTwo = NESTED.replace(
      '### 测试一个测试',
      '### 另一个瘦任务\n\n<!--\ncid: "c30"\n-->\n#### 只有一个子节点\n\n### 测试一个测试',
    )
    const island = archipelagoOf(withTwo)
    const subs = island.subIslands ?? []
    expect(subs.length).toBe(2)
    const bottoms = new Set(subs.map((sub) => sub.bounds.maxY))
    expect(bottoms.size).toBe(1)
  })

  it('向后兼容：只有一层子节点时，父子关系与数量不变', () => {
    const flat = `<!--
next_cid: 10
centers:
  - at: "node:work/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SID}"
-->
# work

<!--
cid: "c1"
session_id: "${SID}"
-->
## 09-30 19:55 会话

### 任务甲

<!--
cid: "c2"
-->
#### 子一

<!--
cid: "c3"
-->
#### 子二
`
    const island = archipelagoOf(flat)
    const l3 = byText(island, '任务甲')!
    expect(l3.children.map((node) => node.text)).toEqual(['子一', '子二'])
  })
})
