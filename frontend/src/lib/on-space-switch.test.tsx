/**
 * SpaceSwitchProvider tests (F0 §6.3).
 *
 * Verifies the pxii:space-switched event handler executes the hard order:
 * ② syncEngine.destroy → ③ queryClient.clear → ④ STORE_RESET_FNS.forEach
 *
 * Uses React.createElement instead of JSX because vitest config lacks
 * a React JSX transform plugin (tsconfig jsx: preserve).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render } from '@testing-library/react'
import { SpaceSwitchProvider } from '@/lib/on-space-switch'
import { PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'

// Mock syncEngine
vi.mock('@/lib/sync/types', () => ({
  syncEngineStub: {
    destroy: vi.fn(),
  },
}))

// Mock queryClient
vi.mock('@/lib/query-client', () => ({
  queryClient: {
    clear: vi.fn(),
  },
}))

// Import after mocks
import { syncEngineStub } from '@/lib/sync/types'
import { queryClient } from '@/lib/query-client'
import { useSyncStore } from '@/stores/sync-store'
import { useTimerStore } from '@/stores/timer-store'
import { useAppStore } from '@/stores/app-store'
import { useAuthStore } from '@/stores/auth-store'
import { useSpaceStore } from '@/stores/space-store'

describe('SpaceSwitchProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSyncStore.getState().reset()
    useTimerStore.getState().reset()
    useAppStore.getState().reset()
    useAuthStore.getState().reset()
    useSpaceStore.getState().reset()
  })

  it('dispatching pxii:space-switched calls syncEngine.destroy', () => {
    render(createElement(SpaceSwitchProvider, null, 'test'))
    window.dispatchEvent(new CustomEvent(PXII_SPACE_SWITCHED_EVENT))
    expect(syncEngineStub.destroy).toHaveBeenCalledTimes(1)
  })

  it('dispatching pxii:space-switched calls queryClient.clear', () => {
    render(createElement(SpaceSwitchProvider, null, 'test'))
    window.dispatchEvent(new CustomEvent(PXII_SPACE_SWITCHED_EVENT))
    expect(queryClient.clear).toHaveBeenCalledTimes(1)
  })

  it('dispatching pxii:space-switched resets all 17 business stores', () => {
    // Mutate stores to non-default state
    useSyncStore.setState({ status: 'error', pendingCount: 99 })
    useTimerStore.setState({ mode: 'countdown', status: 'running' })
    useAppStore.setState({ isOnline: false })

    render(createElement(SpaceSwitchProvider, null, 'test'))
    window.dispatchEvent(new CustomEvent(PXII_SPACE_SWITCHED_EVENT))

    // Verify stores were reset
    expect(useSyncStore.getState().status).toBe('idle')
    expect(useSyncStore.getState().pendingCount).toBe(0)
    expect(useTimerStore.getState().mode).toBe('pomodoro')
    expect(useTimerStore.getState().status).toBe('idle')
    expect(useAppStore.getState().isOnline).toBe(true)
  })

  it('does not reset auth-store or space-store on space switch', () => {
    useAuthStore.setState({ masterToken: 'test-token' })
    useSpaceStore.setState({ currentSpaceId: 'space-1' })

    render(createElement(SpaceSwitchProvider, null, 'test'))
    window.dispatchEvent(new CustomEvent(PXII_SPACE_SWITCHED_EVENT))

    expect(useAuthStore.getState().masterToken).toBe('test-token')
    expect(useSpaceStore.getState().currentSpaceId).toBe('space-1')
  })
})
