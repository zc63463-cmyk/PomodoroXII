'use client'

import { createElement, useState } from 'react'
import { Button } from '@/components/ui/button'
import { deriveSessionClock, type ClockFacts } from '@/lib/focus-session/clock'

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
  const endSession = async () => {
    try {
      await onFlushNote?.('session-end')
    } catch {
      setNoteAttention(true)
    }
    await onEnd(new Date().toISOString())
  }

  return createElement(
    'section', { 'aria-label': 'Focus session clock', className: 'grid justify-items-center gap-4' },
    createElement('output', { 'aria-live': 'off', className: 'font-mono text-5xl tabular-nums' },
      `${format(clock.remainingSeconds)}${clock.overtimeSeconds > 0 ? ` +${format(clock.overtimeSeconds)}` : ''}`),
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
