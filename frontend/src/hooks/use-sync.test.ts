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

  it('returns error and conflicts from store', () => {
    useSyncStore.setState({
      error: '同步出错',
      conflicts: [{ outboxId: 1, entityType: 'task', entityId: 't1', localVersion: {}, remoteVersion: {}, conflictType: 'version' }],
    })
    const { result } = renderHook(() => useSync())
    expect(result.current.error).toBe('同步出错')
    expect(result.current.conflicts).toHaveLength(1)
  })

  it('returns sync and resolveConflict actions', () => {
    const { result } = renderHook(() => useSync())
    expect(typeof result.current.sync).toBe('function')
    expect(typeof result.current.resolveConflict).toBe('function')
  })
})
