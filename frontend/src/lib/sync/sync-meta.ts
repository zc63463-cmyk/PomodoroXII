/**
 * syncMeta 读写辅助（F1 §2.1，F1-D2 锁定）。
 *
 * 管理 per-space Dexie syncMeta 表中的六键：
 * since / since_id / tombstone_since_id / server_time / last_full_sync / last_sync_at
 *
 * 所有函数首参 db: PomodoroXIDB（HC-6 per-space db 注入）。
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
}

/** 从 syncMeta 表读取全部游标（缺失为空串） */
export async function loadSyncMeta(db: PomodoroXIDB): Promise<SyncMetaSnapshot> {
  const keys = Object.values(SYNC_META_KEYS)
  const rows = await db.syncMeta.bulkGet(keys)
  const map = new Map<string, string>()
  rows.forEach((row, i) => {
    if (row) map.set(keys[i], row.value)
  })
  return {
    since: map.get(SYNC_META_KEYS.SINCE) ?? '',
    sinceId: map.get(SYNC_META_KEYS.SINCE_ID) ?? '',
    tombstoneSinceId: map.get(SYNC_META_KEYS.TOMBSTONE_SINCE_ID) ?? '',
    serverTime: map.get(SYNC_META_KEYS.SERVER_TIME) ?? '',
    lastFullSync: map.get(SYNC_META_KEYS.LAST_FULL_SYNC) ?? '',
    lastSyncAt: map.get(SYNC_META_KEYS.LAST_SYNC_AT) ?? '',
  }
}

/** 部分写入 syncMeta（upsert key-value 行），仅更新传入字段 */
export async function saveSyncMeta(
  db: PomodoroXIDB,
  partial: Partial<SyncMetaSnapshot>,
): Promise<void> {
  const entries = Object.entries(partial).map(([field, value]) => ({
    key: FIELD_TO_KEY[field as keyof SyncMetaSnapshot],
    value: String(value),
  }))
  if (entries.length > 0) await db.syncMeta.bulkPut(entries)
}

/** 清空三游标（since/since_id/tombstone_since_id），保留 serverTime/lastFullSync/lastSyncAt */
export async function clearSyncCursors(db: PomodoroXIDB): Promise<void> {
  await db.syncMeta.bulkPut([
    { key: SYNC_META_KEYS.SINCE, value: '' },
    { key: SYNC_META_KEYS.SINCE_ID, value: '' },
    { key: SYNC_META_KEYS.TOMBSTONE_SINCE_ID, value: '' },
  ])
}

/** 写入 last_sync_at（ISO 字符串），供 S1-4 UI 显示 */
export async function touchLastSyncAt(db: PomodoroXIDB, iso: string): Promise<void> {
  await db.syncMeta.put({ key: SYNC_META_KEYS.LAST_SYNC_AT, value: iso })
}
