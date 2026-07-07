import { describe, it, expect, afterEach } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import { SYNC_META_KEYS } from './types'
import { loadSyncMeta, saveSyncMeta, clearSyncCursors, touchLastSyncAt, touchLastFullSync } from './sync-meta'

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
})
