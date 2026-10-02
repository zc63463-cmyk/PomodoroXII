/**
 * 右栏导图**小视图**（TimerMapPort）—— ADR-0008 D15 后的断言面。
 *
 * 断言锚在可观察结构上：树渲染（SVG + 会话节点高亮 + 类型节点）、极简态 `data-minimal`
 * 派生且**同一 DOM**（几何不变）、无图/解析失败 → 占位（fail-soft）、
 * 点即定位（`onFocusNode` 抛出 cid，极简态仍可用）。
 * 快速记录的断言已随职责迁移到 `timer-map-editor.test.tsx`（D15）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  findSessionIslandLayout,
  readWorkMapLayout,
  subIslandVisualBounds,
} from '@/lib/work-map/island-layout'
import { appendThoughtNode } from '@/lib/work-map/thought-nodes'

import { projectArchipelagoIsland, TimerMapPort } from './timer-map-port'
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

/**
 * 小视图**专注跟随**（PXII-FEAT-PORT-FOCUS-SYNC）。
 *
 * 群岛 fixture：会话岛下挂 4 个 L3 子岛 —— 横向卡片流总宽 ~1152px 远超声部 280px 视口，
 * 正是外派单描述"整图微缩如线"的场景。断言锚在 **viewBox 的落点**（纯几何，可精确比对）
 * 与模式切换的 `aria-pressed` / `data-view-mode` 上。
 */
const ARCHIPELAGO_MARKDOWN = `<!--
next_cid: 9
centers:
  - at: "node:小视图测试workitem/10-02 10:00 会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 小视图测试workitem

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
const ARCHIPELAGO_ISLAND = findSessionIslandLayout(ARCHIPELAGO_LAYOUT, SESSION_ID)!
/**
 * ★ 渲染器内部会把**单会话岛**再投影一次（`layoutArchipelagoIsland`，方案 A 横向卡片流）——
 * 小视图拿到的几何是**投影后**的，故期望值必须同源算（复用 `projectArchipelagoIsland`，
 * 它就是 `TimerMapPort` 内部用的那一份，不是另抄的几何）。
 */
const PROJECTED_ISLAND = projectArchipelagoIsland(ARCHIPELAGO_ISLAND)
/** 乙岛（第 2 个子岛）—— 专注跟随的目标。 */
const YI_ISLAND = PROJECTED_ISLAND.subIslands![1]

/** 渲染器的 viewBox 口径：目标 bounds ± pad（`focusBounds` 模式用调用方给的 focusPadding）。 */
const viewBoxOf = (container: HTMLElement): string =>
  container.querySelector('svg.wm-tree')?.getAttribute('viewBox') ?? ''

/** 小视图专注跟随的内边距（与组件里 `focusPadding` 同值 —— 改一处必须改另一处）。 */
const PORT_FOCUS_PADDING = 6

const FOCUSED_VB = (() => {
  // ★ 小视图画的是**群岛卡片形态**，故取非聚焦态 bounds（含卡片微标签留白），
  //   而非编辑区大画布的聚焦态内边距（那套是为横幅/返回按钮预留的）。
  const b = subIslandVisualBounds(YI_ISLAND, false)
  const p = PORT_FOCUS_PADDING
  return `${b.minX - p} ${b.minY - p} ${b.maxX - b.minX + p * 2} ${b.maxY - b.minY + p * 2}`
})()

const ALL_VB = (() => {
  // 投影岛（isArchipelago）的全览口径 = 自身 bounds ± 12（不套地标卡外框）
  const b = PROJECTED_ISLAND.bounds
  return `${b.minX - 12} ${b.minY - 12} ${b.maxX - b.minX + 24} ${b.maxY - b.minY + 24}`
})()

describe('TimerMapPort 专注跟随与小视图模式（PXII-FEAT-PORT-FOCUS-SYNC）', () => {
  const renderPort = (
    props: Partial<Parameters<typeof TimerMapPort>[0]> = {},
  ): ReturnType<typeof render> =>
    render(
      <TimerMapPort
        mapText={ARCHIPELAGO_MARKDOWN}
        sessionId={SESSION_ID}
        minimal={false}
        {...props}
      />,
    )

  it('★ focused（默认）：currentPlanTitle 命中子岛 → viewBox 对齐该子岛（280px 视口被充分填充）', async () => {
    const { container } = renderPort({ currentPlanTitle: '乙岛' })
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-view-mode', 'focused')
    expect(screen.getByTestId('map-port-canvas')).toHaveAttribute('data-follow', 'true')
    // viewBox 有 240ms 缓动（rAF），等它落位
    await waitFor(() => expect(viewBoxOf(container)).toBe(FOCUSED_VB))
    // 对齐后的可见宽度 = 该子岛宽度（远小于全图 1184）→ 确实是"放大跟随"而非全景
    const focusedW = Number(FOCUSED_VB.split(' ')[2])
    const allW = PROJECTED_ISLAND.bounds.maxX - PROJECTED_ISLAND.bounds.minX
    expect(focusedW).toBeLessThan(allW)
  })

  it('★ focused：未命中（无当前项 / 标题对不上 / 准备态）→ **自动回退全景**（fail-soft，不渲染空图）', async () => {
    const { container, unmount } = renderPort({ currentPlanTitle: null })
    expect(screen.getByTestId('map-port-canvas')).toHaveAttribute('data-follow', 'false')
    await waitFor(() => expect(viewBoxOf(container)).toBe(ALL_VB))
    unmount()

    const { container: mismatch } = renderPort({ currentPlanTitle: '不存在的项' })
    expect(screen.getByTestId('map-port-canvas')).toHaveAttribute('data-follow', 'false')
    await waitFor(() => expect(viewBoxOf(mismatch)).toBe(ALL_VB))
  })

  it('★ all 模式：即使命中当前项也维持全景（用户显式选择优先于自动跟随）', async () => {
    const { container } = renderPort({ currentPlanTitle: '乙岛', viewMode: 'all' })
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-view-mode', 'all')
    expect(screen.getByTestId('map-port-canvas')).toHaveAttribute('data-follow', 'false')
    await waitFor(() => expect(viewBoxOf(container)).toBe(ALL_VB))
  })

  it('★ 模式微胶囊：两段 aria-pressed 随模式翻转；点击可自由切换（非受控自持）', async () => {
    const { container } = renderPort({ currentPlanTitle: '乙岛' })
    const focused = screen.getByTestId('map-port-mode-focused')
    const all = screen.getByTestId('map-port-mode-all')
    expect(focused).toHaveAttribute('aria-pressed', 'true')
    expect(all).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(viewBoxOf(container)).toBe(FOCUSED_VB))

    fireEvent.click(all)
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-view-mode', 'all')
    expect(screen.getByTestId('map-port-mode-all')).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(viewBoxOf(container)).toBe(ALL_VB))

    fireEvent.click(screen.getByTestId('map-port-mode-focused'))
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-view-mode', 'focused')
    await waitFor(() => expect(viewBoxOf(container)).toBe(FOCUSED_VB))
  })

  it('★ 受控用法：viewMode + onViewModeChange 由调用方持有（切换只上抛，不自行改状态）', () => {
    const onViewModeChange = vi.fn()
    renderPort({ currentPlanTitle: '乙岛', viewMode: 'focused', onViewModeChange })
    fireEvent.click(screen.getByTestId('map-port-mode-all'))
    expect(onViewModeChange).toHaveBeenCalledWith('all')
    // 受控 → 父级没更新前模式不动（React 受控语义）
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-view-mode', 'focused')
  })

  it('★ 专注跟随只改 viewBox、**不改 DOM**：节点与连线数在两种模式与两种目标下恒定', () => {
    const { container: followed } = renderPort({ currentPlanTitle: '乙岛' })
    const followedCounts = {
      nodes: followed.querySelectorAll('.wm-node').length,
      links: followed.querySelectorAll('.wm-link').length,
      cards: followed.querySelectorAll('[data-testid="wm-sub-island-card"]').length,
    }
    const { container: all } = renderPort({ currentPlanTitle: '乙岛', viewMode: 'all' })
    expect(all.querySelectorAll('.wm-node').length).toBe(followedCounts.nodes)
    expect(all.querySelectorAll('.wm-link').length).toBe(followedCounts.links)
    expect(all.querySelectorAll('[data-testid="wm-sub-island-card"]').length).toBe(followedCounts.cards)
  })

  it('★ 沉浸极简态契约不受模式影响：minimal + focused 仍是同一 DOM（只隐文字、几何不变）', async () => {
    const { container } = renderPort({ currentPlanTitle: '乙岛', minimal: true })
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'true')
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-view-mode', 'focused')
    await waitFor(() => expect(viewBoxOf(container)).toBe(FOCUSED_VB))
    expect(screen.getByTestId('wm-session-node')).toHaveAttribute('data-session', 'true')
  })

  it('★ 无导图时不渲染模式胶囊（占位态没有可切换的视图）', () => {
    render(<TimerMapPort mapText={null} sessionId={SESSION_ID} minimal={false} />)
    expect(screen.queryByTestId('map-port-mode-toggle')).toBeNull()
    expect(screen.getByTestId('map-port-empty')).toBeTruthy()
  })
})
