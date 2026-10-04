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
import { findSessionIslandLayout, readWorkMapLayout } from '@/lib/work-map/island-layout'
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
    // 发端枢纽 tooltip：首行是 `会话发端：<完整标题>`（PXII-FEAT-SESSION-HUB），
    // 末行仍是只读原因 —— 两者都在，用 toContain 而非全等
    const sessionTitle = sessionNode?.querySelector('title')?.textContent ?? ''
    expect(sessionTitle).toContain('会话发端：09-30 19:55 会话')
    expect(sessionTitle).toContain('会话节点（只读）')

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

/**
 * 会话发端枢纽 + 地标卡顶栏标题（PXII-FEAT-SESSION-HUB，2026-10-02）。
 *
 * 断言锚在 DOM 可观察量上：会话岛根渲染为 `.wm-box--session-hub`（外环 + 中心
 * 亮点），**不再**渲染宽矩形卡与截断文本；完整会话标题出现在岛地标卡顶栏
 * （`.wm-island-title`）且当前会话/历史会话呈不同态；交互契约（data-session /
 * data-cid / role / tooltip）在枢纽形态下原样保留。
 */
describe('会话发端枢纽与顶栏标题（PXII-FEAT-SESSION-HUB）', () => {
  const hubOf = (container: HTMLElement): Element | null =>
    container.querySelector('[data-testid="wm-session-hub"]')

  it('★ 会话岛根渲染发端枢纽：外圆环 + 中心亮点，不再有宽矩形卡与节点文本', () => {
    const { container } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} />,
    )
    const sessionNode = container.querySelector('.wm-node[data-session="true"]')!
    const hub = hubOf(container)
    expect(hub).not.toBeNull()
    expect(sessionNode.contains(hub)).toBe(true)

    // 外圆环 r=10 + 中心亮点 r=4（SESSION_HUB_SIZE=28 盒内）
    const ring = hub!.querySelector('circle.wm-hub-ring')!
    const core = hub!.querySelector('circle.wm-hub-core')!
    expect(Number(ring.getAttribute('r'))).toBe(10)
    expect(Number(core.getAttribute('r'))).toBe(4)
    // 圆心落在盒中心（14,14）
    expect(Number(ring.getAttribute('cx'))).toBe(14)
    expect(Number(ring.getAttribute('cy'))).toBe(14)

    // 会话节点不再画矩形卡、不再画自己的文本（标题已上浮到地标卡）。
    // 注：`textContent` 含 `<title>` tooltip（其中带完整标题），故按**可见文本**
    // 判定 —— `.wm-text` 文本元素不存在即"画布内无截断标题"。
    expect(sessionNode.querySelector('rect.wm-box')).toBeNull()
    expect(sessionNode.querySelector('.wm-text')).toBeNull()
    // 但它是"当前会话"：枢纽带 data-hub-current
    expect(hub).toHaveAttribute('data-hub-current', 'true')
    // 普通节点仍是矩形卡 + 文本（回归面：枢纽只作用于会话岛根）
    const stockNode = container.querySelector('.wm-node[data-readonly="true"]')!
    expect(stockNode.querySelector('rect.wm-box')).not.toBeNull()
    expect(stockNode.querySelector('.wm-text')).not.toBeNull()
  })

  it('★ 地标卡顶栏标题：完整会话标题上浮（当前会话蓝 / 历史会话灰），超长截断 + tooltip 全文', () => {
    const { container } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} />,
    )
    const card = container.querySelector('[data-testid="wm-island-card"]')!
    const title = card.querySelector('[data-testid="wm-island-title"]')!
    expect(title).not.toBeNull()
    expect(title.textContent).toBe('09-30 19:55 会话')
    expect(title.getAttribute('data-full-title')).toBe('09-30 19:55 会话')
    expect(title.getAttribute('data-truncated')).toBe('false')
    expect(title).toHaveAttribute('text-anchor', 'start')
    expect(title).toHaveAttribute('dominant-baseline', 'central')
    // 完整标题经 <title> 可读（挂在包裹 <g> 上，textContent 不重复）
    expect(card.querySelector('[data-testid="wm-island-title-wrap"] title')?.textContent)
      .toBe('09-30 19:55 会话')
    // 当前会话岛：卡片带 --current，标题走高亮（颜色由 CSS 派生）
    expect(card).toHaveClass('wm-island-card--current')
  })

  it('★ 历史会话岛（sessionId 不命中）→ 枢纽不带当前态、卡片不带 --current', () => {
    const { container } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId="other-session" />,
    )
    const hub = hubOf(container)
    expect(hub).not.toBeNull()
    expect(hub).toHaveAttribute('data-hub-current', 'false')
    expect(container.querySelector('[data-testid="wm-island-card"]')).not.toHaveClass(
      'wm-island-card--current',
    )
    // 标题仍完整呈现（历史会话同样享有顶栏标题）
    expect(container.querySelector('[data-testid="wm-island-title"]')?.textContent)
      .toBe('09-30 19:55 会话')
  })

  it('★ 交互契约在枢纽形态下保留：data-session / data-cid / role=button / 发端 tooltip', () => {
    const onFocusNode = vi.fn()
    const { container } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} onFocusNode={onFocusNode} />,
    )
    const sessionNode = container.querySelector('.wm-node[data-session="true"]')!
    expect(sessionNode).toHaveAttribute('data-cid', 'c1')
    expect(sessionNode).toHaveAttribute('role', 'button')
    expect(sessionNode).toHaveAttribute('tabindex', '0')
    // 发端 tooltip：`会话发端：<完整标题>`（定位模式下会话节点可点，故无只读提示）
    expect(sessionNode.querySelector('title')?.textContent).toBe('会话发端：09-30 19:55 会话')
    // 点击仍上抛 cid（枢纽不是"视觉换皮就丢交互"）
    fireEvent.click(hubOf(container)!)
    expect(onFocusNode).toHaveBeenCalledWith('c1')
  })

  it('★ 超长会话标题：顶栏标题截断补 `…`，data-full-title 仍持全文', () => {
    const longTitle = '这是一个特别特别特别特别特别特别特别长的会话标题应当被截断'
    const longDoc = `<!--
next_cid: 2
centers:
  - at: "node:工作项/${longTitle}"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 工作项

<!--
cid: "c1"
session_id: "${SESSION_ID}"
-->
## ${longTitle}

### 子节点
`
    const layout = readWorkMapLayout(longDoc)!
    const { container } = render(
      <WorkMapTree islands={layout.islands} sessionId={SESSION_ID} />,
    )
    const title = container.querySelector('[data-testid="wm-island-title"]')!
    expect(title.getAttribute('data-full-title')).toBe(longTitle)
    expect(title.getAttribute('data-truncated')).toBe('true')
    expect(title.textContent!.endsWith('…')).toBe(true)
    expect(title.textContent!.length).toBeLessThan(longTitle.length)
  })

  it('★ 地标卡保底最小宽度（MIN_ISLAND_CARD_W = 260）：单短节点极窄岛不压缩顶栏', () => {
    const tinyDoc = `<!--
next_cid: 2
centers:
  - at: "node:项/会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 项

<!--
cid: "c1"
session_id: "${SESSION_ID}"
-->
## 会话

### 短
`
    const layout = readWorkMapLayout(tinyDoc)!
    const { container } = render(
      <WorkMapTree islands={layout.islands} sessionId={SESSION_ID} />,
    )
    const card = container.querySelector('[data-testid="wm-island-card"]')!
    const frame = card.querySelector('rect.wm-island-frame')!
    const cardWidth = Number(frame.getAttribute('width'))
    expect(cardWidth).toBeGreaterThanOrEqual(260)
  })
})

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
    // 准备态下没有任何"当前会话"枢纽（历史会话岛根仍有枢纽，但 data-hub-current=false）
    expect(container.querySelectorAll('[data-hub-current="true"]')).toHaveLength(0)

    // 真实会话 id 命中时行为不变：恰好会话节点一个高亮。
    // ★ PXII-FEAT-SESSION-HUB：会话节点的"高亮"形态从矩形蓝框（.wm-box--session）
    //   改为发端枢纽的蓝环（.wm-box--session-hub[data-hub-current='true']）。
    const { container: withSid } = render(
      <WorkMapTree islands={LAYOUT.islands} sessionId={SESSION_ID} />,
    )
    expect(withSid.querySelectorAll('.wm-box--session-hub')).toHaveLength(1)
    expect(withSid.querySelectorAll('[data-hub-current="true"]')).toHaveLength(1)
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

  it('★ 当前专注计划项高亮（方案 A）：currentPlanTitle 命中 depth 1 节点挂 .wm-node--current-plan 与 [专注中] 标识', () => {
    const { container } = render(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        currentPlanTitle="测试次一级的workitme"
      />,
    )
    const currentPlanNode = container.querySelector('.wm-node[data-current-plan="true"]')
    expect(currentPlanNode).not.toBeNull()
    expect(currentPlanNode).toHaveClass('wm-node--current-plan')
    expect(currentPlanNode!.querySelector('.wm-box--current-plan')).not.toBeNull()
    expect(currentPlanNode!.querySelector('title')?.textContent).toContain('[专注中]')

    // 不匹配的标题不误标
    const { container: mismatchContainer } = render(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        currentPlanTitle="其它不存在项"
      />,
    )
    expect(mismatchContainer.querySelector('.wm-node[data-current-plan="true"]')).toBeNull()
  })

  it('★ 嵌套子岛（PXII-FEAT-NESTED-ISLAND）：渲染 L3 子岛卡片、支持当前计划项标识', () => {
    const { container } = render(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        currentPlanTitle="测试次一级的workitme"
      />,
    )
    const subCards = container.querySelectorAll('[data-testid="wm-sub-island-card"]')
    expect(subCards.length).toBeGreaterThanOrEqual(1)
    const currentSubCard = container.querySelector('[data-testid="wm-sub-island-card"][data-current-plan="true"]')
    expect(currentSubCard).not.toBeNull()
    expect(currentSubCard).toHaveClass('wm-sub-island-card--current')
    expect(currentSubCard?.querySelector('.wm-sub-island-frame')).not.toBeNull()
    expect(currentSubCard?.querySelector('.wm-sub-island-tag-text')?.textContent).toContain('L3 子岛')
  })

  it('★ 嵌套子岛聚焦与交互：双击卡片/点击标签上抛 onSubIslandFocusRequest，focusedSubIslandId 生效并 dim 其它子岛', () => {
    const onSubFocus = vi.fn()
    const { container, rerender } = render(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        onSubIslandFocusRequest={onSubFocus}
      />,
    )
    const subCard = container.querySelector('[data-testid="wm-sub-island-card"]')
    expect(subCard).not.toBeNull()
    const subId = subCard!.getAttribute('data-sub-island-id')!
    expect(subId).toBeTruthy()

    // 全局视角下：会话地标大卡存在
    expect(container.querySelector('[data-testid="wm-island-card"]')).not.toBeNull()

    // 点击标签上抛
    const tagWrap = subCard!.querySelector('.wm-sub-island-tag-wrap')!
    fireEvent.click(tagWrap)
    expect(onSubFocus).toHaveBeenCalledWith(subId)

    // 双击卡片上抛
    fireEvent.doubleClick(subCard!)
    expect(onSubFocus).toHaveBeenCalledWith(subId)

    // 当 focusedSubIslandId 命中时（进入 L3 专注岛视图）
    rerender(
      <WorkMapTree
        islands={LAYOUT.islands}
        sessionId={SESSION_ID}
        currentPlanTitle="测试次一级的workitme"
        focusedSubIslandId={subId}
        onSubIslandFocusRequest={onSubFocus}
      />,
    )
    expect(subCard).toHaveClass('wm-sub-island-card--focused')
    expect(subCard?.getAttribute('data-focused')).toBe('true')

    // 方案 A 关键断言 1：外层父会话大卡隐藏，不产生层叠挤压
    expect(container.querySelector('[data-testid="wm-island-card"]')).toBeNull()

    // 方案 A 关键断言 2：聚焦子岛顶栏标题（红框）与左色条呈现
    const subTitle = subCard!.querySelector('[data-testid="wm-sub-island-title"]')
    expect(subTitle).not.toBeNull()
    expect(subTitle?.textContent).toContain('L3 子任务岛')
    expect(subCard!.querySelector('.wm-sub-island-bar')).not.toBeNull()

    // 方案 A 关键断言 3：状态角标
    const subBadge = subCard!.querySelector('[data-testid="wm-sub-island-badge"]')
    expect(subBadge).not.toBeNull()
    expect(subBadge?.textContent).toContain('当前专注中')

    // 方案 A 关键断言 4：底部返回全局群岛胶囊按钮，点击上抛退出
    const exitBtn = subCard!.querySelector('[data-testid="map-sub-island-exit-btn"]')
    expect(exitBtn).not.toBeNull()
    expect(exitBtn?.textContent).toContain('返回会话全局群岛')
    fireEvent.click(exitBtn!)
    expect(onSubFocus).toHaveBeenLastCalledWith('')
  })
})

/**
 * 群岛 fixture：会话岛下挂 **4 个** L3 子岛 —— 触发 `layoutArchipelagoIsland`
 * 横向卡片流（>2 才撑宽），从而覆盖"全局群岛卡片"这一支的完成态渲染。
 */
const ARCHIPELAGO_MARKDOWN = `<!--
next_cid: 9
centers:
  - at: "node:完成态测试workitem/10-02 10:00 会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 完成态测试workitem

<!--
cid: "c1"
session_id: "${SESSION_ID}"
-->
## 10-02 10:00 会话

<!--
cid: "c2"
-->
### 甲岛

<!--
cid: "c3"
-->
### 乙岛

<!--
cid: "c4"
-->
### 丙岛

<!--
cid: "c5"
-->
### 丁岛
`

const ARCHIPELAGO_LAYOUT = readWorkMapLayout(ARCHIPELAGO_MARKDOWN)!

/**
 * 横向群岛卡片流只对**单会话岛**投影（`islands.length === 1` 才生效，
 * 多岛全览维持全局 2D 排布）—— 与 `TimerMapEditor` / `TimerMapPort` 的用法一致。
 */
const ARCHIPELAGO_ISLAND = findSessionIslandLayout(ARCHIPELAGO_LAYOUT, SESSION_ID)!

describe('WorkMapTree 子岛一键完成（PXII-FEAT-PLAN-CHECKOFF）', () => {
  const cardOf = (container: HTMLElement, title: string): Element => {
    const cards = [...container.querySelectorAll('[data-testid="wm-sub-island-card"]')]
    const hit = cards.find((card) =>
      card.querySelector('[data-testid="wm-sub-island-card-title"]')?.textContent?.includes(title),
    )
    if (hit === undefined) throw new Error(`找不到子岛卡片：${title}`)
    return hit
  }

  it('★ 未完成：卡片渲染打勾按钮（data-completed="false"、○），点击上抛该子岛标题', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        planCompletion={new Map([['甲岛', false]])}
        onTogglePlanCompletion={onToggle}
      />,
    )
    const card = cardOf(container, '甲岛')
    const check = card.querySelector('[data-testid="wm-sub-island-check"]')!
    expect(check).not.toBeNull()
    expect(check.getAttribute('data-completed')).toBe('false')
    expect(check.getAttribute('aria-pressed')).toBe('false')
    expect(check.querySelector('.wm-sub-island-check-mark')?.textContent).toBe('○')
    expect(card.getAttribute('data-completed')).toBeNull()

    fireEvent.click(check)
    expect(onToggle).toHaveBeenCalledWith('甲岛')
  })

  it('★ 已完成：卡片挂 --completed / data-completed="true"，✓ 标记与「✓ 已完成」胶囊，且**分支与连线完整保留**', () => {
    const { container } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        planCompletion={new Map([['乙岛', true]])}
        onTogglePlanCompletion={vi.fn()}
      />,
    )
    const card = cardOf(container, '乙岛')
    expect(card).toHaveClass('wm-sub-island-card--completed')
    expect(card.getAttribute('data-completed')).toBe('true')

    // 打勾按钮：淡绿实底对勾
    const check = card.querySelector('[data-testid="wm-sub-island-check"]')!
    expect(check).toHaveClass('wm-sub-island-check--done')
    expect(check.getAttribute('data-completed')).toBe('true')
    expect(check.querySelector('.wm-sub-island-check-mark')?.textContent).toBe('✓')

    // 右上角微型胶囊「✓ 已完成」
    expect(card.querySelector('.wm-sub-island-tag-text')?.textContent).toBe('✓ 已完成')

    // ★ 红线：完成态**不裁信息** —— 整图节点/连线数与未完成时逐一相等
    //   （节点与连线是子岛卡片的**兄弟**而非子元素，故按整图统计）
    expect(container.querySelectorAll('.wm-node').length).toBeGreaterThan(0)
    //   该子岛的根节点仍在 DOM 且带完成绿意（不是被隐藏）
    const rootMark = container.querySelector('.wm-node[data-plan-completed="true"]')
    expect(rootMark).not.toBeNull()
    expect(rootMark!.querySelector('.wm-box--plan-completed')).not.toBeNull()

    const { container: plain } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        planCompletion={new Map([['乙岛', false]])}
        onTogglePlanCompletion={vi.fn()}
      />,
    )
    expect(plain.querySelectorAll('.wm-node').length).toBe(container.querySelectorAll('.wm-node').length)
    expect(plain.querySelectorAll('.wm-link').length).toBe(container.querySelectorAll('.wm-link').length)
    expect(plain.querySelectorAll('.wm-text').length).toBe(container.querySelectorAll('.wm-text').length)
  })

  it('★ 打勾点击阻断冒泡：单击打勾**不会**触发卡片的聚焦双击（两个动作互不吃掉）', () => {
    const onToggle = vi.fn()
    const onSubFocus = vi.fn()
    const { container } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        planCompletion={new Map([['甲岛', false]])}
        onTogglePlanCompletion={onToggle}
        onSubIslandFocusRequest={onSubFocus}
      />,
    )
    const check = cardOf(container, '甲岛').querySelector('[data-testid="wm-sub-island-check"]')!

    fireEvent.click(check)
    fireEvent.doubleClick(check)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onSubFocus).not.toHaveBeenCalled()

    // 对照：卡片本体的双击仍然聚焦（打勾按钮没有把整张卡的双击吞掉）
    fireEvent.doubleClick(cardOf(container, '甲岛'))
    expect(onSubFocus).toHaveBeenCalledTimes(1)
  })

  it('★ 未传 planCompletion（小视图 / 总览）→ 不渲染任何打勾入口与完成态（纯展示零变化）', () => {
    const { container } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        onTogglePlanCompletion={vi.fn()}
      />,
    )
    expect(container.querySelector('[data-testid="wm-sub-island-check"]')).toBeNull()
    expect(container.querySelector('.wm-sub-island-card--completed')).toBeNull()
    // 未命中的子岛（有 Map 但无此项）同样不打勾：只有"本次计划的项"才可闭环
    const { container: partial } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        planCompletion={new Map([['甲岛', true]])}
        onTogglePlanCompletion={vi.fn()}
      />,
    )
    expect(partial.querySelectorAll('[data-testid="wm-sub-island-check"]')).toHaveLength(1)
  })

  it('★ 已完成子岛的**根节点**带轻微绿意（data-plan-completed），其余节点不受影响', () => {
    const { container } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        planCompletion={new Map([['丙岛', true]])}
        onTogglePlanCompletion={vi.fn()}
      />,
    )
    const marked = container.querySelectorAll('.wm-node[data-plan-completed="true"]')
    // 每个子岛只有根节点一个 → 恰 1 个（本 fixture 各子岛均为叶子，无后代思考节点）
    expect(marked).toHaveLength(1)
    expect(marked[0].querySelector('.wm-box--plan-completed')).not.toBeNull()
  })

  it('★ 聚焦态：打勾按钮与状态角标并排（不叠字），已完成时角标仍为「N 项思考」而非被顶掉', () => {
    const subCard = (container: HTMLElement): Element =>
      container.querySelector('[data-testid="wm-sub-island-card"]')!
    const subId = (() => {
      const { container } = render(
        <WorkMapTree islands={[ARCHIPELAGO_ISLAND]} sessionId={SESSION_ID} />,
      )
      return subCard(container).getAttribute('data-sub-island-id')!
    })()

    const { container } = render(
      <WorkMapTree
        islands={[ARCHIPELAGO_ISLAND]}
        sessionId={SESSION_ID}
        focusedSubIslandId={subId}
        planCompletion={new Map([['甲岛', true]])}
        onTogglePlanCompletion={vi.fn()}
      />,
    )
    const card = subCard(container)
    expect(card.getAttribute('data-focused')).toBe('true')
    expect(card.getAttribute('data-completed')).toBe('true')

    const check = card.querySelector('[data-testid="wm-sub-island-check"]')!
    const badge = card.querySelector('[data-testid="wm-sub-island-badge"]')!
    // 几何不重叠：打勾圆心 + 半径 ≤ 角标左缘
    const cx = Number(check.querySelector('circle')!.getAttribute('cx'))
    const r = Number(check.querySelector('circle')!.getAttribute('r'))
    const badgeX = Number(badge.querySelector('rect')!.getAttribute('x'))
    expect(cx + r).toBeLessThanOrEqual(badgeX)
    // 状态角标语义不被完成态顶掉（「N 项思考」/「当前专注中」照旧）
    expect(badge.textContent).toContain('项思考')
  })
})
