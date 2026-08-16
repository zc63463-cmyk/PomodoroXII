'use client'

import { createElement, useState } from 'react'
import { deriveSessionClock, type ClockFacts } from '@/lib/focus-session/clock'

interface SessionClockProps {
  session: ClockFacts
  nowMs: number
  owner: boolean
  onPause?: (occurredAt: string) => Promise<void> | void
  onResume?: (occurredAt: string) => Promise<void> | void
  onEnd: (occurredAt: string) => Promise<void> | void
  onFlushNote?: (reason: 'session-end') => Promise<void> | void
}

const format = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

export function SessionClock({ session, nowMs, owner, onPause, onResume, onEnd, onFlushNote }: SessionClockProps) {
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
        ? createElement('button', { type: 'button', onClick: () => void onPause?.(new Date().toISOString()), disabled: !owner }, 'Pause')
        : session.clockState === 'paused'
          ? createElement('button', { type: 'button', onClick: () => void onResume?.(new Date().toISOString()), disabled: !owner }, 'Resume')
          : null,
      session.clockState !== 'ended'
        ? createElement('button', { type: 'button', onClick: () => void endSession(), disabled: !owner }, 'End session')
        : null,
    ),
    !owner ? createElement('p', { role: 'status' }, 'Read-only in this Tab') : null,
    noteAttention ? createElement('p', { role: 'status' }, 'Session ended; note needs attention') : null,
  )
}
