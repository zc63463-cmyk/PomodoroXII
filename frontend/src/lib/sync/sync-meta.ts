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
import {
  SYNC_META_KEYS,
  type PendingAckState,
  type SnapshotContinuation,
  type SyncMetaSnapshot,
} from './types'

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
  clientId: SYNC_META_KEYS.CLIENT_ID,
  clientToken: SYNC_META_KEYS.CLIENT_TOKEN,
  pendingAckCursor: SYNC_META_KEYS.PENDING_ACK_CURSOR,
  pendingAckRecoveryProof: SYNC_META_KEYS.PENDING_ACK_RECOVERY_PROOF,
  snapshotToken: SYNC_META_KEYS.SNAPSHOT_TOKEN,
  snapshotOffset: SYNC_META_KEYS.SNAPSHOT_OFFSET,
  snapshotCursor: SYNC_META_KEYS.SNAPSHOT_CURSOR,
  snapshotRecoveryVersion: SYNC_META_KEYS.SNAPSHOT_RECOVERY_VERSION,
  snapshotContinuation: SYNC_META_KEYS.SNAPSHOT_CONTINUATION,
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
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
  const pendingAckStr = map.get(SYNC_META_KEYS.PENDING_ACK_CURSOR) ?? ''
  const parsedPendingAck = Number(pendingAckStr)
  const validPendingAck = pendingAckStr !== ''
    && Number.isSafeInteger(parsedPendingAck)
    && parsedPendingAck >= 0
  const pendingAckRecoveryProof = map.get(SYNC_META_KEYS.PENDING_ACK_RECOVERY_PROOF) ?? ''
  const snapshotToken = map.get(SYNC_META_KEYS.SNAPSHOT_TOKEN) ?? ''
  const snapshotContinuation = map.get(SYNC_META_KEYS.SNAPSHOT_CONTINUATION) ?? ''
  const snapshotOffsetStr = map.get(SYNC_META_KEYS.SNAPSHOT_OFFSET) ?? ''
  const snapshotCursorStr = map.get(SYNC_META_KEYS.SNAPSHOT_CURSOR) ?? ''
  const snapshotVersionStr = map.get(SYNC_META_KEYS.SNAPSHOT_RECOVERY_VERSION) ?? ''
  const parsedSnapshotOffset = Number(snapshotOffsetStr)
  const parsedSnapshotCursor = Number(snapshotCursorStr)
  const parsedSnapshotVersion = Number(snapshotVersionStr)
  const isCanonicalNonNegativeInteger = (value: string, parsed: number): boolean =>
    /^(0|[1-9]\d*)$/.test(value)
    && Number.isSafeInteger(parsed)
    && parsed >= 0
  const validSnapshot = isUuid(snapshotToken)
    && snapshotContinuation.trim() !== ''
    && isCanonicalNonNegativeInteger(snapshotOffsetStr, parsedSnapshotOffset)
    && isCanonicalNonNegativeInteger(snapshotCursorStr, parsedSnapshotCursor)
    && snapshotVersionStr === '1'
    && parsedSnapshotVersion === 1
  return {
    since: map.get(SYNC_META_KEYS.SINCE) ?? '',
    sinceId: map.get(SYNC_META_KEYS.SINCE_ID) ?? '',
    tombstoneSinceId: map.get(SYNC_META_KEYS.TOMBSTONE_SINCE_ID) ?? '',
    serverTime: map.get(SYNC_META_KEYS.SERVER_TIME) ?? '',
    lastFullSync: map.get(SYNC_META_KEYS.LAST_FULL_SYNC) ?? '',
    lastSyncAt: map.get(SYNC_META_KEYS.LAST_SYNC_AT) ?? '',
    cursor: validCursor ? parsedCursor : null,
    cursorVersion: validCursor ? 2 : null,
    clientId: map.get(SYNC_META_KEYS.CLIENT_ID) ?? '',
    clientToken: map.get(SYNC_META_KEYS.CLIENT_TOKEN) ?? '',
    pendingAckCursor: validPendingAck ? parsedPendingAck : null,
    pendingAckRecoveryProof: validPendingAck && pendingAckRecoveryProof.trim() !== ''
      ? pendingAckRecoveryProof
      : null,
    snapshotToken: validSnapshot ? snapshotToken.toLowerCase() : null,
    snapshotOffset: validSnapshot ? parsedSnapshotOffset : null,
    snapshotCursor: validSnapshot ? parsedSnapshotCursor : null,
    snapshotRecoveryVersion: validSnapshot ? 1 : null,
    snapshotContinuation: validSnapshot ? snapshotContinuation : null,
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

/** 在 Dexie 事务中读取或生成稳定 UUID，并复读已持久化值。 */
export async function ensureClientId(db: PomodoroXIDB): Promise<string> {
  return db.transaction('rw', db.syncMeta, async () => {
    const existing = (await db.syncMeta.get(SYNC_META_KEYS.CLIENT_ID))?.value ?? ''
    if (isUuid(existing)) return existing.toLowerCase()
    await db.syncMeta.put({
      key: SYNC_META_KEYS.CLIENT_ID,
      value: crypto.randomUUID().toLowerCase(),
    })
    const persisted = (await db.syncMeta.get(SYNC_META_KEYS.CLIENT_ID))?.value ?? ''
    if (!isUuid(persisted)) throw new Error('failed to persist sync client UUID')
    return persisted.toLowerCase()
  })
}

function isValidClientToken(token: string): boolean {
  return token.length >= 32 && token.length <= 256 && token.trim() === token
}

/** 在 Dexie 事务中复用或预生成高熵设备凭证，并在任何注册请求前持久化。 */
export async function ensureClientToken(db: PomodoroXIDB): Promise<string> {
  return db.transaction('rw', db.syncMeta, async () => {
    const existing = (await db.syncMeta.get(SYNC_META_KEYS.CLIENT_TOKEN))?.value ?? ''
    if (isValidClientToken(existing)) return existing
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    await db.syncMeta.put({ key: SYNC_META_KEYS.CLIENT_TOKEN, value: token })
    const persisted = (await db.syncMeta.get(SYNC_META_KEYS.CLIENT_TOKEN))?.value ?? ''
    if (!isValidClientToken(persisted)) throw new Error('failed to persist sync client token')
    return persisted
  })
}

export async function loadPendingAckState(db: PomodoroXIDB): Promise<PendingAckState | null> {
  const meta = await loadSyncMeta(db)
  return meta.pendingAckCursor == null
    ? null
    : { cursor: meta.pendingAckCursor, recoveryProof: meta.pendingAckRecoveryProof }
}

/** 调用方可处于包含 syncMeta 的既有 Dexie 事务中。 */
export async function recordPendingAck(
  db: PomodoroXIDB,
  cursor: number,
  recoveryProof: string | null = null,
): Promise<void> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid pending ACK cursor')
  if (recoveryProof !== null && recoveryProof.trim() === '') {
    throw new Error('invalid pending ACK recovery proof')
  }
  const current = await loadPendingAckState(db)
  if (current && current.cursor > cursor) return
  if (current && current.cursor === cursor && current.recoveryProof && !recoveryProof) return
  await db.syncMeta.bulkPut([
    { key: SYNC_META_KEYS.PENDING_ACK_CURSOR, value: String(cursor) },
    { key: SYNC_META_KEYS.PENDING_ACK_RECOVERY_PROOF, value: recoveryProof ?? '' },
  ])
}

export async function clearPendingAck(db: PomodoroXIDB, acknowledged: number): Promise<void> {
  await db.transaction('rw', db.syncMeta, async () => {
    const state = await loadPendingAckState(db)
    if (state && state.cursor <= acknowledged) {
      await db.syncMeta.bulkDelete([
        SYNC_META_KEYS.PENDING_ACK_CURSOR,
        SYNC_META_KEYS.PENDING_ACK_RECOVERY_PROOF,
      ])
    }
  })
}

export async function loadSnapshotContinuation(
  db: PomodoroXIDB,
): Promise<SnapshotContinuation | null> {
  const meta = await loadSyncMeta(db)
  if (
    meta.snapshotToken == null
    || meta.snapshotOffset == null
    || meta.snapshotCursor == null
    || meta.snapshotRecoveryVersion !== 1
    || meta.snapshotContinuation == null
  ) return null
  return {
    token: meta.snapshotToken,
    offset: meta.snapshotOffset,
    cursor: meta.snapshotCursor,
    version: 1,
    recoveryContinuation: meta.snapshotContinuation,
  }
}

/** 调用方可处于包含 syncMeta 的既有 Dexie 事务中。 */
export async function saveSnapshotContinuation(
  db: PomodoroXIDB,
  continuation: SnapshotContinuation,
): Promise<void> {
  if (
    !isUuid(continuation.token)
    || !Number.isSafeInteger(continuation.offset)
    || continuation.offset < 0
    || !Number.isSafeInteger(continuation.cursor)
    || continuation.cursor < 0
    || continuation.version !== 1
    || continuation.recoveryContinuation.trim() === ''
  ) throw new Error('invalid snapshot continuation')
  await saveSyncMeta(db, {
    snapshotToken: continuation.token.toLowerCase(),
    snapshotOffset: continuation.offset,
    snapshotCursor: continuation.cursor,
    snapshotRecoveryVersion: 1,
    snapshotContinuation: continuation.recoveryContinuation,
  })
}

/** 原子清理 continuation 与对应 Seen IDs；无合法 token 时清理全部孤儿 seen。 */
export async function clearSnapshotRecovery(db: PomodoroXIDB): Promise<void> {
  await db.transaction('rw', [db.syncMeta, db.snapshotSeen], async () => {
    const token = (await db.syncMeta.get(SYNC_META_KEYS.SNAPSHOT_TOKEN))?.value ?? ''
    if (isUuid(token)) {
      await db.snapshotSeen.where('snapshotToken').equals(token.toLowerCase()).delete()
    } else {
      await db.snapshotSeen.clear()
    }
    await db.syncMeta.bulkDelete([
      SYNC_META_KEYS.SNAPSHOT_TOKEN,
      SYNC_META_KEYS.SNAPSHOT_OFFSET,
      SYNC_META_KEYS.SNAPSHOT_CURSOR,
      SYNC_META_KEYS.SNAPSHOT_RECOVERY_VERSION,
      SYNC_META_KEYS.SNAPSHOT_CONTINUATION,
    ])
  })
}

/** 清空同步游标，但保留 clientId、pendingAckCursor 与 Snapshot continuation。 */
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
