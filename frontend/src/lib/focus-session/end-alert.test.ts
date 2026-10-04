import { describe, expect, it, vi, type Mock } from 'vitest'
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

  it('双体系兼容：休息型到点说「休息结束」，投入型文案逐字不变', () => {
    const breakNotify = vi.fn()
    const breakAlert = createEndAlert({ notify: breakNotify, beep: vi.fn() })
    breakAlert.check({ ...baseTick, sessionId: 'break-1', mode: 'short_break', plannedSeconds: 300 })
    expect(breakNotify).toHaveBeenCalledWith('休息结束', '本轮休息 5 分钟已完成')

    // work / free / countdown / 未声明模式：同一份专注文案
    const focusModes = [undefined, 'work', 'free', 'countdown'] as const
    for (const [index, mode] of focusModes.entries()) {
      const notify = vi.fn()
      createEndAlert({ notify, beep: vi.fn() })
        .check({ ...baseTick, sessionId: `s-${index}`, mode, plannedSeconds: 1500 })
      expect(notify).toHaveBeenCalledWith('专注结束', '本轮计划 25 分钟已完成')
    }
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

// ── PXII-FEAT-TIMER-CHIME（2026-10-02）：柔和钟声 + AudioContext 手势预热 ──────
//
// 单例 `sharedAudioContext` 是**模块级**状态 → 每个用例先 `vi.resetModules()` 再
// 动态 import，拿到全新模块实例（顶部静态 import 的实例不参与断言）。

interface FakeOscillator {
  type: string
  frequency: { setValueAtTime: Mock }
  connect: Mock
  start: Mock
  stop: Mock
}

interface FakeGain {
  gain: { setValueAtTime: Mock; exponentialRampToValueAtTime: Mock }
  connect: Mock
}

interface FakeAudioContextInstance {
  state: AudioContextState
  currentTime: number
  oscillators: FakeOscillator[]
  gains: FakeGain[]
  resume: Mock
  close: Mock
}

/** 在 window 上装一台可控的 AudioContext 假实现；返回实例表与还原函数。 */
function installFakeAudioContext(initialState: AudioContextState = 'suspended') {
  const instances: FakeAudioContextInstance[] = []
  class FakeAudioContext {
    state: AudioContextState = initialState
    currentTime = 0
    destination = {}
    oscillators: FakeOscillator[] = []
    gains: FakeGain[] = []
    resume = vi.fn(async () => { this.state = 'running' as AudioContextState })
    close = vi.fn(async () => {})
    createOscillator = (): FakeOscillator => {
      const oscillator: FakeOscillator = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      }
      this.oscillators.push(oscillator)
      return oscillator
    }
    createGain = (): FakeGain => {
      const gain: FakeGain = {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      }
      this.gains.push(gain)
      return gain
    }
    constructor() {
      instances.push(this as unknown as FakeAudioContextInstance)
    }
  }
  const target = window as unknown as Record<string, unknown>
  const previous = target.AudioContext
  target.AudioContext = FakeAudioContext
  return { instances, restore: () => { target.AudioContext = previous } }
}

describe('ensureAudioContextReady（手势预热单例，PXII-FEAT-TIMER-CHIME）', () => {
  it('无 Web Audio API（jsdom 默认）→ null，绝不抛', async () => {
    vi.resetModules()
    const { ensureAudioContextReady } = await import('./end-alert')

    expect(ensureAudioContextReady()).toBeNull()
  })

  it('★ 首次调用创建单例并解锁 suspended；再次调用复用同一实例（不重复创建）', async () => {
    vi.resetModules()
    const fake = installFakeAudioContext('suspended')
    try {
      const { ensureAudioContextReady } = await import('./end-alert')

      const first = ensureAudioContextReady()
      expect(fake.instances).toHaveLength(1)
      expect(first).toBe(fake.instances[0])
      // Autoplay 解锁：suspended → resume()
      expect(fake.instances[0]?.resume).toHaveBeenCalledTimes(1)

      const second = ensureAudioContextReady()
      expect(second).toBe(first)
      expect(fake.instances).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('已 running 的上下文不重复 resume', async () => {
    vi.resetModules()
    const fake = installFakeAudioContext('running')
    try {
      const { ensureAudioContextReady } = await import('./end-alert')

      expect(ensureAudioContextReady()).toBe(fake.instances[0])
      expect(fake.instances[0]?.resume).not.toHaveBeenCalled()
    } finally {
      fake.restore()
    }
  })
})

describe('柔和双音钟声合成（defaultBeep → playGentleBell）', () => {
  it('★ 两对谐波共四振荡器 + 指数包络收尾；复用单例且**不** close', async () => {
    vi.resetModules()
    const fake = installFakeAudioContext('running')
    try {
      const { createEndAlert: createAlert } = await import('./end-alert')
      const warn = vi.fn()
      createAlert({ notify: vi.fn(), warn }).check({ ...baseTick })

      // 全程 fail-quiet：不因音频问题留下任何 warn
      expect(warn).not.toHaveBeenCalled()
      expect(fake.instances).toHaveLength(1)
      const ctx = fake.instances[0]
      if (!ctx) throw new Error('fake AudioContext 未创建')

      // 声 1 = D5 + A5，声 2 = D6 + A6（零素材纯合成）
      expect(ctx.oscillators).toHaveLength(4)
      expect(ctx.gains).toHaveLength(2)
      expect(ctx.oscillators.map((osc) => osc.frequency.setValueAtTime.mock.calls[0]?.[0]))
        .toEqual([587.33, 880, 1174.66, 1760])

      // 每对声部：0.005s 起音到峰值 → 指数衰减到近零（消除截断爆破音）
      for (const gain of ctx.gains) {
        const ramps = gain.gain.exponentialRampToValueAtTime.mock.calls
        expect(ramps).toHaveLength(2)
        expect(ramps[1]?.[0]).toBeCloseTo(0.0001, 5)
      }

      // ★ 单例语义：到点播放**不**关闭上下文（否则下一次提醒又要重新解锁）
      expect(ctx.close).not.toHaveBeenCalled()
    } finally {
      fake.restore()
    }
  })

  it('playGentleBell 可直接驱动预热上下文（「试听提示音」入口同一条路径）', async () => {
    vi.resetModules()
    const fake = installFakeAudioContext('running')
    try {
      const { ensureAudioContextReady, playGentleBell } = await import('./end-alert')
      const ctx = ensureAudioContextReady()
      if (!ctx) throw new Error('预热失败')

      playGentleBell(ctx)
      playGentleBell(ctx)

      // 每次调用新增两对谐波（试听可重复触发）
      expect(fake.instances[0]?.oscillators).toHaveLength(8)
      expect(fake.instances[0]?.close).not.toHaveBeenCalled()
    } finally {
      fake.restore()
    }
  })
})
