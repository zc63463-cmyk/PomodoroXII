'use client'

import { createElement, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import { deriveRingProgress, deriveSessionClock, type ClockFacts } from '@/lib/focus-session/clock'

interface SessionClockProps {
  session: ClockFacts
  nowMs: number
  owner: boolean
  /** 只读原因（上层给出：另一个标签页 / 另一台设备）。 */
  ownerHint?: string
  onPause?: (occurredAt: string) => Promise<void> | void
  onResume?: (occurredAt: string) => Promise<void> | void
  onEnd: (occurredAt: string) => Promise<void> | void
  onFlushNote?: (reason: 'session-end') => Promise<void> | void
  /**
   * 只读时把会话接管到本标签页。协议与后端端点早已就绪
   * （active-session-coordinator.takeover → POST /active-session/takeover），
   * 此前唯独没有入口 —— 上一个标签页关掉后，会话就永久只读、既不能继续
   * 也不能结束，这是实测卡死的原因。
   */
  onTakeover?: () => Promise<void> | void
}

const format = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

/**
 * 环几何（工单 B 2026-09-14）：viewBox 200×200、半径 88 —— 给 stroke 宽度
 * 与光晕留出余量。周长由半径算出，不在 CSS 里重复。
 */
const RING_RADIUS = 88
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * 庆祝粒子：固定 12 向、距离分三档 —— **确定性**优于随机：
 * 可测（每次渲染一致）、肉眼也不会有"某次特别丑"的分布。
 * 位移以 CSS 自定义属性下传，keyframe 只写一份（见 globals.css timer 块）。
 */
const CELEBRATION_PARTICLES = Array.from({ length: 12 }, (_, index) => {
  const angle = (Math.PI * 2 * index) / 12 - Math.PI / 2
  const distance = 76 + (index % 3) * 16
  return {
    tx: `${Math.round(Math.cos(angle) * distance)}px`,
    ty: `${Math.round(Math.sin(angle) * distance)}px`,
  }
})

/** 粒子驻留时长（毫秒）：与 globals.css 的 timer-particle-burst 时长同源约定。 */
const CELEBRATION_MS = 1600

/**
 * prefers-reduced-motion 检测（JS 侧，仅粒子用）。
 *
 * 粒子选择**不渲染**而不是"渲染后靠 CSS 关动画"：纯 CSS 的
 * `animation: none` 会让粒子静止残留（全部位移塌在圆心附近），比不做更糟。
 * 环境不支持 matchMedia（jsdom/老浏览器）按"允许动画"处理 —— 不能因为
 * 探测能力缺失就永远不庆祝。
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function SessionClock({
  session,
  nowMs,
  owner,
  ownerHint,
  onPause,
  onResume,
  onEnd,
  onFlushNote,
  onTakeover,
}: SessionClockProps) {
  const [noteAttention, setNoteAttention] = useState(false)
  const clock = deriveSessionClock(session, nowMs)
  const ring = deriveRingProgress(session, nowMs)
  // 数字翻转：以"显示的分钟"为重挂载键 —— 每秒重挂会让 pop 动画变成持续抖动，
  // 分钟粒度才是"时间在走"的节拍。
  const minutes = Math.floor(clock.remainingSeconds / 60)

  // ── 越过计划点的一次性庆祝粒子（工单 B） ────────────────────────────────
  // ★ 闩锁独立于 end-alert（那是通知/声音语义）：视觉与提醒互不引用，
  //   二者各自记账 —— end-alert 改了不会连带改这里的行为，反之亦然。
  const lastRemainingBySession = useRef(new Map<string, number>())
  const celebratedSessions = useRef(new Set<string>())
  const [celebration, setCelebration] = useState<string | null>(null)

  useEffect(() => {
    const sessionId = session.sessionId
    if (!sessionId || session.plannedSeconds <= 0) return
    const previous = lastRemainingBySession.current.get(sessionId)
    lastRemainingBySession.current.set(sessionId, clock.remainingSeconds)
    // "越过" = 本组件**观测到的转移**：先前看到剩余 > 0，现在剩 0 且仍运行中。
    // 中途才打开页面（首见即已超时）不算越过 —— 迟到半小时的庆祝是误报。
    if (previous === undefined || previous <= 0) return
    if (clock.remainingSeconds !== 0 || session.clockState !== 'running') return
    if (celebratedSessions.current.has(sessionId)) return
    // 闩锁记在"尝试"上（与 end-alert 同款语义）：超时期间每 tick 都满足条件，
    // 只在成功路径上记会导致 reduce 用户每次开页面都重新判断。
    celebratedSessions.current.add(sessionId)
    if (prefersReducedMotion()) return
    setCelebration(sessionId)
  }, [clock.remainingSeconds, session])

  // 定时移除：粒子按 CSS keyframe 播完即隐，但节点不该永久留在 DOM 里
  //（也保证"只庆祝一次"的断言有可观察的结束态）。
  useEffect(() => {
    if (celebration === null) return
    const timer = setTimeout(() => setCelebration(null), CELEBRATION_MS)
    return () => clearTimeout(timer)
  }, [celebration])

  const endSession = async () => {
    try {
      await onFlushNote?.('session-end')
    } catch {
      setNoteAttention(true)
    }
    await onEnd(new Date().toISOString())
  }

  const ringClassName = [
    'timer-ring relative grid place-items-center',
    ring.overtime ? 'timer-ring--overtime' : '',
    session.clockState === 'running' ? 'timer-ring-live' : '',
  ].filter(Boolean).join(' ')

  return createElement(
    'section', { 'aria-label': 'Focus session clock', className: 'grid justify-items-center gap-4' },
    createElement('div', { className: ringClassName, 'data-testid': 'timer-ring' },
      // 环本体 aria-hidden：语义源是中间的数字（aria-live="off" 的 output 不变），
      // 环只是同一事实的视觉重述，读屏重复朗读没有信息增量。
      createElement('svg', { viewBox: '0 0 200 200', 'aria-hidden': true, className: 'h-56 w-56 -rotate-90' },
        createElement('circle', {
          className: 'timer-ring-track',
          cx: 100, cy: 100, r: RING_RADIUS, fill: 'none', strokeWidth: 8,
        }),
        createElement('circle', {
          className: 'timer-ring-progress',
          cx: 100, cy: 100, r: RING_RADIUS, fill: 'none', strokeWidth: 8,
          strokeLinecap: 'round',
          strokeDasharray: RING_CIRCUMFERENCE,
          strokeDashoffset: RING_CIRCUMFERENCE * (1 - ring.fraction),
          'data-testid': 'timer-ring-progress',
        }),
      ),
      celebration === null
        ? null
        : createElement('div', {
            className: 'timer-celebration', 'data-testid': 'timer-celebration', 'aria-hidden': true,
          }, CELEBRATION_PARTICLES.map((particle, index) => createElement('span', {
            key: index,
            className: 'timer-celebration-particle',
            style: {
              '--timer-particle-tx': particle.tx,
              '--timer-particle-ty': particle.ty,
            } as CSSProperties,
          }))),
      createElement('output', {
        key: `minute-${minutes}`,
        'aria-live': 'off',
        'data-testid': 'timer-digits',
        className: 'timer-digits absolute inset-0 grid place-items-center font-mono text-5xl tabular-nums',
      }, `${format(clock.remainingSeconds)}${clock.overtimeSeconds > 0 ? ` +${format(clock.overtimeSeconds)}` : ''}`),
    ),
    createElement('div', { className: 'flex gap-2' },
      session.clockState === 'running'
        ? createElement(Button, {
            type: 'button', variant: 'outline', size: 'sm',
            onClick: () => void onPause?.(new Date().toISOString()), disabled: !owner,
          }, 'Pause')
        : session.clockState === 'paused'
          ? createElement(Button, {
              type: 'button', size: 'sm',
              onClick: () => void onResume?.(new Date().toISOString()), disabled: !owner,
            }, 'Resume')
          : null,
      session.clockState !== 'ended'
        ? createElement(Button, {
            type: 'button', variant: 'outline', size: 'sm',
            onClick: () => void endSession(), disabled: !owner,
          }, 'End session')
        : null,
    ),
    !owner
      ? createElement(
          'div',
          { className: 'grid justify-items-center gap-2 text-center' },
          createElement('p', { role: 'status' }, 'Read-only in this Tab'),
          ownerHint
            ? createElement('p', { className: 'max-w-sm text-xs text-muted-foreground' }, ownerHint)
            : null,
          onTakeover
            ? createElement(Button, {
                type: 'button', size: 'sm',
                ...({ 'data-takeover-session': true } as unknown as Record<string, never>),
                onClick: () => void onTakeover(),
              }, '在本标签页接管')
            : null,
        )
      : null,
    noteAttention ? createElement('p', { role: 'status' }, 'Session ended; note needs attention') : null,
  )
}
