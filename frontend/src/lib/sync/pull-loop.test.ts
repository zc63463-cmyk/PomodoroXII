import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { PomodoroXIDB } from '@/services/database'
import { spaceApi } from '@/services/api'
import { runPullLoop } from './pull-loop'
import { loadSyncMeta, saveSyncMeta } from './sync-meta'

/**
 * pull-loop.ts 单测（PL1–PL9）。
 *
 * 验证 F1 §2.4 + §2.4b 分页循环 + 游标持久化 + isFull 路径。
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

describe('pull-loop', () => {
  let db: PomodoroXIDB
  const originalAdapter = spaceApi.defaults.adapter

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    if (db) await db.delete()
  })

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
    // 预存游标
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

    // isFull → 首页调 /sync/full（非 /sync/pull）
    expect(capturedUrl).toContain('/sync/full')
    // 循环结束后游标被 saveSyncMeta 更新为响应值（clearSyncCursors 在拉取前清空）
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
    expect(meta.sinceId).toBe('task-2') // page2.next_since_id
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
})
