import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionClock } from './session-clock'

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
