/**
 * 工作导图读取（island-view）—— 协议可观察行为断言（ADR-0008 D11 纪律）。
 *
 * 断言锚在**协议行为**上（解析往返、cid 优先、路径锚三态、坐标成对强转、
 * 岛投影切分、fail-soft），不锚 kernel 内部实现细节。
 *
 * ★ 其中两处是 2026-09-30 spike 的实测发现，本文件即回归钉：
 *   1. `x`/`y` 经 kernel note 解析后是**字符串**（"900"）→ 必须数值强转；
 *   2. 本项目写出侧产出的岛文件（root 块 + 节点块）必须能被本读取侧读回。
 */
import { astToEditable, parseMm } from '@mindcanvas/kernel'
import type { EditableNode } from '@mindcanvas/kernel'
import { describe, expect, it, vi } from 'vitest'

import { findSessionIsland, readWorkMapView, resolveCenters } from './island-view'

/** 本系统真实产出的岛文件（2026-09-30 验收，S2 端到端链路写下的原件）。 */
const OUR_ISLAND = `<!--
next_cid: 2
centers:
  - at: "node:测试次一级的workitme/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "c766be47-8725-443b-86e3-7cfee648a2f4"
-->
# 测试次一级的workitme

<!--
cid: "c1"
session_id: "c766be47-8725-443b-86e3-7cfee648a2f4"
-->
## 09-30 19:55 会话

### 测试次一级的workitme
`

/** S0 手写协议样本（带 x/y 坐标；用于坐标强转与多岛切分断言）。 */
const S0_SAMPLE = `<!--
next_cid: c2
centers:
  - at: "node:实现依赖域阻塞计算/2026-09-29 会话 A"
    cid: c1
    dir: right
    x: 900
    y: 0
-->
# 实现依赖域阻塞计算

## 任务树

### 派生 blocked 信号

<!--
cid: c1
note:
  - 先确认上游取消后是否需要显式确认
-->
## 2026-09-29 会话 A

### 为什么不在事务内发通知
`

const treeOf = (text: string): EditableNode => {
  const parsed = parseMm(text)
  if (parsed.root === null) throw new Error('fixture 解析失败')
  const editable = astToEditable(parsed.root)
  if (editable === null) throw new Error('fixture 转换失败')
  return editable
}

describe('readWorkMapView（读我们自己的产出）', () => {
  it('★ 本项目写出的岛文件可被读回：根 + 会话岛（两处同写）+ session_id 保留', () => {
    const view = readWorkMapView(OUR_ISLAND)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.root.text).toBe('测试次一级的workitme')
    expect(view.diagnostics).toEqual([])
    expect(view.islands).toHaveLength(2)

    const rootIsland = view.islands[0]
    expect(rootIsland.sourceKind).toBe('root')
    expect(rootIsland.sessionId).toBeNull()
    expect(rootIsland.nodes.map((node) => node.text)).toEqual(['测试次一级的workitme'])

    const island = findSessionIsland(view, 'c766be47-8725-443b-86e3-7cfee648a2f4')
    expect(island).not.toBeNull()
    expect(island?.sourceKind).toBe('promoted')
    expect(island?.nodes.map((node) => node.text)).toEqual([
      '09-30 19:55 会话',
      '测试次一级的workitme',
    ])
    // 节点级 session_id 与根块 centers 条目一致（两处同写的读侧确认）
    expect(island?.nodes[0]?.note?.session_id).toBe('c766be47-8725-443b-86e3-7cfee648a2f4')
  })

  it('按会话定位：无此会话时返回 null（端口可据此显示"本会话暂无岛"）', () => {
    const view = readWorkMapView(OUR_ISLAND)
    if (view === null) throw new Error('fixture 解析失败')
    expect(findSessionIsland(view, 'not-a-session')).toBeNull()
    expect(findSessionIsland(view, '')).toBeNull()
  })
})

describe('readWorkMapView（S0 样本与边界）', () => {
  it('多岛切分：根岛 + 升格会话岛，岛内成员前序且互不重复', () => {
    const view = readWorkMapView(S0_SAMPLE)
    if (view === null) throw new Error('fixture 解析失败')
    expect(view.diagnostics).toEqual([])
    expect(view.islands.map((island) => island.sourceKind)).toEqual(['root', 'promoted'])
    const [root, promoted] = view.islands
    expect(root?.nodes.map((node) => node.text)).toEqual([
      '实现依赖域阻塞计算',
      '任务树',
      '派生 blocked 信号',
    ])
    expect(promoted?.nodes.map((node) => node.text)).toEqual([
      '2026-09-29 会话 A',
      '为什么不在事务内发通知',
    ])
  })

  it('fail-soft：空文本 → null', () => {
    expect(readWorkMapView('')).toBeNull()
    expect(readWorkMapView('   \n\t ')).toBeNull()
  })

  it('fail-soft：无根文档 → null 且只记 warn，不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(readWorkMapView('<!--\nnote: 只有备注块，没有标题\n-->\n')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('resolveCenters（自持读数，协议可观察行为）', () => {
  it('★ 坐标强转：kernel 解析出的字符串 "900"/"0" → 数（否则坐标静默丢失）', () => {
    const { specs, diagnostics } = resolveCenters(treeOf(S0_SAMPLE))
    expect(diagnostics).toEqual([])
    expect(specs).toHaveLength(1)
    expect(specs[0]?.state).toBe('well-formed')
    expect(specs[0]?.pos).toEqual({ x: 900, y: 0 })
    expect(specs[0]?.dir).toBe('right')
  })

  it('坐标成对口径：只给 x → 不认（null），不猜 y', () => {
    const tree = treeOf(`<!--
centers:
  - at: "node:根"
    x: 10
-->
# 根
`)
    const { specs } = resolveCenters(tree)
    expect(specs[0]?.pos).toBeNull()
  })

  it('cid 优先于 at：两者指向不同节点时按 cid 解析', () => {
    const tree = treeOf(`<!--
centers:
  - at: "node:根/另一支"
    cid: c1
-->
# 根

<!--
cid: c1
-->
## 本支

## 另一支
`)
    const { specs } = resolveCenters(tree)
    expect(specs[0]?.state).toBe('well-formed')
    const hit = specs[0]?.nodeId
    expect(hit).not.toBeNull()
    // 命中节点应是「本支」（cid 所在），而不是 at 指向的「另一支」
    const walk = (node: EditableNode): string | null => {
      if (node.id === hit) return node.text ?? ''
      for (const child of node.children) {
        const found = walk(child)
        if (found !== null) return found
      }
      return null
    }
    expect(walk(tree)).toBe('本支')
  })

  it('路径锚三态：唯一命中 well-formed、无命中 dangling、同名多命中 stale', () => {
    // 注：fixture 用「双键条目」（at + dir）——单键条目会被 kernel 解析成标量，
    // 见下方"单键条目口径"用例；这里要测的是路径锚本身。
    const unique = treeOf(`<!--
centers:
  - at: "node:根/支/叶"
    dir: right
-->
# 根

## 支

### 叶
`)
    expect(resolveCenters(unique).specs[0]?.state).toBe('well-formed')

    const missing = treeOf(`<!--
centers:
  - at: "node:根/不存在"
    dir: right
-->
# 根
`)
    expect(resolveCenters(missing).specs[0]?.state).toBe('dangling')

    const ambiguous = treeOf(`<!--
centers:
  - at: "node:根/支/叶"
    dir: right
-->
# 根

## 支

### 叶

### 叶
`)
    const specs = resolveCenters(ambiguous).specs
    expect(specs[0]?.state).toBe('stale')
    expect(specs[0]?.nodeId).toBeNull()
  })

  it('★ 单键条目口径（实测）：只有单个 k: v 行的 centers 条目被 kernel 解析成标量 → 跳过 + 诊断', () => {
    const tree = treeOf(`<!--
centers:
  - at: "node:根"
-->
# 根
`)
    const { specs, diagnostics } = resolveCenters(tree)
    expect(specs).toEqual([])
    expect(diagnostics.map((d) => d.code)).toEqual(['center-entry-invalid'])
  })

  it('非记录条目跳过并产出诊断；无 centers 时为空', () => {
    const tree: EditableNode = {
      id: 'r1',
      type: 'text',
      text: '根',
      note: { centers: [42, { at: 'node:根', dir: 'left' }] },
      children: [],
    }
    const { specs, diagnostics } = resolveCenters(tree)
    expect(diagnostics.map((d) => d.code)).toEqual(['center-entry-invalid'])
    expect(specs).toHaveLength(1)
    expect(specs[0]?.state).toBe('well-formed')
    expect(specs[0]?.dir).toBe('left')

    const bare = treeOf('# 根\n')
    expect(resolveCenters(bare)).toEqual({ specs: [], diagnostics: [] })
  })
})
