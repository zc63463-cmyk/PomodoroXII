'use client'

import { createElement, type ReactNode } from 'react'

/**
 * 环几何（工单① 2026-09-14 自 session-clock 提取）：viewBox 200×200、半径 88
 * —— 给 stroke 宽度与光晕留出余量。周长由半径算出，不在 CSS 里重复。
 */
const RING_RADIUS = 88
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

interface TimerRingProps {
  /** 0..1 的进度。越界由本组件 clamp 饱和（超时后弧长不再增长）。 */
  fraction: number
  /** 越过计划点：只换色（弧长应由调用方封顶在 1）。 */
  overtime: boolean
  /** 运行态呼吸光晕开关（准备态静止传 false）。 */
  live: boolean
  /** svg 尺寸类覆盖：默认运行态 h-56 w-56；准备态预览传 h-40 w-40。 */
  svgClassName?: string
  /** 数字槽：渲染在环中心（绝对定位等样式由调用方决定）。 */
  children?: ReactNode
}

/**
 * TimerRing（工单① 2026-09-14）：钟面环的展示组件 —— 只把 fraction 画成弧长。
 *
 * ★ 提取动机：准备态要复用"静止环"预览（规格 L448-452）。语义与展示分离：
 *   数字才是语义源，环恒 aria-hidden —— 读屏重复朗读没有信息增量。
 *   运行态的记账逻辑（deriveRingProgress、粒子闩锁、数字分钟键重挂载）
 *   全部留在 SessionClock；本组件无状态、无副作用，输出对入参纯函数化。
 *
 * ★ 兼容面逐字保留（session-clock.test.tsx 是重构硬闸）：
 *   - data-testid="timer-ring" 挂在 div 上、progress 圈 "timer-ring-progress"；
 *   - viewBox 200×200、r=88、strokeDasharray=2π·88、strokeWidth=8；
 *   - timer-ring--overtime / timer-ring-live 两个类名开关；
 *   - 默认尺寸 h-56 w-56（运行态原值）。
 */
export function TimerRing({ fraction, overtime, live, svgClassName = 'h-56 w-56', children }: TimerRingProps) {
  const clampedFraction = Math.min(Math.max(fraction, 0), 1)
  const ringClassName = [
    'timer-ring relative grid place-items-center',
    overtime ? 'timer-ring--overtime' : '',
    live ? 'timer-ring-live' : '',
  ].filter(Boolean).join(' ')

  return createElement(
    'div',
    { className: ringClassName, 'data-testid': 'timer-ring' },
    // 环本体 aria-hidden：语义源是中间的数字（session-clock 的 output 不变），
    // 环只是同一事实的视觉重述。
    createElement(
      'svg',
      { viewBox: '0 0 200 200', 'aria-hidden': true, className: `${svgClassName} -rotate-90` },
      createElement('circle', {
        className: 'timer-ring-track',
        cx: 100, cy: 100, r: RING_RADIUS, fill: 'none', strokeWidth: 8,
      }),
      createElement('circle', {
        className: 'timer-ring-progress',
        cx: 100, cy: 100, r: RING_RADIUS, fill: 'none', strokeWidth: 8,
        strokeLinecap: 'round',
        strokeDasharray: RING_CIRCUMFERENCE,
        strokeDashoffset: RING_CIRCUMFERENCE * (1 - clampedFraction),
        'data-testid': 'timer-ring-progress',
      }),
    ),
    children,
  )
}
