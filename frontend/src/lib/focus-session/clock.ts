export interface ClockFacts {
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
