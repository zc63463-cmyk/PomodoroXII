import { afterEach, describe, expect, it } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

import type { PomodoroXIDB } from '@/services/database'
import { INITIAL_S4_OUTBOX_FIELDS } from '@/services/database'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { spaceApi } from '@/services/api'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { withSpaceAuthorityFence } from './space-authority-fence'
import { loadSyncV2Meta, writeSyncV2Meta } from './sync-meta'
import { RealSyncEngine } from './engine'

class FakeLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(_name) ?? Promise.resolve()
    const result = previous.then(callback)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(_name, tail)
    void tail.finally(() => { if (this.tails.get(_name) === tail) this.tails.delete(_name) })
    return result
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const originalAdapter = spaceApi.defaults.adapter

function installLocks(value: FakeLockManager | undefined): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value })
}

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

const catalogHash = 'a'.repeat(64)
const emptyChunkSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const recoveryCursor = 'recovery-cursor-01'
const pullCursor = 'pull-cursor-0001'

function installEmptyV2Adapter(calls: string[], engine?: RealSyncEngine): void {
  spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const url = config.url ?? ''
    calls.push(url)
    if (url.endsWith('/sync/v2/recover')) {
      return ok({
        payload_jsonl_base64: '', entity_count: 0, chunk_sha256: emptyChunkSha256,
        next_page_token: null, has_more: false, catalog_hash: catalogHash,
        waterline_cursor: recoveryCursor,
      }, config)
    }
    if (url.endsWith('/sync/v2/ack')) {
      const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
      return ok({ client_id: body.client_id, accepted: true,
        requires_recovery: false, catalog_hash: catalogHash }, config)
    }
    if (url.endsWith('/sync/v2/pull')) {
      if (engine) engine.destroy()
      return ok({ events: [], next_cursor: pullCursor, has_more: false,
        catalog_hash: catalogHash }, config)
    }
    if (url.endsWith('/sync/v2/operations/query')) {
      return ok({ items: [] }, config)
    }
    if (url.endsWith('/sync/v2/push')) {
      return ok({ batch_id: 'unused-batch-01', applied: [], conflicts: [], errors: [] }, config)
    }
    throw new Error(`unexpected sync URL: ${url}`)
  }
}

describe('RealSyncEngine Sync v2 orchestration', () => {
  let db: PomodoroXIDB | undefined

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
    if (db) await db.delete()
    db = undefined
  })

  it('fails closed without Web Locks and performs no network request', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(undefined)
    const calls: string[] = []
    spaceApi.defaults.adapter = async (config) => { calls.push(config.url ?? ''); return ok({}, config) }
    const engine = new RealSyncEngine(db, db.spaceId)

    await expect(engine.sync()).rejects.toMatchObject({ code: 'space_authority_lock_unavailable' })

    expect(engine.getStatus()).toBe('idle')
    expect(calls).toEqual([])
    engine.destroy()
  })

  it('runs recovery/ACK before pull/ACK on the first sync', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    const calls: string[] = []
    installEmptyV2Adapter(calls)
    const engine = new RealSyncEngine(db, db.spaceId)

    await engine.sync()

    expect(calls).toEqual([
      '/sync/v2/recover', '/sync/v2/ack',
      '/sync/v2/pull', '/sync/v2/ack',
    ])
    expect(engine.getStatus()).toBe('idle')
    expect(engine.getLastSyncedAt()).not.toBeNull()
    engine.destroy()
  })

  it('uses the persisted opaque cursor without recovery on subsequent sync', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: pullCursor, pendingAck: null, catalogHash, requiresFullRecovery: false },
    ))
    const calls: string[] = []
    installEmptyV2Adapter(calls)
    const engine = new RealSyncEngine(db, db.spaceId)

    await engine.sync()

    expect(calls).toEqual(['/sync/v2/pull', '/sync/v2/ack'])
    engine.destroy()
  })

  it('does not invoke completion callbacks after destroy interrupts pull', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: pullCursor, pendingAck: null, catalogHash, requiresFullRecovery: false },
    ))
    const calls: string[] = []
    const engine = new RealSyncEngine(db, db.spaceId)
    let completed = 0
    engine.onSyncComplete(() => { completed += 1 })
    installEmptyV2Adapter(calls, engine)

    await engine.sync()

    expect(calls).toEqual(['/sync/v2/pull', '/sync/v2/ack'])
    expect(completed).toBe(0)
  })

  it('queries a new ready receipt before pushing it and clears the applied row', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    const operationId = 'engine-push-op-01'
    const entityId = 'engine-note-01'
    const payload = { id: entityId }
    await db.outbox.put({
      id: 1, spaceId: db.spaceId, entityType: 'note', entityId,
      action: 'delete', payload: JSON.stringify(payload),
      payloadHash: await hashCommandPayload(payload), operationId,
      compoundOperationId: null, compoundOrder: null, expectedVersion: 1,
      requiresVersionRebase: false, transportState: 'ready',
      createdAt: '2026-07-14T10:00:00.000Z', synced: false,
      lastError: null, lastErrorCode: null, failedAt: null, attemptCount: 0,
      ...INITIAL_S4_OUTBOX_FIELDS,
    })
    const calls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.endsWith('/sync/v2/recover')) {
        return ok({ payload_jsonl_base64: '', entity_count: 0,
          chunk_sha256: emptyChunkSha256, next_page_token: null, has_more: false,
          catalog_hash: catalogHash, waterline_cursor: recoveryCursor }, config)
      }
      if (url.endsWith('/sync/v2/ack')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        return ok({ client_id: body.client_id, accepted: true,
          requires_recovery: false, catalog_hash: catalogHash }, config)
      }
      if (url.endsWith('/sync/v2/pull')) {
        return ok({ events: [], next_cursor: pullCursor, has_more: false,
          catalog_hash: catalogHash }, config)
      }
      if (url.endsWith('/sync/v2/operations/query')) {
        return ok({ items: [{ operation_id: operationId, state: 'unknown',
          batch_id: null, result: null }] }, config)
      }
      if (url.endsWith('/sync/v2/push')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        return ok({ batch_id: body.batch_id, applied: [{ operation_id: operationId,
          entity_type: 'note', entity_id: entityId, version: 2, resolution: null }],
          conflicts: [], errors: [] }, config)
      }
      throw new Error(`unexpected sync URL: ${url}`)
    }
    const engine = new RealSyncEngine(db, db.spaceId)

    await engine.sync()

    expect(calls).toEqual([
      '/sync/v2/recover', '/sync/v2/ack',
      '/sync/v2/pull', '/sync/v2/ack',
      '/sync/v2/operations/query', '/sync/v2/push',
    ])
    expect(await db.outbox.get(1)).toBeUndefined()
    engine.destroy()
  })

  it('markDirty remains synchronous and destroy cancels later work', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    const engine = new RealSyncEngine(db, db.spaceId)
    engine.markDirty('note', 'n1', 'update')
    expect(engine.getPendingCount()).toBe(1)
    engine.destroy()
    engine.markDirty('note', 'n2', 'update')
    expect(engine.getPendingCount()).toBe(0)
  })
})

// ===== S1-FIX: 409 cursor_expired 自愈 + wipe 竞态互斥 =====

function cursorExpiredRejection(config: InternalAxiosRequestConfig): AxiosResponse {
  // 模拟真实 xhr adapter 的 409 拒绝形态（AxiosError 携带 canonical error body）
  const error = new Error('Request failed with status code 409') as Error & {
    response?: { status: number; statusText: string; headers: Record<string, string>; data: unknown; config: InternalAxiosRequestConfig }
  }
  error.response = {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    data: {
      code: 'cursor_expired',
      message: 'Sync cursor expired; perform a full sync',
      retryable: false,
      request_id: 'diag-req-01',
      details: { recovery_action: 'full_recovery' },
    },
    config,
  }
  throw error
}

describe('RealSyncEngine cursor_expired self-heal', () => {
  let db: PomodoroXIDB | undefined

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
    if (db) await db.delete()
    db = undefined
  })

  it('CE1: pull 409 cursor_expired → 持久化 requiresFullRecovery=true，下一周期自动全量恢复收敛', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: pullCursor, pendingAck: null, catalogHash, requiresFullRecovery: false },
    ))
    const calls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.endsWith('/sync/v2/pull') && calls.filter((u) => u.endsWith('/sync/v2/pull')).length === 1) {
        cursorExpiredRejection(config)
      }
      if (url.endsWith('/sync/v2/recover')) {
        return ok({ payload_jsonl_base64: '', entity_count: 0,
          chunk_sha256: emptyChunkSha256, next_page_token: null, has_more: false,
          catalog_hash: catalogHash, waterline_cursor: recoveryCursor }, config)
      }
      if (url.endsWith('/sync/v2/ack')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        return ok({ client_id: body.client_id, accepted: true,
          requires_recovery: false, catalog_hash: catalogHash }, config)
      }
      if (url.endsWith('/sync/v2/pull')) {
        return ok({ events: [], next_cursor: pullCursor, has_more: false,
          catalog_hash: catalogHash }, config)
      }
      if (url.endsWith('/sync/v2/operations/query')) {
        return ok({ items: [] }, config)
      }
      if (url.endsWith('/sync/v2/push')) {
        return ok({ batch_id: 'unused-batch-ce1', applied: [], conflicts: [], errors: [] }, config)
      }
      throw new Error(`unexpected sync URL: ${url}`)
    }
    const engine = new RealSyncEngine(db, db.spaceId)

    // 单次 sync() 内自愈：pull 409 cursor_expired → 标记 → 同周期立即重试
    // （全量恢复 + ACK waterline + 增量 pull）→ 收敛回 idle
    await engine.sync()
    expect(calls).toEqual([
      '/sync/v2/pull', // 首次 pull：409 cursor_expired
      '/sync/v2/recover', '/sync/v2/ack', // 自愈重试：全量恢复 + ACK waterline
      '/sync/v2/pull', '/sync/v2/ack', // 恢复后增量拉取
    ])
    expect(engine.getStatus()).toBe('idle')
    expect(engine.getLastSyncedAt()).not.toBeNull()
    const meta = await withSpaceAuthorityFence(db.spaceId, () =>
      loadSyncV2Meta(db!))
    expect(meta.requiresFullRecovery).toBe(false)
    engine.destroy()
  })

  it('CE2: wipeUninitializedSyncMeta 与同步周期互斥 —— 游标已安装时不清理任何状态', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: pullCursor, pendingAck: null, catalogHash, requiresFullRecovery: false },
    ))
    await db.syncMeta.put({ key: 'sync_v2_client_id', value: 'client-keep-01' })

    const { wipeUninitializedSyncMeta } = await import('./index')
    await wipeUninitializedSyncMeta(db, db.spaceId)

    const clientRow = await db.syncMeta.get('sync_v2_client_id')
    expect(clientRow?.value).toBe('client-keep-01')
    const cursorRow = await db.syncMeta.get('sync_v2_cursor')
    expect(cursorRow?.value).toBe(pullCursor)
  })

  it('CE3: wipeUninitializedSyncMeta 在游标未安装时清理 push/admission 残留', async () => {
    db = await openPomodoroXIDB(`engine-test-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
    await db.syncMeta.put({ key: 'sync_v2_client_id', value: 'client-stale-01' })
    await db.syncPushBatches.put({
      key: 'active', spaceId: db.spaceId, clientId: 'client-stale-01',
      authorityKind: 'standalone_batch', compoundOperationId: null,
      batchId: 'batch-stale-01', operationIds: [], frozenRows: [],
      readyRoots: [], readyRootSetSha256: '0'.repeat(64), events: [],
      idempotencyKey: 'sync-0000',
    } as unknown as import('@/services/database').SyncPendingPushBatch)

    const { wipeUninitializedSyncMeta } = await import('./index')
    await wipeUninitializedSyncMeta(db, db.spaceId)

    expect(await db.syncMeta.count()).toBe(0)
    expect(await db.syncPushBatches.count()).toBe(0)
  })
})
