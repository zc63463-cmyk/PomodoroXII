import { afterEach, describe, expect, it } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { spaceApi } from '@/services/api'
import { getOrCreateClientId } from './client-registry'
import { loadSyncV2Meta, sendPendingAck, writeSyncV2Meta } from './sync-meta'
import { withSpaceAuthorityFence } from './space-authority-fence'
import type { PomodoroXIDB } from '@/services/database'

const catalogHash = 'a'.repeat(64)
const originalAdapter = spaceApi.defaults.adapter

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

describe('Sync v2 protocol metadata', () => {
  let db: PomodoroXIDB | undefined
  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    if (db) await db.delete()
    db = undefined
  })

  it('requires recovery when protocol state is absent', async () => {
    db = await openPomodoroXIDB(`sync-meta-${crypto.randomUUID()}`)
    await expect(loadSyncV2Meta(db)).resolves.toEqual({
      cursor: null, pendingAck: null, catalogHash: null, requiresFullRecovery: true,
    })
  })

  it('writes opaque state only under the live same-Space fence', async () => {
    db = await openPomodoroXIDB(`sync-meta-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: 'opaque-cursor-01', pendingAck: 'opaque-cursor-01',
        catalogHash, requiresFullRecovery: false },
    ))
    await expect(loadSyncV2Meta(db)).resolves.toMatchObject({
      cursor: 'opaque-cursor-01', pendingAck: 'opaque-cursor-01', catalogHash,
    })
  })

  it('compare-clears only the acknowledged pending ACK', async () => {
    db = await openPomodoroXIDB(`sync-meta-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
      db!, db!.spaceId, token,
      { cursor: 'opaque-cursor-01', pendingAck: 'opaque-cursor-01',
        catalogHash, requiresFullRecovery: false },
    ))
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
      return ok({ client_id: body.client_id, accepted: true,
        requires_recovery: false, catalog_hash: catalogHash }, config)
    }
    await withSpaceAuthorityFence(db.spaceId, (token) =>
      sendPendingAck(db!, spaceApi, db!.spaceId, 'client-a', token))
    await expect(loadSyncV2Meta(db)).resolves.toMatchObject({ pendingAck: null })
  })

  it('creates and reuses one stable client ID', async () => {
    db = await openPomodoroXIDB(`sync-meta-${crypto.randomUUID()}`)
    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      const first = await getOrCreateClientId(db!, db!.spaceId, token)
      const second = await getOrCreateClientId(db!, db!.spaceId, token)
      expect(first).toBe(second)
    })
  })
})
