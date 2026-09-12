import { beforeEach, describe, expect, it } from 'vitest'

import { useTaskSpaceStore } from './task-space-store'

describe('BlockerAck 一次性放行（内存态）', () => {
  beforeEach(() => {
    useTaskSpaceStore.setState({ pendingLaunchAckId: null })
  })

  it('acknowledges, reports and clears per work item', () => {
    expect(useTaskSpaceStore.getState().hasLaunchAck('l2')).toBe(false)
    useTaskSpaceStore.getState().acknowledgeLaunch('l2')
    expect(useTaskSpaceStore.getState().hasLaunchAck('l2')).toBe(true)
    expect(useTaskSpaceStore.getState().hasLaunchAck('other')).toBe(false)

    // 清除其它项不误伤当前放行。
    useTaskSpaceStore.getState().clearLaunchAck('other')
    expect(useTaskSpaceStore.getState().hasLaunchAck('l2')).toBe(true)

    useTaskSpaceStore.getState().clearLaunchAck('l2')
    expect(useTaskSpaceStore.getState().hasLaunchAck('l2')).toBe(false)
  })

  it('clears unconditionally without an argument', () => {
    useTaskSpaceStore.getState().acknowledgeLaunch('l2')
    useTaskSpaceStore.getState().clearLaunchAck()
    expect(useTaskSpaceStore.getState().pendingLaunchAckId).toBeNull()
  })

  it('reset() drops the ack so a new space never inherits it', () => {
    useTaskSpaceStore.getState().acknowledgeLaunch('l2')
    useTaskSpaceStore.getState().reset()
    expect(useTaskSpaceStore.getState().pendingLaunchAckId).toBeNull()
  })
})
