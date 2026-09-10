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

/**
 * 按作用域的游标键前缀（作用域订阅用，见 app/sync/scopes.py）。
 *
 * ★ 迁移策略：syncMeta 是 KV 表，所以 per-scope 游标**只新增 key**，
 *   完全不触碰既有的 `sync_v2_cursor`。老客户端/老数据照常工作 ——
 *   全量订阅的游标与作用域订阅的游标各存各的，互不干扰。
 *
 * ★ 为什么要分开存：全量游标是**全局语义**的，直接拿去当某个作用域的游标会
 *   丢其它作用域的事件（被越过的 id 拿不回来）。所以启用作用域订阅时，
 *   该作用域的游标必须从空开始（服务端会签发新游标），不能复用全量游标。
 */
export const SYNC_SCOPE_CURSOR_PREFIX = 'sync_v2_cursor_scope_'

/** 前端已知的作用域清单，需与后端 `app/sync/scopes.py` 的 SYNC_SCOPES 保持一致。 */
export const SYNC_SCOPES = ['planning', 'notes', 'tasks', 'focus'] as const
export type SyncScope = (typeof SYNC_SCOPES)[number]

export function scopeCursorKey(scope: string): string {
  return `${SYNC_SCOPE_CURSOR_PREFIX}${scope}`
}

export interface SyncV2MetaSnapshot {
  cursor: string | null
  pendingAck: string | null
  catalogHash: string | null
  requiresFullRecovery: boolean
  /** 按作用域的游标。空对象 = 尚未启用作用域订阅（默认）。 */
  scopeCursors: Record<string, string>
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
  for (const [scope, cursor] of Object.entries(value.scopeCursors)) {
    if (typeof scope !== 'string' || scope === '' || typeof cursor !== 'string' || cursor === '') {
      throw new Error('invalid scope cursor')
    }
  }
  return value
}

async function loadScopeCursors(db: PomodoroXIDB): Promise<Record<string, string>> {
  const rows = await db.syncMeta.bulkGet(SYNC_SCOPES.map(scopeCursorKey))
  const out: Record<string, string> = {}
  SYNC_SCOPES.forEach((scope, index) => {
    const value = rows[index]?.value
    if (value !== undefined && value !== '') out[scope] = value
  })
  return out
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
    scopeCursors: await loadScopeCursors(db),
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
  const scopeCursors = next.scopeCursors ?? {}
  await db.syncMeta.bulkPut([
    { key: SYNC_V2_META_KEYS.CURSOR, value: next.cursor ?? '' },
    { key: SYNC_V2_META_KEYS.PENDING_ACK, value: next.pendingAck ?? '' },
    { key: SYNC_V2_META_KEYS.CATALOG_HASH, value: next.catalogHash ?? '' },
    {
      key: SYNC_V2_META_KEYS.REQUIRES_FULL_RECOVERY,
      value: String(next.requiresFullRecovery),
    },
    // per-scope 游标：只写已知作用域，空值写成空串（等价于「该作用域尚无游标」）
    ...SYNC_SCOPES.map((scope) => ({
      key: scopeCursorKey(scope),
      value: scopeCursors[scope] ?? '',
    })),
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
