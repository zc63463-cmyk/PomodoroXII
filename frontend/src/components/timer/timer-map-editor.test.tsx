/**
 * 中央导图编辑区（TimerMapEditor）—— ADR-0008 D15 / D13 步 2（快速记录迁移后）。
 *
 * 断言锚在可观察结构上：树渲染（SVG + 节点 + 连线 + 计数）、快速记录闭环
 * （类型行 → 浮层 → 回调 → 收起 / 失败提示）、fail-soft 占位。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
