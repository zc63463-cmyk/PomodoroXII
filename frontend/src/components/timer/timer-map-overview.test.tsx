/**
 * 结束态「岛总览」（TimerMapOverview）—— ADR-0008 D13 步 3-4b / D17。
 *
 * 断言锚在可观察量上：**全部 islands**（不滤当前会话）+ 岛/项计数、当前会话岛高亮、
 * **只读**（无编辑入口）、筛选 **dim 不 hide**（节点数不变、树结构未断）、fail-soft 占位。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { addChildNode } from '@/lib/work-map/node-edits'

import { TimerMapOverview } from './timer-map-overview'

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

/** 两个 problem + 一个 todo。 */
const DOC = (() => {
  let text = addChildNode(BASE, { parentCid: 'c1', title: '甲', thoughtType: 'problem' }).text
  text = addChildNode(text, { parentCid: 'c1', title: '乙', thoughtType: 'problem' }).text
  return addChildNode(text, { parentCid: 'c1', title: '丙', thoughtType: 'todo' }).text
})()

describe('TimerMapOverview（结束态岛总览）', () => {
  it('★ 渲染**全部** islands（不滤当前会话）+ 岛数/项数计数；当前会话岛高亮', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 岛总览')
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('2 个岛')
    const canvas = screen.getByTestId('map-overview-canvas')
    expect(canvas.querySelector('svg.wm-tree')).not.toBeNull()
    // 当前会话岛（本次）被标出且只有它
    expect(canvas.querySelectorAll('[data-testid="wm-current-island"]')).toHaveLength(1)
    expect(canvas.querySelectorAll('[data-testid="wm-session-node"]')).toHaveLength(1)
    expect(container.querySelectorAll('.wm-link').length).toBeGreaterThan(0)
  })

  it('★ title prop：默认「岛总览」；准备态主图弹层传「主图」（只改文案不改内容）', () => {
    const { unmount } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 岛总览')
    unmount()

    render(<TimerMapOverview mapText={DOC} sessionId={null} title="主图" />)
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 主图')
    // 内容不变：图例 + 全部 islands 照旧
    expect(screen.getByTestId('map-legend')).toBeTruthy()
    expect(screen.getByTestId('map-overview-canvas')).toBeTruthy()
  })

  it('★ 只读（红线 2）：无编辑入口 —— 无 data-cid、无操作行、无快速记录行', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    expect(container.querySelectorAll('.wm-node[data-cid]')).toHaveLength(0)
    expect(screen.queryByTestId('map-node-actions')).toBeNull()
    expect(screen.queryByTestId('map-quick')).toBeNull()
  })

  it('★ 筛选 dim 不 hide：点「问题」→ 命中高亮、其余 dim，**节点数不变**、连线仍在', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    const total = container.querySelectorAll('.wm-node').length
    expect(total).toBeGreaterThanOrEqual(6) // 根 H1 + 会话岛 5
    expect(container.querySelectorAll('.wm-node[data-dim="true"]')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('map-legend-problem'))

    // dim 而非 hide：节点**一个都没少**（hide 会让这个数变小）
    expect(container.querySelectorAll('.wm-node').length).toBe(total)
    expect(container.querySelectorAll('.wm-node[data-highlight="true"]')).toHaveLength(2)
    expect(container.querySelectorAll('.wm-node[data-dim="true"]')).toHaveLength(total - 2)
    // 树结构未断：连线仍在
    expect(container.querySelectorAll('.wm-link').length).toBeGreaterThan(0)

    // 「全部」恢复全亮
    fireEvent.click(screen.getByTestId('map-legend-all'))
    expect(container.querySelectorAll('.wm-node[data-dim="true"]')).toHaveLength(0)
    expect(container.querySelectorAll('.wm-node[data-highlight="true"]')).toHaveLength(0)
  })

  it('★ 连线随两端：一端亮则线亮（树不被打散）', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    fireEvent.click(screen.getByTestId('map-legend-problem'))
    const links = [...container.querySelectorAll('.wm-link')]
    const dimLinks = links.filter((link) => link.getAttribute('data-dim') === 'true')
    // 有连线：一部分因"至少一端命中"而保持亮 → dim 的少于全部
    expect(links.length).toBeGreaterThan(0)
    expect(dimLinks.length).toBeLessThan(links.length)
  })

  it('fail-soft：无导图 / 解析失败 → 占位（不渲染 canvas）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { unmount } = render(<TimerMapOverview mapText={null} sessionId={SID} />)
    expect(screen.getByTestId('map-overview-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-overview-canvas')).toBeNull()
    unmount()

    render(<TimerMapOverview mapText={'<!--\nnote: 无标题\n-->\n'} sessionId={SID} />)
    expect(screen.getByTestId('map-overview-empty')).toBeTruthy()
    warn.mockRestore()
  })
})