import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockEngineInstances: Array<{
  destroy: ReturnType<typeof vi.fn>
  sync: ReturnType<typeof vi.fn>
  onPullComplete: ReturnType<typeof vi.fn>
  onPushComplete: ReturnType<typeof vi.fn>
  onConflict: ReturnType<typeof vi.fn>
  onSyncComplete: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  getLastSyncedAt: ReturnType<typeof vi.fn>
  getPendingCount: ReturnType<typeof vi.fn>
  getConflicts: ReturnType<typeof vi.fn>
}> = []

vi.mock('./engine', () => ({
  // ★必须用 function（非箭头）才能被 `new` 调用（Vitest v4 要求）
  RealSyncEngine: vi.fn().mockImplementation(function () {
    const instance = {
      destroy: vi.fn(),
      sync: vi.fn().mockResolvedValue(undefined),
      onPullComplete: vi.fn().mockReturnValue(() => {}),
      onPushComplete: vi.fn().mockReturnValue(() => {}),
      onConflict: vi.fn().mockReturnValue(() => {}),
      onSyncComplete: vi.fn().mockReturnValue(() => {}),
      getStatus: vi.fn().mockReturnValue('idle'),
      getLastSyncedAt: vi.fn().mockReturnValue(null),
      getPendingCount: vi.fn().mockReturnValue(0),
      getConflicts: vi.fn().mockReturnValue([]),
    }
    mockEngineInstances.push(instance)
    return instance
  }),
}))

vi.mock('@/services/space-db', () => ({
  spaceDBManager: { hasSpace: true, current: { name: 'mock-db' } },
}))

// ★关键：mock useSyncStore 暴露 setState 静态方法（D2）
const mockSetState = vi.fn()
vi.mock('@/stores/sync-store', () => ({
  useSyncStore: { setState: mockSetState, getState: () => ({}) },
}))

vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn(), clear: vi.fn() },
}))

describe('lib/sync/index', () => {
  beforeEach(() => {
    vi.resetModules()
    mockEngineInstances.length = 0
    vi.clearAllMocks()
  })

  it('IX1: bootstrapSyncEngine 创建 RealSyncEngine 并替换单例', async () => {
    const mod = await import('./index')
    const { RealSyncEngine } = await import('./engine')

    mod.bootstrapSyncEngine('space-1')

    expect(RealSyncEngine).toHaveBeenCalledWith(expect.anything(), 'space-1')
    // ★用 namespace 访问 live binding（解构会在赋值前捕获旧值）
    expect(mod.syncEngine).toBe(mockEngineInstances[0])
  })

  it('IX2: wire 后 onPullComplete 回调 → invalidate query only (S1-4.1 §6.4)', async () => {
    const mod = await import('./index')
    const { queryClient } = await import('@/lib/query-client')

    mod.bootstrapSyncEngine('space-1')
    const engine = mockEngineInstances[0]!
    mockSetState.mockClear()

    const pullCb = engine.onPullComplete.mock.calls[0]![0] as () => void
    pullCb()

    // S1-4.1：onPullComplete wire 仅 invalidate；终态由 onSyncComplete 写
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['pxii', 'space-1'],
    })
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('IX3: re-bootstrap 替换为新实例并 destroy 旧实例', async () => {
    const mod = await import('./index')

    mod.bootstrapSyncEngine('space-1')
    const first = mockEngineInstances[0]!

    mod.bootstrapSyncEngine('space-2')
    const second = mockEngineInstances[1]!

    // 第二次 bootstrap 内部 destroy 了第一个实例
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(second).not.toBe(first)
    expect(mod.syncEngine).toBe(second)
  })

  it('IX4: wire onSyncComplete → setState idle + lastSyncedAt', async () => {
    const mod = await import('./index')

    mod.bootstrapSyncEngine('space-1')
    const engine = mockEngineInstances[0]!
    mockSetState.mockClear()

    engine.getStatus.mockReturnValue('idle')
    engine.getLastSyncedAt.mockReturnValue('2026-07-07T08:30:00Z')
    engine.getPendingCount.mockReturnValue(0)
    engine.getConflicts.mockReturnValue([])

    const syncCompleteCb = engine.onSyncComplete.mock.calls[0]![0] as () => void
    syncCompleteCb()

    expect(mockSetState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'idle',
        lastSyncedAt: '2026-07-07T08:30:00Z',
        pendingCount: 0,
        conflicts: [],
        error: null,
      }),
    )
  })

  it('IX5: wire onSyncComplete infra-error → error 文案', async () => {
    const mod = await import('./index')

    mod.bootstrapSyncEngine('space-1')
    const engine = mockEngineInstances[0]!
    mockSetState.mockClear()

    engine.getStatus.mockReturnValue('infra-error')
    engine.getLastSyncedAt.mockReturnValue(null)
    engine.getPendingCount.mockReturnValue(0)
    engine.getConflicts.mockReturnValue([])

    const syncCompleteCb = engine.onSyncComplete.mock.calls[0]![0] as () => void
    syncCompleteCb()

    expect(mockSetState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'infra-error',
        error: '网络异常，同步暂停',
      }),
    )
  })
})
