/**
 * 准备态「主图」弹层（WorkMapPreviewOverlay）—— ADR-0008 D18 / D13 步 3-4a。
 *
 * 断言锚在可观察行为上：内容**复用** TimerMapOverview（标题「主图」）、
 * 关闭三通道（按钮 / Esc / backdrop）、**焦点归还**、**滚动锁可还原**、只读、fail-soft。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { addChildNode } from '@/lib/work-map/node-edits'

import { WorkMapPreviewOverlay } from './work-map-preview-overlay'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

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

const DOC = (() => {
  let text = addChildNode(BASE, { parentCid: 'c1', title: '甲', thoughtType: 'problem' }).text
  text = addChildNode(text, { parentCid: 'c1', title: '乙', thoughtType: 'todo' }).text
  return text
})()

afterEach(() => {
  // 滚动锁在测试间不得泄漏
  document.body.style.overflow = ''
})

/** 触发按钮 + 弹层的组合（复刻页面接线：显隐在外部持有）。 */
function Harness({
  initial,
  mapText = DOC,
  loading = false,
}: {
  initial: boolean
  mapText?: string | null
  loading?: boolean
}) {
  const [open, setOpen] = useState(initial)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        查看主图
      </button>
      <WorkMapPreviewOverlay
        open={open}
        loading={loading}
        mapText={mapText}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

describe('WorkMapPreviewOverlay（准备态主图弹层）', () => {
  it('closed → 不渲染任何弹层（backdrop / panel 都不在）', () => {
    render(<Harness initial={false} />)
    expect(screen.queryByTestId('map-preview-panel')).toBeNull()
    expect(screen.queryByTestId('map-preview-backdrop')).toBeNull()
  })

  it('★ open：面板 role=dialog + aria-modal + aria-label；内容**复用** TimerMapOverview（标题「主图」）', () => {
    render(<Harness initial />)
    const panel = screen.getByTestId('map-preview-panel')
    expect(panel).toHaveAttribute('role', 'dialog')
    expect(panel).toHaveAttribute('aria-modal', 'true')
    expect(panel).toHaveAttribute('aria-label', '工作导图 · 主图')

    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 主图')
    expect(screen.getByTestId('map-overview-canvas')).toBeTruthy()
    expect(screen.getByTestId('map-legend')).toBeTruthy() // 图例随总览一起来了
  })

  it('★ BUG-WM-001 回归（2026-10-01）：准备态弹层 sessionId=null，不再误挂「本次」高亮框', () => {
    // 修复前：WorkMapTree 里 `node.sessionId === sessionId` 的 null === null
    // 让根岛与存量节点全部带上 wm-box--session 蓝框。
    const { container } = render(<Harness initial />)
    expect(container.querySelectorAll('.wm-box--session')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="wm-session-node"]')).toHaveLength(0)
    expect(container.querySelectorAll('.wm-node[data-session="true"]')).toHaveLength(0)
  })

  it('★ 只读（红线 2）：弹层内无编辑入口、无快速记录行', () => {
    const { container } = render(<Harness initial />)
    expect(container.querySelectorAll('.wm-node[data-cid]')).toHaveLength(0)
    expect(screen.queryByTestId('map-node-actions')).toBeNull()
    expect(screen.queryByTestId('map-quick')).toBeNull()
  })

  it('loading → 「读取中…」（不渲染 canvas）', () => {
    render(<Harness initial loading />)
    expect(screen.getByTestId('map-preview-loading')).toHaveTextContent('读取中…')
    expect(screen.queryByTestId('map-overview-canvas')).toBeNull()
  })

  it('fail-soft：无导图（mapText=null）→ 占位', () => {
    render(<Harness initial mapText={null} />)
    expect(screen.getByTestId('map-overview-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-overview-canvas')).toBeNull()
  })

  it('★ 关闭三通道：按钮 / Esc / backdrop（点面板内部不关）', () => {
    const onClose = vi.fn()
    render(
      <WorkMapPreviewOverlay open loading={false} mapText={DOC} onClose={onClose} />,
    )
    // 点面板内部 → 不关
    fireEvent.click(screen.getByTestId('map-preview-panel'))
    expect(onClose).not.toHaveBeenCalled()
    // backdrop → 关
    fireEvent.click(screen.getByTestId('map-preview-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
    // Esc → 关
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    // 关闭按钮 → 关
    fireEvent.click(screen.getByTestId('map-preview-close'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('★ 焦点：打开聚焦面板；关闭后**归还触发按钮**；滚动锁可还原', () => {
    render(<Harness initial={false} />)
    const trigger = screen.getByRole('button', { name: '查看主图' })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    const panel = screen.getByTestId('map-preview-panel')
    expect(document.activeElement).toBe(panel) // 打开 → 聚焦面板
    expect(document.body.style.overflow).toBe('hidden') // 滚动锁

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('map-preview-panel')).toBeNull()
    expect(document.activeElement).toBe(trigger) // 焦点归还
    expect(document.body.style.overflow).toBe('') // 解锁
  })

  it('★ 卸载必解锁：打开状态下直接卸载 → body 滚动还原', () => {
    const { unmount } = render(<Harness initial />)
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('')
  })
})