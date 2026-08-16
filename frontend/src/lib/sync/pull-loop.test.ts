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
})
