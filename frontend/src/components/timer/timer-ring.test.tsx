import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TimerRing } from './timer-ring'

/**
 * TimerRing（工单① 2026-09-14）：从 session-clock 提取的展示组件。
 * 这里锁"提取后独立可用"的兼容面（clamp / 类名 / aria / children / 尺寸覆盖）；
 * session-clock.test.tsx 则是"原调用方零破坏"的硬闸，两套互补。
 */
const CIRCUMFERENCE = 2 * Math.PI * 88
const dashoffset = () => Number(screen.getByTestId('timer-ring-progress').getAttribute('stroke-dashoffset'))

describe('TimerRing（工单① 提取的展示组件）', () => {
  it('dashoffset = C×(1−fraction) 且越界 clamp：0 / 半程 / 满程 / >1 / <0', () => {
    const { rerender } = render(createElement(TimerRing, { fraction: 0, overtime: false, live: false }))
    expect(dashoffset()).toBeCloseTo(CIRCUMFERENCE, 5)

    rerender(createElement(TimerRing, { fraction: 0.5, overtime: false, live: false }))
    expect(dashoffset()).toBeCloseTo(CIRCUMFERENCE / 2, 5)

    rerender(createElement(TimerRing, { fraction: 1, overtime: false, live: false }))
    expect(dashoffset()).toBeCloseTo(0, 5)

    // 越界饱和：>1 不画出第二圈、<0 不回卷成反向弧
    rerender(createElement(TimerRing, { fraction: 1.4, overtime: true, live: false }))
    expect(dashoffset()).toBeCloseTo(0, 5)

    rerender(createElement(TimerRing, { fraction: -0.3, overtime: false, live: false }))
    expect(dashoffset()).toBeCloseTo(CIRCUMFERENCE, 5)
  })

  it('overtime / live 类名开关（准备态两者皆为 false）', () => {
    const { rerender } = render(createElement(TimerRing, { fraction: 0, overtime: true, live: true }))
    expect(screen.getByTestId('timer-ring')).toHaveClass('timer-ring--overtime')
    expect(screen.getByTestId('timer-ring')).toHaveClass('timer-ring-live')

    rerender(createElement(TimerRing, { fraction: 0, overtime: false, live: false }))
    expect(screen.getByTestId('timer-ring')).not.toHaveClass('timer-ring--overtime')
    expect(screen.getByTestId('timer-ring')).not.toHaveClass('timer-ring-live')
  })

  it('svg aria-hidden、几何逐字（viewBox / r=88 / dasharray）且 children 渲染在环内', () => {
    render(createElement(TimerRing, { fraction: 0.25, overtime: false, live: false },
      createElement('div', { 'data-testid': 'slot' }, '25:00')))

    const ring = screen.getByTestId('timer-ring')
    const svg = ring.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 200 200')

    const progress = screen.getByTestId('timer-ring-progress')
    expect(progress.getAttribute('r')).toBe('88')
    expect(Number(progress.getAttribute('stroke-dasharray'))).toBeCloseTo(CIRCUMFERENCE, 5)

    expect(screen.getByTestId('slot')).toHaveTextContent('25:00')
    expect(ring.contains(screen.getByTestId('slot'))).toBe(true)
  })

  it('svgClassName 覆盖默认尺寸（默认运行态 h-56 w-56；准备态传 h-40 w-40）', () => {
    const { rerender } = render(createElement(TimerRing, { fraction: 0, overtime: false, live: false }))
    const svgClass = () => screen.getByTestId('timer-ring').querySelector('svg')?.getAttribute('class') ?? ''
    expect(svgClass()).toContain('h-56 w-56')
    expect(svgClass()).toContain('-rotate-90')

    rerender(createElement(TimerRing, {
      fraction: 0, overtime: false, live: false, svgClassName: 'h-40 w-40',
    }))
    expect(svgClass()).toContain('h-40 w-40')
    expect(svgClass()).not.toContain('h-56')
  })
})
