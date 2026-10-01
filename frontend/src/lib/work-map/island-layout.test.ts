/**
 * 工作导图几何层（island-layout）—— ADR-0008 D15 步 3-1。
 *
 * 断言锚在**几何可观察量**上：节点盒不重叠、子节点在父的右侧（`dir: right` 数据语义）、
 * 连线数与可见边数一致、会话节点与类型节点可辨识、fail-soft。
 */
import { describe, expect, it, vi } from 'vitest'

import { appendThoughtNode } from './thought-nodes'
import { setNodeComment } from './node-edits'
import { findSessionIslandLayout, measureWorkMapNode, readWorkMapLayout } from './island-layout'
import { astToEditable, parseMm } from '@mindcanvas/kernel'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/** 真实产出的岛文件（+ 两个类型节点，模拟快速记录后的形态）。 */
const BASE = `<!--
next_cid: 2
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

### 测试次一级的workitme
`

const WITH_THOUGHTS = appendThoughtNode(
  appendThoughtNode(BASE, { sessionId: SID, type: 'problem', title: 'token 对照：灰阶 vs 玻璃主题' }).text,
  { sessionId: SID, type: 'todo', title: '写一节"岛的归档策略"草案' },
).text

describe('readWorkMapLayout（几何层）', () => {
  it('★ 岛与节点：根岛 + 会话岛；会话岛含会话根、L3 子节点与两个类型节点', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    expect(layout).not.toBeNull()
    if (layout === null) return
    expect(layout.islands).toHaveLength(2)

    const island = findSessionIslandLayout(layout, SID)
    expect(island).not.toBeNull()
    if (island === null) return
    expect(island.sourceKind).toBe('promoted')
    expect(island.tree.sessionNode).toBe(true)
    expect(island.nodes.map((node) => node.text)).toEqual([
      '09-30 19:55 会话',
      '测试次一级的workitme',
      'token 对照：灰阶 vs 玻璃主题',
      '写一节"岛的归档策略"草案',
    ])
    expect(island.nodes.map((node) => node.thoughtType)).toEqual([
      null, null, 'problem', 'todo',
    ])
  })

  it('★ 数据语义 dir: right 落到几何：子节点在父的**右侧**、深度递增、盒有效', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')

    const root = island.tree
    expect(root.depth).toBe(0)
    for (const child of root.children) {
      expect(child.depth).toBe(1)
      expect(child.box.x).toBeGreaterThan(root.box.x) // 右侧生长（dir: right）
      expect(child.box.w).toBeGreaterThanOrEqual(76)
      expect(child.box.h).toBeGreaterThan(0)
    }
    // 同级不重叠（纵向排开）
    const ys = root.children.map((child) => child.box.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1])
    }
    expect(island.bounds.maxX).toBeGreaterThan(island.bounds.minX)
    expect(island.bounds.maxY).toBeGreaterThan(island.bounds.minY)
  })

  it('连线：条数 = 岛内可见边数（4 节点 → 3 条），path 非空且两端都在岛内', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    expect(island.links).toHaveLength(3)
    const ids = new Set(island.nodes.map((node) => node.id))
    for (const link of island.links) {
      expect(ids.has(link.fromId)).toBe(true)
      expect(ids.has(link.toId)).toBe(true)
      expect(link.path.length).toBeGreaterThan(0)
    }
  })

  it('度量自持：全角更宽、夹在 [76, 240]、非文本节点不崩', () => {
    const narrow = astToEditable(parseMm('# 根\n\n## a\n')!.root!)!
    const wide = astToEditable(parseMm('# 根\n\n## 很长很长很长很长很长很长很长很长很长很长很长很长的标题\n')!.root!)!
    const narrowChild = narrow.children[0]
    const wideChild = wide.children[0]
    expect(measureWorkMapNode(narrowChild, 1).w).toBeLessThan(measureWorkMapNode(wideChild, 1).w)
    expect(measureWorkMapNode(wideChild, 1).w).toBeLessThanOrEqual(240)
    expect(measureWorkMapNode(narrowChild, 1).w).toBeGreaterThanOrEqual(76)
  })

  it('fail-soft：空文本 / 无根文档 → null（只记 warn，不抛）', () => {
    expect(readWorkMapLayout('')).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(readWorkMapLayout('<!--\nnote: 无标题\n-->\n')).toBeNull()
    warn.mockRestore()
  })

  it('★ 稳定编辑键 cid：可编辑节点带 cid，存量无 cid 节点为 null（只读；D16-a）', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    // 会话节点 c1；存量 L3 标题行无块 → null；两个快速记录节点 c2 / c3
    expect(island.nodes.map((node) => node.cid)).toEqual(['c1', null, 'c2', 'c3'])
  })

  it('★ 注释 comment：从块内 note 列表读出；无注释节点为 null', () => {
    const withComment = setNodeComment(WITH_THOUGHTS, {
      cid: 'c2',
      comment: ['先确认上游', 'blocked 不能进 post-image'],
    }).text
    const layout = readWorkMapLayout(withComment)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    expect(
      island.nodes.find((node) => node.text === 'token 对照：灰阶 vs 玻璃主题')?.comment,
    ).toEqual(['先确认上游', 'blocked 不能进 post-image'])
    expect(
      island.nodes.find((node) => node.text === '写一节"岛的归档策略"草案')?.comment,
    ).toBeNull()
  })

  it('脏值容忍：cid 缺失 / note 非字符串列表 → null（读侧 fail-closed）', () => {
    const dirty = WITH_THOUGHTS.replace(
      '<!--\nthought_type: "problem"\ncid: "c2"\n-->',
      '<!--\nthought_type: "problem"\nnote: 只是标量\n-->',
    )
    const layout = readWorkMapLayout(dirty)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    const node = island.nodes.find((item) => item.text === 'token 对照：灰阶 vs 玻璃主题')
    expect(node?.cid).toBeNull()
    expect(node?.comment).toBeNull()
  })
})
