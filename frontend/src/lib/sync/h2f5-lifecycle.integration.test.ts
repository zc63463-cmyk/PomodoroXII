import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { PomodoroXIDB } from '@/services/database'
import { spaceApi } from '@/services/api'
import { RealSyncEngine } from './engine'
import { loadSyncMeta, saveSyncMeta } from './sync-meta'
import { SYNC_PULL_KEYS } from './types'

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  if (typeof data === 'object' && data !== null && 'server_time' in data) {
    const page = data as Record<string, unknown>
    page.tombstones ??= []
    for (const key of SYNC_PULL_KEYS) page[key] ??= []
    if ((config.url ?? '').includes('/sync/full')) page.is_full ??= true
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

function registration(config: InternalAxiosRequestConfig) {
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
  return {
    client_id: body.client_id as string,
    display_name: null,
    ack_cursor: 0,
    lease_expires_at: '2026-08-12T00:00:00Z',
    snapshot_required: false,
  }
}

function snapshotPage(
  token: string,
  offset: number,
  cursor: number,
  hasMore: boolean,
  taskId: string,
) {
  return {
    server_time: '2026-07-12T12:00:00.000Z',
    has_more: hasMore,
    tombstones_has_more: false,
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    next_cursor: cursor,
    cursor_version: 2,
    snapshot_token: token,
    snapshot_offset: offset,
    recovery_continuation: hasMore ? `continuation-${offset}` : null,
    recovery_proof: hasMore ? null : `proof-${cursor}`,
    tasks: [{
      id: taskId,
      title: taskId,
      description: '',
      status: 'todo',
      priority: 'medium',
      tags: [],
      plan: '',
      completion: '',
      due_date: null,
      estimated_pomodoros: 1,
      actual_pomodoros: 0,
      archived_at: null,
      created_at: '2026-07-12T12:00:00.000Z',
      updated_at: '2026-07-12T12:00:00.000Z',
      version: 1,
    }],
  }
}

function emptyPush() {
  return { applied: [], conflicts: [], errors: [], server_time: '2026-07-12T12:00:00Z' }
}

function appliedPush(config: InternalAxiosRequestConfig) {
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
  const events = body.events as Array<{
    entity_type: string
    entity_id: string
    action: string
  }>
  return {
    ...emptyPush(),
    applied: events.map((event, index) => ({ ...event, index })),
  }
}

describe('H2-F5 frontend lifecycle integration', () => {
  let db: PomodoroXIDB
  const originalAdapter = spaceApi.defaults.adapter

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    if (db) {
      if (!db.isOpen()) await db.open()
      await db.delete()
    }
  })

  it('real Dexie close/reopen resumes the committed snapshot page before ACK and push', async () => {
    const dbName = `h2f5-reopen-${crypto.randomUUID()}`
    db = new PomodoroXIDB(dbName)
    await db.open()
    await db.outbox.add({
      entityType: 'task', entityId: 'local-pending', action: 'update', payload: '{}',
      createdAt: Date.now(), synced: false,
    } as never)
    const token = '12345678-1234-4234-8234-123456789abc'
    let rejectNextPage!: (error: Error) => void
    let signalNextPageEntered!: () => void
    const nextPageEntered = new Promise<void>((resolve) => {
      signalNextPageEntered = resolve
    })
    let initialCalls = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      initialCalls++
      if (initialCalls === 1) return ok(registration(config), config)
      if (initialCalls === 2) return ok(snapshotPage(token, 1, 20, true, 'page-one'), config)
      return new Promise<AxiosResponse>((_, reject) => {
        rejectNextPage = reject
        signalNextPageEntered()
      })
    }

    const crashedEngine = new RealSyncEngine(db, 'space-h2f5-reopen')
    await vi.waitFor(() => expect(crashedEngine.getPendingCount()).toBe(1))
    const interruptedSync = crashedEngine.fullSync()
    await vi.waitFor(async () => {
      const meta = await loadSyncMeta(db)
      expect(meta.snapshotToken).toBe(token)
      expect(meta.snapshotOffset).toBe(1)
      expect(meta.snapshotContinuation).toBe('continuation-1')
      expect(await db.snapshotSeen.get([token, 'tasks', 'page-one'])).toBeDefined()
    })

    await nextPageEntered
    crashedEngine.destroy()
    db.close()
    rejectNextPage(new Error('simulated browser crash after committed page'))
    await interruptedSync

    db = new PomodoroXIDB(dbName)
    await db.open()
    const reopenedMeta = await loadSyncMeta(db)
    expect(reopenedMeta.snapshotToken).toBe(token)
    expect(reopenedMeta.snapshotOffset).toBe(1)
    expect(reopenedMeta.snapshotContinuation).toBe('continuation-1')
    expect(await db.snapshotSeen.get([token, 'tasks', 'page-one'])).toBeDefined()
    expect(await db.outbox.count()).toBe(1)

    const calls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.includes('/sync/clients')) {
        return ok({ ...registration(config), snapshot_required: true }, config)
      }
      if (url.includes('/sync/full')) {
        const params = config.params as Record<string, unknown>
        expect(params.snapshot_token).toBe(token)
        expect(params.snapshot_offset).toBe(1)
        expect(params.recovery_continuation).toBe('continuation-1')
        return ok(snapshotPage(token, 2, 20, false, 'page-two'), config)
      }
      if (url.includes('/sync/ack')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        expect(body).toMatchObject({ ack_cursor: 20, recovery_proof: 'proof-20' })
        return ok({
          ack_cursor: 20,
          lease_expires_at: '2026-08-12T00:00:00Z',
          retention_floor: 20,
          current_cursor: 20,
        }, config)
      }
      if (url.includes('/sync/push')) return ok(appliedPush(config), config)
      throw new Error(`unexpected request: ${url}`)
    }

    const resumedEngine = new RealSyncEngine(db, 'space-h2f5-reopen')
    await vi.waitFor(() => expect(resumedEngine.getPendingCount()).toBe(1))
    await resumedEngine.sync()

    expect(calls).toEqual(['/sync/clients', '/sync/full', '/sync/ack', '/sync/push'])
    expect(await db.tasks.get('page-one')).toBeDefined()
    expect(await db.tasks.get('page-two')).toBeDefined()
    expect((await loadSyncMeta(db)).snapshotToken).toBeNull()
    expect((await loadSyncMeta(db)).pendingAckCursor).toBeNull()
    expect(await db.outbox.count()).toBe(0)
    expect(resumedEngine.getStatus()).toBe('idle')
    resumedEngine.destroy()
  })

  it('lost terminal recovery ACK response is reconciled by registration after close/reopen', async () => {
    const dbName = `h2f5-lost-ack-${crypto.randomUUID()}`
    db = new PomodoroXIDB(dbName)
    await db.open()
    await db.outbox.add({
      entityType: 'task', entityId: 'local-after-recovery', action: 'update', payload: '{}',
      createdAt: Date.now(), synced: false,
    } as never)
    const token = '87654321-4321-4321-8321-cba987654321'
    let serverAckCursor = 0
    let snapshotRequired = true
    const calls: string[] = []
    const ackBodies: Array<Record<string, unknown>> = []

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.includes('/sync/clients')) {
        return ok({
          ...registration(config),
          ack_cursor: serverAckCursor,
          snapshot_required: snapshotRequired,
        }, config)
      }
      if (url.includes('/sync/full')) {
        return ok(snapshotPage(token, 1, 20, false, 'recovered-terminal'), config)
      }
      if (url.includes('/sync/ack')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        ackBodies.push(body)
        expect(body).toMatchObject({ ack_cursor: 20, recovery_proof: 'proof-20' })
        serverAckCursor = 20
        snapshotRequired = false
        throw new Error('Network Error: ACK 200 response lost')
      }
      throw new Error(`unexpected request before reopen: ${url}`)
    }

    const lostResponseEngine = new RealSyncEngine(db, 'space-h2f5-lost-ack')
    await vi.waitFor(() => expect(lostResponseEngine.getPendingCount()).toBe(1))
    await lostResponseEngine.sync()

    expect(calls).toEqual(['/sync/clients', '/sync/full', '/sync/ack'])
    expect(serverAckCursor).toBe(20)
    expect(snapshotRequired).toBe(false)
    expect((await loadSyncMeta(db)).pendingAckCursor).toBe(20)
    expect((await loadSyncMeta(db)).pendingAckRecoveryProof).toBe('proof-20')
    expect(await db.outbox.count()).toBe(1)
    expect(lostResponseEngine.getStatus()).toBe('infra-error')
    lostResponseEngine.destroy()
    db.close()

    db = new PomodoroXIDB(dbName)
    await db.open()
    expect((await loadSyncMeta(db)).pendingAckCursor).toBe(20)
    expect((await loadSyncMeta(db)).pendingAckRecoveryProof).toBe('proof-20')

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.includes('/sync/clients')) {
        return ok({
          ...registration(config),
          ack_cursor: serverAckCursor,
          snapshot_required: snapshotRequired,
        }, config)
      }
      if (url.includes('/sync/pull')) {
        return ok({
          ...snapshotPage(token, 1, 21, false, 'unused'),
          snapshot_token: undefined,
          snapshot_offset: undefined,
          recovery_proof: undefined,
          recovery_continuation: undefined,
          tasks: [],
        }, config)
      }
      if (url.includes('/sync/ack')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        ackBodies.push(body)
        expect(body).toMatchObject({ ack_cursor: 21, recovery_proof: null })
        serverAckCursor = 21
        return ok({
          ack_cursor: 21,
          lease_expires_at: '2026-08-12T00:00:00Z',
          retention_floor: 20,
          current_cursor: 21,
        }, config)
      }
      if (url.includes('/sync/push')) return ok(appliedPush(config), config)
      throw new Error(`unexpected request after reopen: ${url}`)
    }

    const reconciledEngine = new RealSyncEngine(db, 'space-h2f5-lost-ack')
    await vi.waitFor(() => expect(reconciledEngine.getPendingCount()).toBe(1))
    await reconciledEngine.sync()

    expect(calls).toEqual([
      '/sync/clients', '/sync/full', '/sync/ack',
      '/sync/clients', '/sync/pull', '/sync/ack', '/sync/push',
    ])
    expect(ackBodies).toEqual([
      expect.objectContaining({ ack_cursor: 20, recovery_proof: 'proof-20' }),
      expect.objectContaining({ ack_cursor: 21, recovery_proof: null }),
    ])
    expect((await loadSyncMeta(db)).pendingAckCursor).toBeNull()
    expect((await loadSyncMeta(db)).pendingAckRecoveryProof).toBeNull()
    expect(await db.outbox.count()).toBe(0)
    expect(reconciledEngine.getStatus()).toBe('idle')
    reconciledEngine.destroy()
  })

  it('damaged continuation restarts only once and never pushes partial state', async () => {
    db = new PomodoroXIDB(`h2f5-damage-${crypto.randomUUID()}`)
    await db.open()
    const staleToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await saveSyncMeta(db, {
      cursor: 10,
      cursorVersion: 2,
      snapshotToken: staleToken,
      snapshotOffset: 1,
      snapshotCursor: 20,
      snapshotRecoveryVersion: 1,
      snapshotContinuation: 'damaged-continuation',
    })
    await db.snapshotSeen.put({ snapshotToken: staleToken, tableName: 'tasks', entityId: 'stale' })
    await db.outbox.add({
      entityType: 'task', entityId: 'must-not-push', action: 'update', payload: '{}',
      createdAt: Date.now(), synced: false,
    } as never)

    const calls: Array<{ url: string; token?: unknown }> = []
    let fullCalls = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push({
        url,
        token: (config.params as Record<string, unknown> | undefined)?.snapshot_token,
      })
      if (url.includes('/sync/clients')) {
        return ok({ ...registration(config), snapshot_required: true }, config)
      }
      if (url.includes('/sync/full')) {
        fullCalls++
        throw {
          response: { status: 409, data: { error_type: 'sync_snapshot_expired' }, config },
          message: `snapshot damaged ${fullCalls}`,
        }
      }
      if (url.includes('/sync/push')) return ok(emptyPush(), config)
      throw new Error(`unexpected request: ${url}`)
    }

    const engine = new RealSyncEngine(db, 'space-h2f5-damage')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(1))
    await engine.sync()

    expect(calls.map((call) => call.url)).toEqual([
      '/sync/clients', '/sync/full', '/sync/full',
    ])
    expect(calls[1]?.token).toBe(staleToken)
    expect(calls[2]?.token).toBeUndefined()
    expect(fullCalls).toBe(2)
    expect(await db.snapshotSeen.count()).toBe(0)
    expect((await loadSyncMeta(db)).snapshotToken).toBeNull()
    expect(await db.outbox.count()).toBe(1)
    expect(engine.getStatus()).toBe('error')
    engine.destroy()
  })
})
