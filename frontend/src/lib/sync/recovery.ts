import { canonicalize } from 'json-canonicalize'
import { z } from 'zod'
import Dexie from 'dexie'

import type { ApiSyncV2RecoveryResponse, SnapshotEntityRecord } from './types'
import { FINAL_SYNC_ENTITY_TO_TABLE, FINAL_SYNC_ENTITY_TYPE_SET } from './types'
import { parseIJsonTextRejectingDuplicateKeys } from './response-schema'
import {
  decodeCanonicalStandardBase64,
} from './response-schema'
import { sha256HexBytes } from './authority-identity'
import type { AxiosInstance } from 'axios'
import type { PomodoroXIDB } from '@/services/database'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { syncV2Recover } from './transport'
import { sendPendingAck, persistSyncV2MetaInCurrentTransaction } from './sync-meta'

const snapshotEntityRecord = z.strictObject({
  kind: z.literal('entity'),
  entity_type: z.string().refine((value) => FINAL_SYNC_ENTITY_TYPE_SET.has(value)),
  entity_id: z.string().min(1),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
  payload: z.record(z.string(), z.unknown()),
})

export function parseCanonicalJsonLines(bytes: Uint8Array): SnapshotEntityRecord[] {
  if (bytes.length === 0) return []
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.endsWith('\n')) throw new Error('canonical JSONL must end with LF')
  const lines = text.slice(0, -1).split('\n')
  if (lines.some((line) => line.length === 0)) {
    throw new Error('canonical JSONL contains an empty record')
  }
  return lines.map((line) => {
    const parsed = parseIJsonTextRejectingDuplicateKeys(line)
    if (canonicalize(parsed) !== line) throw new Error('JSONL record is not canonical')
    return snapshotEntityRecord.parse(parsed) as SnapshotEntityRecord
  })
}

export async function verifyChunkSha256(
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  const actual = await sha256HexBytes(bytes)
  if (actual !== expectedSha256) throw new Error('recovery chunk hash mismatch')
}

export function assertRecoveryTokenProgress(
  pageTokenUsed: string | null,
  page: ApiSyncV2RecoveryResponse,
): void {
  if (page.has_more) {
    if (page.next_page_token === null || page.next_page_token === pageTokenUsed) {
      throw new Error('Recovery token did not advance')
    }
    return
  }
  if (page.next_page_token !== null) {
    throw new Error('Terminal recovery page has a continuation token')
  }
}

async function applyCleanRecoveryRecords(
  db: PomodoroXIDB,
  spaceId: string,
  records: readonly SnapshotEntityRecord[],
): Promise<void> {
  const seen = new Set<string>()
  const protectedKeys = new Set(
    (await db.outbox.toArray())
      .filter((row) => row.spaceId === spaceId && !row.synced)
      .map((row) => `${row.entityType}:${row.entityId}`),
  )
  for (const record of records) {
    const tableName = FINAL_SYNC_ENTITY_TO_TABLE[record.entity_type]
    const table = (db as unknown as Record<string, {
      get: (key: string) => Promise<Record<string, unknown> | undefined>
      put: (value: Record<string, unknown>) => Promise<unknown>
    }>)[tableName]
    if (!table) throw new Error(`unknown recovery table ${record.entity_type}`)
    const key = record.entity_id
    seen.add(`${record.entity_type}:${key}`)
    const local = await table.get(key)
    const dirty = local?._dirty === true ||
      (record.entity_type === 'workItemNote' && local?.syncState !== 'clean')
    if (dirty || protectedKeys.has(`${record.entity_type}:${key}`)) continue
    await table.put({
      ...record.payload,
      id: (record.payload.id as string | undefined) ?? key,
      version: record.version,
      updated_at: record.updated_at,
      _dirty: false,
      ...(record.entity_type === 'workItemNote' ? { syncState: 'clean', localRevision: 0 } : {}),
    })
  }
  // Stale clean rows are intentionally reconciled only for final entities and only
  // when no unsynced outbox row protects their identity.
  for (const [entityType, tableName] of Object.entries(FINAL_SYNC_ENTITY_TO_TABLE)) {
    const table = (db as unknown as Record<string, {
      toArray: () => Promise<Array<Record<string, unknown>>>
      bulkDelete: (keys: string[]) => Promise<unknown>
    }>)[tableName]
    if (!table) continue
    const stale = (await table.toArray())
      .filter((row) => row._dirty !== true &&
        !protectedKeys.has(`${entityType}:${String(row.id)}`) &&
        !seen.has(`${entityType}:${String(row.id)}`))
      .map((row) => String(row.id))
    if (stale.length > 0) await table.bulkDelete(stale)
  }
}

export async function runFullRecovery(
  db: PomodoroXIDB,
  api: AxiosInstance,
  spaceId: string,
  clientId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  let state = await db.syncRecoveryState.get('active')
  if (state && (state.spaceId !== spaceId || state.clientId !== clientId)) {
    throw new Error('Recovery state belongs to another Space or sync client')
  }
  while (!state || state.state === 'downloading') {
    const response = (await syncV2Recover(api, {
      client_id: clientId,
      page_token: state?.nextPageToken ?? null,
    })).data
    assertRecoveryTokenProgress(state?.nextPageToken ?? null, response)
    const bytes = decodeCanonicalStandardBase64(response.payload_jsonl_base64)
    await verifyChunkSha256(bytes, response.chunk_sha256)
    const records = parseCanonicalJsonLines(bytes)
    if (records.length !== response.entity_count) {
      throw new Error('Recovery entity count mismatch')
    }
    const recoveryId = state?.recoveryId ?? crypto.randomUUID()
    if (state && (state.catalogHash !== response.catalog_hash ||
        state.waterlineCursor !== response.waterline_cursor)) {
      throw new Error('Recovery page bindings changed')
    }
    await db.transaction('rw', db.syncRecoveryState, db.syncRecoveryChunks, async () => {
      requireSpaceAuthorityToken(token, spaceId)
      await db.syncRecoveryChunks.put({
        spaceId, recoveryId, index: state?.nextChunkIndex ?? 0,
        sha256: response.chunk_sha256, entityCount: response.entity_count,
        payloadJsonlBase64: response.payload_jsonl_base64,
        pageTokenUsed: state?.nextPageToken ?? null,
        nextPageToken: response.next_page_token, hasMore: response.has_more,
        catalogHash: response.catalog_hash, waterlineCursor: response.waterline_cursor,
      })
      await db.syncRecoveryState.put({
        key: 'active', spaceId, recoveryId, clientId,
        nextPageToken: response.next_page_token,
        catalogHash: response.catalog_hash, waterlineCursor: response.waterline_cursor,
        nextChunkIndex: (state?.nextChunkIndex ?? 0) + 1,
        state: response.has_more ? 'downloading' : 'ready',
      })
    })
    state = await db.syncRecoveryState.get('active')
  }
  if (!state) throw new Error('Recovery state disappeared')
  const runTransaction = db.transaction.bind(db) as unknown as (
    mode: 'rw', ...args: unknown[]
  ) => Promise<void>
  await runTransaction('rw', ...db.tables, db.syncMeta, db.syncRecoveryState, db.syncRecoveryChunks, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const chunks = await db.syncRecoveryChunks.where('recoveryId').equals(state!.recoveryId).sortBy('index')
    if (chunks.length !== state!.nextChunkIndex || chunks.some((chunk, index) => chunk.index !== index)) {
      throw new Error('Recovery staging sequence is invalid')
    }
    const records: SnapshotEntityRecord[] = []
    for (const chunk of chunks) {
      const bytes = decodeCanonicalStandardBase64(chunk.payloadJsonlBase64)
      await Dexie.waitFor(verifyChunkSha256(bytes, chunk.sha256))
      const parsed = parseCanonicalJsonLines(bytes)
      if (parsed.length !== chunk.entityCount) throw new Error('Recovery staged count mismatch')
      records.push(...parsed)
    }
    await applyCleanRecoveryRecords(db, spaceId, records)
    await persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {
      cursor: state!.waterlineCursor,
      pendingAck: state!.waterlineCursor,
      catalogHash: state!.catalogHash,
      requiresFullRecovery: true,
    })
    await db.syncRecoveryChunks.where('recoveryId').equals(state!.recoveryId).delete()
    await db.syncRecoveryState.delete('active')
  })
  await sendPendingAck(db, api, spaceId, clientId, token)
}
