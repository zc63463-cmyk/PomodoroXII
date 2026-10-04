/**
 * 中央导图编辑区（TimerMapEditor）—— ADR-0008 D15 / D13 步 2（快速记录迁移后）。
 *
 * 断言锚在可观察结构上：树渲染（SVG + 节点 + 连线 + 计数）、快速记录闭环
 * （类型行 → 浮层 → 回调 → 收起 / 失败提示）、fail-soft 占位、
 * 节点编辑交互（选中、改名、加子、类型、注释、删除二次确认）、
 * 外部 focusCid 定位高亮环（独立于内部 selectedCid，fail-soft）。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ARCHIPELAGO_CARD_W,
  ARCHIPELAGO_GAP_X,
} from '@/lib/work-map/island-layout'

import { TimerMapEditor } from './timer-map-editor'

const SESSION_ID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

const ISLAND = `<!--
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
`

describe('TimerMapEditor（中央编辑区）', () => {
  it('★ 树渲染：SVG + 会话节点高亮 + 计数（与右栏小视图共用同一份渲染器）', () => {
    const { container } = render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} />,
    )
    expect(screen.getByTestId('map-editor-canvas')).toBeTruthy()
    expect(container.querySelector('svg.wm-tree')).not.toBeNull()
    expect(screen.getByTestId('wm-session-node')).toHaveAttribute('data-session', 'true')
    expect(container.querySelectorAll('.wm-node')).toHaveLength(2)
    expect(container.querySelectorAll('.wm-link')).toHaveLength(1)
    expect(screen.getByText('2 项')).toBeTruthy()
  })

  it('★ 快速记录：类型行 5 类 → 浮层输入 → 提交回调（类型 + 文本），成功后收起', async () => {
    const onQuickRecord = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onQuickRecord={onQuickRecord} />,
    )
    const row = screen.getByTestId('map-quick')
    expect(row.querySelectorAll('button')).toHaveLength(5)
    expect(screen.queryByTestId('map-quick-pop')).toBeNull()

    fireEvent.click(screen.getByTestId('map-quick-problem'))
    expect(screen.getByTestId('map-quick-pop')).toBeTruthy()
    fireEvent.change(screen.getByTestId('map-quick-input'), { target: { value: 'token 对照' } })
    fireEvent.click(screen.getByTestId('map-quick-submit'))

    await waitFor(() => expect(onQuickRecord).toHaveBeenCalledWith('problem', 'token 对照'))
    await waitFor(() => expect(screen.queryByTestId('map-quick-pop')).toBeNull())
  })

  it('提交失败 → 卡内错误文案（不抛、浮层保留以便重试）', async () => {
    const onQuickRecord = vi.fn().mockRejectedValue(new Error('session_node_not_found'))
    render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onQuickRecord={onQuickRecord} />,
    )
    fireEvent.click(screen.getByTestId('map-quick-insight'))
    fireEvent.change(screen.getByTestId('map-quick-input'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('map-quick-submit'))

    expect(await screen.findByTestId('map-quick-error')).toHaveTextContent('session_node_not_found')
    expect(screen.getByTestId('map-quick-pop')).toBeTruthy()
  })

  it('★ 取消方式一：点击「取消」按钮 → 浮层收起、草稿清空、错误清除', async () => {
    const onQuickRecord = vi.fn().mockRejectedValue(new Error('网络超时'))
    render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onQuickRecord={onQuickRecord} />,
    )
    fireEvent.click(screen.getByTestId('map-quick-insight'))
    expect(screen.getByTestId('map-quick-pop')).toBeTruthy()

    const input = screen.getByTestId('map-quick-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '待放弃草稿' } })
    expect(input.value).toBe('待放弃草稿')

    // 触发错误后，点击取消应一并消除错误提示
    fireEvent.click(screen.getByTestId('map-quick-submit'))
    expect(await screen.findByTestId('map-quick-error')).toHaveTextContent('网络超时')

    // 点击取消
    fireEvent.click(screen.getByTestId('map-quick-cancel'))
    expect(screen.queryByTestId('map-quick-pop')).toBeNull()
    expect(screen.queryByTestId('map-quick-error')).toBeNull()

    // 重新打开同一类型，草稿已被重置
    fireEvent.click(screen.getByTestId('map-quick-insight'))
    expect((screen.getByTestId('map-quick-input') as HTMLInputElement).value).toBe('')
  })

  it('★ 取消方式二：输入框内按 Escape 键 → 浮层收起、草稿清空', () => {
    const onQuickRecord = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onQuickRecord={onQuickRecord} />,
    )
    fireEvent.click(screen.getByTestId('map-quick-problem'))
    const input = screen.getByTestId('map-quick-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '某项草稿' } })

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('map-quick-pop')).toBeNull()

    // 再次点开，草稿已清空
    fireEvent.click(screen.getByTestId('map-quick-problem'))
    expect((screen.getByTestId('map-quick-input') as HTMLInputElement).value).toBe('')
  })

  it('★ 取消方式三：再次点击已激活的类型按钮（反选 Toggle）→ 浮层收起', () => {
    const onQuickRecord = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onQuickRecord={onQuickRecord} />,
    )
    const btn = screen.getByTestId('map-quick-decision')
    // 第一次点击：激活打开
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('map-quick-pop')).toBeTruthy()

    // 第二次点击同一按钮：反选关闭
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('map-quick-pop')).toBeNull()
  })

  it('★ 类型切换：从一类切到另一类保留草稿文本，只变更类型', () => {
    const onQuickRecord = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onQuickRecord={onQuickRecord} />,
    )
    fireEvent.click(screen.getByTestId('map-quick-problem'))
    const input = screen.getByTestId('map-quick-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '这其实是洞察' } })

    // 切换至洞察
    fireEvent.click(screen.getByTestId('map-quick-insight'))
    expect(screen.getByTestId('map-quick-pop')).toBeTruthy()
    expect((screen.getByTestId('map-quick-input') as HTMLInputElement).value).toBe('这其实是洞察')
  })

  it('只读编辑区（不传 onQuickRecord）→ 不渲染类型行', () => {
    render(<TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} />)
    expect(screen.queryByTestId('map-quick')).toBeNull()
  })

  it('类型节点渲染形状标记（data-thought）；fail-soft：无导图 → 占位', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { container, unmount } = render(
      <TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} />,
    )
    expect(container.querySelector('.wm-node[data-thought]')).toBeNull() // 本 fixture 无类型节点
    unmount()

    render(<TimerMapEditor mapText={null} sessionId={SESSION_ID} />)
    expect(screen.getByTestId('map-editor-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-editor-canvas')).toBeNull()
    warn.mockRestore()
  })
})

/** 带一个**可编辑节点**（cid c2，含注释）的岛 —— 节点编辑交互断言的 fixture。 */
const EDITABLE_ISLAND = `${ISLAND.trimEnd()}

<!--
thought_type: "problem"
cid: "c2"
note:
  - 一条注释
-->
### 可编辑节点
`

/**
 * 群岛流 fixture：会话岛下挂 **4 个** L3 子岛（>2 才触发 `WorkMapTree` 的横向撑宽，
 * 从而激活溢出指示与翻页按钮）。子岛标题即 `subIslands[i].title`，用于断言切岛落点。
 */
const ARCHIPELAGO_ISLAND = `<!--
next_cid: 9
centers:
  - at: "node:群岛测试workitem/10-02 10:00 会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 群岛测试workitem

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

/** 画布（键位作用域的焦点持有者）。 */
const canvasEl = (): HTMLElement => screen.getByTestId('map-editor-canvas')

/** 在画布上敲一个键（可选修饰键）。 */
const pressKey = (
  key: string,
  options: { alt?: boolean; shift?: boolean; ctrl?: boolean; target?: HTMLElement } = {},
): void => {
  fireEvent.keyDown(options.target ?? canvasEl(), {
    key,
    altKey: options.alt ?? false,
    shiftKey: options.shift ?? false,
    ctrlKey: options.ctrl ?? false,
  })
}

/** 当前聚焦的子岛标题（从横幅读；未聚焦 → null）。 */
const focusedTitle = (): string | null => {
  const banner = screen.queryByTestId('map-sub-island-banner')
  if (banner === null) return null
  return banner.querySelector('strong')?.textContent ?? null
}

describe('TimerMapEditor 群岛流导航（PXII-FEAT-ARCHIPELAGO-NAV）', () => {
  const renderArchipelago = (
    onEdit = vi.fn().mockResolvedValue(undefined),
    onQuickRecord = vi.fn().mockResolvedValue(undefined),
  ) => {
    const utils = render(
      <TimerMapEditor
        mapText={ARCHIPELAGO_ISLAND}
        sessionId={SESSION_ID}
        onEdit={onEdit}
        onQuickRecord={onQuickRecord}
      />,
    )
    return { ...utils, onEdit, onQuickRecord }
  }

  it('★ `]` / `[`：逐岛环形切换（末岛 → 首岛、首岛 → 末岛），并自动平移居中', () => {
    const { container } = renderArchipelago()
    const viewport = screen.getByTestId('map-canvas-viewport')
    expect(focusedTitle()).toBeNull()

    // 全局态按 `]` → 进入第 1 岛
    pressKey(']')
    expect(focusedTitle()).toBe('甲岛')
    expect(screen.getByTestId('map-sub-island-banner')).toBeTruthy()

    // 依次向后
    pressKey(']')
    expect(focusedTitle()).toBe('乙岛')
    pressKey(']')
    expect(focusedTitle()).toBe('丙岛')
    pressKey(']')
    expect(focusedTitle()).toBe('丁岛')

    // 末岛再按 `]` → 环回首岛（不是停在边界）
    pressKey(']')
    expect(focusedTitle()).toBe('甲岛')

    // `[` 从首岛反向环绕到末岛
    pressKey('[')
    expect(focusedTitle()).toBe('丁岛')
    pressKey('[')
    expect(focusedTitle()).toBe('丙岛')

    // 聚焦态下视口复位到基准（平移居中由渲染器按该岛 bounds 自适应框定）
    expect(viewport.style.transform).toContain('translate(0px, 0px)')
    expect(viewport.style.transform).toContain('scale(1)')

    // 切换子岛会收敛节点选中态：操作行不再残留（防"对着看不见的节点操作"）
    expect(screen.queryByTestId('map-node-actions')).toBeNull()
    expect(container.querySelector('.wm-node[data-selected="true"]')).toBeNull()
  })

  it('★ Alt+← / Alt+→ 与 `[` / `]` 等价', () => {
    renderArchipelago()
    pressKey('ArrowRight', { alt: true })
    expect(focusedTitle()).toBe('甲岛')
    pressKey('ArrowRight', { alt: true })
    expect(focusedTitle()).toBe('乙岛')
    pressKey('ArrowLeft', { alt: true })
    expect(focusedTitle()).toBe('甲岛')
    pressKey('ArrowLeft', { alt: true })
    expect(focusedTitle()).toBe('丁岛')
  })

  it('★ 数字键 1~4：直达对应子岛；越界序号（5~9）忽略且不跳转', () => {
    const { container } = renderArchipelago()

    pressKey('3')
    expect(focusedTitle()).toBe('丙岛')

    pressKey('1')
    expect(focusedTitle()).toBe('甲岛')

    pressKey('4')
    expect(focusedTitle()).toBe('丁岛')

    // 越界：只有 4 个岛，按 5~9 应保持原状
    for (const key of ['5', '6', '7', '8', '9']) {
      pressKey(key)
      expect(focusedTitle()).toBe('丁岛')
    }
    // 越界键不产生副作用，也不残留选中
    expect(container.querySelector('.wm-node[data-selected="true"]')).toBeNull()
  })

  it('★ `0`：退出聚焦态回到全局群岛视图；全局态下 `0` 无副作用（让键冒泡）', () => {
    renderArchipelago()
    pressKey('2')
    expect(focusedTitle()).toBe('乙岛')

    pressKey('0')
    expect(focusedTitle()).toBeNull()
    expect(screen.queryByTestId('map-sub-island-banner')).toBeNull()

    // 已是全局态：再按 `0` 不产生任何变化（键位层无接收者即让位）
    pressKey('0')
    expect(focusedTitle()).toBeNull()
  })

  it('★ Esc：聚焦态下退出聚焦（逐级退让的第二级），且不吞掉全局 Esc', () => {
    renderArchipelago()
    pressKey('2')
    expect(focusedTitle()).toBe('乙岛')

    pressKey('Escape')
    expect(focusedTitle()).toBeNull()
  })

  it('★ 防穿透：快速记录浮层输入框里按 `[` `]` 1~9 0 都是**打字**，不切岛', async () => {
    const { onEdit } = renderArchipelago()
    fireEvent.click(screen.getByTestId('map-quick-insight'))
    const input = screen.getByTestId('map-quick-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)

    for (const key of ['[', ']', '1', '2', '0']) {
      pressKey(key, { target: input })
    }
    fireEvent.change(input, { target: { value: '[1] 待办 2' } })

    // 文本原样保留，视图完全未动
    expect(input.value).toBe('[1] 待办 2')
    expect(focusedTitle()).toBeNull()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('★ 防穿透：节点编辑浮层输入框里按 `[` `]` / 数字键不切岛、不改类型', () => {
    const { container, onEdit } = renderArchipelago()
    fireEvent.click(container.querySelector('.wm-node[data-cid="c2"]')!)
    fireEvent.click(screen.getByTestId('map-action-rename'))
    const input = screen.getByTestId('map-action-input')

    for (const key of ['[', ']', '1', '9', '0']) {
      pressKey(key, { target: input })
    }

    expect(focusedTitle()).toBeNull()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('★ 防穿透：Alt+←/→ 在输入框内不切岛（文本选区/光标语义优先）', () => {
    renderArchipelago()
    fireEvent.click(screen.getByTestId('map-quick-todo'))
    const input = screen.getByTestId('map-quick-input')

    pressKey('ArrowLeft', { alt: true, target: input })
    pressKey('ArrowRight', { alt: true, target: input })
    expect(focusedTitle()).toBeNull()
  })

  it('★ 有选中节点时数字键仍是「类型直切」，切岛交给 `[` `]`（两层语义互斥）', async () => {
    const { container, onEdit } = renderArchipelago()
    fireEvent.click(container.querySelector('.wm-node[data-cid="c2"]')!)

    // 有接收者 → 数字键直切类型，不切岛
    pressKey('1')
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'type', cid: 'c2', type: 'insight' }),
    )
    expect(focusedTitle()).toBeNull()

    // 同一时刻 `]` 仍然切岛（岛屿导航与类型直切各走各的键）
    pressKey(']')
    expect(focusedTitle()).toBe('甲岛')
  })

  it('★ 关键不变量：聚焦子岛后编辑节点（mapText 更新），保持聚焦在该子岛，不退回全局', () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <TimerMapEditor mapText={ARCHIPELAGO_ISLAND} sessionId={SESSION_ID} onEdit={onEdit} />,
    )

    // 1. 聚焦到甲岛
    pressKey('1')
    expect(focusedTitle()).toBe('甲岛')
    expect(screen.getByTestId('map-sub-island-banner')).toHaveTextContent('甲岛')

    // 2. 模拟编辑后 mapText 重新解析更新（例如添加/编辑了思考内容）
    const updatedMapText = ARCHIPELAGO_ISLAND.replace('思考1', '思考1-已编辑')
    rerender(
      <TimerMapEditor mapText={updatedMapText} sessionId={SESSION_ID} onEdit={onEdit} />,
    )

    // 3. 断言：依然处于聚焦态、依然聚焦在甲岛，绝不退回全局
    expect(focusedTitle()).toBe('甲岛')
    expect(screen.getByTestId('map-sub-island-banner')).toHaveTextContent('甲岛')
    expect(screen.queryByTestId('map-view-global')).not.toHaveClass('wm-view-btn--active')
  })
})

describe('TimerMapEditor 群岛流视口溢出（PXII-FEAT-ARCHIPELAGO-OVERFLOW）', () => {
  const renderArchipelago = (onEdit = vi.fn().mockResolvedValue(undefined)) => {
    const utils = render(
      <TimerMapEditor mapText={ARCHIPELAGO_ISLAND} sessionId={SESSION_ID} onEdit={onEdit} />,
    )
    return { ...utils, onEdit }
  }

  it('★ 溢出控件仅在全局群岛视图渲染；进入聚焦态后自动隐藏', () => {
    renderArchipelago()
    expect(screen.getByTestId('map-scroll-left')).toBeTruthy()
    expect(screen.getByTestId('map-scroll-right')).toBeTruthy()

    pressKey('2')
    expect(screen.queryByTestId('map-scroll-left')).toBeNull()
    expect(screen.queryByTestId('map-scroll-right')).toBeNull()
    expect(screen.queryByTestId('map-fade-left')).toBeNull()
    expect(screen.queryByTestId('map-fade-right')).toBeNull()

    pressKey('0')
    expect(screen.getByTestId('map-scroll-left')).toBeTruthy()
  })

  it('★ 边界状态：初始滚到最左 → 左钮禁用且左遮罩隐退，右钮可用', () => {
    renderArchipelago()
    expect(screen.getByTestId('map-scroll-left')).toBeDisabled()
    expect(screen.getByTestId('map-scroll-right')).not.toBeDisabled()
    expect(screen.getByTestId('map-fade-left')).toHaveAttribute('data-visible', 'false')
    expect(screen.getByTestId('map-fade-right')).toHaveAttribute('data-visible', 'true')
  })

  it('★ 点击 `›` 向右翻页一个步长（1 卡宽 + 间距），并出现左遮罩', () => {
    renderArchipelago()
    const viewport = screen.getByTestId('map-canvas-viewport')
    expect(viewport.style.transform).toContain('translate(0px, 0px)')

    fireEvent.click(screen.getByTestId('map-scroll-right'))
    const step = ARCHIPELAGO_CARD_W + ARCHIPELAGO_GAP_X
    expect(viewport.style.transform).toContain(`translate(${-step}px, 0px)`)

    // 已离开左边界 → 左钮可用、左遮罩浮现
    expect(screen.getByTestId('map-scroll-left')).not.toBeDisabled()
    expect(screen.getByTestId('map-fade-left')).toHaveAttribute('data-visible', 'true')
  })

  it('★ 点击 `‹` 向左翻页，且不会翻过最左端（夹在 0）', () => {
    renderArchipelago()
    const viewport = screen.getByTestId('map-canvas-viewport')
    const step = ARCHIPELAGO_CARD_W + ARCHIPELAGO_GAP_X

    fireEvent.click(screen.getByTestId('map-scroll-right'))
    expect(viewport.style.transform).toContain(`translate(${-step}px, 0px)`)

    fireEvent.click(screen.getByTestId('map-scroll-left'))
    expect(viewport.style.transform).toContain('translate(0px, 0px)')
    // 已在最左端 → 左钮回到禁用（隐退）
    expect(screen.getByTestId('map-scroll-left')).toBeDisabled()
  })

  it('★ 连续右翻至最右端 → 右钮禁用且右遮罩隐退（不会滚出空白区）', () => {
    renderArchipelago()
    const right = screen.getByTestId('map-scroll-right')
    // 4 卡总宽 1152 + 32 = 1184；兜底视口 860 → 最多右翻 324px，两跳即到边界
    for (let i = 0; i < 5; i += 1) {
      if ((right as HTMLButtonElement).disabled) break
      fireEvent.click(right)
    }
    expect(screen.getByTestId('map-scroll-right')).toBeDisabled()
    expect(screen.getByTestId('map-fade-right')).toHaveAttribute('data-visible', 'false')
    expect(screen.getByTestId('map-scroll-left')).not.toBeDisabled()
  })

  it('★ 子岛 ≤ 2 个（不撑宽）→ 不渲染溢出控件', () => {
    render(<TimerMapEditor mapText={ISLAND} sessionId={SESSION_ID} onEdit={vi.fn()} />)
    expect(screen.queryByTestId('map-scroll-left')).toBeNull()
    expect(screen.queryByTestId('map-scroll-right')).toBeNull()
    expect(screen.queryByTestId('map-fade-left')).toBeNull()
  })
})

describe('TimerMapEditor 节点编辑（ADR-0008 D16 / D13 步 3-2）', () => {
  const renderEditor = (onEdit = vi.fn().mockResolvedValue(undefined)) => {
    const utils = render(
      <TimerMapEditor mapText={EDITABLE_ISLAND} sessionId={SESSION_ID} onEdit={onEdit} />,
    )
    return { ...utils, onEdit }
  }
  const editableNode = (container: HTMLElement): Element | null =>
    container.querySelector('.wm-node[data-cid="c2"]')

  it('★ 选中：只有可编辑节点可点；会话节点/无 cid 节点点击无效（hover 提示只读）', () => {
    const { container } = renderEditor()
    // 可编辑面只有 c2 一个；会话节点与存量 L3 节点都标 readonly
    expect(container.querySelectorAll('.wm-node[data-cid]')).toHaveLength(1)
    expect(container.querySelectorAll('.wm-node[data-readonly="true"]')).toHaveLength(2)
    expect(container.querySelector('.wm-node[data-readonly="true"] title')?.textContent).toContain('只读')
    expect(screen.queryByTestId('map-node-actions')).toBeNull()

    fireEvent.click(screen.getByTestId('wm-session-node'))
    expect(screen.queryByTestId('map-node-actions')).toBeNull()

    fireEvent.click(editableNode(container)!)
    expect(screen.getByTestId('map-node-actions')).toBeTruthy()
    expect(editableNode(container)).toHaveAttribute('data-selected', 'true')
  })

  it('★ 改名：浮层预填现值 → 提交回调 rename', async () => {
    const { container, onEdit } = renderEditor()
    fireEvent.click(editableNode(container)!)
    fireEvent.click(screen.getByTestId('map-action-rename'))
    const input = screen.getByTestId('map-action-input') as HTMLInputElement
    expect(input.value).toBe('可编辑节点')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'rename', cid: 'c2', title: '新标题' }),
    )
    await waitFor(() => expect(screen.queryByTestId('map-action-pop')).toBeNull())
  })

  it('★ 加子：空输入 → 提交回调 add', async () => {
    const { container, onEdit } = renderEditor()
    fireEvent.click(editableNode(container)!)
    fireEvent.click(screen.getByTestId('map-action-add'))
    const input = screen.getByTestId('map-action-input') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '子标题' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'add', cid: 'c2', title: '子标题' }),
    )
  })

  it('★ 类型：5 chip；点 chip 回调 type；「清除类型」回调 type=null', async () => {
    const { container, onEdit } = renderEditor()
    fireEvent.click(editableNode(container)!)
    fireEvent.click(screen.getByTestId('map-action-type'))
    expect(screen.getByTestId('map-action-pop').querySelectorAll('.wm-action-chip[data-thought]')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('map-action-type-decision'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'type', cid: 'c2', type: 'decision' }),
    )

    fireEvent.click(screen.getByTestId('map-action-type'))
    fireEvent.click(screen.getByTestId('map-action-type-clear'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({ kind: 'type', cid: 'c2', type: null }),
    )
  })

  it('★ 注释：选中显示注释内容；浮层多行预填 → 提交为一行一条的列表', async () => {
    const { container, onEdit } = renderEditor()
    fireEvent.click(editableNode(container)!)
    expect(screen.getByTestId('map-node-comment')).toHaveTextContent('一条注释')

    fireEvent.click(screen.getByTestId('map-action-comment'))
    const area = screen.getByTestId('map-action-input') as HTMLTextAreaElement
    expect(area.value).toBe('一条注释')
    fireEvent.change(area, { target: { value: '第一行\n第二行' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({
        kind: 'comment', cid: 'c2', comment: ['第一行', '第二行'],
      }),
    )
  })

  it('★ 删除二次确认：第一次不删（文案变「确认删除？」），第二次才回调', async () => {
    const { container, onEdit } = renderEditor()
    fireEvent.click(editableNode(container)!)
    fireEvent.click(screen.getByTestId('map-action-delete'))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByTestId('map-action-delete')).toHaveTextContent('确认删除？')

    fireEvent.click(screen.getByTestId('map-action-delete'))
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith({ kind: 'delete', cid: 'c2' }))
  })

  it('删除二次确认：3 秒未再点 → 回退为「删除」', () => {
    vi.useFakeTimers()
    try {
      const { container } = renderEditor()
      fireEvent.click(editableNode(container)!)
      fireEvent.click(screen.getByTestId('map-action-delete'))
      expect(screen.getByTestId('map-action-delete')).toHaveTextContent('确认删除？')
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(screen.getByTestId('map-action-delete')).toHaveTextContent('删除')
    } finally {
      vi.useRealTimers()
    }
  })

  it('编辑失败 → 卡内提示（map-edit-error），浮层保留以便重试', async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error('cid_not_found'))
    const { container } = renderEditor(onEdit)
    fireEvent.click(editableNode(container)!)
    fireEvent.click(screen.getByTestId('map-action-rename'))
    fireEvent.change(screen.getByTestId('map-action-input'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))
    expect(await screen.findByTestId('map-edit-error')).toHaveTextContent('cid_not_found')
    expect(screen.getByTestId('map-action-pop')).toBeTruthy()
  })

  it('不传 onEdit → 整树只读（无 data-cid、无操作行）', () => {
    const { container } = render(
      <TimerMapEditor mapText={EDITABLE_ISLAND} sessionId={SESSION_ID} />,
    )
    expect(container.querySelectorAll('.wm-node[data-cid]')).toHaveLength(0)
    fireEvent.click(container.querySelectorAll('.wm-node')[0])
    expect(screen.queryByTestId('map-node-actions')).toBeNull()
  })

  it('★ focusCid 定位高亮环：透传至 WorkMapTree 独立呈现，不与 selectedCid 混用', () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const { container, rerender } = render(
      <TimerMapEditor
        mapText={EDITABLE_ISLAND}
        sessionId={SESSION_ID}
        focusCid="c2"
        onEdit={onEdit}
      />,
    )
    // 节点获得 focus 环，但并未处于编辑选中态（无操作行）
    const node = editableNode(container)
    expect(node).toHaveClass('wm-node--focus')
    expect(node).toHaveAttribute('data-focus', 'true')
    expect(node?.getAttribute('data-selected')).toBeNull()
    expect(screen.queryByTestId('map-node-actions')).toBeNull()

    // fail-soft：指向不存在/已删节点时无环无报错
    rerender(
      <TimerMapEditor
        mapText={EDITABLE_ISLAND}
        sessionId={SESSION_ID}
        focusCid="non-existent-cid"
        onEdit={onEdit}
      />,
    )
    expect(container.querySelector('.wm-node--focus')).toBeNull()
  })

  it('★ 画布缩放工具条（PXII-FEAT-ZOOM-PAN）：放大、缩小、重置与自适应居中', () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor
        mapText={EDITABLE_ISLAND}
        sessionId={SESSION_ID}
        onEdit={onEdit}
      />,
    )
    const viewport = screen.getByTestId('map-canvas-viewport')
    expect(viewport.style.transform).toContain('scale(1)')

    // 放大
    fireEvent.click(screen.getByTestId('map-zoom-in'))
    expect(viewport.style.transform).toContain('scale(1.2)')
    expect(screen.getByTestId('map-zoom-reset')).toHaveTextContent('120%')

    // 缩小
    fireEvent.click(screen.getByTestId('map-zoom-out'))
    expect(viewport.style.transform).toContain('scale(1)')
    expect(screen.getByTestId('map-zoom-reset')).toHaveTextContent('100%')

    // 再次放大并重置
    fireEvent.click(screen.getByTestId('map-zoom-in'))
    expect(viewport.style.transform).toContain('scale(1.2)')
    fireEvent.click(screen.getByTestId('map-zoom-reset'))
    expect(viewport.style.transform).toContain('scale(1)')

    // 自适应
    fireEvent.click(screen.getByTestId('map-zoom-fit'))
    expect(viewport.style.transform).toContain('scale(1)')
  })

  it('★ 嵌套子岛视图切换（PXII-FEAT-NESTED-ISLAND）：全局岛 vs L3 子岛视图自由切换与退出', () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor
        mapText={EDITABLE_ISLAND}
        sessionId={SESSION_ID}
        onEdit={onEdit}
      />,
    )
    // 渲染视图切换控制组
    const toggle = screen.getByTestId('map-sub-island-toggle')
    expect(toggle).toBeTruthy()
    expect(screen.getByTestId('map-view-global')).toHaveAttribute('aria-pressed', 'true')

    // 点击切换到 L3 子岛聚焦
    const subBtn = screen.getAllByRole('button', { name: /聚焦子岛/ })[0]!
    fireEvent.click(subBtn)

    // 呈现聚焦横幅与退出按钮
    expect(screen.getByTestId('map-sub-island-banner')).toHaveTextContent('正在聚焦 L3 子岛')
    expect(screen.getByTestId('map-view-global')).toHaveAttribute('aria-pressed', 'false')

    // 点击横幅退出按钮 → 返回会话全局
    fireEvent.click(screen.getByTestId('map-sub-island-exit'))
    expect(screen.queryByTestId('map-sub-island-banner')).toBeNull()
    expect(screen.getByTestId('map-view-global')).toHaveAttribute('aria-pressed', 'true')
  })

  it('★ 子岛聚焦下快速记录（PXII-FEAT-NESTED-ISLAND）：输入定向挂载到当前 L3 子岛', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const onQuickRecord = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor
        mapText={EDITABLE_ISLAND}
        sessionId={SESSION_ID}
        onEdit={onEdit}
        onQuickRecord={onQuickRecord}
      />,
    )
    // 聚焦到有 cid 的子岛（可编辑节点，cid="c2"）
    const subBtns = screen.getAllByRole('button', { name: /聚焦子岛/ })
    const targetSubBtn = subBtns.find((btn) => btn.getAttribute('data-testid')?.includes('c2') || btn.textContent?.includes('可编辑')) ?? subBtns[subBtns.length - 1]!
    fireEvent.click(targetSubBtn)
    expect(screen.getByTestId('map-sub-island-banner')).toBeInTheDocument()

    // 点击待办类型按钮打开浮层
    fireEvent.click(screen.getByTestId('map-quick-todo'))
    const input = screen.getByTestId('map-quick-input')
    expect(input.getAttribute('placeholder')).toContain('追加到 L3 子岛')

    // 输入并提交
    fireEvent.change(input, { target: { value: '子任务专属待办' } })
    fireEvent.click(screen.getByTestId('map-quick-submit'))

    // 关键断言：直接调 onEdit（kind: 'add', cid: 子岛cid, title, thoughtType）而不是全会话的 onQuickRecord
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith({
        kind: 'add',
        cid: 'c2',
        title: '子任务专属待办',
        thoughtType: 'todo',
      }),
    )
    expect(onQuickRecord).not.toHaveBeenCalled()
  })
})

/**
 * 子岛一键完成（PXII-FEAT-PLAN-CHECKOFF）—— 页面层「计划项 ⇄ 导图卡片」的接线。
 *
 * 断言锚：卡片打勾按钮上抛**计划项 id**（不是标题）、`Alt+D` / `Ctrl+Enter`
 * 在聚焦态生效、写回走的是调用方给的 `onSetCompletionDraft`（不发明第二套状态）。
 */
describe('TimerMapEditor 子岛一键完成（PXII-FEAT-PLAN-CHECKOFF）', () => {
  /** 甲岛已完成 / 乙岛未完成 / 丙丁岛不在本次计划里（不应出现打勾入口）。 */
  const PLANS = [
    { id: 'plan-jia', workItemId: 'wi-jia', titleSnapshot: '甲岛', completionDraft: true },
    { id: 'plan-yi', workItemId: 'wi-yi', titleSnapshot: '乙岛', completionDraft: false },
  ]

  const renderWithPlans = (onSet = vi.fn().mockResolvedValue(undefined)) => {
    const utils = render(
      <TimerMapEditor
        mapText={ARCHIPELAGO_ISLAND}
        sessionId={SESSION_ID}
        // 键盘心流只在可编辑画布上挂载（与既有键位矩阵同一前提），故补 onEdit
        onEdit={vi.fn().mockResolvedValue(undefined)}
        plans={PLANS}
        onSetCompletionDraft={onSet}
      />,
    )
    return { ...utils, onSet }
  }

  const cardTitled = (container: HTMLElement, title: string): Element => {
    const hit = [...container.querySelectorAll('[data-testid="wm-sub-island-card"]')].find((card) =>
      card.querySelector('[data-testid="wm-sub-island-card-title"]')?.textContent?.includes(title),
    )
    if (hit === undefined) throw new Error(`找不到子岛卡片：${title}`)
    return hit
  }

  it('★ 卡片打勾按钮：点击上抛**计划项 id** 与取反后的完成态（复用 setCompletion 契约）', () => {
    const { container, onSet } = renderWithPlans()

    // 甲岛已完成 → 按钮呈对勾态；点击应回传 false（取消完成）
    const jiaCheck = cardTitled(container, '甲岛').querySelector('[data-testid="wm-sub-island-check"]')!
    expect(jiaCheck.getAttribute('data-completed')).toBe('true')
    fireEvent.click(jiaCheck)
    expect(onSet).toHaveBeenCalledWith('plan-jia', false)

    // 乙岛未完成 → 点击应回传 true
    const yiCheck = cardTitled(container, '乙岛').querySelector('[data-testid="wm-sub-island-check"]')!
    expect(yiCheck.getAttribute('data-completed')).toBe('false')
    fireEvent.click(yiCheck)
    expect(onSet).toHaveBeenCalledWith('plan-yi', true)
  })

  it('★ 不在本次计划里的子岛 → 不渲染打勾入口（不画"点了没反应"的假按钮）', () => {
    const { container } = renderWithPlans()
    expect(container.querySelectorAll('[data-testid="wm-sub-island-check"]')).toHaveLength(2)
    expect(cardTitled(container, '丙岛').querySelector('[data-testid="wm-sub-island-check"]')).toBeNull()
    expect(cardTitled(container, '丁岛').querySelector('[data-testid="wm-sub-island-check"]')).toBeNull()
  })

  it('★ 只读编辑区（不传 plans / onSetCompletionDraft）→ 完全没有完成态入口（零回归）', () => {
    const { container } = render(
      <TimerMapEditor mapText={ARCHIPELAGO_ISLAND} sessionId={SESSION_ID} />,
    )
    expect(container.querySelector('[data-testid="wm-sub-island-check"]')).toBeNull()
    expect(container.querySelector('.wm-sub-island-card--completed')).toBeNull()
  })

  it('★ 聚焦态横幅：胶囊显示当前完成态，点击切换', () => {
    const { onSet } = renderWithPlans()
    pressKey('2') // 乙岛
    expect(focusedTitle()).toBe('乙岛')

    const pill = screen.getByTestId('map-sub-island-complete')
    expect(pill).toHaveAttribute('data-completed', 'false')
    expect(pill.textContent).toBe('○ 标记完成')
    fireEvent.click(pill)
    expect(onSet).toHaveBeenCalledWith('plan-yi', true)
  })

  it('★ 聚焦态横幅：未命中计划项的聚焦子岛**不出现**完成胶囊（无完成态可切换）', () => {
    renderWithPlans()
    pressKey('3') // 丙岛（不在 PLANS 里）
    expect(focusedTitle()).toBe('丙岛')
    expect(screen.queryByTestId('map-sub-island-complete')).toBeNull()
    // 退出聚焦入口照旧在（横幅没有因缺胶囊而变形）
    expect(screen.getByTestId('map-sub-island-exit')).toBeTruthy()
  })

  it('★ 快捷键 Alt+D：聚焦态一键切换完成', () => {
    const { onSet } = renderWithPlans()
    pressKey('2')
    expect(focusedTitle()).toBe('乙岛')

    pressKey('d', { alt: true })
    expect(onSet).toHaveBeenCalledWith('plan-yi', true)
  })

  it('★ 快捷键 Ctrl+Enter：与 Alt+D 等价；未聚焦 / 未命中计划项时**不认领**（键让位）', () => {
    const { onSet } = renderWithPlans()

    // 全局态（未聚焦）：无接收者 → 不触发
    pressKey('Enter', { ctrl: true })
    expect(onSet).not.toHaveBeenCalled()

    // 聚焦丙岛（不在计划里）：同样不触发
    pressKey('3')
    expect(focusedTitle()).toBe('丙岛')
    pressKey('Enter', { ctrl: true })
    expect(onSet).not.toHaveBeenCalled()

    // 聚焦乙岛（在计划里）→ 触发
    pressKey('2')
    expect(focusedTitle()).toBe('乙岛')
    pressKey('Enter', { ctrl: true })
    expect(onSet).toHaveBeenCalledWith('plan-yi', true)
  })

  it('★ 防穿透：快速记录输入框里 Alt+D / Ctrl+Enter 是**打字/提交语义**，不切换完成态', () => {
    const onSet = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapEditor
        mapText={ARCHIPELAGO_ISLAND}
        sessionId={SESSION_ID}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onQuickRecord={vi.fn().mockResolvedValue(undefined)}
        plans={PLANS}
        onSetCompletionDraft={onSet}
      />,
    )
    pressKey('2') // 先进入乙岛聚焦态（有接收者）
    expect(focusedTitle()).toBe('乙岛')

    fireEvent.click(screen.getByTestId('map-quick-insight'))
    const input = screen.getByTestId('map-quick-input') as HTMLElement
    pressKey('d', { alt: true, target: input })
    pressKey('Enter', { ctrl: true, target: input })
    expect(onSet).not.toHaveBeenCalled()
  })

  it('★ 完成态不裁信息：卡片变绿后卡内节点与连线数不变（复盘信息完整保留）', () => {
    const { container } = renderWithPlans()
    const before = {
      nodes: container.querySelectorAll('.wm-node').length,
      links: container.querySelectorAll('.wm-link').length,
      texts: container.querySelectorAll('.wm-text').length,
    }
    expect(cardTitled(container, '甲岛')).toHaveClass('wm-sub-island-card--completed')

    const { container: plain } = render(
      <TimerMapEditor
        mapText={ARCHIPELAGO_ISLAND}
        sessionId={SESSION_ID}
        plans={PLANS.map((plan) => ({ ...plan, completionDraft: false }))}
        onSetCompletionDraft={vi.fn()}
      />,
    )
    expect(plain.querySelectorAll('.wm-node').length).toBe(before.nodes)
    expect(plain.querySelectorAll('.wm-link').length).toBe(before.links)
    expect(plain.querySelectorAll('.wm-text').length).toBe(before.texts)
  })
})
