/**
 * performLogout tests (F0 §5.7).
 *
 * Verifies the full logout lifecycle:
 * destroy → clear → 17 store reset → auth/space/bootstrap reset
 * → close → metaDB.clearSpaces → clearAll → redirect
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

// Mock spaceDBManager
vi.mock('@/services/space-db', () => ({
  spaceDBManager: {
    close: vi.fn(),
  },
}))

// Mock metaDB
vi.mock('@/services/meta-database', () => ({
  metaDB: {
    clearSpaces: vi.fn().mockResolvedValue(undefined),
  },
}))

// Mock tokenStorage
vi.mock('@/lib/token-storage', () => ({
  tokenStorage: {
    clearAll: vi.fn(),
  },
}))

// Import after mocks
import { performLogout } from '@/lib/logout'
import { syncEngineStub } from '@/lib/sync/types'
import { queryClient } from '@/lib/query-client'
import { spaceDBManager } from '@/services/space-db'
import { metaDB } from '@/services/meta-database'
import { tokenStorage } from '@/lib/token-storage'
import { useAuthStore } from '@/stores/auth-store'
import { useSpaceStore } from '@/stores/space-store'
import { useBootstrapStore } from '@/lib/bootstrap-store'
import { useSyncStore } from '@/stores/sync-store'
import { useTimerStore } from '@/stores/timer-store'
import { useAppStore } from '@/stores/app-store'

describe('performLogout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mutate stores to non-default state to verify reset
    useSyncStore.setState({ status: 'error', pendingCount: 99 })
    useTimerStore.setState({ mode: 'countdown', status: 'running' })
    useAppStore.setState({ isOnline: false })
    useAuthStore.setState({ masterToken: 'test-token' })
    useSpaceStore.setState({ currentSpaceId: 'space-1' })
    useBootstrapStore.setState({ phase: 'ready' })

    // Mock window.location.href setter
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
    })
  })

  it('calls syncEngine.destroy', async () => {
    await performLogout()
    expect(syncEngineStub.destroy).toHaveBeenCalledTimes(1)
  })

  it('calls queryClient.clear', async () => {
    await performLogout()
    expect(queryClient.clear).toHaveBeenCalledTimes(1)
  })

  it('resets all 17 business stores', async () => {
    await performLogout()
    // Verify a sample of business stores were reset
    expect(useSyncStore.getState().status).toBe('idle')
    expect(useSyncStore.getState().pendingCount).toBe(0)
    expect(useTimerStore.getState().mode).toBe('pomodoro')
    expect(useTimerStore.getState().status).toBe('idle')
    expect(useAppStore.getState().isOnline).toBe(true)
  })

  it('resets auth-store, space-store, and bootstrap-store', async () => {
    await performLogout()
    expect(useAuthStore.getState().masterToken).toBeNull()
    expect(useSpaceStore.getState().currentSpaceId).toBeNull()
    expect(useBootstrapStore.getState().phase).toBe('pending')
  })

  it('calls spaceDBManager.close and metaDB.clearSpaces', async () => {
    await performLogout()
    expect(spaceDBManager.close).toHaveBeenCalledTimes(1)
    expect(metaDB.clearSpaces).toHaveBeenCalledTimes(1)
  })

  it('calls tokenStorage.clearAll', async () => {
    await performLogout()
    expect(tokenStorage.clearAll).toHaveBeenCalledTimes(1)
  })

  it('redirects to /login', async () => {
    await performLogout()
    expect(window.location.href).toBe('/login')
  })
})
