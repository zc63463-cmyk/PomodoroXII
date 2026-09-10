import { afterEach, describe, expect, it } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { spaceApi } from '@/services/api'
import { runPullLoopV2, assertPullProgress, validateSyncV2PullLimit } from './pull-loop'
import { loadSyncV2Meta, writeSyncV2Meta } from './sync-meta'
import { withSpaceAuthorityFence } from './space-authority-fence'
import type { PomodoroXIDB } from '@/services/database'

const catalogHash = 'a'.repeat(64)
const originalAdapter = spaceApi.defaults.adapter

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

describe('Sync v2 pull loop', () => {
  let db: PomodoroXIDB | undefined

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    if (db) await db.delete()
    db = undefined
  })

  it('validates the locked 1..500 page limit and cursor progress', () => {
    expect(validateSyncV2PullLimit(undefined)).toBe(500)
    expect(validateSyncV2PullLimit(1)).toBe(1)
    expect(() => validateSyncV2PullLimit(0)).toThrow()
    expect(() => validateSyncV2PullLimit(501)).toThrow()
    expect(() => assertPullProgress('same', {
      events: [{ operation_id: 'op', batch_id: 'batch', entity_type: 'note',
        entity_id: 'n', action: 'update', payload: {}, version: 1,
        created_at: '2026-07-14T10:00:00.000Z' }],
      next_cursor: 'same', has_more: false, catalog_hash: catalogHash,
    })).toThrow()
  })

  it('persists every page before ACK and resumes from the opaque cursor', async () => {
    db = await openPomodoroXIDB(`pull-loop-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: 'cursor-start-0001', pendingAck: null, catalogHash, requiresFullRecovery: false },
    ))
    const calls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.endsWith('/sync/v2/pull')) {
        return ok({ events: [], next_cursor: 'cursor-next-0001', has_more: false,
          catalog_hash: catalogHash }, config)
      }
      if (url.endsWith('/sync/v2/ack')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        return ok({ client_id: body.client_id, accepted: true,
          requires_recovery: false, catalog_hash: catalogHash }, config)
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      await expect(runPullLoopV2(db!, spaceApi, db!.spaceId, 'client-a', token))
        .resolves.toMatchObject({ pages: 1, dirtyConflicts: [] })
    })

    expect(calls).toEqual(['/sync/v2/pull', '/sync/v2/ack'])
    await expect(loadSyncV2Meta(db)).resolves.toMatchObject({
      cursor: 'cursor-next-0001', pendingAck: null, requiresFullRecovery: false,
    })
  })

  it('★ 按作用域拉取：请求带 scope，游标落在 scopeCursors 且不动全量游标', async () => {
    db = await openPomodoroXIDB(`pull-loop-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      {
        cursor: 'cursor-full-0001',
        pendingAck: null,
        catalogHash,
        requiresFullRecovery: false,
        scopeCursors: { planning: 'cursor-scope-0001' },
      },
    ))
    const queries: Array<Record<string, unknown>> = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.endsWith('/sync/v2/pull')) {
        queries.push(config.params as Record<string, unknown>)
        return ok({ events: [], next_cursor: 'cursor-scope-0002', has_more: false,
          catalog_hash: catalogHash }, config)
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      await expect(
        runPullLoopV2(db!, spaceApi, db!.spaceId, 'client-a', token, { scope: 'planning' }),
      ).resolves.toMatchObject({ pages: 1 })
    })

    // 请求带上 scope 与**该作用域自己的**游标
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatchObject({ scope: 'planning', cursor: 'cursor-scope-0001' })

    // 游标写回作用域槽位；全量游标原封不动
    await expect(loadSyncV2Meta(db)).resolves.toMatchObject({
      cursor: 'cursor-full-0001',
      scopeCursors: { planning: 'cursor-scope-0002' },
    })
  })

  it('★ 作用域拉取不发起 ACK —— ACK 驱动 retention 裁剪，误 ACK 会丢数据', async () => {
    db = await openPomodoroXIDB(`pull-loop-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      {
        cursor: 'cursor-full-0001',
        pendingAck: null,
        catalogHash,
        requiresFullRecovery: false,
        scopeCursors: { notes: 'cursor-scope-0001' },
      },
    ))
    const calls: string[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      calls.push(url)
      if (url.endsWith('/sync/v2/pull')) {
        return ok({ events: [], next_cursor: 'cursor-scope-0002', has_more: false,
          catalog_hash: catalogHash }, config)
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      await runPullLoopV2(db!, spaceApi, db!.spaceId, 'client-a', token, { scope: 'notes' })
    })

    // 只有 pull，没有 ack —— 服务端的 ack_sequence 是单值的，
    // 拿作用域游标去 ACK 会让服务端误判消费进度并裁剪掉别的事件。
    expect(calls).toEqual(['/sync/v2/pull'])
    await expect(loadSyncV2Meta(db)).resolves.toMatchObject({ pendingAck: null })
  })

  it('未安装作用域游标时直接报错，不静默退回全量', async () => {
    db = await openPomodoroXIDB(`pull-loop-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: 'cursor-full-0001', pendingAck: null, catalogHash, requiresFullRecovery: false },
    ))

    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      await expect(
        runPullLoopV2(db!, spaceApi, db!.spaceId, 'client-a', token, { scope: 'planning' }),
      ).rejects.toThrow(/scope cursor is not installed/)
    })
  })

  it('不传 scope 时请求里不出现 scope 参数（与历史请求逐字一致）', async () => {
    db = await openPomodoroXIDB(`pull-loop-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: 'cursor-start-0001', pendingAck: null, catalogHash, requiresFullRecovery: false },
    ))
    const queries: Array<Record<string, unknown>> = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const url = config.url ?? ''
      if (url.endsWith('/sync/v2/pull')) {
        queries.push(config.params as Record<string, unknown>)
        return ok({ events: [], next_cursor: 'cursor-next-0001', has_more: false,
          catalog_hash: catalogHash }, config)
      }
      if (url.endsWith('/sync/v2/ack')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
        return ok({ client_id: body.client_id, accepted: true,
          requires_recovery: false, catalog_hash: catalogHash }, config)
      }
      throw new Error(`unexpected URL ${url}`)
    }

    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      await runPullLoopV2(db!, spaceApi, db!.spaceId, 'client-a', token)
    })

    expect(queries).toHaveLength(1)
    expect(queries[0]).not.toHaveProperty('scope')
    expect(queries[0]).toMatchObject({ cursor: 'cursor-start-0001' })
  })
})
