import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { PomodoroXIDB } from '@/services/database'
import { spaceApi } from '@/services/api'
import { runPullLoop } from './pull-loop'
import { loadSyncMeta, saveSyncMeta } from './sync-meta'

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
  return { data, status: 200, statusText: 'OK', headers: {}, config }
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
})
