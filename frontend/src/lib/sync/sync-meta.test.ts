import { describe, it, expect, afterEach } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import { SYNC_META_KEYS } from './types'
import {
  clearPendingAck,
  clearSyncCursors,
  ensureClientId,
  loadSyncMeta,
  recordPendingAck,
  saveSyncMeta,
  touchLastFullSync,
  touchLastSyncAt,
} from './sync-meta'

/**
 * sync-meta.ts 单测（SM1–SM6）。
 *
 * 验证 F1 §2.1 syncMeta 六键的读写、偏量 upsert、清游标、隔离性。
 * 测试范式：随机 dbName + db.open() + afterEach db.delete()（对齐 database.test.ts）。
 */

async function openTestDb(): Promise<PomodoroXIDB> {
  const db = new PomodoroXIDB('sync-meta-test-' + crypto.randomUUID())
  await db.open()
  return db
}

describe('sync-meta', () => {
  let db: PomodoroXIDB

  afterEach(async () => {
    if (db) await db.delete()
  })

  it('SM1: 空库 loadSyncMeta 返回全空快照', async () => {
    db = await openTestDb()
    const meta = await loadSyncMeta(db)
    expect(meta.since).toBe('')
    expect(meta.sinceId).toBe('')
    expect(meta.tombstoneSinceId).toBe('')
    expect(meta.serverTime).toBe('')
    expect(meta.lastFullSync).toBe('')
    expect(meta.lastSyncAt).toBe('')
  })

  it('SM2: saveSyncMeta 偏量写入 — since 有值，其余仍空', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { since: '2026-01-01T00:00:00.000Z' })
    const meta = await loadSyncMeta(db)
    expect(meta.since).toBe('2026-01-01T00:00:00.000Z')
    expect(meta.sinceId).toBe('')
    expect(meta.tombstoneSinceId).toBe('')
    expect(meta.serverTime).toBe('')
    expect(meta.lastFullSync).toBe('')
    expect(meta.lastSyncAt).toBe('')
  })

  it('SM3: 写入 since + sinceId + tombstoneSinceId + serverTime — round-trip 一致', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, {
      since: '2026-07-01T00:00:00.000Z',
      sinceId: 'task-123',
      tombstoneSinceId: 'note-456',
      serverTime: '2026-07-01T12:00:00.000Z',
    })
    const meta = await loadSyncMeta(db)
    expect(meta.since).toBe('2026-07-01T00:00:00.000Z')
    expect(meta.sinceId).toBe('task-123')
    expect(meta.tombstoneSinceId).toBe('note-456')
    expect(meta.serverTime).toBe('2026-07-01T12:00:00.000Z')
    // 未写入的字段仍为空
    expect(meta.lastFullSync).toBe('')
    expect(meta.lastSyncAt).toBe('')
  })

  it('SM4: clearSyncCursors 仅清三游标，保留 serverTime/lastFullSync/lastSyncAt', async () => {
    db = await openTestDb()
    // 先写入全部六字段
    await saveSyncMeta(db, {
      since: '2026-07-01T00:00:00.000Z',
      sinceId: 'task-123',
      tombstoneSinceId: 'note-456',
      serverTime: '2026-07-01T12:00:00.000Z',
      lastFullSync: '2026-06-01T00:00:00.000Z',
      lastSyncAt: '2026-07-01T11:00:00.000Z',
    })
    // 清游标
    await clearSyncCursors(db)
    const meta = await loadSyncMeta(db)
    // 三游标清空
    expect(meta.since).toBe('')
    expect(meta.sinceId).toBe('')
    expect(meta.tombstoneSinceId).toBe('')
    // 非游标字段保留
    expect(meta.serverTime).toBe('2026-07-01T12:00:00.000Z')
    expect(meta.lastFullSync).toBe('2026-06-01T00:00:00.000Z')
    expect(meta.lastSyncAt).toBe('2026-07-01T11:00:00.000Z')
  })

  it('SM5: 两个独立 dbName — meta 不串扰', async () => {
    const db1 = await openTestDb()
    const db2 = await openTestDb()
    try {
      await saveSyncMeta(db1, { since: 'A' })
      await saveSyncMeta(db2, { since: 'B' })
      const meta1 = await loadSyncMeta(db1)
      const meta2 = await loadSyncMeta(db2)
      expect(meta1.since).toBe('A')
      expect(meta2.since).toBe('B')
    } finally {
      await db1.delete()
      await db2.delete()
    }
  })

  it('SM6: touchLastSyncAt 写入 last_sync_at key', async () => {
    db = await openTestDb()
    const iso = '2026-07-06T12:00:00.000Z'
    await touchLastSyncAt(db, iso)
    const row = await db.syncMeta.get(SYNC_META_KEYS.LAST_SYNC_AT)
    expect(row?.value).toBe(iso)
  })

  it('SM7: saveSyncMeta 空对象 no-op + undefined 值过滤', async () => {
    db = await openTestDb()
    // 空对象 → no-op
    await saveSyncMeta(db, {})
    expect(await db.syncMeta.count()).toBe(0)
    // undefined 值 → 过滤，不写入 "undefined" 字符串
    await saveSyncMeta(db, { since: undefined })
    expect(await db.syncMeta.count()).toBe(0)
    const meta = await loadSyncMeta(db)
    expect(meta.since).toBe('')
  })

  it('SM8: touchLastFullSync 写入 last_full_sync key', async () => {
    db = await openTestDb()
    const iso = '2026-07-06T00:00:00.000Z'
    await touchLastFullSync(db, iso)
    const row = await db.syncMeta.get(SYNC_META_KEYS.LAST_FULL_SYNC)
    expect(row?.value).toBe(iso)
    // 验证 loadSyncMeta 也能读到
    const meta = await loadSyncMeta(db)
    expect(meta.lastFullSync).toBe(iso)
  })

  it('SM9: nullable cursor 使用空串编码且 round-trip 保持 null', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, { cursor: null, cursorVersion: null })

    expect((await db.syncMeta.get(SYNC_META_KEYS.CURSOR))?.value).toBe('')
    expect((await db.syncMeta.get(SYNC_META_KEYS.CURSOR_VERSION))?.value).toBe('')
    const meta = await loadSyncMeta(db)
    expect(meta.cursor).toBeNull()
    expect(meta.cursorVersion).toBeNull()
  })

  it.each([
    ['null', 'null'],
    ['NaN', '2'],
    ['1.5', '2'],
    ['-1', '2'],
    ['12', '1'],
    ['12', 'broken'],
  ])('SM10: 损坏或不支持的 cursor meta %s/%s fail-closed 到 legacy', async (cursor, version) => {
    db = await openTestDb()
    await db.syncMeta.bulkPut([
      { key: SYNC_META_KEYS.CURSOR, value: cursor },
      { key: SYNC_META_KEYS.CURSOR_VERSION, value: version },
    ])

    const meta = await loadSyncMeta(db)
    expect(meta.cursor).toBeNull()
    expect(meta.cursorVersion).toBeNull()
  })

  it('SM11: ensureClientId 生成并稳定复用合法 UUID', async () => {
    db = await openTestDb()

    const first = await ensureClientId(db)
    const second = await ensureClientId(db)

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).toBe(first)
    expect((await loadSyncMeta(db)).clientId).toBe(first)
  })

  it('SM12: ensureClientId 遇损坏值时替换为新 UUID 并稳定复用', async () => {
    db = await openTestDb()
    await db.syncMeta.put({ key: SYNC_META_KEYS.CLIENT_ID, value: 'broken-client-id' })

    const repaired = await ensureClientId(db)

    expect(repaired).not.toBe('broken-client-id')
    expect(await ensureClientId(db)).toBe(repaired)
  })

  it('SM13: clearSyncCursors 保留 clientId 与 pending ACK', async () => {
    db = await openTestDb()
    await saveSyncMeta(db, {
      cursor: 12,
      cursorVersion: 2,
      clientId: '123e4567-e89b-42d3-a456-426614174000',
      pendingAckCursor: 11,
    })

    await clearSyncCursors(db)

    const meta = await loadSyncMeta(db)
    expect(meta.cursor).toBeNull()
    expect(meta.clientId).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(meta.pendingAckCursor).toBe(11)
  })

  it('SM14: recordPendingAck 只保留最大值，clearPendingAck 不误删更新后的更大值', async () => {
    db = await openTestDb()

    await recordPendingAck(db, 20)
    await recordPendingAck(db, 10)
    expect((await loadSyncMeta(db)).pendingAckCursor).toBe(20)

    await clearPendingAck(db, 19)
    expect((await loadSyncMeta(db)).pendingAckCursor).toBe(20)
    await clearPendingAck(db, 20)
    expect((await loadSyncMeta(db)).pendingAckCursor).toBeNull()
  })
})
