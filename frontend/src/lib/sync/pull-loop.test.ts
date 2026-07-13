import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { PomodoroXIDB } from '@/services/database'
import { spaceApi } from '@/services/api'
import { runPullLoop } from './pull-loop'
import { loadSyncMeta, saveSyncMeta } from './sync-meta'
import { SYNC_PULL_KEYS } from './types'

/**
 * pull-loop.ts 单测（PL1–PL9 + H2-D cursor 协议 PL10–PL13）。
 *
 * 验证 F1 §2.4 + §2.4b 分页循环 + 游标持久化 + isFull 路径 + H2-D cursor 双协议。
 * Mock 模式：spaceApi.defaults.adapter = async (config) => ({ data, status, ... })
 */

async function openTestDb(): Promise<PomodoroXIDB> {
  const db = new PomodoroXIDB('pull-loop-test-' + crypto.randomUUID())
  await db.open()
  return db
}

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  if (typeof data === 'object' && data !== null && 'server_time' in data) {
    const page = data as Record<string, unknown>
    page.tombstones ??= []
    for (const key of SYNC_PULL_KEYS) page[key] ??= []
    if ((config.url ?? '').includes('/sync/full')) {
      page.is_full ??= true
      if (page.cursor_version === 2) {
        page.snapshot_token ??= '22222222-2222-4222-8222-222222222222'
        page.snapshot_offset ??= page.has_more === true || page.tombstones_has_more === true ? 1 : 0
        if (page.has_more === true || page.tombstones_has_more === true) {
          page.recovery_continuation ??= 'continuation-page-1'
        }
      }
    }
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

function taskRow(id: string, dirty: boolean) {
  return {
    id,
    title: id,
    status: 'todo',
    updated_at: '2026-01-01T00:00:00.000Z',
    _dirty: dirty,
    deletion_state: 'active',
    version: 1,
  } as unknown as Parameters<PomodoroXIDB['tasks']['put']>[0]
}

function taskWireRow(id: string, updatedAt = '2026-07-06T12:00:00.000Z') {
  return {
    id,
    title: id,
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
    created_at: updatedAt,
    updated_at: updatedAt,
    version: 1,
  }
}

function page1Data() {
  return {
    server_time: '2026-07-06T12:00:00.000Z',
    has_more: true,
    tombstones_has_more: false,
    next_since: '2026-07-06T12:00:00.000Z',
    next_since_id: 'task-1',
    next_tombstone_since_id: 't1',
  }
}

function page2Data() {
  return {
    server_time: '2026-07-06T12:01:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '2026-07-06T12:01:00.000Z',
    next_since_id: 'task-2',
    next_tombstone_since_id: 't2',
  }
}

function singlePageData() {
  return {
    server_time: '2026-07-06T12:00:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '2026-07-06T12:00:00.000Z',
    next_since_id: 'task-final',
    next_tombstone_since_id: 'tf',
  }
}

// H2-D cursor 协议 mock 数据
function cursorPage1() {
  return {
    server_time: '2026-07-06T12:00:00.000Z',
    has_more: true,
    tombstones_has_more: false,
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    next_cursor: 42,
    cursor_version: 2,
  }
}

function cursorPage2() {
  return {
    server_time: '2026-07-06T12:01:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    next_cursor: 84,
    cursor_version: 2,
  }
}

function cursorSinglePage() {
  return {
    server_time: '2026-07-06T12:00:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    next_cursor: 99,
    cursor_version: 2,
  }
}

describe('pull-loop', () => {
  let db: PomodoroXIDB
  const originalAdapter = spaceApi.defaults.adapter

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    if (db) await db.delete()
  })

  // ---- 旧协议测试（保持兼容） ----

  it('PL1: 有 since → 调 /sync/pull', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })

    let capturedUrl = ''
    let capturedSince = ''
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      capturedUrl = config.url ?? ''
      capturedSince = (config.params as Record<string, unknown>)?.since as string
      return ok(singlePageData(), config)
    }

    await runPullLoop(db, spaceApi)

    expect(capturedUrl).toContain('/sync/pull')
    expect(capturedSince).toBe('2026-01-01T00:00:00.000Z')
  })

  it('PL2: isFull=true → /sync/full + clearSyncCursors', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, {
      since: '2026-01-01T00:00:00.000Z',
      sinceId: 'old-id',
      tombstoneSinceId: 'old-tid',
    })

    let capturedUrl = ''
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      capturedUrl = config.url ?? ''
      return ok(singlePageData(), config)
    }

    await runPullLoop(db, spaceApi, { isFull: true })

    expect(capturedUrl).toContain('/sync/full')
    const meta = await loadSyncMeta(db)
    expect(meta.since).toBe('2026-07-06T12:00:00.000Z')
  })

  it('PL3/PL6: has_more 两页 → pages=2 且 next_since_id 传入下一页', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })

    const captured: InternalAxiosRequestConfig[] = []
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      captured.push(config)
      return ok(call === 1 ? page1Data() : page2Data(), config)
    }

    const result = await runPullLoop(db, spaceApi)

    expect(result.pages).toBe(2)
    expect(captured[0]!.url).toContain('/sync/pull')
    expect((captured[1]!.params as Record<string, unknown>)?.since_id).toBe('task-1')
  })

  it('PL4: 单页 has_more=false → 结束', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok(singlePageData(), config)
    }

    const result = await runPullLoop(db, spaceApi)

    expect(result.pages).toBe(1)
  })

  it('PL5: 两页 → syncMeta 持久化最终游标', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })

    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      return ok(call === 1 ? page1Data() : page2Data(), config)
    }

    await runPullLoop(db, spaceApi)

    const meta = await loadSyncMeta(db)
    expect(meta.sinceId).toBe('task-2')
  })

  it('PL7: next_tombstone_since_id 推进', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })

    const captured: InternalAxiosRequestConfig[] = []
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      captured.push(config)
      return ok(call === 1 ? page1Data() : page2Data(), config)
    }

    await runPullLoop(db, spaceApi)

    expect((captured[1]!.params as Record<string, unknown>)?.tombstone_since_id).toBe('t1')
  })

  it('PL8: full 结束 → touchLastFullSync', async () => {
    db = await openTestDb()

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok(singlePageData(), config)
    }

    await runPullLoop(db, spaceApi, { isFull: true })

    const meta = await loadSyncMeta(db)
    expect(meta.lastFullSync).toBe('2026-07-06T12:00:00.000Z')
  })

  it('PL9: 空变更响应（无实体组）→ 不报错', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok(singlePageData(), config)
    }

    const result = await runPullLoop(db, spaceApi)

    expect(result.pages).toBe(1)
    expect(result.dirtyConflicts).toHaveLength(0)
  })

  // ---- H2-D cursor 协议测试 ----

  it('PL10: 有 cursor → 调 /sync/pull?cursor=N', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { cursor: 10, cursorVersion: 2 })

    let capturedCursor: unknown = undefined
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      capturedCursor = (config.params as Record<string, unknown>)?.cursor
      return ok(cursorSinglePage(), config)
    }

    await runPullLoop(db, spaceApi)

    expect(capturedCursor).toBe(10)
  })

  it('PL11: cursor 两页 → next_cursor 传入下一页', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { cursor: 0, cursorVersion: 2 })

    const captured: InternalAxiosRequestConfig[] = []
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      captured.push(config)
      return ok(call === 1 ? cursorPage1() : cursorPage2(), config)
    }

    const result = await runPullLoop(db, spaceApi)

    expect(result.pages).toBe(2)
    // 第二页请求应携带 cursor=42（第一页返回的 next_cursor）
    expect((captured[1]!.params as Record<string, unknown>)?.cursor).toBe(42)
  })

  it('PL12: cursor isFull → /sync/full?cursor=0', async () => {
    db = await openTestDb()

    let capturedUrl = ''
    let capturedCursor: unknown = undefined
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      capturedUrl = config.url ?? ''
      capturedCursor = (config.params as Record<string, unknown>)?.cursor
      return ok(cursorSinglePage(), config)
    }

    await runPullLoop(db, spaceApi, { isFull: true })

    expect(capturedUrl).toContain('/sync/full')
    expect(capturedCursor).toBe(0)
  })

  it('PL13: cursor 协议结束后 syncMeta 持久化 cursor', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { cursor: 0, cursorVersion: 2 })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok(cursorSinglePage(), config)
    }

    await runPullLoop(db, spaceApi)

    const meta = await loadSyncMeta(db)
    expect(meta.cursor).toBe(99) // cursorSinglePage.next_cursor
    expect(meta.cursorVersion).toBe(2)
  })

  it('PL14: legacy 首轮后第二轮仍走 legacy，不发送 null cursor', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })
    const cursors: unknown[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      cursors.push((config.params as Record<string, unknown>)?.cursor)
      return ok(singlePageData(), config)
    }

    await runPullLoop(db, spaceApi)
    await runPullLoop(db, spaceApi)

    expect(cursors).toEqual([undefined, undefined])
    expect((await db.syncMeta.get('cursor'))?.value).toBe('')
    expect((await loadSyncMeta(db)).cursor).toBeNull()
  })

  it('PL15: full snapshot 使用 snapshot token/offset 分页且只在结束后保存 snapshot_cursor', async () => {
    db = await openTestDb()
    const captured: InternalAxiosRequestConfig[] = []
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      captured.push(config)
      call++
      return ok(
        call === 1
          ? { ...cursorPage1(), next_cursor: 200, snapshot_token: '33333333-3333-4333-8333-333333333333', snapshot_offset: 1 }
          : { ...cursorPage2(), next_cursor: 200, snapshot_token: '33333333-3333-4333-8333-333333333333', snapshot_offset: 2 },
        config,
      )
    }

    await runPullLoop(db, spaceApi, { isFull: true, limit: 1 })

    expect(captured[0]!.url).toContain('/sync/full')
    expect(captured[1]!.url).toContain('/sync/full')
    expect((captured[1]!.params as Record<string, unknown>).snapshot_token).toBe('33333333-3333-4333-8333-333333333333')
    expect((captured[1]!.params as Record<string, unknown>).snapshot_offset).toBe(1)
    expect((await loadSyncMeta(db)).cursor).toBe(200)
  })

  it('PL16: full snapshot 完成后删除未见 clean ghost 并保留 dirty ghost 与 outbox', async () => {
    db = await openTestDb()
    await db.tasks.bulkPut([taskRow('clean-ghost', false), taskRow('dirty-ghost', true)])
    await db.outbox.add({
      entityType: 'task',
      entityId: 'dirty-ghost',
      action: 'update',
      payload: '{}',
      createdAt: Date.now(),
      synced: false,
    })
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({ ...cursorSinglePage(), tasks: [] }, config)
    }

    await runPullLoop(db, spaceApi, { isFull: true })

    expect(await db.tasks.get('clean-ghost')).toBeUndefined()
    expect(await db.tasks.get('dirty-ghost')).toBeDefined()
    expect(await db.outbox.count()).toBe(1)
  })

  it('PL17: full snapshot 分页中断时不提前删除 clean ghost', async () => {
    db = await openTestDb()
    await db.tasks.put(taskRow('clean-ghost', false))
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      if (call === 1) {
        return ok({
          ...cursorPage1(),
          snapshot_token: '44444444-4444-4444-8444-444444444444',
          snapshot_offset: 1,
          tasks: [],
        }, config)
      }
      throw new Error('page interrupted')
    }

    await expect(runPullLoop(db, spaceApi, { isFull: true, limit: 1 })).rejects.toThrow(
      'page interrupted',
    )

    expect(await db.tasks.get('clean-ghost')).toBeDefined()
  })

  it('PL22: materialized snapshot 每页原子保存 merge、seen 与 continuation', async () => {
    db = await openTestDb()
    const token = '77777777-7777-4777-8777-777777777777'
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      if (call === 1) {
        return ok({
          ...cursorPage1(),
          next_cursor: 200,
          snapshot_token: token,
          snapshot_offset: 1,
          tasks: [taskWireRow('page-one')],
        }, config)
      }
      throw new Error('browser stopped after committed page')
    }

    await expect(runPullLoop(db, spaceApi, { isFull: true, limit: 1 })).rejects.toThrow(
      'browser stopped',
    )

    const meta = await loadSyncMeta(db)
    expect(await db.tasks.get('page-one')).toBeDefined()
    expect(meta.snapshotToken).toBe(token)
    expect(meta.snapshotOffset).toBe(1)
    expect(meta.snapshotCursor).toBe(200)
    expect(meta.snapshotContinuation).toBe('continuation-page-1')
    expect(await db.snapshotSeen.get([token, 'tasks', 'page-one'])).toBeDefined()
    expect(meta.cursor).toBeNull()
  })

  it('PL23: 浏览器重启后从 continuation 继续并使用持久化 Seen IDs 完成 reconcile', async () => {
    db = await openTestDb()
    const token = '88888888-8888-4888-8888-888888888888'
    await db.tasks.bulkPut([taskRow('page-one', false), taskRow('clean-ghost', false)])
    await db.snapshotSeen.put({ snapshotToken: token, tableName: 'tasks', entityId: 'page-one' })
    await saveSyncMeta(db, {
      snapshotToken: token,
      snapshotOffset: 1,
      snapshotCursor: 200,
      snapshotRecoveryVersion: 1,
      snapshotContinuation: 'persisted-continuation',
    })
    let captured: Record<string, unknown> = {}
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      captured = config.params as Record<string, unknown>
      return ok({
        ...cursorPage2(),
        next_cursor: 200,
        snapshot_token: token,
        snapshot_offset: 2,
        tasks: [taskWireRow('page-two', '2026-07-06T12:01:00.000Z')],
      }, config)
    }

    await runPullLoop(db, spaceApi, { isFull: true, limit: 1 })

    expect(captured.snapshot_token).toBe(token)
    expect(captured.snapshot_offset).toBe(1)
    expect(captured.recovery_continuation).toBe('persisted-continuation')
    expect(await db.tasks.get('page-one')).toBeDefined()
    expect(await db.tasks.get('page-two')).toBeDefined()
    expect(await db.tasks.get('clean-ghost')).toBeUndefined()
    expect((await loadSyncMeta(db)).cursor).toBe(200)
    expect((await loadSyncMeta(db)).snapshotToken).toBeNull()
    expect(await db.snapshotSeen.where('snapshotToken').equals(token).count()).toBe(0)
  })

  it('PL24: continuation 事务失败会回滚本页 merge、Seen IDs 与 offset', async () => {
    db = await openTestDb()
    const token = '99999999-9999-4999-8999-999999999999'
    const originalBulkPut = db.snapshotSeen.bulkPut.bind(db.snapshotSeen)
    vi.spyOn(db.snapshotSeen, 'bulkPut').mockRejectedValue(new Error('seen write failed'))
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => ok({
      ...cursorPage1(),
      next_cursor: 300,
      snapshot_token: token,
      snapshot_offset: 1,
      tasks: [taskWireRow('rolled-back')],
    }, config)

    await expect(runPullLoop(db, spaceApi, { isFull: true, limit: 1 })).rejects.toThrow(
      'seen write failed',
    )

    expect(await db.tasks.get('rolled-back')).toBeUndefined()
    expect((await loadSyncMeta(db)).snapshotToken).toBeNull()
    expect(await db.snapshotSeen.count()).toBe(0)
    db.snapshotSeen.bulkPut = originalBulkPut
  })

  it('PL25: materialized snapshot 非终页 offset 必须严格前进', async () => {
    db = await openTestDb()
    const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => ok({
      ...cursorPage1(), snapshot_token: token, snapshot_offset: 0, next_cursor: 50,
    }, config)

    await expect(runPullLoop(db, spaceApi, { isFull: true })).rejects.toThrow('did not advance')
    expect((await loadSyncMeta(db)).snapshotToken).toBeNull()
  })

  it('PL26: materialized snapshot 所有分页必须保持同一 snapshot cursor', async () => {
    db = await openTestDb()
    const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      return ok(call === 1
        ? { ...cursorPage1(), snapshot_token: token, snapshot_offset: 1, next_cursor: 50 }
        : { ...cursorPage2(), snapshot_token: token, snapshot_offset: 2, next_cursor: 51 }, config)
    }

    await expect(runPullLoop(db, spaceApi, { isFull: true })).rejects.toThrow('cursor changed')
    const meta = await loadSyncMeta(db)
    expect(meta.snapshotCursor).toBe(50)
    expect(meta.cursor).toBeNull()
  })

  it('PL27: 非法 continuation 启动新快照前清理残留 meta 与 Seen IDs', async () => {
    db = await openTestDb()
    const staleToken = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    await db.syncMeta.bulkPut([
      { key: 'snapshot_token', value: staleToken },
      { key: 'snapshot_offset', value: '-1' },
      { key: 'snapshot_cursor', value: '20' },
      { key: 'snapshot_recovery_version', value: '1' },
    ])
    await db.snapshotSeen.put({ snapshotToken: staleToken, tableName: 'tasks', entityId: 'stale' })
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => ok({
      ...cursorSinglePage(), next_cursor: 30,
      snapshot_token: 'ffffffff-ffff-4fff-8fff-ffffffffffff', snapshot_offset: 0,
    }, config)

    await runPullLoop(db, spaceApi, { isFull: true })

    expect(await db.snapshotSeen.where('snapshotToken').equals(staleToken).count()).toBe(0)
    expect((await loadSyncMeta(db)).snapshotToken).toBeNull()
    expect((await loadSyncMeta(db)).cursor).toBe(30)
  })

  it('PL28: terminal proof 写入失败时回滚终页并保留上一页 continuation', async () => {
    db = await openTestDb()
    const token = '12121212-1212-4212-8212-121212121212'
    await db.tasks.put(taskRow('clean-ghost', false))
    const originalBulkPut = db.syncMeta.bulkPut.bind(db.syncMeta)
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      if (call === 1) {
        return ok({
          ...cursorPage1(),
          next_cursor: 200,
          snapshot_token: token,
          snapshot_offset: 1,
          tasks: [taskWireRow('page-one')],
        }, config)
      }
      vi.spyOn(db.syncMeta, 'bulkPut').mockImplementation(((entries: Parameters<typeof db.syncMeta.bulkPut>[0]) => {
        if (entries.some((entry) => entry.key === 'pending_ack_recovery_proof')) {
          return Promise.reject(new Error('proof write failed'))
        }
        return originalBulkPut(entries)
      }) as typeof db.syncMeta.bulkPut)
      return ok({
        ...cursorPage2(),
        next_cursor: 200,
        snapshot_token: token,
        snapshot_offset: 2,
        recovery_proof: 'terminal-proof-200',
        tasks: [taskWireRow('terminal-row')],
      }, config)
    }

    await expect(runPullLoop(db, spaceApi, {
      isFull: true,
      limit: 1,
      clientId: '34343434-3434-4434-8434-343434343434',
      snapshotRequired: true,
    })).rejects.toThrow('proof write failed')

    const meta = await loadSyncMeta(db)
    expect(await db.tasks.get('page-one')).toBeDefined()
    expect(await db.tasks.get('terminal-row')).toBeUndefined()
    expect(await db.tasks.get('clean-ghost')).toBeDefined()
    expect(meta.cursor).toBeNull()
    expect(meta.pendingAckCursor).toBeNull()
    expect(meta.pendingAckRecoveryProof).toBeNull()
    expect(meta.snapshotToken).toBe(token)
    expect(meta.snapshotOffset).toBe(1)
    expect(meta.snapshotContinuation).toBe('continuation-page-1')
    expect(await db.snapshotSeen.get([token, 'tasks', 'page-one'])).toBeDefined()
    db.syncMeta.bulkPut = originalBulkPut
  })

  it('PL18: legacy full 也按权威快照删除缺失的本地 clean 实体', async () => {
    db = await openTestDb()
    await db.tasks.put(taskRow('legacy-local', false))
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({ ...singlePageData(), tasks: [] }, config)
    }

    await runPullLoop(db, spaceApi, { isFull: true })

    expect(await db.tasks.get('legacy-local')).toBeUndefined()
  })

  it('PL19: materialized snapshot reconcile 保护 unsynced outbox 引用', async () => {
    db = await openTestDb()
    await db.tasks.bulkPut([taskRow('clean-ghost', false), taskRow('outbox-ghost', false)])
    await db.outbox.add({
      entityType: 'task', entityId: 'outbox-ghost', action: 'update', payload: '{}',
      createdAt: Date.now(), synced: false,
    })
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      return ok({ ...cursorSinglePage(), tasks: [] }, config)
    }

    await runPullLoop(db, spaceApi, { isFull: true })

    expect(await db.tasks.get('clean-ghost')).toBeUndefined()
    expect(await db.tasks.get('outbox-ghost')).toBeDefined()
  })

  it('PL20: full 分页协议或 snapshot_token 中途变化时 fail-closed', async () => {
    db = await openTestDb()
    await db.tasks.put(taskRow('protocol-ghost', false))
    let call = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call++
      return ok(call === 1
        ? { ...cursorPage1(), snapshot_token: '55555555-5555-4555-8555-555555555555', snapshot_offset: 1 }
        : { ...cursorPage2(), snapshot_token: '66666666-6666-4666-8666-666666666666', snapshot_offset: 2 }, config)
    }

    await expect(runPullLoop(db, spaceApi, { isFull: true, limit: 1 })).rejects.toThrow(
      'token changed',
    )
    expect(await db.tasks.get('protocol-ghost')).toBeDefined()
    expect((await loadSyncMeta(db)).cursor).toBeNull()
  })

  it('PL29: 畸形增量页在解析阶段拒绝，不落盘、不推进 cursor 或 pending ACK', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { cursor: 10, cursorVersion: 2 })
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const page = {
        ...cursorSinglePage(),
        next_cursor: 20,
        tasks: [{
          id: 'must-not-land', title: 'invalid row without updated_at', status: 'todo',
        }],
      }
      for (const key of SYNC_PULL_KEYS) (page as Record<string, unknown>)[key] ??= []
      return { data: page, status: 200, statusText: 'OK', headers: {}, config }
    }

    await expect(runPullLoop(db, spaceApi)).rejects.toThrow('invalid structure')

    expect(await db.tasks.get('must-not-land')).toBeUndefined()
    const meta = await loadSyncMeta(db)
    expect(meta.cursor).toBe(10)
    expect(meta.pendingAckCursor).toBeNull()
  })

  it('PL30: 中间畸形实体使整页在 transaction 前拒绝且不产生 ACK/proof', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { cursor: 10, cursorVersion: 2 })
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const page = {
        ...cursorSinglePage(),
        next_cursor: 20,
        tasks: [
          {
            id: 'valid-before-invalid', title: 'valid', description: '', status: 'todo', priority: 'medium',
            tags: [], plan: '', completion: '', due_date: null, estimated_pomodoros: 1,
            actual_pomodoros: 0, archived_at: null, created_at: '2026-07-06T12:00:00.000Z',
            updated_at: '2026-07-06T12:00:00.000Z', version: 1,
          },
          {
            id: 'invalid-middle', title: 'invalid', description: '', status: 'corrupted', priority: 'medium',
            tags: [], plan: '', completion: '', due_date: null, estimated_pomodoros: 1,
            actual_pomodoros: 0, archived_at: null, created_at: '2026-07-06T12:00:00.000Z',
            updated_at: '2026-07-06T12:00:00.000Z', version: 1,
          },
          {
            id: 'valid-after-invalid', title: 'valid', description: '', status: 'todo', priority: 'medium',
            tags: [], plan: '', completion: '', due_date: null, estimated_pomodoros: 1,
            actual_pomodoros: 0, archived_at: null, created_at: '2026-07-06T12:00:00.000Z',
            updated_at: '2026-07-06T12:00:00.000Z', version: 1,
          },
        ],
      }
      for (const key of SYNC_PULL_KEYS) (page as Record<string, unknown>)[key] ??= []
      return { data: page, status: 200, statusText: 'OK', headers: {}, config }
    }

    await expect(runPullLoop(db, spaceApi)).rejects.toThrow('invalid structure')

    expect(await db.tasks.get('valid-before-invalid')).toBeUndefined()
    expect(await db.tasks.get('invalid-middle')).toBeUndefined()
    expect(await db.tasks.get('valid-after-invalid')).toBeUndefined()
    const meta = await loadSyncMeta(db)
    expect(meta.cursor).toBe(10)
    expect(meta.pendingAckCursor).toBeNull()
    expect(meta.pendingAckRecoveryProof).toBeNull()
  })

  it('PL21: reconcile 失败会回滚终页 merge、cursor 与 lastFullSync', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { cursor: 7, cursorVersion: 2, lastFullSync: 'old-full' })
    await db.tasks.put(taskRow('ghost', false))
    const originalBulkDelete = db.tasks.bulkDelete.bind(db.tasks)
    vi.spyOn(db.tasks, 'bulkDelete').mockImplementation(() => {
      throw new Error('reconcile failed')
    })
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => ok({
      ...cursorSinglePage(), next_cursor: 99, tasks: [taskWireRow('terminal-row')],
    }, config)

    await expect(runPullLoop(db, spaceApi, { isFull: true })).rejects.toThrow('reconcile failed')

    expect((await loadSyncMeta(db)).cursor).toBe(7)
    expect((await loadSyncMeta(db)).lastFullSync).toBe('old-full')
    expect(await db.tasks.get('terminal-row')).toBeUndefined()
    expect(await db.tasks.get('ghost')).toBeDefined()
    db.tasks.bulkDelete = originalBulkDelete
  })
})
