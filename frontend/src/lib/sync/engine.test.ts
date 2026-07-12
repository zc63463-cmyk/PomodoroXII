import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { PomodoroXIDB } from '@/services/database'
import { spaceApi } from '@/services/api'
import { RealSyncEngine } from './engine'
import { loadSyncMeta } from './sync-meta'

/**
 * engine.ts 单测（EN1–EN20）。
 *
 * 验证 F1 §6.1 RealSyncEngine — 组装 S1-2 runPullLoop + pushAllPending。
 * Mock 模式：spaceApi.defaults.adapter = async (config) => ({ data, status, ... })
 * 真实代码：S1-2 pull-loop/push-batch/merge/outbox/sync-meta 不 mock。
 */

async function openTestDb(): Promise<PomodoroXIDB> {
  const db = new PomodoroXIDB('engine-test-' + crypto.randomUUID())
  await db.open()
  return db
}

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

function errResponse(
  status: number,
  config: InternalAxiosRequestConfig,
  message = 'error',
): AxiosResponse {
  return {
    data: { detail: message },
    status,
    statusText: 'Error',
    headers: {},
    config,
  }
}

/** 单页 pull 响应（无实体，has_more=false） */
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

/** 两页 pull 响应：page1 has_more=true */
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

/** 空 push 响应（无 applied/conflicts/errors） */
function emptyPushResponse() {
  return {
    applied: [],
    conflicts: [],
    errors: [],
    server_time: '2026-07-06T12:00:00.000Z',
  }
}

describe('RealSyncEngine', () => {
  let db: PomodoroXIDB
  const originalAdapter = spaceApi.defaults.adapter

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    if (db) await db.delete()
  })

  // ===== 组 A：markDirty + getPendingCount（EN1, EN2）=====

  it('EN1: markDirty 后 getPendingCount 返回缓存值（不访问 db.tasks）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    // 等 refreshPendingCount 初始化完成
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    // spy db.tasks.get — markDirty 不应访问 Dexie
    const tasksGetSpy = vi.spyOn(db.tasks, 'get')

    engine.markDirty('task', 't1', 'create')

    expect(engine.getPendingCount()).toBe(1)
    expect(tasksGetSpy).not.toHaveBeenCalled()

    engine.destroy()
  })

  it('EN2: 3 次 markDirty → getPendingCount 返回 3（同步缓存）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    engine.markDirty('task', 't1', 'create')
    engine.markDirty('task', 't2', 'update')
    engine.markDirty('note', 'n1', 'delete')

    // 同步返回缓存，不 await Dexie
    expect(engine.getPendingCount()).toBe(3)

    engine.destroy()
  })

  // ===== 组 B：sync() 成功路径（EN3）=====

  it('EN3: sync() 成功 → status idle + lastSyncedAt 有值', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    // 空 since → sync 走 isFull=true（/sync/full 首页）
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      if (url.includes('/sync/push')) {
        return ok(emptyPushResponse(), config)
      }
      return errResponse(404, config, 'not found')
    }

    await engine.sync()

    expect(engine.getStatus()).toBe('idle')
    expect(engine.getLastSyncedAt()).not.toBeNull()
    expect(engine.getLastSyncedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    engine.destroy()
  })

  // ===== 组 C：conflicts 收集（EN4, EN5）=====

  it('EN4: pull dirtyConflicts → getConflicts 非空 + status conflict', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    // 预存本地 _dirty=true task（updated_at 较旧）
    await db.tasks.put({
      id: 't1',
      updated_at: '2026-01-01T00:00:00.000Z',
      _dirty: true,
      title: 'local-dirty',
    } as never)

    // pull 返回同 id 远端行（updated_at 较新）→ _dirty 守卫触发 dirtyConflict
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(
          {
            ...singlePageData(),
            tasks: [
              { id: 't1', updated_at: '2026-07-06T12:00:00.000Z', title: 'remote' },
            ],
          },
          config,
        )
      }
      if (url.includes('/sync/push')) {
        return ok(emptyPushResponse(), config)
      }
      return errResponse(404, config)
    }

    await engine.sync()

    expect(engine.getConflicts().length).toBeGreaterThan(0)
    expect(engine.getStatus()).toBe('conflict')

    engine.destroy()
  })

  it('EN5: push version_mismatch → conflicts 追加', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    // 预存 outbox 未同步行（pushAllPending 需要 pending 才发 HTTP）
    await db.outbox.add({
      entityType: 'task',
      entityId: 't1',
      action: 'update',
      payload: '{"title":"local"}',
      createdAt: Date.now(),
      synced: false,
    } as never)

    // pull 空；push 返回 version_mismatch error
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      if (url.includes('/sync/push')) {
        return ok(
          {
            applied: [],
            conflicts: [],
            errors: [
              {
                index: 0,
                type: 'version',
                action: 'update',
                entity_id: 't1',
                error: 'version_mismatch: expected 1 got 2',
              },
            ],
            server_time: '2026-07-06T12:00:00.000Z',
          },
          config,
        )
      }
      return errResponse(404, config)
    }

    await engine.sync()

    expect(engine.getConflicts().length).toBeGreaterThan(0)
    const conflict = engine.getConflicts()[0]!
    expect(conflict.conflictType).toBe('version')

    engine.destroy()
  })

  // ===== 组 D：回调时机（EN6, EN7）=====

  it('EN6: 两批 push → onPushComplete 回调仅 1 次（S1-Hard-2）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    // 预填 150 行未同步 outbox（batchSize 默认 100 → 两批：100 + 50）
    const outboxRows = Array.from({ length: 150 }, (_, i) => ({
      entityType: 'task',
      entityId: `t${i}`,
      action: 'update' as const,
      payload: '{"title":"local"}',
      createdAt: Date.now() + i,
      synced: false,
    }))
    await db.outbox.bulkAdd(outboxRows as never)

    let pushCallCount = 0
    const off = engine.onPushComplete(() => {
      pushCallCount++
    })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      if (url.includes('/sync/push')) {
        // 回显请求中的 events 为 applied，触发 outbox 清空（避免死循环）
        // 注意：axios 序列化 config.data 为 JSON 字符串，需 parse
        const parsed =
          typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        const events = parsed.events as Array<{
          entity_type: string
          entity_id: string
          action: string
        }>
        const applied = events.map((e) => ({
          index: 0,
          action: e.action,
          entity_type: e.entity_type,
          entity_id: e.entity_id,
        }))
        return ok({ ...emptyPushResponse(), applied }, config)
      }
      return errResponse(404, config)
    }

    await engine.sync()

    expect(pushCallCount).toBe(1) // S1-Hard-2：每周期一次，即使两批
    off()
    engine.destroy()
  })

  it('EN7: 两页 pull → onPullComplete 回调仅 1 次（DR-10）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    let pullCallCount = 0
    const off = engine.onPullComplete(() => {
      pullCallCount++
    })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      // 首页 /sync/full → has_more=true；第二页 /sync/pull → has_more=false
      if (url.includes('/sync/full')) {
        return ok(page1Data(), config)
      }
      if (url.includes('/sync/pull')) {
        return ok(page2Data(), config)
      }
      if (url.includes('/sync/push')) {
        return ok(emptyPushResponse(), config)
      }
      return errResponse(404, config)
    }

    await engine.sync()

    expect(pullCallCount).toBe(1) // DR-10：每周期一次，即使两页
    off()
    engine.destroy()
  })

  // ===== 组 E：resolveConflict（EN8, EN9, EN10 — S1-Hard-3）=====

  it('EN8: resolveConflict(-1, accept-remote) → Dexie 覆盖 + _dirty=false（S1-Hard-3）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    await db.tasks.put({
      id: 't1',
      updated_at: '2026-01-01T00:00:00.000Z',
      _dirty: true,
      title: 'local',
    } as never)

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(
          {
            ...singlePageData(),
            tasks: [
              { id: 't1', updated_at: '2026-07-06T12:00:00.000Z', title: 'remote' },
            ],
          },
          config,
        )
      }
      if (url.includes('/sync/push')) return ok(emptyPushResponse(), config)
      return errResponse(404, config)
    }

    await engine.sync()
    expect(engine.getConflicts().length).toBeGreaterThan(0)

    await engine.resolveConflict(-1, 'accept-remote')

    const task = await db.tasks.get('t1')
    expect(task?.title).toBe('remote')
    expect(task?._dirty).toBe(false)
    expect(engine.getConflicts().length).toBe(0)
    engine.destroy()
  })

  it('EN9: resolveConflict(-1, keep-local) → 本地 _dirty=true 保留（S1-Hard-3）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    await db.tasks.put({
      id: 't1',
      updated_at: '2026-01-01T00:00:00.000Z',
      _dirty: true,
      title: 'local',
    } as never)

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(
          {
            ...singlePageData(),
            tasks: [
              { id: 't1', updated_at: '2026-07-06T12:00:00.000Z', title: 'remote' },
            ],
          },
          config,
        )
      }
      if (url.includes('/sync/push')) return ok(emptyPushResponse(), config)
      return errResponse(404, config)
    }

    await engine.sync()
    expect(engine.getConflicts().length).toBeGreaterThan(0)

    await engine.resolveConflict(-1, 'keep-local')

    const task = await db.tasks.get('t1')
    expect(task?.title).toBe('local')
    expect(task?._dirty).toBe(true)
    expect(engine.getConflicts().length).toBe(0)
    engine.destroy()
  })

  it('EN10: resolveConflict(outboxId>=0, accept-remote) → outbox 行删除', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    const outboxId = await db.outbox.add({
      entityType: 'task',
      entityId: 't1',
      action: 'update',
      payload: '{}',
      createdAt: Date.now(),
      synced: false,
    } as never)

    // 手动注入冲突（绕过 sync 触发路径，直接测 outboxId>=0 分支）
    ;(engine as unknown as { conflicts: unknown[] }).conflicts = [
      {
        outboxId,
        entityType: 'task',
        entityId: 't1',
        localVersion: {},
        remoteVersion: {},
        conflictType: 'version',
      },
    ]

    await engine.resolveConflict(outboxId, 'accept-remote')

    const row = await db.outbox.get(outboxId)
    expect(row).toBeUndefined()
    expect(engine.getConflicts().length).toBe(0)
    engine.destroy()
  })

  // ===== 组 F：守卫与 destroy（EN11, EN12, EN13）=====

  it('EN11: !navigator.onLine → sync 不发 HTTP', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    })

    let adapterCalls = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      adapterCalls++
      return ok({}, config)
    }

    await engine.sync()

    expect(adapterCalls).toBe(0)
    expect(engine.getStatus()).toBe('idle')

    Object.defineProperty(navigator, 'onLine', {
      value: true,
      configurable: true,
    })
    engine.destroy()
  })

  it('EN12: sync 进行中 destroy → onPushComplete 不触发', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    let pushCalled = false
    engine.onPushComplete(() => {
      pushCalled = true
    })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        // pull 返回前 destroy → runSyncCycle 后续检查点 return
        engine.destroy()
        return ok(singlePageData(), config)
      }
      return ok(emptyPushResponse(), config)
    }

    await engine.sync()

    expect(pushCalled).toBe(false)
  })

  it('EN13: destroy() 后 markDirty no-op', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    engine.destroy()
    engine.markDirty('task', 't1', 'create')

    expect(engine.getPendingCount()).toBe(0)
  })

  // ===== 组 G：debounce + fullSync（EN14, EN15, EN16）=====

  it('EN14: 3 次 markDirty → debounce 1 次 sync 周期（T25）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    vi.useFakeTimers()
    let adapterCalls = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      adapterCalls++
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      if (url.includes('/sync/push')) {
        return ok(emptyPushResponse(), config)
      }
      return errResponse(404, config)
    }

    // 3 次 markDirty 同步调用 → debounce 仅保留最后一个 5000ms timer
    engine.markDirty('task', 't1', 'create')
    engine.markDirty('task', 't2', 'update')
    engine.markDirty('note', 'n1', 'delete')

    // 推进 5000ms 触发 debounce 后的 sync
    await vi.advanceTimersByTimeAsync(5000)
    // 等待 sync 周期完成（runPullLoop + pushAllPending 均无 pending → 仅 1 次 /sync/full）
    await vi.waitFor(() => expect(adapterCalls).toBe(1))

    // 关键：3 次 markDirty 仅触发 1 次 sync 周期（1 次 HTTP 调用）
    expect(adapterCalls).toBe(1)

    vi.useRealTimers()
    engine.destroy()
  })

  it('EN15: fullSync() → adapter 首调 /sync/full（非 /sync/pull）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    const urls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      urls.push(config.url ?? '')
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      if (url.includes('/sync/push')) return ok(emptyPushResponse(), config)
      return errResponse(404, config)
    }

    await engine.fullSync()

    expect(urls[0]).toContain('/sync/full')
    engine.destroy()
  })

  it('EN16: 空 since → sync() 走 isFull=true → 首调 /sync/full', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    const urls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      urls.push(config.url ?? '')
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      if (url.includes('/sync/push')) return ok(emptyPushResponse(), config)
      return errResponse(404, config)
    }

    // syncMeta.since 默认 '' → sync() 首次检测走 isFull=true
    await engine.sync()

    expect(urls[0]).toContain('/sync/full')
    engine.destroy()
  })

  // ===== 组 H：infra-error + withSyncLock skip + 冲突清空（EN17-EN20）=====

  it('EN17: mock 500 → status infra-error（DR-8）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    // axios v1.x 自定义 adapter 必须抛错才能触发 onRejected 路径（validateStatus 不作用于 adapter 返回值）
    // 抛 axios-error-like 对象 → 拦截器 onRejected → 非 CF → reject → runSyncCycle catch → DR-8
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw {
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: { detail: 'Internal Server Error' },
          headers: {},
          config,
        },
        message: 'Request failed with status code 500',
        config,
        isAxiosError: true,
        name: 'AxiosError',
      }
    }

    await engine.sync()

    expect(engine.getStatus()).toBe('infra-error')
    engine.destroy()
  })

  it('EN18: mock 400 → status error（DR-8）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw {
        response: {
          status: 400,
          statusText: 'Bad Request',
          data: { detail: 'Bad Request' },
          headers: {},
          config,
        },
        message: 'Request failed with status code 400',
        config,
        isAxiosError: true,
        name: 'AxiosError',
      }
    }

    await engine.sync()

    expect(engine.getStatus()).toBe('error')
    engine.destroy()
  })

  it('EN19: withSyncLock fallback 占用 → onSkip 触发 scheduleSync 重试（T26）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    vi.useFakeTimers()
    // 确保 jsdom 走 fallback 路径（无 navigator.locks）
    delete (navigator as unknown as { locks?: unknown }).locks
    // 预填未过期 flag（10s 前 < 60s TTL）→ withFallbackLock 走 onSkip 分支
    const flagKey = 'pxii_sync_lock_space-1'
    localStorage.setItem(flagKey, String(Date.now() - 10_000))

    let adapterCalls = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      adapterCalls++
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      return ok(emptyPushResponse(), config)
    }

    // 第一次 sync → onSkip（flag 未过期）→ scheduleSync(30_000)
    await engine.sync()
    expect(adapterCalls).toBe(0)

    // 模拟其他 Tab 释放锁（flag 删除）
    localStorage.removeItem(flagKey)

    // 推进 30s → scheduleSync 触发 → sync 重试 → flag 已删 → 执行 fn
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(adapterCalls).toBeGreaterThan(0))

    expect(adapterCalls).toBeGreaterThan(0)

    vi.useRealTimers()
    engine.destroy()
  })

  it('EN20: conflicts 清空后 resolve → status idle', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    const outboxId = await db.outbox.add({
      entityType: 'task',
      entityId: 't1',
      action: 'update',
      payload: '{}',
      createdAt: Date.now(),
      synced: false,
    } as never)

    // 注入冲突 + 手动设 status='conflict'（模拟 addConflicts 效果）
    const internal = engine as unknown as {
      conflicts: unknown[]
      setStatus: (s: string) => void
    }
    internal.conflicts = [
      {
        outboxId,
        entityType: 'task',
        entityId: 't1',
        localVersion: {},
        remoteVersion: {},
        conflictType: 'version',
      },
    ]
    internal.setStatus('conflict')
    expect(engine.getStatus()).toBe('conflict')

    await engine.resolveConflict(outboxId, 'accept-remote')

    expect(engine.getConflicts().length).toBe(0)
    expect(engine.getStatus()).toBe('idle')
    engine.destroy()
  })

  // ===== 组 I：onSyncComplete 回调（EN21, EN22, EN23 — S1-4.1）=====

  it('EN21: sync 成功 → onSyncComplete 回调 1 次；回调内 status=idle + lastSyncedAt 非空', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    let syncCompleteCount = 0
    let statusAtCallback: string | null = null
    let lastSyncedAtCallback: string | null = null
    const off = engine.onSyncComplete(() => {
      syncCompleteCount++
      statusAtCallback = engine.getStatus()
      lastSyncedAtCallback = engine.getLastSyncedAt()
    })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full') || url.includes('/sync/pull')) {
        return ok(singlePageData(), config)
      }
      if (url.includes('/sync/push')) {
        return ok(emptyPushResponse(), config)
      }
      return errResponse(404, config)
    }

    await engine.sync()

    expect(syncCompleteCount).toBe(1)
    expect(statusAtCallback).toBe('idle')
    expect(lastSyncedAtCallback).not.toBeNull()

    off()
    engine.destroy()
  })

  it('EN22: sync 5xx → onSyncComplete 1 次；status=infra-error', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    let syncCompleteCount = 0
    let statusAtCallback: string | null = null
    engine.onSyncComplete(() => {
      syncCompleteCount++
      statusAtCallback = engine.getStatus()
    })

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw {
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: { detail: 'Internal Server Error' },
          headers: {},
          config,
        },
        message: 'Request failed with status code 500',
        config,
        isAxiosError: true,
        name: 'AxiosError',
      }
    }

    await engine.sync()

    expect(syncCompleteCount).toBe(1)
    expect(statusAtCallback).toBe('infra-error')

    engine.destroy()
  })

  it('EN23: 加 onSyncComplete 后 onPullComplete 仍 1 次（DR-10 回归）', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    let pullCallCount = 0
    let syncCompleteCount = 0
    engine.onPullComplete(() => pullCallCount++)
    engine.onSyncComplete(() => syncCompleteCount++)

    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full')) return ok(page1Data(), config)
      if (url.includes('/sync/pull')) return ok(page2Data(), config)
      if (url.includes('/sync/push')) return ok(emptyPushResponse(), config)
      return errResponse(404, config)
    }

    await engine.sync()

    expect(pullCallCount).toBe(1) // DR-10：不因 onSyncComplete 破坏
    expect(syncCompleteCount).toBe(1)

    engine.destroy()
  })

  // ===== 组 J：resolveConflict onSyncComplete（EN27 — S1-4.2）=====

  it('EN24: cursor expired 时执行一次真正 full recovery，不 push 部分状态', async () => {
    db = await openTestDb()
    await db.syncMeta.bulkPut([
      { key: 'cursor', value: '5' },
      { key: 'cursor_version', value: '2' },
    ])
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    const urls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      urls.push(url)
      if (url.includes('/sync/pull')) {
        throw {
          response: {
            status: 409,
            data: {
              error_type: 'sync_cursor_expired',
              floor: 10,
              current_cursor: 20,
              recovery_action: 'full_sync',
            },
            config,
          },
          message: 'Request failed with status code 409',
          config,
          isAxiosError: true,
          name: 'AxiosError',
        }
      }
      if (url.includes('/sync/full')) {
        return ok({
          ...singlePageData(),
          next_cursor: 20,
          cursor_version: 2,
          snapshot_token: 'snap-20',
          snapshot_offset: 0,
        }, config)
      }
      if (url.includes('/sync/push')) return ok(emptyPushResponse(), config)
      return errResponse(404, config)
    }

    await engine.sync()

    expect(urls.filter((url) => url.includes('/sync/pull'))).toHaveLength(1)
    expect(urls.filter((url) => url.includes('/sync/full'))).toHaveLength(1)
    expect(urls.filter((url) => url.includes('/sync/push'))).toHaveLength(0)
    expect((await db.syncMeta.get('cursor'))?.value).toBe('20')
    expect(engine.getStatus()).toBe('idle')
    engine.destroy()
  })

  it('EN25: snapshot expired 时重启一次 full sync', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))
    let fullCalls = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.includes('/sync/full')) {
        fullCalls++
        if (fullCalls === 1) {
          throw {
            response: { status: 409, data: { error_type: 'sync_snapshot_expired' }, config },
            message: 'snapshot expired', config, isAxiosError: true, name: 'AxiosError',
          }
        }
        return ok({
          ...singlePageData(), next_cursor: 20, cursor_version: 2,
          snapshot_token: 'snap-restarted', snapshot_offset: 0,
        }, config)
      }
      if (url.includes('/sync/push')) return ok(emptyPushResponse(), config)
      return errResponse(404, config)
    }

    await engine.fullSync()

    expect(fullCalls).toBe(2)
    expect((await loadSyncMeta(db)).cursor).toBe(20)
    expect(engine.getStatus()).toBe('idle')
    engine.destroy()
  })

  it('EN27: resolveConflict 清空冲突 → onSyncComplete 1 次；回调内 status=idle', async () => {
    db = await openTestDb()
    const engine = new RealSyncEngine(db, 'space-1')
    await vi.waitFor(() => expect(engine.getPendingCount()).toBe(0))

    const outboxId = await db.outbox.add({
      entityType: 'task',
      entityId: 't1',
      action: 'update',
      payload: '{}',
      createdAt: Date.now(),
      synced: false,
    } as never)

    // 注入冲突 + 手动设 status='conflict'
    const internal = engine as unknown as {
      conflicts: unknown[]
      setStatus: (s: string) => void
    }
    internal.conflicts = [{
      outboxId, entityType: 'task', entityId: 't1',
      localVersion: {}, remoteVersion: {}, conflictType: 'version',
    }]
    internal.setStatus('conflict')

    let syncCompleteCount = 0
    let statusAtCallback: string | null = null
    engine.onSyncComplete(() => {
      syncCompleteCount++
      statusAtCallback = engine.getStatus()
    })

    await engine.resolveConflict(outboxId, 'accept-remote')

    expect(syncCompleteCount).toBe(1) // S142-1：resolve 也走 onSyncComplete
    expect(statusAtCallback).toBe('idle')
    expect(engine.getConflicts().length).toBe(0)

    engine.destroy()
  })
})
