/**
 * syncMeta 读写辅助（F1 §2.1，F1-D2 锁定，H2-D 新增 cursor/cursor_version）。
 *
 * 管理 per-space Dexie syncMeta 表中的八键：
 * since / since_id / tombstone_since_id / server_time / last_full_sync / last_sync_at
 * / cursor / cursor_version
 *
 * cursor 优先于旧三游标；cursor=null 或缺失时回退旧协议。
 */

import type { PomodoroXIDB } from '@/services/database'
import type { AxiosInstance } from 'axios'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { syncV2Ack } from './transport'

export const SYNC_V2_META_KEYS = {
  CURSOR: 'sync_v2_cursor',
  PENDING_ACK: 'sync_v2_pending_ack',
  CATALOG_HASH: 'sync_v2_catalog_hash',
  REQUIRES_FULL_RECOVERY: 'sync_v2_requires_full_recovery',
} as const

export interface SyncV2MetaSnapshot {
  cursor: string | null
  pendingAck: string | null
  catalogHash: string | null
  requiresFullRecovery: boolean
}

function optionalOpaqueMetaValue(value: string | undefined, label: string): string | null {
  if (value === undefined || value === '') return null
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${label}`)
  }
  return value
}

function requireValidSyncV2Meta(value: SyncV2MetaSnapshot): SyncV2MetaSnapshot {
  if (value.catalogHash !== null && !/^[0-9a-f]{64}$/.test(value.catalogHash)) {
    throw new Error('invalid sync v2 catalog hash')
  }
  if (value.pendingAck !== null && value.pendingAck !== value.cursor) {
    throw new Error('pending ACK must equal the durably installed cursor')
  }
  return value
}

export async function loadSyncV2Meta(db: PomodoroXIDB): Promise<SyncV2MetaSnapshot> {
  const keys = Object.values(SYNC_V2_META_KEYS)
  const rows = await db.syncMeta.bulkGet(keys)
  const values = new Map<string, string>()
  for (const row of rows) {
    if (row !== undefined) values.set(row.key, row.value)
  }
  const recovery = values.get(SYNC_V2_META_KEYS.REQUIRES_FULL_RECOVERY)
  if (recovery !== undefined && recovery !== 'true' && recovery !== 'false') {
    throw new Error('invalid sync v2 recovery flag')
  }
  return requireValidSyncV2Meta({
    cursor: optionalOpaqueMetaValue(values.get(SYNC_V2_META_KEYS.CURSOR), 'cursor'),
    pendingAck: optionalOpaqueMetaValue(
      values.get(SYNC_V2_META_KEYS.PENDING_ACK), 'pending ACK'),
    catalogHash: optionalOpaqueMetaValue(
      values.get(SYNC_V2_META_KEYS.CATALOG_HASH), 'catalog hash'),
    requiresFullRecovery: recovery === undefined ? true : recovery === 'true',
  })
}

export async function persistSyncV2MetaInCurrentTransaction(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  patch: Partial<SyncV2MetaSnapshot>,
): Promise<SyncV2MetaSnapshot> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const next = requireValidSyncV2Meta({ ...await loadSyncV2Meta(db), ...patch })
  await db.syncMeta.bulkPut([
    { key: SYNC_V2_META_KEYS.CURSOR, value: next.cursor ?? '' },
    { key: SYNC_V2_META_KEYS.PENDING_ACK, value: next.pendingAck ?? '' },
    { key: SYNC_V2_META_KEYS.CATALOG_HASH, value: next.catalogHash ?? '' },
    {
      key: SYNC_V2_META_KEYS.REQUIRES_FULL_RECOVERY,
      value: String(next.requiresFullRecovery),
    },
  ])
  return next
}

export async function writeSyncV2Meta(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  patch: Partial<SyncV2MetaSnapshot>,
): Promise<SyncV2MetaSnapshot> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  return db.transaction('rw', db.syncMeta, async () =>
    persistSyncV2MetaInCurrentTransaction(db, spaceId, token, patch))
}

export async function sendPendingAck(
  db: PomodoroXIDB,
  api: AxiosInstance,
  spaceId: string,
  clientId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const before = await loadSyncV2Meta(db)
  if (before.pendingAck === null) return
  if (before.catalogHash === null) throw new Error('pending ACK has no catalog binding')
  const acknowledged = before.pendingAck
  const response = (await syncV2Ack(api, {
    client_id: clientId,
    cursor: acknowledged,
  })).data
  if (!response.accepted || response.requires_recovery ||
      response.catalog_hash !== before.catalogHash) {
    throw new Error('ACK response did not accept the bound recovery generation')
  }
  await db.transaction('rw', db.syncMeta, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const current = await loadSyncV2Meta(db)
    if (current.pendingAck !== acknowledged) return
    await persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {
      pendingAck: null,
      requiresFullRecovery: false,
    })
  })
}
