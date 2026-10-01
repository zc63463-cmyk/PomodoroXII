/**
 * 工作导图树渲染器（WorkMapTree）单元测试 —— ADR-0008 D15。
 *
 * 验证面：
 * - 纯展示树渲染（SVG、连线、节点）
 * - onFocusNode 小视图定位模式（有 cid 节点可定位，无 cid 节点只读提示）
 * - focusCid 驱动 wm-node--focus 高亮环（fail-soft 容错）
 * - 与 onSelectNode（编辑模式）隔离互斥
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { appendThoughtNode } from '@/lib/work-map/thought-nodes'
import { setNodeComment } from '@/lib/work-map/node-edits'
import { readWorkMapLayout } from '@/lib/work-map/island-layout'
import type { MapIslandLayout, MapTreeNode } from '@/lib/work-map/island-layout'

import { WorkMapTree, type WorkMapDependencyBadge } from './work-map-tree'

const SESSION_ID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

const ISLAND_MARKDOWN = appendThoughtNode(
  `<!--
next_cid: 2
centers:
  - at: "node:测试次一级的workitme/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 测试次一级的workitme

<!--
cid: "c1"
session_id: "${SESSION_ID}"
-->
## 09-30 19:55 会话

### 测试次一级的workitme
`,
  { sessionId: SESSION_ID, type: 'problem', title: '思考节点' },
).text

const LAYOUT = readWorkMapLayout(ISLAND_MARKDOWN)!

describe('WorkMapTree 树渲染与交互', () => {
  it('渲染 SVG 树形结构与无障碍 label', () => {
    const { container } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} label="测试导图" />,
    )
    const svg = container.querySelector('svg.wm-tree')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('aria-label', '测试导图')
    // 4 节点（L1 标题、会话节点、L3 标题、思考节点）与 3 条连线
    expect(container.querySelectorAll('.wm-node')).toHaveLength(4)
    expect(container.querySelectorAll('.wm-link')).toHaveLength(2)
  })

  it('★ 小视图定位模式（仅传 onFocusNode）：有 cid 节点挂定位入口，点击上抛 cid', () => {
    const onFocusNode = vi.fn()
    const { container } = render(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        onFocusNode={onFocusNode}
      />,
    )

    // 会话节点（cid="c1"）和思考节点（cid="c2"）均挂 role="button" 与定位 label
    const focusButtons = screen.getAllByRole('button')
    expect(focusButtons.length).toBeGreaterThanOrEqual(2)

    const sessionNode = container.querySelector('.wm-node[data-session="true"]')
    expect(sessionNode).toHaveAttribute('role', 'button')
    expect(sessionNode?.getAttribute('aria-label')).toContain('定位：')
    expect(sessionNode).toHaveAttribute('tabindex', '0')

    // 点击会话节点
    fireEvent.click(sessionNode!)
    expect(onFocusNode).toHaveBeenCalledWith('c1')

    // 键盘操作（Enter / Space）
    fireEvent.keyDown(sessionNode!, { key: 'Enter' })
    expect(onFocusNode).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(sessionNode!, { key: ' ' })
    expect(onFocusNode).toHaveBeenCalledTimes(3)

    // 点击思考节点
    const thoughtNode = container.querySelector('.wm-node[data-thought="problem"]')
    expect(thoughtNode).toHaveAttribute('role', 'button')
    fireEvent.click(thoughtNode!)
    expect(onFocusNode).toHaveBeenLastCalledWith('c2')
  })

  it('★ 存量节点（无 cid）：不响应定位，保留「存量节点（无 cid，只读）」hover 提示', () => {
    const onFocusNode = vi.fn()
    const { container } = render(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        onFocusNode={onFocusNode}
      />,
    )

    // 存量节点（无 cid，本 fixture 中有 L1 与 L3 两个存量标题）
    const readonlyNodes = container.querySelectorAll('.wm-node[data-readonly="true"]')
    expect(readonlyNodes.length).toBe(2)
    const stockNode = readonlyNodes[0]
    expect(stockNode.getAttribute('role')).toBeNull()
    expect(stockNode.querySelector('title')?.textContent).toBe('存量节点（无 cid，只读）')

    fireEvent.click(stockNode)
    expect(onFocusNode).not.toHaveBeenCalled()
  })

  it('★ focusCid 驱动高亮环：对应节点带 wm-node--focus 与 data-focus', () => {
    const { container, rerender } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} focusCid="c2" />,
    )

    const focusedNode = container.querySelector('.wm-node--focus')
    expect(focusedNode).not.toBeNull()
    expect(focusedNode).toHaveAttribute('data-focus', 'true')
    expect(focusedNode).toHaveAttribute('data-thought', 'problem')

    // 切换 focusCid="c1"
    rerender(<WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} focusCid="c1" />)
    const newFocused = container.querySelector('.wm-node--focus')
    expect(newFocused).toHaveAttribute('data-session', 'true')
  })

  it('fail-soft：focusCid 为 null 或指向不存在/已删节点时无环无报错', () => {
    const { container, rerender } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} focusCid={null} />,
    )
    expect(container.querySelector('.wm-node--focus')).toBeNull()

    // 故意指向已删/不存在的 cid
    rerender(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} focusCid="deleted-cid-999" />,
    )
    expect(container.querySelector('.wm-node--focus')).toBeNull()
  })

  it('编辑模式（传 onSelectNode）与定位模式互斥：会话节点只读不可编辑', () => {
    const onSelectNode = vi.fn()
    const onFocusNode = vi.fn()
    const { container } = render(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        onSelectNode={onSelectNode}
        onFocusNode={onFocusNode}
      />,
    )

    // 编辑模式优先：会话节点不能编辑（只读）
    const sessionNode = container.querySelector('.wm-node[data-session="true"]')
    expect(sessionNode).toHaveAttribute('data-readonly', 'true')
    expect(sessionNode?.querySelector('title')?.textContent).toBe('会话节点（只读）')

    fireEvent.click(sessionNode!)
    expect(onSelectNode).not.toHaveBeenCalled()
    expect(onFocusNode).not.toHaveBeenCalled()

    // 思考节点可编辑
    const thoughtNode = container.querySelector('.wm-node[data-thought="problem"]')
    expect(thoughtNode?.getAttribute('aria-label')).toContain('编辑节点：')
    fireEvent.click(thoughtNode!)
    expect(onSelectNode).toHaveBeenCalledWith('c2')
  })
})

/** 手工实体岛：根 = @work_item:wi-a，子 = @work_item:wi-b（徽章对位用）。 */
function entityNode(
  id: string,
  refId: string,
  depth: number,
  children: MapTreeNode[] = [],
): MapTreeNode {
  return {
    id,
    text: `实体 ${refId}`,
    thoughtType: null,
    sessionId: null,
    sessionNode: false,
    cid: null,
    comment: null,
    refId,
    refKind: 'work_item',
    depth,
    box: { x: depth * 200, y: 0, w: 160, h: 28 },
    children,
  }
}

const DEP_ISLAND: MapIslandLayout = (() => {
  const tree = entityNode('dep-a', 'wi-a', 0, [entityNode('dep-b', 'wi-b', 1)])
  const nodes: MapTreeNode[] = [tree, ...tree.children]
  return {
    rootId: 'dep-root',
    sourceKind: 'promoted',
    sessionId: null,
    tree,
    nodes,
    links: [],
    bounds: { minX: 0, minY: 0, maxX: 360, maxY: 28 },
  }
})()

describe('WorkMapTree 依赖徽章与 BUG-WM-001（D19-b / 2026-10-01）', () => {
  it('★ 有未完成上游：红 ⚡N 徽章 + tooltip 摘要（数据来自 dependency-map-adapter 统计）', () => {
    const badges = new Map<string, WorkMapDependencyBadge>([['wi-a', { upstream: 2, blocked: 2 }]])
    const { container } = render(
      <WorkMapTree islands={[DEP_ISLAND]} sessionId={null} dependencyBadges={badges} />,
    )
    const badge = container.querySelector('[data-testid="wm-dep-badge"]')
    expect(badge).not.toBeNull()
    expect(badge).toHaveClass('wm-dep-badge--blocked')
    expect(badge?.getAttribute('data-blocked')).toBe('true')
    expect(badge?.getAttribute('data-upstream')).toBe('2')
    expect(badge?.textContent).toContain('⚡ 2')
    expect(badge?.querySelector('title')?.textContent).toBe('上游依赖 2 项 · 未完成 2 项')
    // 只有命中 refId 的节点挂徽章：子节点（wi-b 无数据）不挂
    expect(container.querySelectorAll('[data-testid="wm-dep-badge"]')).toHaveLength(1)
  })

  it('★ 上游全部完成：绿 ✓ 徽章（data-blocked=false）', () => {
    const badges = new Map<string, WorkMapDependencyBadge>([['wi-a', { upstream: 3, blocked: 0 }]])
    const { container } = render(
      <WorkMapTree islands={[DEP_ISLAND]} sessionId={null} dependencyBadges={badges} />,
    )
    const badge = container.querySelector('[data-testid="wm-dep-badge"]')
    expect(badge).toHaveClass('wm-dep-badge--ok')
    expect(badge?.getAttribute('data-blocked')).toBe('false')
    expect(badge?.textContent).toContain('✓')
  })

  it('★ 无上游 / 无徽章数据 / 无实体引用 → 不渲染徽章', () => {
    const zero = new Map<string, WorkMapDependencyBadge>([['wi-a', { upstream: 0, blocked: 0 }]])
    const { container, rerender } = render(
      <WorkMapTree islands={[DEP_ISLAND]} sessionId={null} dependencyBadges={zero} />,
    )
    expect(container.querySelector('[data-testid="wm-dep-badge"]')).toBeNull()

    // refId 无命中
    rerender(
      <WorkMapTree
        islands={[DEP_ISLAND]}
        sessionId={null}
        dependencyBadges={new Map([['wi-other', { upstream: 1, blocked: 1 }]])}
      />,
    )
    expect(container.querySelector('[data-testid="wm-dep-badge"]')).toBeNull()

    // 未传 prop（会话岛场景的既有形态）
    rerender(<WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} />)
    expect(container.querySelector('[data-testid="wm-dep-badge"]')).toBeNull()
  })

  it('★ BUG-WM-001 回归：准备态（sessionId=null）不再误挂「本次」高亮框', () => {
    // 修复前：`node.sessionId === sessionId` 的 null === null 让根岛与存量节点
    // 全部带上 wm-box--session / data-session="true"
    const { container } = render(<WorkMapTree islands={LAYOUT.islands} sessionId={null} />)
    expect(container.querySelectorAll('.wm-box--session')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="wm-session-node"]')).toHaveLength(0)
    expect(container.querySelectorAll('.wm-node[data-session="true"]')).toHaveLength(0)

    // 真实会话 id 命中时行为不变：恰好会话节点一个高亮
    const { container: withSid } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} />,
    )
    expect(withSid.querySelectorAll('.wm-box--session')).toHaveLength(1)
    expect(withSid.querySelectorAll('[data-testid="wm-session-node"]')).toHaveLength(1)
  })
})

/**
 * 幕布描述块渲染（PXII-FEAT-DESC-BLOCK，2026-10-01）。
 *
 * 断言锚在 DOM 上：节点 `<g>` 内部真的有 `.wm-desc-bar` 竖线与 `.wm-desc-text`
 * 文本（不再是"只有一个橙点、文字丢在下方操作栏"），且完整注释经 `<title>`
 * 100% 可读 —— 这是"注释不可见"问题的直接回归面。
 */
describe('幕布描述块渲染（PXII-FEAT-DESC-BLOCK）', () => {
  /** 带 2 行注释的思考节点岛（真实写入器产出，几何与渲染走同一条链路）。 */
  const WITH_COMMENT = readWorkMapLayout(
    setNodeComment(ISLAND_MARKDOWN, {
      cid: 'c2',
      comment: ['先确认上游', 'blocked 不能进 post-image'],
    }).text,
  )!

  const commentNode = (container: HTMLElement): Element => {
    const node = container.querySelector('.wm-node[data-comment="true"]')
    if (node === null) throw new Error('没有带注释的节点')
    return node
  }

  it('★ 带注释节点内部渲染引用竖线 + 描述文本（彻底解决「注释不可见」）', () => {
    const { container } = render(
      <WorkMapTree islands={WITH_COMMENT.islands} sessionId={SESSION_ID} />,
    )
    const node = commentNode(container)

    const group = node.querySelector('[data-testid="wm-desc-group"]')
    expect(group).not.toBeNull()

    // 左引用细竖线（2px 圆角，与 MindCanvas DescBlock 同形）
    const bar = group!.querySelector('line.wm-desc-bar')
    expect(bar).not.toBeNull()
    expect(bar).toHaveAttribute('stroke-width', '2')
    expect(bar).toHaveAttribute('stroke-linecap', 'round')
    expect(Number(bar!.getAttribute('y1'))).toBeGreaterThanOrEqual(28) // 竖线在标题带之下
    expect(Number(bar!.getAttribute('y2'))).toBeGreaterThan(Number(bar!.getAttribute('y1')))

    // 描述文字：两行 tspan，内容逐字保真
    const text = group!.querySelector('text.wm-desc-text')
    expect(text).not.toBeNull()
    expect(text).toHaveAttribute('font-size', '10')
    const tspans = [...group!.querySelectorAll('tspan')]
    expect(tspans.map((t) => t.textContent)).toEqual(['先确认上游', 'blocked 不能进 post-image'])
    // 行距 = DESC_LINE_H（14）：两行基线相差 14px
    expect(Number(tspans[1]!.getAttribute('y')) - Number(tspans[0]!.getAttribute('y'))).toBe(14)

    // 旧的"只有橙点"形态已退役（几何足够时不再画点）
    expect(node.querySelector('.wm-comment-dot')).toBeNull()
  })

  it('★ 完整注释经 <title> 100% 可读（> 3 行的长注释靠 hover 兜底）', () => {
    const long = readWorkMapLayout(
      setNodeComment(ISLAND_MARKDOWN, {
        cid: 'c2',
        comment: ['第一行', '第二行', '第三行', '第四行', '第五行'],
      }).text,
    )!
    const { container } = render(<WorkMapTree islands={long.islands} sessionId={SESSION_ID} />)
    const node = commentNode(container)

    // 盒内只画 3 行（可见行上限）
    expect(node.querySelectorAll('tspan')).toHaveLength(3)
    expect(node.getAttribute('data-desc-lines')).toBe('3')

    // tooltip 含全部 5 行 —— 长注释一个字都不丢
    const tooltip = node.querySelector('title')?.textContent ?? ''
    for (const line of ['第一行', '第二行', '第三行', '第四行', '第五行']) {
      expect(tooltip).toContain(line)
    }
    expect(tooltip).toContain('注释备忘')
  })

  it('★ 无注释节点不渲染描述块（也不留橙点）', () => {
    const { container } = render(<WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} />)
    expect(container.querySelector('[data-testid="wm-desc-group"]')).toBeNull()
    expect(container.querySelector('.wm-desc-bar')).toBeNull()
    expect(container.querySelector('.wm-comment-dot')).toBeNull()
  })

  it('★ 选中态提亮：选中带注释节点 → 竖线随选中环（wm-node--selected）', () => {
    const { container } = render(
      <WorkMapTree
        islands={WITH_COMMENT.islands}
        sessionId={SESSION_ID}
        selectedCid="c2"
        onSelectNode={() => undefined}
      />,
    )
    const node = commentNode(container)
    expect(node).toHaveClass('wm-node--selected')
    // 样式钩子在（颜色由 CSS 的 .wm-node--selected .wm-desc-bar 决定）
    expect(node.querySelector('line.wm-desc-bar')).not.toBeNull()
  })

  it('★ 几何不足时降级：手工岛的注释仍以橙点提示（不画出盒外）', () => {
    // 手工构造：box.h 只有 28 但带 comment（老几何 / 外部调用方）
    const flat: MapTreeNode = {
      ...entityNode('flat-a', 'wi-flat', 0),
      comment: ['不该被画出来'],
      box: { x: 0, y: 0, w: 160, h: 28 },
    }
    const island: MapIslandLayout = {
      rootId: 'flat-root',
      sourceKind: 'promoted',
      sessionId: null,
      tree: flat,
      nodes: [flat],
      links: [],
      bounds: { minX: 0, minY: 0, maxX: 160, maxY: 28 },
    }
    const { container } = render(<WorkMapTree islands={[island]} sessionId={null} />)
    const node = container.querySelector('.wm-node[data-comment="true"]')!
    expect(node.querySelector('[data-testid="wm-desc-group"]')).toBeNull()
    expect(node.querySelector('.wm-comment-dot')).not.toBeNull()
    // 全文仍可从 tooltip 读到
    expect(node.querySelector('title')?.textContent).toContain('不该被画出来')
  })

  it('★ 关键不变量：描述文字与竖线**逐 px 落在节点盒内**（不溢出、不压邻居）', () => {
    const withComment = readWorkMapLayout(
      setNodeComment(ISLAND_MARKDOWN, {
        cid: 'c2',
        comment: ['先确认上游', 'blocked 不能进 post-image', '第三行'],
      }).text,
    )!
    const { container } = render(
      <WorkMapTree islands={withComment.islands} sessionId={SESSION_ID} />,
    )
    const node = commentNode(container)
    // 盒高（渲染出的 rect）—— 与度量同源
    const rect = node.querySelector('rect.wm-box')!
    const boxH = Number(rect.getAttribute('height'))
    const boxW = Number(rect.getAttribute('width'))

    // 描述行数 = 3（可见上限内）
    const tspans = [...node.querySelectorAll('.wm-desc-text tspan')]
    expect(tspans).toHaveLength(3)

    // 每条基线 + 字号下沿 ≤ 盒底（文字不会画出盒外）
    const fontSize = Number(node.querySelector('.wm-desc-text')!.getAttribute('font-size'))
    for (const tspan of tspans) {
      const baseline = Number(tspan.getAttribute('y'))
      expect(baseline).toBeLessThanOrEqual(boxH)
      expect(baseline + fontSize * 0.25).toBeLessThanOrEqual(boxH)
    }

    // 竖线两端都在盒内，且不越过盒底
    const bar = node.querySelector('line.wm-desc-bar')!
    expect(Number(bar.getAttribute('y1'))).toBeGreaterThan(0)
    expect(Number(bar.getAttribute('y2'))).toBeLessThanOrEqual(boxH)
    // 竖线 + 缩进后文字仍在盒宽内
    const textX = Number(tspans[0]!.getAttribute('x'))
    expect(textX).toBeGreaterThan(0)
    expect(textX).toBeLessThan(boxW)
  })
})
