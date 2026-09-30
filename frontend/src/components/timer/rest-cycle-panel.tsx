'use client'

import { createElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  isBreakMode,
  modeLabel,
  type RestCycleStep,
  type SessionMode,
} from '@/lib/focus-session/session-mode'

interface RestCyclePanelProps {
  /** 刚结束的那一轮模式。 */
  endedMode: SessionMode
  /** 刚结束那一轮的净专注秒数（投入型）。 */
  focusedSeconds: number
  /** 刚结束那一轮的休息秒数（休息型）。 */
  breakSeconds: number
  /** 节奏判定结果（纯函数给出，页面只渲染）。 */
  cycle: RestCycleStep
  /** 自动开始被前置判定挡下时的可见原因（被阻塞 / 离线 / 已有活动会话）。 */
  blockedReason?: string | null
  starting?: boolean
  /**
   * 发起下一步。只传模式 —— 时长由页面按**该模式的设置值**推导（备选模式
   * 的时长因此不会错用建议模式的数字）。
   */
  onStart: (mode: SessionMode) => void | Promise<void>
  onReturnToTasks?: () => void
}

const minutes = (seconds: number) => Math.max(0, Math.round(seconds / 60))

/**
 * 休息节奏面板（双体系兼容 2026-09-16）。
 *
 * 出现在「会话已结束、且不需要复盘」的位置：
 * - 投入型走完复盘后（reviewState completed/skipped）→ 建议短休/长休；
 * - 休息型结束（免复盘）→ 建议下一个番茄。
 *
 * ★ 只呈现与发起，不自行决定节奏 —— 建议模式/时长/是否自动开始全部来自
 *   `planRestCycle` 纯函数；本组件不读设置、不写会话。
 * ★ 「绝不静默」：被依赖阻塞或离线导致自动开始失败时，原因必须可见。
 */
export function RestCyclePanel({
  endedMode,
  focusedSeconds,
  breakSeconds,
  cycle,
  blockedReason,
  starting = false,
  onStart,
  onReturnToTasks,
}: RestCyclePanelProps) {
  const endedIsBreak = isBreakMode(endedMode)
  const summary = endedIsBreak
    ? `上一轮：${modeLabel(endedMode)} · 休息 ${minutes(breakSeconds)} 分钟`
    : `上一轮：${modeLabel(endedMode)} · 净专注 ${minutes(focusedSeconds)} 分钟`
  const alternative: SessionMode | null = cycle.nextMode === 'short_break'
    ? 'long_break'
    : cycle.nextMode === 'long_break'
      ? 'short_break'
      : null

  return createElement(
    'section',
    {
      className: 'grid gap-4 rounded-lg border p-4',
      'aria-label': 'rest-cycle',
      'data-testid': 'rest-cycle-panel',
    },
    createElement('p', { className: 'text-sm text-muted-foreground' }, summary),
    createElement('h2', { className: 'text-lg font-semibold' },
      endedIsBreak
        ? `休息结束 —— 开始下一个${modeLabel('work')}（${cycle.plannedMinutes} 分钟）`
        : `下一步：${modeLabel(cycle.nextMode)} ${cycle.plannedMinutes} 分钟`),
    blockedReason
      ? createElement('p', { role: 'alert', className: 'text-sm text-destructive' }, blockedReason)
      : null,
    createElement('div', { className: 'flex flex-wrap gap-2' },
      createElement(Button, {
        type: 'button',
        disabled: starting,
        // 仓库既有写法：Button 的 props 类型不接受任意 data-*，统一用这个 cast
        // （见 active-child-conflict-dialog.tsx / session-clock.tsx）。
        ...({ 'data-testid': 'rest-cycle-start' } as unknown as Record<string, never>),
        onClick: () => void onStart(cycle.nextMode),
      }, `开始${modeLabel(cycle.nextMode)} ${cycle.plannedMinutes} 分钟`),
      alternative
        ? createElement(Button, {
            type: 'button',
            variant: 'outline',
            disabled: starting,
            ...({ 'data-testid': `rest-cycle-alt-${alternative}` } as unknown as Record<string, never>),
            onClick: () => void onStart(alternative),
          }, `改为${modeLabel(alternative)}`)
        : null,
      onReturnToTasks
        ? createElement(Button, {
            type: 'button',
            variant: 'ghost',
            onClick: () => onReturnToTasks(),
          }, '回任务页')
        : null,
    ),
  )
}
