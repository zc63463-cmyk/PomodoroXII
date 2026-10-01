/**
 * 右栏导图**小视图**（TimerMapPort）—— ADR-0008 D15 后的断言面。
 *
 * 断言锚在可观察结构上：树渲染（SVG + 会话节点高亮 + 类型节点）、极简态 `data-minimal`
 * 派生且**同一 DOM**（几何不变）、无图/解析失败 → 占位（fail-soft）、
 * 点即定位（`onFocusNode` 抛出 cid，极简态仍可用）。
 * 快速记录的断言已随职责迁移到 `timer-map-editor.test.tsx`（D15）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { appendThoughtNode } from '@/lib/work-map/thought-nodes'

import { TimerMapPort } from './timer-map-port'

const SESSION_ID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/** 本项目真实产出的岛文件（+ 一个类型节点，模拟快速记录后）。 */
const ISLAND = appendThoughtNode(
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
  { sessionId: SESSION_ID, type: 'problem', title: 'token 对照：灰阶 vs 玻璃主题' },
).text

describe('TimerMapPort（右栏小视图）', () => {
  it('★ 树渲染：SVG + 会话节点（wm-session-node）+ 类型节点（data-thought）', () => {
    const { container } = render(
      <TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal={false} />,
    )
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'false')
    expect(screen.getByTestId('map-port-canvas')).toBeTruthy()

    const svg = container.querySelector('svg.wm-tree')
    expect(svg).not.toBeNull()
    // 4 节点（会话 / L3 / 类型节点）与 3 条连线
    expect(container.querySelectorAll('.wm-node')).toHaveLength(3)
    expect(container.querySelectorAll('.wm-link')).toHaveLength(2)
    expect(screen.getByTestId('wm-session-node')).toHaveAttribute('data-session', 'true')
    expect(container.querySelector('.wm-node[data-thought="problem"]')).not.toBeNull()
    expect(screen.getByText('3 项')).toBeTruthy()
  })

  it('极简态：data-minimal 派生，同一 DOM（节点与连线数不变 —— 零布局抖动的结构前提）', () => {
    const full = render(<TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal={false} />)
    const fullNodes = full.container.querySelectorAll('.wm-node').length
    const fullTexts = [...full.container.querySelectorAll('.wm-text')].map((el) => el.textContent)
    full.unmount()

    const minimal = render(<TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal />)
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'true')
    expect(minimal.container.querySelectorAll('.wm-node').length).toBe(fullNodes)
    // 文字节点仍在 DOM（CSS 负责 visibility → 几何不变；jsdom 不跑样式表，钉结构等价）
    expect([...minimal.container.querySelectorAll('.wm-text')].map((el) => el.textContent))
      .toEqual(fullTexts)
    expect(screen.getByTestId('wm-session-node')).toHaveAttribute('data-session', 'true')
  })

  it('★ 点即定位（B-1）：透传 onFocusNode，点击带 cid 节点上抛 cid，存量无 cid 节点只读', () => {
    const onFocusNode = vi.fn()
    const { container } = render(
      <TimerMapPort
        mapText={ISLAND}
        sessionId={SESSION_ID}
        minimal={false}
        onFocusNode={onFocusNode}
      />,
    )

    // 点击会话节点（cid="c1"）
    const sessionNode = screen.getByTestId('wm-session-node')
    fireEvent.click(sessionNode)
    expect(onFocusNode).toHaveBeenCalledWith('c1')

    // 点击思考节点（cid="c2"）
    const thoughtNode = container.querySelector('.wm-node[data-thought="problem"]')
    fireEvent.click(thoughtNode!)
    expect(onFocusNode).toHaveBeenCalledWith('c2')

    // 点击存量无 cid 节点：不抛出
    const readonlyNode = container.querySelector('.wm-node[data-readonly="true"]')
    expect(readonlyNode?.querySelector('title')?.textContent).toBe('存量节点（无 cid，只读）')
    fireEvent.click(readonlyNode!)
    expect(onFocusNode).toHaveBeenCalledTimes(2)
  })

  it('★ 沉浸极简态下定位仍可用（B-1/B-2）：minimal=true 时点击节点仍触发 onFocusNode', () => {
    const onFocusNode = vi.fn()
    const { container } = render(
      <TimerMapPort
        mapText={ISLAND}
        sessionId={SESSION_ID}
        minimal={true}
        onFocusNode={onFocusNode}
      />,
    )
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'true')

    const thoughtNode = container.querySelector('.wm-node[data-thought="problem"]')
    fireEvent.click(thoughtNode!)
    expect(onFocusNode).toHaveBeenCalledWith('c2')
  })

  it('fail-soft：无导图（null）/ 解析失败 → 占位文案，不渲染树', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<TimerMapPort mapText={null} sessionId={SESSION_ID} minimal={false} />)
    expect(screen.getByTestId('map-port-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-port-canvas')).toBeNull()

    render(<TimerMapPort mapText={'!!! not a map !!!\n'} sessionId={SESSION_ID} minimal={false} />)
    expect(screen.getAllByTestId('map-port-empty').length).toBeGreaterThan(0)
    warn.mockRestore()
  })

  it('会话不在岛上（sessionId 不匹配）→ 占位文案（不猜、不渲染别人的岛）', () => {
    render(<TimerMapPort mapText={ISLAND} sessionId={'another-session'} minimal={false} />)
    expect(screen.getByTestId('map-port-empty')).toBeTruthy()
  })
})
