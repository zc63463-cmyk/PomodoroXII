/**
 * `sessionIds` 多会话高亮 —— 纯加法判别测试（反思页「今日视图」用）。
 *
 * ## 为什么单独一个文件而不是并进 timer-map-overview.test.tsx
 * 被测对象是 `TimerMapOverview` → `WorkMapTree` 的**新 prop 通道**，
 * 关注点是"并集语义 + 向后兼容"，与既有测试的"近 N 岛 / 聚焦 / dim"是两回事。
 * 混在一起会让失败定位困难。
 *
 * ## 三条必须钉住的性质
 * 1. **并集**：同时传 `sessionId` 与 `sessionIds` 时两者都高亮
 * 2. **兼容**：只传 `sessionId`（既有调用方）行为逐字节不变
 * 3. **空值**：`''` / 空数组 / undefined 都不许让任何岛误判为"当前"
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { buildSessionIsland } from '@/lib/work-map/session-island'

import { TimerMapOverview } from './timer-map-overview'

const SID_A = 'c766be47-8725-443b-86e3-7cfee648a2f4'
const SID_B = 'aa11bb22-cc33-dd44-ee55-ff6677889900'

/** 一份含**两个**会话岛的导图（同一 L3 图上，ADR-0008 D3 的形状）。 */
const TWO_ISLANDS = (() => {
  const first = buildSessionIsland('', {
    sessionId: SID_A,
    workItemTitle: '导图高度自适应',
    sessionTitle: '10-03 14:00 会话',
    level3Titles: ['甲'],
  })
  const second = buildSessionIsland(first.text, {
    sessionId: SID_B,
    workItemTitle: '导图高度自适应',
    sessionTitle: '10-03 16:30 会话',
    level3Titles: ['乙'],
  })
  return second.text
})()

/** 当前会话岛的 DOM 标记（`wm-island-card--current`）。 */
function currentCount(container: HTMLElement): number {
  return container.querySelectorAll('.wm-island-card--current').length
}

describe('TimerMapOverview · sessionIds（多会话高亮）', () => {
  it('★ 传多个 sessionIds → 多个岛同时高亮', () => {
    const { container } = render(
      <TimerMapOverview mapText={TWO_ISLANDS} sessionId={null} sessionIds={[SID_A, SID_B]} />,
    )
    expect(currentCount(container)).toBe(2)
  })

  it('★ 只传其中一个 → 恰好一个岛高亮（不是"全都不亮"）', () => {
    const { container } = render(
      <TimerMapOverview mapText={TWO_ISLANDS} sessionId={null} sessionIds={[SID_A]} />,
    )
    expect(currentCount(container)).toBe(1)
  })

  it('★ 向后兼容：只传 sessionId（既有调用方形状）行为不变', () => {
    const { container } = render(<TimerMapOverview mapText={TWO_ISLANDS} sessionId={SID_B} />)
    expect(currentCount(container)).toBe(1)
  })

  it('★ 并集语义：sessionId 与 sessionIds 同时传时两者都高亮', () => {
    const { container } = render(
      <TimerMapOverview mapText={TWO_ISLANDS} sessionId={SID_A} sessionIds={[SID_B]} />,
    )
    expect(currentCount(container)).toBe(2)
  })

  it('空值不误判：无任何当前会话时零高亮', () => {
    const a = render(<TimerMapOverview mapText={TWO_ISLANDS} sessionId={null} />)
    expect(currentCount(a.container)).toBe(0)

    const b = render(<TimerMapOverview mapText={TWO_ISLANDS} sessionId={null} sessionIds={[]} />)
    expect(currentCount(b.container)).toBe(0)

    const c = render(
      <TimerMapOverview mapText={TWO_ISLANDS} sessionId={null} sessionIds={['', '']} />,
    )
    expect(currentCount(c.container)).toBe(0)
  })

  it('不匹配的 sessionId 不会让任何岛误判为当前', () => {
    const { container } = render(
      <TimerMapOverview
        mapText={TWO_ISLANDS}
        sessionId={null}
        sessionIds={['00000000-0000-0000-0000-000000000000']}
      />,
    )
    expect(currentCount(container)).toBe(0)
  })
})
