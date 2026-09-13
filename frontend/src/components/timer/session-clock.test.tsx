import { createElement } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionClock } from './session-clock'
import type { ClockFacts } from '@/lib/focus-session/clock'

const running = {
  sessionId: 'session-a', startedAt: '2026-07-15T08:00:00Z', endedAt: null,
  pauseStartedAt: null, plannedSeconds: 1500, pausedSeconds: 0,
  focusedSeconds: 0, clockState: 'running',
} as never

describe('SessionClock', () => {
  it('persists terminal clock facts even when Note flush rejects', async () => {
    const flushNote = vi.fn().mockRejectedValue(new Error('note conflict'))
    const end = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionClock, { session: running, nowMs: Date.parse('2026-07-15T08:10:00Z'),
      owner: true, onFlushNote: flushNote, onEnd: end }))

    fireEvent.click(screen.getByRole('button', { name: 'End session' }))

    await screen.findByText('Session ended; note needs attention')
    expect(end).toHaveBeenCalledOnce()
  })

  it('disables ownership controls in a read-only tab', () => {
    render(createElement(SessionClock, { session: running, nowMs: Date.parse('2026-07-15T08:10:00Z'),
      owner: false, onPause: vi.fn(), onResume: vi.fn(), onEnd: vi.fn() }))

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'End session' })).toBeDisabled()
    expect(screen.getByText('Read-only in this Tab')).toBeInTheDocument()
    // 没有接管回调时不渲染按钮（向后兼容）。
    expect(screen.queryByRole('button', { name: '在本标签页接管' })).toBeNull()
  })

  it('offers an explicit takeover in a read-only tab', () => {
    // 回归（2026-09-11 实测卡死）：只读状态曾没有任何出口 —— 上一个标签页
    // 关掉后会话永久只读、既不能继续也不能结束。协议与端点一直都在，
    // 缺的是这个按钮。
    const takeover = vi.fn()
    render(createElement(SessionClock, { session: running, nowMs: Date.parse('2026-07-15T08:10:00Z'),
      owner: false, ownerHint: '该会话由另一个标签页持有 —— 若那个标签页已关闭，可在此接管继续。',
      onPause: vi.fn(), onResume: vi.fn(), onEnd: vi.fn(), onTakeover: takeover }))

    expect(screen.getByText('该会话由另一个标签页持有 —— 若那个标签页已关闭，可在此接管继续。'))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '在本标签页接管' }))
    expect(takeover).toHaveBeenCalledTimes(1)
  })
})

describe('SessionClock 计时环与庆祝粒子（工单 B 2026-09-14）', () => {
  const CIRCUMFERENCE = 2 * Math.PI * 88
  const at = (secondsFromStart: number) => Date.parse('2026-07-15T08:00:00Z') + secondsFromStart * 1000
  const facts = (overrides: Partial<ClockFacts> = {}): ClockFacts => ({
    sessionId: 'session-a',
    startedAt: '2026-07-15T08:00:00Z',
    endedAt: null,
    pauseStartedAt: null,
    plannedSeconds: 1500,
    pausedSeconds: 0,
    focusedSeconds: 0,
    clockState: 'running',
    ...overrides,
  })
  const dashoffset = () => Number(screen.getByTestId('timer-ring-progress').getAttribute('stroke-dashoffset'))

  it('环 dashoffset 与 elapse/planned 同源：0 / 半程 / 满程', () => {
    const { rerender } = render(createElement(SessionClock, {
      session: facts(), nowMs: at(0), owner: true, onEnd: vi.fn(),
    }))
    expect(dashoffset()).toBeCloseTo(CIRCUMFERENCE, 5)

    rerender(createElement(SessionClock, { session: facts(), nowMs: at(750), owner: true, onEnd: vi.fn() }))
    expect(dashoffset()).toBeCloseTo(CIRCUMFERENCE / 2, 5)

    rerender(createElement(SessionClock, { session: facts(), nowMs: at(1500), owner: true, onEnd: vi.fn() }))
    expect(dashoffset()).toBeCloseTo(0, 5)
  })

  it('★ 超时：弧长饱和在满环且换 overtime 类（环只换色不再增长）', () => {
    render(createElement(SessionClock, {
      session: facts(), nowMs: at(1800), owner: true, onEnd: vi.fn(),
    }))

    expect(dashoffset()).toBeCloseTo(0, 5)
    expect(screen.getByTestId('timer-ring')).toHaveClass('timer-ring--overtime')
  })

  it('运行态呼吸类存在、暂停冻结（live 类消失）', () => {
    const { rerender } = render(createElement(SessionClock, {
      session: facts(), nowMs: at(10), owner: true, onEnd: vi.fn(),
    }))
    expect(screen.getByTestId('timer-ring')).toHaveClass('timer-ring-live')

    rerender(createElement(SessionClock, {
      session: facts({ clockState: 'paused', pauseStartedAt: '2026-07-15T08:00:10Z' }),
      nowMs: at(600), owner: true, onEnd: vi.fn(),
    }))
    expect(screen.getByTestId('timer-ring')).not.toHaveClass('timer-ring-live')
  })

  it('数字翻转以分钟为键：同分钟保节点、跨分钟重挂载（一次性 pop 的触发条件）', () => {
    const { rerender } = render(createElement(SessionClock, {
      session: facts(), nowMs: at(65), owner: true, onEnd: vi.fn(),
    }))
    const before = screen.getByTestId('timer-digits')

    // 1435s → 1434s：同一分钟内，节点应被复用（文本原地更新）
    rerender(createElement(SessionClock, { session: facts(), nowMs: at(66), owner: true, onEnd: vi.fn() }))
    expect(screen.getByTestId('timer-digits')).toBe(before)

    // 1435s → 1375s：跨分钟，key 变化 → 重挂载（新节点）
    rerender(createElement(SessionClock, { session: facts(), nowMs: at(125), owner: true, onEnd: vi.fn() }))
    expect(screen.getByTestId('timer-digits')).not.toBe(before)
  })

  it('★ 越过计划点：粒子恰好渲染一次、1.6s 后移除、后续 tick 不再重复（按会话闩锁）', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(createElement(SessionClock, {
        session: facts(), nowMs: at(1499), owner: true, onEnd: vi.fn(),
      }))
      expect(screen.queryByTestId('timer-celebration')).toBeNull()

      rerender(createElement(SessionClock, { session: facts(), nowMs: at(1500), owner: true, onEnd: vi.fn() }))
      const celebration = screen.getByTestId('timer-celebration')
      expect(celebration.querySelectorAll('.timer-celebration-particle')).toHaveLength(12)

      // 播完由定时器移除（不是永久留在 DOM 里）
      act(() => { vi.advanceTimersByTime(1700) })
      expect(screen.queryByTestId('timer-celebration')).toBeNull()

      // 超时期间 remaining 恒 0、每 tick 都满足触发条件 —— 没有闩锁就会重复庆祝
      rerender(createElement(SessionClock, { session: facts(), nowMs: at(1520), owner: true, onEnd: vi.fn() }))
      expect(screen.queryByTestId('timer-celebration')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('中途打开（首见即已超时）不庆祝 —— 迟到的庆祝是误报', () => {
    render(createElement(SessionClock, {
      session: facts(), nowMs: at(1800), owner: true, onEnd: vi.fn(),
    }))
    expect(screen.queryByTestId('timer-celebration')).toBeNull()
  })

  it('★ prefers-reduced-motion: reduce → 不渲染粒子（渲染后关动画会静止残留）', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }))
    try {
      const { rerender } = render(createElement(SessionClock, {
        session: facts(), nowMs: at(1499), owner: true, onEnd: vi.fn(),
      }))
      rerender(createElement(SessionClock, { session: facts(), nowMs: at(1500), owner: true, onEnd: vi.fn() }))
      expect(screen.queryByTestId('timer-celebration')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
