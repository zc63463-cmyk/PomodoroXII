import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { API_V1_PREFIX } from '@/lib/platform'

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
  // 必须用 function（非箭头）才能被 `new` 调用（Vitest v4 要求）
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

// mock useSyncStore 暴露 setState 静态方法（D2）
const mockSetState = vi.fn()
vi.mock('@/stores/sync-store', () => ({
  useSyncStore: { setState: mockSetState, getState: () => ({}) },
}))

const mockRefreshQuickNotesFromRepository = vi.fn().mockResolvedValue(undefined)
vi.mock('@/stores/quick-note-store', () => ({
  useQuickNoteStore: {
    getState: () => ({
      refreshQuickNotesFromRepository: mockRefreshQuickNotesFromRepository,
    }),
  },
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
    // 用 namespace 访问 live binding（解构会在赋值前捕获旧值）
    expect(mod.syncEngine).toBe(mockEngineInstances[0])
  })

  it('IX2: wire 后 onPullComplete 回调 → invalidate query + refresh QuickNote store', async () => {
    const mod = await import('./index')
    const { queryClient } = await import('@/lib/query-client')

    mod.bootstrapSyncEngine('space-1')
    const engine = mockEngineInstances[0]!
    mockSetState.mockClear()

    const pullCb = engine.onPullComplete.mock.calls[0]![0] as () => void
    pullCb()

    // onPullComplete wire 仅 invalidate；终态由 onSyncComplete 写
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['pxii', 'space-1'],
    })
    expect(mockSetState).not.toHaveBeenCalled()
    expect(mockRefreshQuickNotesFromRepository).toHaveBeenCalledTimes(1)
  })

  it('IX2-QN: wire onPushComplete → pending count + refresh QuickNote store', async () => {
    const mod = await import('./index')

    mod.bootstrapSyncEngine('space-1')
    const engine = mockEngineInstances[0]!
    mockSetState.mockClear()
    mockRefreshQuickNotesFromRepository.mockClear()
    engine.getPendingCount.mockReturnValue(3)

    const pushCb = engine.onPushComplete.mock.calls[0]![0] as () => void
    pushCb()

    expect(mockSetState).toHaveBeenCalledWith({ pendingCount: 3 })
    expect(mockRefreshQuickNotesFromRepository).toHaveBeenCalledTimes(1)
  })

  it('IX3: re-bootstrap 替换为新实例并 destroy 旧实例', async () => {
    const mod = await import('./index')

    mod.bootstrapSyncEngine('space-1')
    const first = mockEngineInstances[0]!
    mod.bootstrapSyncEngine('space-2')
    const second = mockEngineInstances[1]!

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
    expect(mockRefreshQuickNotesFromRepository).toHaveBeenCalledTimes(1)
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
    expect(mockRefreshQuickNotesFromRepository).toHaveBeenCalledTimes(1)
  })
})

function productionSyncSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return productionSyncSources(path)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    if (path.endsWith(join('types', 'api-generated.ts'))) return []
    return [path]
  })
}

function adapter(responseData: unknown, capture: InternalAxiosRequestConfig[]) {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    capture.push(config)
    return { data: responseData, status: 200, statusText: 'OK', headers: {}, config }
  }
}

describe('Sync v2 public boundary', () => {
  it('keeps every Sync v2 URL literal in transport.ts', () => {
    const sourceRoot = join(process.cwd(), 'src')
    const offenders = productionSyncSources(sourceRoot).filter((path) =>
      !path.endsWith(join('lib', 'sync', 'transport.ts'))
      && readFileSync(path, 'utf8').includes('/sync/v2/'),
    )
    expect(offenders.map((path) => relative(sourceRoot, path))).toEqual([])
  })

  it('routes all six calls through canonical Accept and strict parsers', async () => {
    const transport = await import('./transport')
    const calls: InternalAxiosRequestConfig[] = []
    const api = axios.create({ baseURL: API_V1_PREFIX })
    const catalogHash = 'a'.repeat(64)
    const cursor = 'opaque-cursor-0001'

    api.defaults.adapter = adapter({ items: [{
      operation_id: 'op-a', state: 'unknown', batch_id: null, result: null,
    }] }, calls)
    await transport.syncV2QueryOperations(api, {
      client_id: 'client-a', operation_ids: ['op-a'],
    })
    api.defaults.adapter = adapter({
      batch_id: 'batch-a', applied: [], conflicts: [], errors: [],
    }, calls)
    await transport.syncV2Push(api, {
      client_id: 'client-a', batch_id: 'batch-a', events: [],
    })
    api.defaults.adapter = adapter({
      events: [], next_cursor: cursor, has_more: false, catalog_hash: catalogHash,
    }, calls)
    await transport.syncV2Pull(api, { client_id: 'client-a', cursor: null })
    api.defaults.adapter = adapter({
      payload_jsonl_base64: '', entity_count: 0, chunk_sha256: '0'.repeat(64),
      next_page_token: null, has_more: false, catalog_hash: catalogHash,
      waterline_cursor: cursor,
    }, calls)
    await transport.syncV2Recover(api, { client_id: 'client-a', page_token: null })
    api.defaults.adapter = adapter({
      client_id: 'client-a', accepted: true, requires_recovery: false,
      catalog_hash: catalogHash,
    }, calls)
    await transport.syncV2Ack(api, { client_id: 'client-a', cursor })
    api.defaults.adapter = adapter({
      catalog_hash: catalogHash, client_id: 'client-a', registered: true,
      requires_recovery: false, recovery_action: null,
      visible_event_count: 0, active_client_count: 1, recovery_client_count: 0,
    }, calls)
    await transport.syncV2Status(api, { client_id: 'client-a' })

    expect(calls.map((call) => api.getUri({ ...call, params: undefined }))).toEqual([
      '/api/v1/sync/v2/operations/query', '/api/v1/sync/v2/push',
      '/api/v1/sync/v2/pull', '/api/v1/sync/v2/recover',
      '/api/v1/sync/v2/ack', '/api/v1/sync/v2/status',
    ])
    for (const call of calls) {
      expect(call.headers.get('Accept')).toBe(transport.SYNC_V2_ERROR_ACCEPT)
    }

    api.defaults.adapter = adapter({
      events: [], next_cursor: cursor, has_more: false,
      catalog_hash: catalogHash, unexpected: true,
    }, [])
    await expect(transport.syncV2Pull(api, {
      client_id: 'client-a', cursor: null,
    })).rejects.toThrow()
  })
})
