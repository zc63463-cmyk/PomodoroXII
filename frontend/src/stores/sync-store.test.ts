/**
 * sync-store tests (S1-4).
 *
 * Verifies triggerSync/resolveConflict delegate to syncEngine and
 * map engine status to store error messages (DR-8).
 *
 * Note: vi.hoisted is required because vi.mock factories are hoisted
 * above const declarations (temporal dead zone).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockSyncEngine = vi.hoisted(() => ({
  sync: vi.fn(),
  resolveConflict: vi.fn(),
  getStatus: vi.fn().mockReturnValue('idle'),
  getLastSyncedAt: vi.fn().mockReturnValue(null),
  getPendingCount: vi.fn().mockReturnValue(0),
  getConflicts: vi.fn().mockReturnValue([]),
}))

vi.mock('@/lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync')>()
  return {
    ...actual,
    syncEngine: mockSyncEngine,
  }
})

import { useSyncStore } from '@/stores/sync-store'

describe('sync-store', () => {
  beforeEach(() => {
    useSyncStore.getState().reset()
    vi.clearAllMocks()
    mockSyncEngine.getStatus.mockReturnValue('idle')
    mockSyncEngine.getLastSyncedAt.mockReturnValue(null)
    mockSyncEngine.getPendingCount.mockReturnValue(0)
    mockSyncEngine.getConflicts.mockReturnValue([])
  })

  it('SS1: triggerSync 调 syncEngine.sync 并更新 status/lastSyncedAt/pendingCount', async () => {
    mockSyncEngine.getStatus.mockReturnValue('idle')
    mockSyncEngine.getLastSyncedAt.mockReturnValue('2026-07-07T00:00:00Z')
    mockSyncEngine.getPendingCount.mockReturnValue(3)

    await useSyncStore.getState().triggerSync()

    expect(mockSyncEngine.sync).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().status).toBe('idle')
    expect(useSyncStore.getState().lastSyncedAt).toBe('2026-07-07T00:00:00Z')
    expect(useSyncStore.getState().pendingCount).toBe(3)
    expect(useSyncStore.getState().error).toBeNull()
  })

  it('SS2: engine infra-error → store.error="网络异常，同步暂停"', async () => {
    mockSyncEngine.getStatus.mockReturnValue('infra-error')
    await useSyncStore.getState().triggerSync()
    expect(useSyncStore.getState().status).toBe('infra-error')
    expect(useSyncStore.getState().error).toBe('网络异常，同步暂停')
  })

  it('SS3: engine error → store.error="同步出错"', async () => {
    mockSyncEngine.getStatus.mockReturnValue('error')
    await useSyncStore.getState().triggerSync()
    expect(useSyncStore.getState().status).toBe('error')
    expect(useSyncStore.getState().error).toBe('同步出错')
  })

  it('SS4: triggerSync 抛错 → store.status=error + error=message', async () => {
    mockSyncEngine.sync.mockRejectedValueOnce(new Error('network'))
    await useSyncStore.getState().triggerSync()
    expect(useSyncStore.getState().status).toBe('error')
    expect(useSyncStore.getState().error).toBe('network')
  })

  it('SS5: resolveConflict 委托 engine（store 由 wire onSyncComplete 更新）', async () => {
    mockSyncEngine.getConflicts.mockReturnValue([])
    mockSyncEngine.getPendingCount.mockReturnValue(0)
    mockSyncEngine.getStatus.mockReturnValue('idle')

    await useSyncStore.getState().resolveConflict(42, 'accept-remote')

    // S1-4.2：仅断言委托；store 状态更新由 EN27 + wire 覆盖
    expect(mockSyncEngine.resolveConflict).toHaveBeenCalledWith(42, 'accept-remote')
  })

  it('SS7: sync 早退（offline/isSyncing）→ triggerSync 末尾 apply 兜底；store 非 syncing', async () => {
    // mock sync 立即 resolve（模拟早退，不调 onSyncComplete）
    // getStatus 仍 'idle' → 末尾 applyEngineStateToStore 写 idle
    mockSyncEngine.sync.mockResolvedValueOnce(undefined)
    mockSyncEngine.getStatus.mockReturnValue('idle')
    mockSyncEngine.getLastSyncedAt.mockReturnValue(null)
    mockSyncEngine.getPendingCount.mockReturnValue(0)

    await useSyncStore.getState().triggerSync()

    // 关键：triggerSync 先 set 'syncing'，末尾 apply 必须覆盖回 idle
    expect(useSyncStore.getState().status).toBe('idle')
    expect(mockSyncEngine.sync).toHaveBeenCalledTimes(1)
  })
})
