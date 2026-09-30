import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RestCyclePanel } from './rest-cycle-panel'

describe('RestCyclePanel（双体系兼容 · 休息节奏）', () => {
  it('工作轮结束 → 建议短休，摘要给出净专注分钟，按钮带建议时长', () => {
    const onStart = vi.fn()
    render(createElement(RestCyclePanel, {
      endedMode: 'work',
      focusedSeconds: 1450,
      breakSeconds: 0,
      cycle: { nextMode: 'short_break', plannedMinutes: 5, autoStart: false },
      onStart,
    }))

    expect(screen.getByTestId('rest-cycle-panel')).toHaveTextContent('上一轮：专注 · 净专注 24 分钟')
    expect(screen.getByTestId('rest-cycle-panel')).toHaveTextContent('下一步：短休息 5 分钟')

    fireEvent.click(screen.getByTestId('rest-cycle-start'))
    expect(onStart).toHaveBeenCalledWith('short_break')
  })

  it('建议长休时提供"改为短休息"备选（备选只传模式，时长由页面按设置推导）', () => {
    const onStart = vi.fn()
    render(createElement(RestCyclePanel, {
      endedMode: 'work',
      focusedSeconds: 1500,
      breakSeconds: 0,
      cycle: { nextMode: 'long_break', plannedMinutes: 15, autoStart: false },
      onStart,
    }))

    expect(screen.getByRole('button', { name: '开始长休息 15 分钟' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('rest-cycle-alt-short_break'))
    expect(onStart).toHaveBeenCalledWith('short_break')
  })

  it('休息结束 → 建议下一个番茄（摘要显示休息分钟）', () => {
    render(createElement(RestCyclePanel, {
      endedMode: 'short_break',
      focusedSeconds: 0,
      breakSeconds: 320,
      cycle: { nextMode: 'work', plannedMinutes: 25, autoStart: false },
      onStart: vi.fn(),
    }))

    expect(screen.getByTestId('rest-cycle-panel')).toHaveTextContent('上一轮：短休息 · 休息 5 分钟')
    expect(screen.getByRole('button', { name: '开始专注 25 分钟' })).toBeInTheDocument()
    // 下一个番茄没有"备选休息"按钮（建议本来就是工作轮）
    expect(screen.queryByTestId('rest-cycle-alt-short_break')).toBeNull()
  })

  it('自动开始被挡下时原因必须可见（role=alert）', () => {
    render(createElement(RestCyclePanel, {
      endedMode: 'work',
      focusedSeconds: 60,
      breakSeconds: 0,
      cycle: { nextMode: 'short_break', plannedMinutes: 5, autoStart: true },
      blockedReason: 'active_session_exists:space-a:space-a',
      onStart: vi.fn(),
    }))

    expect(screen.getByRole('alert')).toHaveTextContent('active_session_exists')
  })

  it('pending 时按钮禁用（避免重复发起）；提供回任务页出口', () => {
    const onStart = vi.fn()
    const onReturnToTasks = vi.fn()
    render(createElement(RestCyclePanel, {
      endedMode: 'work',
      focusedSeconds: 60,
      breakSeconds: 0,
      cycle: { nextMode: 'short_break', plannedMinutes: 5, autoStart: false },
      starting: true,
      onStart,
      onReturnToTasks,
    }))

    const start = screen.getByTestId('rest-cycle-start')
    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(onStart).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '回任务页' }))
    expect(onReturnToTasks).toHaveBeenCalledTimes(1)
  })
})
