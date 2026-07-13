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

describe('H2-F5 frontend lifecycle integration', () => {
  let db: PomodoroXIDB
  const originalAdapter = spaceApi.defaults.adapter

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    if (db) await db.delete()
  })

  it('browser crash resumes committed page, ACK failure gates push, next cycle ACKs then pushes', async () => {
    db = new PomodoroXIDB(`h2f5-lifecycle-${crypto.randomUUID()}`)
    await db.open()
    const token = '12345678-1234-4234-8234-123456789abc'
    let crashCalls = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      crashCalls++
      if (crashCalls === 1) return ok(registration(config), config)
      if (crashCalls === 2) return ok(snapshotPage(token, 1, 20, true, 'page-one'), config)
      throw new Error('simulated browser crash after committed page')
    }
    const crashedEngine = new RealSyncEngine(db, 'space-h2f5')
    await vi.waitFor(() => expect(crashedEngine.getPendingCount()).toBe(0))
    await crashedEngine.fullSync()
    expect(crashedEngine.getStatus()).toBe('error')
    crashedEngine.destroy()
    expect((await loadSyncMeta(db)).snapshotOffset).toBe(1)
    expect(await db.snapshotSeen.get([token, 'tasks', 'page-one'])).toBeDefined()
    await db.outbox.add({
      entityType: 'task', entityId: 'local-pending', action: 'update', payload: '{}',
      createdAt: Date.now(), synced: false,
    } as never)

    let ackShouldFail = true
    const calls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.includes('/sync/clients')) {
        return ok({ ...registration(config), snapshot_required: true }, config)
      }
      if (url.includes('/sync/full')) {
        expect((config.params as Record<string, unknown>).snapshot_token).toBe(token)
        expect((config.params as Record<string, unknown>).snapshot_offset).toBe(1)
        expect((config.params as Record<string, unknown>).recovery_continuation).toBe(
          'continuation-1',
        )
        return ok(snapshotPage(token, 2, 20, false, 'page-two'), config)
      }
      if (url.includes('/sync/ack')) {
        if (ackShouldFail) throw new Error('injected ACK outage')
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        return ok({
          ack_cursor: body.ack_cursor,
          lease_expires_at: '2026-08-12T00:00:00Z',
          retention_floor: body.ack_cursor,
          current_cursor: body.ack_cursor,
        }, config)
      }
      if (url.includes('/sync/pull')) {
        return ok({
          ...snapshotPage(token, 2, 20, false, 'page-two'),
          snapshot_token: undefined,
          snapshot_offset: undefined,
          recovery_proof: undefined,
          recovery_continuation: undefined,
          tasks: [],
        }, config)
      }
      if (url.includes('/sync/push')) return ok(emptyPush(), config)
      throw new Error(`unexpected request: ${url}`)
    }

    const firstEngine = new RealSyncEngine(db, 'space-h2f5')
    await vi.waitFor(() => expect(firstEngine.getPendingCount()).toBe(1))
    await firstEngine.sync()

    expect(calls).toEqual(['/sync/clients', '/sync/full', '/sync/ack'])
    expect(await db.tasks.get('page-one')).toBeDefined()
    expect(await db.tasks.get('page-two')).toBeDefined()
    expect((await loadSyncMeta(db)).snapshotToken).toBeNull()
    expect((await loadSyncMeta(db)).pendingAckCursor).toBe(20)
    expect(await db.outbox.count()).toBe(1)
    expect(firstEngine.getStatus()).toBe('error')
    firstEngine.destroy()

    calls.length = 0
    ackShouldFail = false
    const secondEngine = new RealSyncEngine(db, 'space-h2f5')
    await vi.waitFor(() => expect(secondEngine.getPendingCount()).toBe(1))
    await secondEngine.sync()

    expect(calls).toEqual([
      '/sync/clients', '/sync/ack', '/sync/pull', '/sync/ack', '/sync/push',
    ])
    expect((await loadSyncMeta(db)).pendingAckCursor).toBeNull()
    expect(secondEngine.getStatus()).toBe('idle')
    secondEngine.destroy()
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
