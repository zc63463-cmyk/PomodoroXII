import type { AxiosInstance } from 'axios'

import type { PomodoroXIDB } from '@/services/database'
import { applySyncEventRecord } from './merge'
import {
  loadSyncV2Meta,
  persistSyncV2MetaInCurrentTransaction,
  sendPendingAck,
} from './sync-meta'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { syncV2Pull } from './transport'
import type { ApiSyncV2PullResponse, PullLoopResult, SyncConflict } from './types'

export const SYNC_V2_PULL_LIMIT = 500

export function validateSyncV2PullLimit(limit: number | undefined): number {
  const value = limit ?? SYNC_V2_PULL_LIMIT
  if (!Number.isSafeInteger(value) || value < 1 || value > SYNC_V2_PULL_LIMIT) {
    throw new Error('sync v2 pull limit must be an integer from 1 to 500')
  }
  return value
}

export function assertPullProgress(
  requestedCursor: string | null,
  page: ApiSyncV2PullResponse,
): void {
  if (page.has_more && page.events.length === 0) {
    throw new Error('Pull page claims more events without a record')
  }
  if ((page.has_more || page.events.length > 0) && page.next_cursor === requestedCursor) {
    throw new Error('Pull cursor did not advance')
  }
}

export async function runPullLoopV2(
  db: PomodoroXIDB,
  api: AxiosInstance,
  spaceId: string,
  clientId: string,
  token: SpaceAuthorityToken,
  options: { limit?: number } = {},
): Promise<PullLoopResult> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  let meta = await loadSyncV2Meta(db)
  if (meta.requiresFullRecovery) throw new Error('sync v2 full recovery required')
  if (meta.pendingAck !== null) {
    await sendPendingAck(db, api, spaceId, clientId, token)
    meta = await loadSyncV2Meta(db)
  }
  if (meta.cursor === null) throw new Error('sync v2 cursor is not installed')
  const limit = validateSyncV2PullLimit(options.limit)
  let cursor: string | null = meta.cursor
  let pages = 0
  const dirtyConflicts: SyncConflict[] = []
  while (true) {
    const response: ApiSyncV2PullResponse =
      (await syncV2Pull(api, { client_id: clientId, cursor, limit })).data
    assertPullProgress(cursor, response)
    const runTransaction = db.transaction.bind(db) as unknown as (
      mode: 'rw', ...args: unknown[]
    ) => Promise<void>
    await runTransaction('rw', ...db.tables, async () => {
      requireSpaceAuthorityToken(token, spaceId)
      for (const record of response.events) {
        await applySyncEventRecord(db, spaceId, token, record, dirtyConflicts)
      }
      await persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {
        cursor: response.next_cursor,
        pendingAck: response.next_cursor,
        catalogHash: response.catalog_hash,
        requiresFullRecovery: false,
      })
    })
    await sendPendingAck(db, api, spaceId, clientId, token)
    pages += 1
    cursor = response.next_cursor
    if (!response.has_more) break
  }
  return { pages, dirtyConflicts }
}
