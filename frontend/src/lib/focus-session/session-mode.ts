/**
 * 双体系兼容 · 番茄钟模式与休息节奏（2026-09-16）。
 *
 * 这里是**纯函数层**：模式元数据、按模式的默认时长/预设、以及"下一步该做什么"
 * 的休息节奏判定。页面只做接线，不在此之外重新发明规则。
 *
 * 与任务空间的事实边界（服务端同口径）：
 * - 投入型（work / free / countdown）：正常累计 focused 秒数、承接三级计划、
 *   结束进复盘；只有 work 计为「番茄」。
 * - 休息型（short_break / long_break）：focused_seconds 恒 0（不计投入）、
 *   免复盘、不承接三级计划；仍挂同一个二级 WorkItem（归因不变量不放宽）。
 */

import {
  FOCUS_PRESETS,
  SESSION_TYPES,
  SESSION_TYPE_LABELS,
  TIMER_MODES,
  WORK_PRESETS,
} from '@/utils/constants'
import type { FocusSessionType } from '@/lib/contracts/focus-session'

export type SessionMode = FocusSessionType

export const SESSION_MODES: readonly SessionMode[] = SESSION_TYPES

export const BREAK_MODES = ['short_break', 'long_break'] as const

/** 休息预设（分钟）：短休 5/10/15、长休 15/20/30（经典番茄钟取值）。 */
export const BREAK_PRESETS: Record<'short_break' | 'long_break', readonly number[]> = {
  short_break: [5, 10, 15],
  long_break: [15, 20, 30],
}

export function isBreakMode(mode: SessionMode | null | undefined): boolean {
  return mode === 'short_break' || mode === 'long_break'
}

/** 计为「番茄」的模式（统计口径：自由/倒计时是专注时间但不是番茄）。 */
export function countsAsPomodoro(mode: SessionMode | null | undefined): boolean {
  return mode === 'work'
}

export function modeLabel(mode: SessionMode): string {
  return TIMER_MODES[mode]?.label ?? SESSION_TYPE_LABELS[mode] ?? mode
}

export function modeDescription(mode: SessionMode): string {
  return TIMER_MODES[mode]?.description ?? ''
}

/** 环/强调色（沿用 TIMER_MODES 的模式色，只做展示）。 */
export function modeColor(mode: SessionMode): string {
  return TIMER_MODES[mode]?.color ?? '#E74C3C'
}

export function presetsForMode(mode: SessionMode): readonly number[] {
  if (mode === 'short_break' || mode === 'long_break') return BREAK_PRESETS[mode]
  if (mode === 'work') return WORK_PRESETS
  return FOCUS_PRESETS
}

export interface ModeDurationSettings {
  pomodoroDuration: number
  shortBreakDuration: number
  longBreakDuration: number
}

/** 按模式的默认计划时长（分钟）。自由/倒计时沿用 work 的默认值再自定。 */
export function defaultMinutesForMode(mode: SessionMode, settings: ModeDurationSettings): number {
  if (mode === 'short_break') return settings.shortBreakDuration
  if (mode === 'long_break') return settings.longBreakDuration
  return settings.pomodoroDuration
}

/** 长休判定：每完成 `longBreakInterval` 个番茄来一次长休（0 个不算）。 */
export function nextBreakMode(
  completedWorkSessions: number,
  longBreakInterval: number,
): 'short_break' | 'long_break' {
  const interval = Number.isFinite(longBreakInterval) && longBreakInterval >= 1
    ? Math.trunc(longBreakInterval)
    : 1
  const completed = Number.isFinite(completedWorkSessions) && completedWorkSessions > 0
    ? Math.trunc(completedWorkSessions)
    : 0
  if (completed === 0) return 'short_break'
  return completed % interval === 0 ? 'long_break' : 'short_break'
}

export interface RestCycleSettings extends ModeDurationSettings {
  longBreakInterval: number
  autoStartBreaks: boolean
  autoStartPomodoros: boolean
}

export interface RestCycleStep {
  /** 下一步该开的模式。 */
  nextMode: SessionMode
  plannedMinutes: number
  /** 用户设置是否要求自动开始这一步（页面仍要过启动前置判定）。 */
  autoStart: boolean
}

/**
 * 休息节奏判定 —— 只在一轮完整走完（timerCompletion === 'completed'）后接续：
 * - 投入型结束 → 短休 / 长休（按已完成番茄数）；
 * - 休息型结束 → 下一个番茄（work）。
 * 提前结束 / 中断不进入节奏（返回 null）：那是一次打断，不是一轮番茄。
 */
export function planRestCycle(input: {
  endedMode: SessionMode | null | undefined
  timerCompletion: 'completed' | 'ended_early' | 'interrupted' | null
  /** 含本次在内的已完成番茄数（work 型、正常结束、非无效）。 */
  completedWorkSessions: number
  settings: RestCycleSettings
}): RestCycleStep | null {
  const endedMode = input.endedMode ?? 'work'
  if (isBreakMode(endedMode)) {
    // 休息结束 → 回到工作：休息被提前掐断同样要回工作（那不是"打断一轮
    // 番茄"，只是休息短了点）；只有 interrupted 才不接续。
    if (input.timerCompletion === 'interrupted') return null
    return {
      nextMode: 'work',
      plannedMinutes: defaultMinutesForMode('work', input.settings),
      autoStart: input.settings.autoStartPomodoros,
    }
  }
  // 投入型只在完整走完一轮后接续休息：提前结束/中断是一次打断，不是一轮番茄。
  if (input.timerCompletion !== 'completed') return null
  const breakMode = nextBreakMode(input.completedWorkSessions, input.settings.longBreakInterval)
  return {
    nextMode: breakMode,
    plannedMinutes: defaultMinutesForMode(breakMode, input.settings),
    autoStart: input.settings.autoStartBreaks,
  }
}

interface CompletedWorkSessionLike {
  sessionType?: FocusSessionType | null
  clockState?: string | null
  timerCompletion?: 'completed' | 'ended_early' | 'interrupted' | null
  validity?: 'pending' | 'valid' | 'invalid' | null
  endedAt?: string | null
}

/**
 * 已完成番茄计数（本地缓存行口径）。
 *
 * 统计口径：work 型 + 已结束 + 正常结束 + 未判无效。`free` / `countdown`
 * 是专注时间但不是番茄；休息型永不计数。
 */
export function countCompletedWorkSessions(sessions: readonly CompletedWorkSessionLike[]): number {
  return sessions.filter((session) => (
    (session.sessionType ?? 'work') === 'work' &&
    (session.clockState === 'ended' || session.endedAt != null) &&
    session.timerCompletion === 'completed' &&
    session.validity !== 'invalid'
  )).length
}
