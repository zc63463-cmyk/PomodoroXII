import { describe, expect, it, vi } from 'vitest'
import { createEndAlert } from './end-alert'

const baseTick = {
  sessionId: 'session-a',
  clockState: 'running' as const,
  remainingSeconds: 0,
  plannedSeconds: 1500,
  notificationEnabled: true,
  soundEnabled: true,
}

describe('createEndAlert（工单① 结束提醒）', () => {
  it('到点恰好触发一次：未到点/暂停/已结束都不响，越过计划点后多 tick 不重复', () => {
    const notify = vi.fn()
    const beep = vi.fn()
    const alert = createEndAlert({ notify, beep })

    alert.check({ ...baseTick, remainingSeconds: 60 })
    alert.check({ ...baseTick, clockState: 'paused', remainingSeconds: 0 })
    alert.check({ ...baseTick, clockState: 'ended', remainingSeconds: 0 })
    expect(notify).not.toHaveBeenCalled()
    expect(beep).not.toHaveBeenCalled()

    alert.check(baseTick)
    alert.check(baseTick)
    alert.check(baseTick)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(beep).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('专注结束', '本轮计划 25 分钟已完成')
  })

  it('notificationEnabled=false 不发通知，但不影响提示音', () => {
    const notify = vi.fn()
    const beep = vi.fn()
    const alert = createEndAlert({ notify, beep })

    alert.check({ ...baseTick, notificationEnabled: false })

    expect(notify).not.toHaveBeenCalled()
    expect(beep).toHaveBeenCalledTimes(1)
  })

  it('soundEnabled=false 不响，但不影响通知', () => {
    const notify = vi.fn()
    const beep = vi.fn()
    const alert = createEndAlert({ notify, beep })

    alert.check({ ...baseTick, soundEnabled: false })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(beep).not.toHaveBeenCalled()
  })

  it('无 Notification/AudioContext API（jsdom 默认路径）不崩且只留 warn', () => {
    const warn = vi.fn()
    const alert = createEndAlert({ warn })

    expect(() => alert.check(baseTick)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.flat().join('\n')).toContain('notification_api_unavailable')
    expect(warn.mock.calls.flat().join('\n')).toContain('audio_api_unavailable')
  })

  it('注入通道抛异常时吞掉并只 warn；失败也记闩，不放大成 log 洪水', () => {
    const warn = vi.fn()
    const notify = vi.fn(() => { throw new Error('permission_denied') })
    const beep = vi.fn(() => { throw new Error('audio_blocked') })
    const alert = createEndAlert({ notify, beep, warn })

    expect(() => alert.check(baseTick)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(2)

    warn.mockClear()
    alert.check(baseTick)
    alert.check(baseTick)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(beep).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('新 session id 可再次触发，并按新的计划时长播报', () => {
    const notify = vi.fn()
    const alert = createEndAlert({ notify, beep: vi.fn() })

    alert.check(baseTick)
    alert.check({ ...baseTick, sessionId: 'session-b', plannedSeconds: 2700 })

    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenLastCalledWith('专注结束', '本轮计划 45 分钟已完成')
  })
})
