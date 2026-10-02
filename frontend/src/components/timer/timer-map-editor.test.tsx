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
})
