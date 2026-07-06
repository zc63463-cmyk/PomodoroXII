/**
 * useSync hook tests (F0 §5.4).
 *
 * Verifies the hook returns sync-store state via selector-only subscriptions.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSync } from '@/hooks/use-sync'
import { useSyncStore } from '@/stores/sync-store'

describe('useSync', () => {
  beforeEach(() => {
    useSyncStore.getState().reset()
  })

  it('returns idle status initially', () => {
    const { result } = renderHook(() => useSync())
    expect(result.current.status).toBe('idle')
    expect(result.current.lastSyncedAt).toBeNull()
    expect(result.current.pendingCount).toBe(0)
  })

  it('reflects sync-store state changes', () => {
    useSyncStore.setState({ status: 'syncing', pendingCount: 3 })
    const { result } = renderHook(() => useSync())
    expect(result.current.status).toBe('syncing')
    expect(result.current.pendingCount).toBe(3)
  })

  it('reflects lastSyncedAt after sync', () => {
    useSyncStore.setState({ lastSyncedAt: '2026-07-06T12:00:00Z' })
    const { result } = renderHook(() => useSync())
    expect(result.current.lastSyncedAt).toBe('2026-07-06T12:00:00Z')
  })
})
