/**
 * 今日事实抽屉 —— 组件层单测。
 *
 * 组件只做「展示 + 收集意图」，不碰 store/repository，所以这里全部用注入的
 * 快照 + spy 穷举交互（与 `session-review-harvest.test.tsx` 同一套路）。
 *
 * 锁住三件事：
 * 1. **无事实不占位**（`isEmpty` / `loading` → 返回 null）
 * 2. **不评分**（界面里不得出现任何百分制/评分数值）
 * 3. 注入按钮把意图交给页面（组件自己不写库）
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  emptyDailyEvidence,
  type DailyEvidenceSnapshot,
  type DailySessionFact,
} from '@/lib/reflections/daily-evidence'

import { DailyEvidenceDrawer } from './daily-evidence-drawer'

function fact(over: Partial<DailySessionFact> = {}): DailySessionFact {
  return {
    sessionId: 's1',
    startedLabel: '14:00',
    endedLabel: '14:45',
    focusedSeconds: 2700,
    level2WorkItemId: 'L2-a',
    titleSnapshot: '导图高度自适应',
    validity: 'valid',
    interrupted: false,
    ...over,
  }
}

function snapshot(over: Partial<DailyEvidenceSnapshot> = {}): DailyEvidenceSnapshot {
  return {
    ...emptyDailyEvidence('2026-10-03'),
    totalFocusedSeconds: 2700,
    sessionCount: 1,
    validCount: 1,
    sessions: [fact()],
    byLevel2: [
      { level2WorkItemId: 'L2-a', titleSnapshot: '导图高度自适应', focusedSeconds: 2700, sessionCount: 1 },
    ],
    isEmpty: false,
    ...over,
  }
}

describe('DailyEvidenceDrawer', () => {
  afterEach(cleanup)

  // 2026-10-03 行为修正：原实现 `isEmpty → return null`，与「功能不存在」同形，
  // 用户分不出「今天没记录」和「改了没生效」。故改为**始终渲染外壳** + 中性说明。
  it('无事实时仍渲染外壳并给出中性说明（区分「没记录」与「不存在」）', () => {
    render(<DailyEvidenceDrawer snapshot={emptyDailyEvidence('2026-10-03')} />)
    expect(screen.getByTestId('daily-evidence-drawer')).toBeTruthy()
    expect(screen.getByTestId('daily-evidence-empty')).toBeTruthy()
    expect(screen.getByText(/这一天没有番茄钟记录/)).toBeTruthy()
  })

  it('无事实时不摆注入按钮（没有内容可注入，禁用按钮是噪音）', () => {
    const onInject = vi.fn()
    render(<DailyEvidenceDrawer snapshot={emptyDailyEvidence('2026-10-03')} onInject={onInject} />)
    expect(screen.queryByTestId('daily-evidence-inject')).toBeNull()
  })

  it('读取中同样收起（避免闪烁一个空壳）', () => {
    const { container } = render(<DailyEvidenceDrawer snapshot={snapshot()} loading />)
    expect(container.innerHTML).toBe('')
  })

  it('呈现事实账本：时长 / 会话数 / 中断数', () => {
    // 注意：「中断」在统计卡与时间轴标签里都会出现，故此处只断言三张卡的标题存在
    render(<DailyEvidenceDrawer snapshot={snapshot({ interruptedCount: 2 })} />)
    expect(screen.getByText('净专注')).toBeTruthy()
    expect(screen.getByText('会话数')).toBeTruthy()
    expect(screen.getAllByText('中断').length).toBeGreaterThan(0)
    // 45m 同时出现在统计卡与时间轴，属预期（同一把尺子算两处）
    expect(screen.getAllByText('45m').length).toBeGreaterThan(0)
  })

  it('时间轴显示任务标题与有效性标签', () => {
    render(<DailyEvidenceDrawer snapshot={snapshot()} />)
    expect(screen.getByText('14:00 – 14:45')).toBeTruthy()
    // 任务标题出现在时间轴与投入分布两处
    expect(screen.getAllByText('导图高度自适应').length).toBe(2)
    expect(screen.getByText('45m ·')).toBeTruthy()
  })

  it('中断会话标为「中断」而不是「有效」', () => {
    const s = snapshot({ interruptedCount: 1, sessions: [fact({ interrupted: true })] })
    const { container } = render(<DailyEvidenceDrawer snapshot={s} />)
    // 时间轴条目上的有效性标签
    expect(container.textContent).toContain('45m · 中断')
  })

  it('界面里不出现任何百分制评分（反羞耻：不做人格/效率打分）', () => {
    const { container } = render(<DailyEvidenceDrawer snapshot={snapshot()} />)
    expect(container.textContent ?? '').not.toMatch(/\d+\s*分/)
    expect(container.textContent ?? '').not.toMatch(/评分|得分|效率指数/)
  })

  it('悬挂思考以中性图标呈现，不加评判字样', () => {
    const s = snapshot({
      hanging: [
        { cid: 'c1', title: '针对 Safari 17 测试弹性高度', thoughtType: 'todo', sessionId: 's1' },
      ],
    })
    render(<DailyEvidenceDrawer snapshot={s} />)
    expect(screen.getByText(/悬挂中的思考/)).toBeTruthy()
    expect(screen.getByText(/针对 Safari 17 测试弹性高度/)).toBeTruthy()
    expect(document.body.textContent ?? '').not.toMatch(/拖延|未完成事项警告/)
  })

  it('点击注入把意图交给页面（组件自己不写库）', () => {
    const onInject = vi.fn()
    render(<DailyEvidenceDrawer snapshot={snapshot()} onInject={onInject} />)
    fireEvent.click(screen.getByTestId('daily-evidence-inject'))
    expect(onInject).toHaveBeenCalledTimes(1)
  })

  it('注入中禁用按钮，防重复提交', () => {
    const onInject = vi.fn()
    render(<DailyEvidenceDrawer snapshot={snapshot()} onInject={onInject} injecting />)
    const button = screen.getByTestId('daily-evidence-inject') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('注入中')
  })

  it('未提供 onInject 时按钮禁用（无动作入口就不给可点的壳）', () => {
    render(<DailyEvidenceDrawer snapshot={snapshot()} />)
    const button = screen.getByTestId('daily-evidence-inject') as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('投入分布缺失时整段隐藏（不留空标题）', () => {
    const s = snapshot({ byLevel2: [] })
    render(<DailyEvidenceDrawer snapshot={s} />)
    expect(screen.queryByText('投入分布')).toBeNull()
  })
})
