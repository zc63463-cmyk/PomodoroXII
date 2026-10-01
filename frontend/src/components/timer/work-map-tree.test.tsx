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
import { readWorkMapLayout } from '@/lib/work-map/island-layout'

import { WorkMapTree } from './work-map-tree'

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
