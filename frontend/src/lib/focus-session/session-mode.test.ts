import { describe, expect, it } from 'vitest'
import {
  countCompletedWorkSessions,
  defaultMinutesForMode,
  isBreakMode,
  nextBreakMode,
  planRestCycle,
  presetsForMode,
  SESSION_MODES,
  type RestCycleSettings,
} from './session-mode'

const settings: RestCycleSettings = {
  pomodoroDuration: 25,
  shortBreakDuration: 5,
  longBreakDuration: 15,
  longBreakInterval: 4,
  autoStartBreaks: false,
  autoStartPomodoros: false,
}

describe('session-mode · 模式元数据', () => {
  it('5 个模式全在（work / short_break / long_break / free / countdown）', () => {
    expect(SESSION_MODES).toEqual(['work', 'short_break', 'long_break', 'free', 'countdown'])
  })

  it('休息判据只认 short_break / long_break', () => {
    expect(['short_break', 'long_break'].every((mode) => isBreakMode(mode as never))).toBe(true)
    expect(['work', 'free', 'countdown'].some((mode) => isBreakMode(mode as never))).toBe(false)
    expect(isBreakMode(null)).toBe(false)
  })

  it('默认时长按模式取设置值', () => {
    expect(defaultMinutesForMode('work', settings)).toBe(25)
    expect(defaultMinutesForMode('short_break', settings)).toBe(5)
    expect(defaultMinutesForMode('long_break', settings)).toBe(15)
    // 自由/倒计时沿用 work 默认值再自定（没有独立设置键）
    expect(defaultMinutesForMode('free', settings)).toBe(25)
    expect(defaultMinutesForMode('countdown', settings)).toBe(25)
  })

  it('预设按模式分流：work=WORK_PRESETS，短休/长休各自区间，free/countdown=FOCUS_PRESETS', () => {
    expect(presetsForMode('work')).toEqual([25, 45, 60, 90])
    expect(presetsForMode('short_break')).toEqual([5, 10, 15])
    expect(presetsForMode('long_break')).toEqual([15, 20, 30])
    expect(presetsForMode('free')).toEqual([45, 60, 90, 120])
  })
})

describe('session-mode · 长休间隔判定', () => {
  it('每 N 个番茄长休一次；0 个（第一轮）只给短休', () => {
    expect(nextBreakMode(0, 4)).toBe('short_break')
    expect(nextBreakMode(1, 4)).toBe('short_break')
    expect(nextBreakMode(3, 4)).toBe('short_break')
    expect(nextBreakMode(4, 4)).toBe('long_break')
    expect(nextBreakMode(8, 4)).toBe('long_break')
    expect(nextBreakMode(5, 4)).toBe('short_break')
  })

  it('脏数据（间隔 0 / 负数 / NaN）退化为每次短休，不抛错、不静默长休', () => {
    expect(nextBreakMode(4, 0)).toBe('long_break') // interval 退回 1：每个都算"满 N"
    expect(nextBreakMode(4, -1)).toBe('long_break')
    expect(nextBreakMode(4, Number.NaN)).toBe('long_break')
    expect(nextBreakMode(Number.NaN, 4)).toBe('short_break')
    expect(nextBreakMode(-3, 4)).toBe('short_break')
  })
})

describe('session-mode · 休息节奏判定', () => {
  it('投入型完整走完 → 建议休息（短休/长休按已完成番茄数）', () => {
    expect(planRestCycle({
      endedMode: 'work', timerCompletion: 'completed', completedWorkSessions: 1,
      settings,
    })).toEqual({ nextMode: 'short_break', plannedMinutes: 5, autoStart: false })

    expect(planRestCycle({
      endedMode: 'work', timerCompletion: 'completed', completedWorkSessions: 4,
      settings,
    })).toEqual({ nextMode: 'long_break', plannedMinutes: 15, autoStart: false })
  })

  it('投入型提前结束 / 中断 → 不接续（那是一次打断，不是一轮番茄）', () => {
    expect(planRestCycle({
      endedMode: 'work', timerCompletion: 'ended_early', completedWorkSessions: 1, settings,
    })).toBeNull()
    expect(planRestCycle({
      endedMode: 'free', timerCompletion: 'interrupted', completedWorkSessions: 1, settings,
    })).toBeNull()
  })

  it('休息结束 → 回工作（休息提前掐断同样回工作；interrupted 不接续）', () => {
    expect(planRestCycle({
      endedMode: 'short_break', timerCompletion: 'completed', completedWorkSessions: 1, settings,
    })).toEqual({ nextMode: 'work', plannedMinutes: 25, autoStart: false })

    expect(planRestCycle({
      endedMode: 'long_break', timerCompletion: 'ended_early', completedWorkSessions: 4, settings,
    })).toEqual({ nextMode: 'work', plannedMinutes: 25, autoStart: false })

    expect(planRestCycle({
      endedMode: 'short_break', timerCompletion: 'interrupted', completedWorkSessions: 1, settings,
    })).toBeNull()
  })

  it('自动开始开关：含本次的番茄数决定长休，autoStartBreaks 控制休息自动开始', () => {
    const autoSettings: RestCycleSettings = {
      ...settings, autoStartBreaks: true, autoStartPomodoros: true,
    }
    expect(planRestCycle({
      endedMode: 'work', timerCompletion: 'completed', completedWorkSessions: 2, settings: autoSettings,
    })).toEqual({ nextMode: 'short_break', plannedMinutes: 5, autoStart: true })
    expect(planRestCycle({
      endedMode: 'short_break', timerCompletion: 'completed', completedWorkSessions: 2,
      settings: autoSettings,
    })).toEqual({ nextMode: 'work', plannedMinutes: 25, autoStart: true })
  })

  it('缺失 endedMode 按 work 解释（旧缓存行没有该字段的口径）', () => {
    expect(planRestCycle({
      endedMode: undefined, timerCompletion: 'completed', completedWorkSessions: 1, settings,
    })).toEqual({ nextMode: 'short_break', plannedMinutes: 5, autoStart: false })
  })
})

describe('session-mode · 已完成番茄计数', () => {
  it('只数 work 型 + 已结束 + 正常结束 + 非无效', () => {
    const sessions = [
      { sessionType: 'work' as const, clockState: 'ended', timerCompletion: 'completed' as const, validity: 'valid' as const },
      // 缺 sessionType 的旧缓存行按 work 解释
      { clockState: 'ended', endedAt: '2026-09-16T08:00:00Z', timerCompletion: 'completed' as const, validity: 'pending' as const },
      { sessionType: 'work' as const, clockState: 'ended', timerCompletion: 'ended_early' as const, validity: 'valid' as const },
      { sessionType: 'work' as const, clockState: 'ended', timerCompletion: 'completed' as const, validity: 'invalid' as const },
      { sessionType: 'short_break' as const, clockState: 'ended', timerCompletion: 'completed' as const, validity: 'valid' as const },
      { sessionType: 'free' as const, clockState: 'ended', timerCompletion: 'completed' as const, validity: 'valid' as const },
      { sessionType: 'work' as const, clockState: 'running', timerCompletion: null, validity: 'pending' as const },
    ]
    expect(countCompletedWorkSessions(sessions)).toBe(2)
  })

  it('空列表返回 0', () => {
    expect(countCompletedWorkSessions([])).toBe(0)
  })
})
