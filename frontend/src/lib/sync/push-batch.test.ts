import { describe, it, expect, afterEach } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { PomodoroXIDB } from '@/services/database'
import { spaceApi } from '@/services/api'
import { buildPushEvents, pushBatch, pushAllPending } from './push-batch'
import type { OutboxEvent } from '@/types'

/**
 * push-batch.ts 单测（PB1–PB10）。
 *
 * 验证 F1 §5.1–§5.4 push 批处理 + 冲突响应处理。
 * Mock 模式：spaceApi.defaults.adapter = async (config) => ({ data, status, ... })
 */

async function openTestDb(): Promise<PomodoroXIDB> {
  const db = new PomodoroXIDB('push-test-' + crypto.randomUUID())
  await db.open()
  return db
}

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

function makeOutboxRow(
  id: number,
  entityType: OutboxEvent['entityType'],
  entityId: string,
  action: OutboxEvent['action'] = 'create',
  payload: unknown = { id: entityId, title: 'X' },
  createdAt = 1751803200000,
): OutboxEvent {
  return {
    id,
    entityType,
    entityId,
    action,
    payload: JSON.stringify(payload),
    createdAt,
    synced: false,
  }
}

describe('push-batch', () => {
  let db: PomodoroXIDB
  const originalAdapter = spaceApi.defaults.adapter

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    if (db) await db.delete()
  })

  it('PB1: buildPushEvents 字段映射 + ISO', () => {
    const rows: OutboxEvent[] = [
      makeOutboxRow(1, 'task', 't1', 'create', { id: 't1', title: 'X' }, 1751803200000),
    ]
    const events = buildPushEvents(rows)

    expect(events).toHaveLength(1)
    expect(events[0]!.entity_type).toBe('task')
    expect(events[0]!.entity_id).toBe('t1')
    expect(events[0]!.action).toBe('create')
    expect(events[0]!.client_updated_at).toBe(new Date(1751803200000).toISOString())
    expect(events[0]!.payload).toEqual({ id: 't1', title: 'X' })
  })

  it('PB1-QN: buildPushEvents maps quickNote delete tombstone payload', () => {
    const rows: OutboxEvent[] = [
      makeOutboxRow(11, 'quickNote', 'qn1', 'delete', { id: 'qn1' }, 1751803200000),
    ]

    const events = buildPushEvents(rows)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      entity_type: 'quickNote',
      entity_id: 'qn1',
      action: 'delete',
      payload: { id: 'qn1' },
      client_updated_at: new Date(1751803200000).toISOString(),
    })
  })

  it('PB2: applied 无 resolution → 清 outbox', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(1, 'task', 't1', 'create'))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [{ entity_type: 'task', entity_id: 't1', action: 'create' }],
        conflicts: [],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    const result = await pushBatch(db, spaceApi, rows)

    expect(result.clearedOutboxIds).toContain(1)
    expect(await db.outbox.count()).toBe(0)
  })

  it('PB2-QN: applied quickNote delete clears the repository tombstone outbox', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(21, 'quickNote', 'qn1', 'delete', { id: 'qn1' }))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [{ entity_type: 'quickNote', entity_id: 'qn1', action: 'delete' }],
        conflicts: [],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    const result = await pushBatch(db, spaceApi, rows)

    expect(result.clearedOutboxIds).toContain(21)
    expect(await db.outbox.where('entityId').equals('qn1').count()).toBe(0)
  })

  it('PB3: applied resolution=remote → 清 + remoteWinCount=1', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(1, 'task', 't1', 'update'))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [{ entity_type: 'task', entity_id: 't1', action: 'update', resolution: 'remote' }],
        conflicts: [],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    const result = await pushBatch(db, spaceApi, rows)

    expect(await db.outbox.count()).toBe(0)
    expect(result.remoteWinCount).toBe(1)
  })

  it('PB4: conflicts resolution=local → 清 outbox', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(1, 'task', 't1', 'create'))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [],
        conflicts: [{ entity_type: 'task', entity_id: 't1', resolution: 'local' }],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    await pushBatch(db, spaceApi, rows)

    expect(await db.outbox.count()).toBe(0)
  })

  it('PB5: conflicts resolution=tombstone → 清 + deletion_state', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(1, 'task', 't1', 'delete'))
    // 种一行 task 供 tombstone 标记
    await db.tasks.put({
      id: 't1', title: 'T', status: 'todo',
      updated_at: '2026-01-01T00:00:00.000Z',
      _dirty: true, deletion_state: 'active', version: 1,
    } as unknown as Parameters<PomodoroXIDB['tasks']['put']>[0])

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [],
        conflicts: [{ entity_type: 'task', entity_id: 't1', resolution: 'tombstone' }],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    await pushBatch(db, spaceApi, rows)

    expect(await db.outbox.count()).toBe(0)
    const task = await db.tasks.get('t1')
    expect(task!.deletion_state).toBe('deleted')
    expect(task!._dirty).toBe(false)
  })

  it('PB6: conflicts resolution=circular_ref → 清 + count', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(1, 'task', 't1', 'create'))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [],
        conflicts: [{ entity_type: 'task', entity_id: 't1', resolution: 'circular_ref' }],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    const result = await pushBatch(db, spaceApi, rows)

    expect(await db.outbox.count()).toBe(0)
    expect(result.circularRefCount).toBe(1)
  })

  it('PB7: errors 通用 → outbox 保留 + retriableErrorCount=1', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(1, 'task', 't1', 'create'))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [],
        conflicts: [],
        errors: [{ entity_type: 'task', entity_id: 't1', error: 'something_failed' }],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    const result = await pushBatch(db, spaceApi, rows)

    expect(await db.outbox.count()).toBe(1)
    expect(result.retriableErrorCount).toBe(1)
    const row = await db.outbox.get(1)
    expect(row).toMatchObject({
      lastError: 'something_failed',
      lastErrorCode: 'push_error',
      attemptCount: 1,
    })
    expect(row!.failedAt).toEqual(expect.any(String))
  })

  it('PB7-QN: generic quickNote push error marks only the matching outbox event failed', async () => {
    db = await openTestDb()
    await db.outbox.bulkPut([
      makeOutboxRow(31, 'quickNote', 'failed-qn', 'update', { id: 'failed-qn', content: 'A' }),
      makeOutboxRow(32, 'quickNote', 'pending-qn', 'update', { id: 'pending-qn', content: 'B' }),
    ])

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [],
        conflicts: [],
        errors: [{ entity_type: 'quickNote', entity_id: 'failed-qn', error: 'quick_note_rejected' }],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    const result = await pushBatch(db, spaceApi, rows)
    const failed = await db.outbox.get(31)
    const pending = await db.outbox.get(32)

    expect(result.retriableErrorCount).toBe(1)
    expect(failed).toMatchObject({
      lastError: 'quick_note_rejected',
      lastErrorCode: 'push_error',
      attemptCount: 1,
    })
    expect(pending!.lastError).toBeUndefined()
  })

  it('PB8: 150 行 → pushAllPending 调 2 次 POST 且 outbox 清空', async () => {
    db = await openTestDb()
    // 种 150 行 outbox（不带 id 让 Dexie 自增主键）
    const rows = Array.from({ length: 150 }, (_, i) => ({
      entityType: 'task' as const,
      entityId: `t${i}`,
      action: 'create' as const,
      payload: JSON.stringify({ id: `t${i}`, title: 'X' }),
      createdAt: i,
      synced: false,
    }))
    await db.outbox.bulkAdd(rows)

    let postCount = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      if (config.url?.includes('/sync/push')) {
        postCount++
        // 动态生成 applied：请求中的所有 events 都成功应用
        const body =
          typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        const events = (body as { events: Array<{ entity_type: string; entity_id: string; action: string }> }).events
        return ok({
          applied: events.map((e) => ({
            entity_type: e.entity_type,
            entity_id: e.entity_id,
            action: e.action,
          })),
          conflicts: [],
          errors: [],
          server_time: '2026-07-06T12:00:00.000Z',
        }, config)
      }
      return ok({}, config)
    }

    await pushAllPending(db, spaceApi, 100)

    expect(postCount).toBe(2)
    expect(await db.outbox.count()).toBe(0)
  })

  it('PB9: errors version_mismatch → 进 conflicts + outbox 保留', async () => {
    db = await openTestDb()
    await db.outbox.put(makeOutboxRow(1, 'task', 't1', 'update'))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({
        applied: [],
        conflicts: [],
        errors: [{ entity_type: 'task', entity_id: 't1', error: 'version_mismatch' }],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const rows = await db.outbox.toArray()
    const result = await pushBatch(db, spaceApi, rows)

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.outboxId).toBe(1)
    expect(result.conflicts[0]!.entityType).toBe('task')
    expect(result.conflicts[0]!.entityId).toBe('t1')
    expect(await db.outbox.count()).toBe(1)
    const row = await db.outbox.get(1)
    expect(row).toMatchObject({
      lastError: 'version_mismatch',
      lastErrorCode: 'version_mismatch',
      attemptCount: 1,
    })
  })

  it('PB10: 空 outbox → pushAllPending no-op', async () => {
    db = await openTestDb()

    let postCount = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      if (config.url?.includes('/sync/push')) postCount++
      return ok({ applied: [], conflicts: [], errors: [], server_time: '2026-07-06T12:00:00.000Z' }, config)
    }

    const result = await pushAllPending(db, spaceApi)

    expect(postCount).toBe(0)
    expect(result.clearedOutboxIds).toHaveLength(0)
    expect(result.conflicts).toHaveLength(0)
  })
})
