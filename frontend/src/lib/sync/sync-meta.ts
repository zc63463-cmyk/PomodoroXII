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
import { SYNC_META_KEYS, type SyncMetaSnapshot } from './types'

/** SyncMetaSnapshot camelCase 字段 → SYNC_META_KEYS snake_case 值 */
const FIELD_TO_KEY: Record<keyof SyncMetaSnapshot, string> = {
  since: SYNC_META_KEYS.SINCE,
  sinceId: SYNC_META_KEYS.SINCE_ID,
  tombstoneSinceId: SYNC_META_KEYS.TOMBSTONE_SINCE_ID,
  serverTime: SYNC_META_KEYS.SERVER_TIME,
  lastFullSync: SYNC_META_KEYS.LAST_FULL_SYNC,
  lastSyncAt: SYNC_META_KEYS.LAST_SYNC_AT,
  cursor: SYNC_META_KEYS.CURSOR,
  cursorVersion: SYNC_META_KEYS.CURSOR_VERSION,
}

/** 从 syncMeta 表读取全部游标（缺失为空串/null） */
export async function loadSyncMeta(db: PomodoroXIDB): Promise<SyncMetaSnapshot> {
  const keys = Object.values(SYNC_META_KEYS)
  const rows = await db.syncMeta.bulkGet(keys)
  const map = new Map<string, string>()
  rows.forEach((row, i) => {
    if (row) map.set(keys[i], row.value)
  })
  const cursorStr = map.get(SYNC_META_KEYS.CURSOR) ?? ''
  const cursorVerStr = map.get(SYNC_META_KEYS.CURSOR_VERSION) ?? ''
  const parsedCursor = Number(cursorStr)
  const parsedVersion = Number(cursorVerStr)
  const validCursor =
    cursorStr !== '' &&
    cursorVerStr !== '' &&
    Number.isSafeInteger(parsedCursor) &&
    parsedCursor >= 0 &&
    parsedVersion === 2
  return {
    since: map.get(SYNC_META_KEYS.SINCE) ?? '',
    sinceId: map.get(SYNC_META_KEYS.SINCE_ID) ?? '',
    tombstoneSinceId: map.get(SYNC_META_KEYS.TOMBSTONE_SINCE_ID) ?? '',
    serverTime: map.get(SYNC_META_KEYS.SERVER_TIME) ?? '',
    lastFullSync: map.get(SYNC_META_KEYS.LAST_FULL_SYNC) ?? '',
    lastSyncAt: map.get(SYNC_META_KEYS.LAST_SYNC_AT) ?? '',
    cursor: validCursor ? parsedCursor : null,
    cursorVersion: validCursor ? 2 : null,
  }
}

/** 部分写入 syncMeta（upsert key-value 行），仅更新传入字段；undefined 值自动过滤 */
export async function saveSyncMeta(
  db: PomodoroXIDB,
  partial: Partial<SyncMetaSnapshot>,
): Promise<void> {
  const entries = Object.entries(partial)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => ({
      key: FIELD_TO_KEY[field as keyof SyncMetaSnapshot],
      value: value === null ? '' : String(value),
    }))
  if (entries.length > 0) await db.syncMeta.bulkPut(entries)
}

/** 清空所有游标（since/since_id/tombstone_since_id/cursor/cursor_version），保留 serverTime/lastFullSync/lastSyncAt */
export async function clearSyncCursors(db: PomodoroXIDB): Promise<void> {
  await db.syncMeta.bulkPut([
    { key: SYNC_META_KEYS.SINCE, value: '' },
    { key: SYNC_META_KEYS.SINCE_ID, value: '' },
    { key: SYNC_META_KEYS.TOMBSTONE_SINCE_ID, value: '' },
    { key: SYNC_META_KEYS.CURSOR, value: '' },
    { key: SYNC_META_KEYS.CURSOR_VERSION, value: '' },
  ])
}

/** 写入 last_sync_at（ISO 字符串），供 S1-4 UI 显示 */
export async function touchLastSyncAt(db: PomodoroXIDB, iso: string): Promise<void> {
  await db.syncMeta.put({ key: SYNC_META_KEYS.LAST_SYNC_AT, value: iso })
}

/** 写入 last_full_sync（ISO 字符串），fullSync 完成后调用（F1 §2.1） */
export async function touchLastFullSync(db: PomodoroXIDB, iso: string): Promise<void> {
  await db.syncMeta.put({ key: SYNC_META_KEYS.LAST_FULL_SYNC, value: iso })
}
