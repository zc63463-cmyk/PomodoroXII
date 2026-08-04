import { beforeEach, describe, expect, it } from 'vitest'
import { selectDerivedClock, useTimerStore } from './timer-store'

describe('timer-store Task 8 local provisional projection', () => {
  beforeEach(() => useTimerStore.getState().reset())

  it('installs local provisional session facts immediately and derives timestamp clock', () => {
    const aggregate = {
      session: {
        sessionId: 'local-session', startedAt: '2026-07-15T08:00:00Z', endedAt: null,
        pauseStartedAt: null, plannedSeconds: 1500, pausedSeconds: 0, focusedSeconds: 0,
        clockState: 'running', version: 0,
      },
    } as never

    useTimerStore.getState().installLocalProvisional({
      spaceId: 'space-a', operationId: 'op-a', ownerDeviceId: 'device-a', ownerTabId: 'tab-a', aggregate,
    })
    useTimerStore.getState().setNow(Date.parse('2026-07-15T08:05:00Z'))

    expect(useTimerStore.getState().localProvisional?.aggregate.session.sessionId).toBe('local-session')
    expect(selectDerivedClock(useTimerStore.getState())?.remainingSeconds).toBe(1200)
    expect(() => useTimerStore.getState().assertCanStart('space-b')).toThrow('active_session_exists')
  })

  it('updates only the local provisional session projection after a repository clock action', () => {
    useTimerStore.getState().installLocalProvisional({
      spaceId: 'space-a', operationId: 'op-a', ownerDeviceId: 'device-a', ownerTabId: 'tab-a',
      aggregate: { session: { sessionId: 'local-session', clockState: 'running' } } as never,
    })

    useTimerStore.getState().updateLocalProvisionalSession({ sessionId: 'local-session', clockState: 'paused' } as never)

    expect(useTimerStore.getState().localProvisional?.aggregate.session.clockState).toBe('paused')
    expect(useTimerStore.getState().ownershipMode).toBe('owner')
  })

  it('retains terminal provisional evidence without blocking a later start', () => {
    useTimerStore.getState().installLocalProvisional({
      spaceId: 'space-a', operationId: 'op-a', ownerDeviceId: 'device-a', ownerTabId: 'tab-a',
      aggregate: { session: { sessionId: 'local-session', clockState: 'ended' } } as never,
    })

    expect(() => useTimerStore.getState().assertCanStart('space-b')).not.toThrow()
    expect(useTimerStore.getState().localProvisional?.aggregate.session.clockState).toBe('ended')
  })
})
