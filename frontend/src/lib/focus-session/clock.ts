export interface ClockFacts {
  /**
   * 会话 id（工单 B 2026-09-14 起可选声明）。
   *
   * 纯钟面推导（deriveSessionClock）不需要它；消费方要做**按会话记账**的
   * 闩锁时需要（庆祝粒子：同一会话只庆祝一次）。两种运行时形态都带这个能力：
   * CachedFocusSession 有 sessionId，FocusSessionView 有 id —— 见 sessionIdOf。
   */
  sessionId?: string
  /**
   * 番茄钟模式（双体系兼容 2026-09-16，可选声明）。
   *
   * 纯钟面推导不需要它；消费方要按模式改**呈现**时需要（环色调、模式标签、
   * 休息型的尺寸/文案）。缺省按 'work' 解释 —— 与缓存行/服务端列默认同口径。
   */
  sessionType?: string | null
  startedAt: string
  endedAt: string | null
  pauseStartedAt: string | null
  plannedSeconds: number
  pausedSeconds: number
  focusedSeconds: number
  clockState: 'running' | 'paused' | 'ended'
}

export interface DerivedClock {
  elapsedSeconds: number
  remainingSeconds: number
  overtimeSeconds: number
}

export interface RingProgress {
  /** 0..1 的进度；plannedSeconds=0 时为 0（防除零）。超时后饱和在 1。 */
  fraction: number
  /** 已越过计划点（elapsed > planned）。环只换色，不再增长。 */
  overtime: boolean
}

const seconds = (milliseconds: number) => Math.max(0, Math.floor(milliseconds / 1000))

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`)
  return parsed
}

export function deriveSessionClock(session: ClockFacts, nowMs: number): DerivedClock {
  let elapsedSeconds: number
  if (session.clockState === 'ended') {
    elapsedSeconds = Math.max(0, session.focusedSeconds)
  } else {
    const end = session.clockState === 'paused'
      ? timestamp(session.pauseStartedAt ?? '', 'pauseStartedAt')
      : nowMs
    elapsedSeconds = Math.max(
      0,
      seconds(end - timestamp(session.startedAt, 'startedAt')) - session.pausedSeconds,
    )
  }
  return {
    elapsedSeconds,
    remainingSeconds: Math.max(0, session.plannedSeconds - elapsedSeconds),
    overtimeSeconds: Math.max(0, elapsedSeconds - session.plannedSeconds),
  }
}

/**
 * 环形进度（工单 B 2026-09-14）。
 *
 * ★ 环不是第二个真相源：fraction 完全从 deriveSessionClock 的 elapsed 重述，
 *   不存在「数字显示 A、环显示 B」的可能 —— 环只是把同一个事实画成弧长。
 * ★ fraction 饱和在 1：超时后弧长不再增长（overtime 只换颜色），
 *   否则 planned=25min 会画出两圈。
 * ★ plannedSeconds=0 防除零：返回 0（环空），不做任何除法。
 */
export function deriveRingProgress(session: ClockFacts, nowMs: number): RingProgress {
  const { elapsedSeconds } = deriveSessionClock(session, nowMs)
  const fraction = session.plannedSeconds > 0
    ? Math.min(elapsedSeconds / session.plannedSeconds, 1)
    : 0
  return { fraction, overtime: elapsedSeconds > session.plannedSeconds }
}

/**
 * 秒数 → "分:秒"（工单① 2026-09-14 自 session-clock 提取为公共导出）。
 *
 * 运行态数字与准备态预览共用同一实现，避免两份格式化漂移：
 * - padStart(2) 是**保底两位**不是封顶 —— 90 分钟 → "90:00"、
 *   120 分钟 → "120:00"；时长预设本就含 90/120，截断会显示错数。
 * - 原始实现逐字保留（含负值/非整数的既有行为）：调用方
 *   （deriveSessionClock / plannedSeconds）保证传入非负整数。
 */
export function formatClockSeconds(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
