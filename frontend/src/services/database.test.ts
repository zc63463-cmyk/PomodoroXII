import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'
import { PomodoroXIDB, V16_SYNC_TABLES } from '@/services/database'
import { SYNC_PLUMBING_TABLES } from '@/types/sync'
import { dexieDbNameForSpace } from '@/lib/platform'

/**
 * PomodoroXIDB 测试。
 *
 * schema 级验证：content_hash 索引存在、版本号正确。
 * upgrade 运行时验证：v15→v16 升级时 _etag 被删除、deletion_state/version
 * 被填充（通过 raw Dexie 创建 v15 旧库 + PomodoroXIDB 打开触发 upgrade）。
 */
describe('PomodoroXIDB', () => {
  it('opens a named database with tasks table then deletes it', async () => {
    const dbName = 'pomodoroxi-test-' + crypto.randomUUID()
    const db = new PomodoroXIDB(dbName)
    await db.open()
    expect(db.tasks).toBeDefined()
    expect(db.tables.some((t) => t.name === 'tasks')).toBe(true)
    await db.delete()
  })

  it('v16 schema adds content_hash index to tasks table', async () => {
    const dbName = 'pomodoroxi-v16-' + crypto.randomUUID()
    const db = new PomodoroXIDB(dbName)
    await db.open()
    const schema = db.tasks.schema
    expect(schema.indexes.some((idx) => idx.keyPath === 'content_hash')).toBe(true)
    await db.delete()
  })

  it('latest database version is 17', async () => {
    const dbName = 'pomodoroxi-ver-' + crypto.randomUUID()
    const db = new PomodoroXIDB(dbName)
    await db.open()
    expect(db.verno).toBe(17)
    await db.delete()
  })

  it('v16 upgrade strips _etag and fills deletion_state/version on existing rows', async () => {
    const dbName = 'pomodoroxi-v16-upgrade-' + crypto.randomUUID()

    // Arrange: 用 raw Dexie 模拟 v15 旧库
    const oldDb = new Dexie(dbName)
    oldDb.version(15).stores({
      tasks: 'id, status, created_at, updated_at, due_date, _dirty',
    })
    await oldDb.open()
    await oldDb.table('tasks').put({
      id: 'test-1',
      title: 'Test task from v15',
      status: 'todo',
      _etag: 'abc123',
    })
    await oldDb.close()

    // Act: 用 PomodoroXIDB 打开，触发 v15→v16 upgrade
    const db = new PomodoroXIDB(dbName)
    await db.open()

    // Assert: 验证 upgrade hook 转换
    const row = await db.tasks.get('test-1')
    expect(row).toBeDefined()
    // _etag is a v15 legacy field not in CachedTask type; cast to inspect
    const raw = row as unknown as Record<string, unknown>
    expect(raw._etag).toBeUndefined()
    expect(row!.deletion_state).toBe('active')
    expect(row!.version).toBe(1)

    await db.delete()
  })

  it('v16 upgrade applies _etag removal and deletion_state/version fill across multiple tables', async () => {
    const dbName = 'pomodoroxi-v16-multi-' + crypto.randomUUID()

    // Arrange: 用 raw Dexie 模拟 v15 旧库，声明 tasks + sessions + notes
    // （v15 时的 schema 声明，来自 database.ts 的 version(5) 和 version(15)）
    const oldDb = new Dexie(dbName)
    oldDb.version(15).stores({
      tasks: 'id, status, created_at, updated_at, due_date, _dirty',
      sessions: 'id, task_id, started_at, type, synced, _dirty, mood',
      notes: 'id, title, updated_at, category, folder_id, status, trashed_at, *tags, _dirty',
    })
    await oldDb.open()

    // 在三张表各放一行带 _etag 的 v15 数据
    await oldDb.table('tasks').put({ id: 't1', title: 'Task', status: 'todo', _etag: 'e-t1' })
    await oldDb.table('sessions').put({ id: 's1', task_id: null, type: 'work', _etag: 'e-s1' })
    await oldDb.table('notes').put({ id: 'n1', title: 'Note', _etag: 'e-n1' })
    await oldDb.close()

    // Act: 用 PomodoroXIDB 打开，触发 v15→v16 upgrade
    const db = new PomodoroXIDB(dbName)
    await db.open()

    // Assert: 三张表的行都完成了 upgrade 转换
    const task = await db.tasks.get('t1')
    const session = await db.sessions.get('s1')
    const note = await db.notes.get('n1')

    for (const row of [task, session, note]) {
      expect(row).toBeDefined()
      const raw = row as unknown as Record<string, unknown>
      expect(raw._etag).toBeUndefined()
      expect(raw.deletion_state).toBe('active')
      expect(raw.version).toBe(1)
    }

    await db.delete()
  })

  it('v16 upgrade excludes plumbing tables (F0 §3.4 / T28)', () => {
    for (const name of SYNC_PLUMBING_TABLES) {
      expect(V16_SYNC_TABLES as readonly string[]).not.toContain(name)
    }
  })

  it('v16 upgrade preserves trashed_at while filling SyncFields (F0 §3.5)', async () => {
    const dbName = 'pomodoroxi-v16-trash-' + crypto.randomUUID()
    const trashedAt = '2026-07-01T12:00:00.000Z'

    const oldDb = new Dexie(dbName)
    oldDb.version(15).stores({
      notes: 'id, title, updated_at, category, folder_id, status, trashed_at, *tags, _dirty',
    })
    await oldDb.open()
    await oldDb.table('notes').put({
      id: 'n-trash',
      title: 'Trashed note',
      trashed_at: trashedAt,
      _etag: 'legacy',
    })
    await oldDb.close()

    const db = new PomodoroXIDB(dbName)
    await db.open()
    const row = await db.notes.get('n-trash')
    expect(row?.trashed_at).toBe(trashedAt)
    expect(row?.deletion_state).toBe('active')
    expect(row?.version).toBe(1)
    const raw = row as unknown as Record<string, unknown>
    expect(raw._etag).toBeUndefined()
    await db.delete()
  })

  it('dexieDbNameForSpace matches F0 HC-3 naming', () => {
    expect(dexieDbNameForSpace('abc-123')).toBe('pomodoroxi_abc-123')
  })

  it('v17 upgrade backfills outbox rows with idempotency fields', async () => {
    const dbName = 'pomodoroxi-v17-backfill-' + crypto.randomUUID()

    // Arrange: create v16 database with outbox rows
    const oldDb = new Dexie(dbName)
    oldDb.version(16).stores({
      outbox: '++id, entityType, entityId, synced, createdAt',
    })
    await oldDb.open()
    await oldDb.table('outbox').bulkPut([
      { entityType: 'task', entityId: 't1', action: 'create', payload: JSON.stringify({ id: 't1' }), createdAt: 1, synced: false },
      { entityType: 'task', entityId: 't2', action: 'update', payload: JSON.stringify({ id: 't2', version: 3 }), createdAt: 2, synced: false },
      { entityType: 'task', entityId: 't3', action: 'delete', payload: JSON.stringify({ id: 't3' }), createdAt: 3, synced: false },
      { entityType: 'task', entityId: 't4', action: 'update', payload: JSON.stringify({ id: 't4' }), createdAt: 4, synced: false },
      { entityType: 'task', entityId: 't5', action: 'create', payload: JSON.stringify({ id: 't5' }), createdAt: 5, synced: false },
    ])
    await oldDb.close()

    // Act: open with PomodoroXIDB (triggers v17 upgrade)
    const db = new PomodoroXIDB(dbName)
    await db.open()

    // Assert: verify backfill
    const rows = await db.outbox.toArray()
    expect(rows).toHaveLength(5)
    expect(rows.every(r => typeof r.operationId === 'string' && r.operationId.length > 0)).toBe(true)

    const create1 = rows.find(r => r.entityId === 't1')!
    expect(create1.expectedVersion).toBeNull()
    expect(create1.requiresVersionRebase).toBe(false)

    const update2 = rows.find(r => r.entityId === 't2')!
    expect(update2.expectedVersion).toBe(2)
    expect(update2.requiresVersionRebase).toBe(false)

    const delete3 = rows.find(r => r.entityId === 't3')!
    expect(delete3.expectedVersion).toBeNull()
    expect(delete3.requiresVersionRebase).toBe(true)

    const update4 = rows.find(r => r.entityId === 't4')!
    expect(update4.expectedVersion).toBeNull()
    expect(update4.requiresVersionRebase).toBe(true)

    const create5 = rows.find(r => r.entityId === 't5')!
    expect(create5.expectedVersion).toBeNull()
    expect(create5.requiresVersionRebase).toBe(false)

    await db.delete()
  })

  it('v17 upgrade preserves existing outbox identity and version fields', async () => {
    const dbName = 'pomodoroxi-v17-preserve-' + crypto.randomUUID()
    const oldDb = new Dexie(dbName)
    oldDb.version(16).stores({
      outbox: '++id, entityType, entityId, synced, createdAt',
    })
    await oldDb.open()
    await oldDb.table('outbox').bulkPut([
      {
        entityType: 'task', entityId: 'known-version', action: 'update',
        payload: JSON.stringify({ id: 'known-version', version: 99 }),
        createdAt: 1, synced: false, operationId: 'persisted-operation',
        expectedVersion: 12, requiresVersionRebase: false,
      },
      {
        entityType: 'task', entityId: 'needs-rebase', action: 'delete',
        payload: JSON.stringify({ id: 'needs-rebase', version: 5 }),
        createdAt: 2, synced: false, operationId: 'persisted-rebase',
        expectedVersion: null, requiresVersionRebase: true,
      },
    ])
    await oldDb.close()

    const db = new PomodoroXIDB(dbName)
    await db.open()

    const knownVersion = await db.outbox.where('entityId').equals('known-version').first()
    expect(knownVersion?.operationId).toBe('persisted-operation')
    expect(knownVersion?.expectedVersion).toBe(12)
    expect(knownVersion?.requiresVersionRebase).toBe(false)

    const needsRebase = await db.outbox.where('entityId').equals('needs-rebase').first()
    expect(needsRebase?.operationId).toBe('persisted-rebase')
    expect(needsRebase?.expectedVersion).toBeNull()
    expect(needsRebase?.requiresVersionRebase).toBe(true)

    await db.delete()
  })

  it('v17 upgrade rollback: interruption leaves no partial backfill', async () => {
    const dbName = 'pomodoroxi-v17-interrupt-' + crypto.randomUUID()

    // Arrange: create v16 database with 5 outbox rows
    const oldDb = new Dexie(dbName)
    oldDb.version(16).stores({
      outbox: '++id, entityType, entityId, synced, createdAt',
    })
    await oldDb.open()
    await oldDb.table('outbox').bulkPut([
      { entityType: 'task', entityId: 't1', action: 'create', payload: JSON.stringify({ id: 't1' }), createdAt: 1, synced: false },
      { entityType: 'task', entityId: 't2', action: 'update', payload: JSON.stringify({ id: 't2', version: 3 }), createdAt: 2, synced: false },
      { entityType: 'task', entityId: 't3', action: 'delete', payload: JSON.stringify({ id: 't3' }), createdAt: 3, synced: false },
      { entityType: 'task', entityId: 't4', action: 'update', payload: JSON.stringify({ id: 't4' }), createdAt: 4, synced: false },
      { entityType: 'task', entityId: 't5', action: 'create', payload: JSON.stringify({ id: 't5' }), createdAt: 5, synced: false },
    ])
    await oldDb.close()

    // Patch crypto.randomUUID to throw on 3rd call (mid-upgrade)
    const originalRandomUUID = crypto.randomUUID
    let callCount = 0
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        callCount++
        if (callCount === 3) throw new Error('injected upgrade failure')
        return 'fake-uuid-' + callCount
      },
    })

    // Act: try to open with PomodoroXIDB (should fail mid-upgrade)
    let openError: Error | null = null
    const failDb = new PomodoroXIDB(dbName)
    try {
      await failDb.open()
    } catch (e) {
      openError = e as Error
    }
    try { failDb.close() } catch { /* already closed */ }

    // Restore crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: originalRandomUUID,
    })

    // Assert: upgrade failed
    expect(openError).not.toBeNull()
    expect(openError!.message).toContain('injected upgrade failure')

    // Verify no partial backfill: open raw Dexie at current version
    const checkDb = new Dexie(dbName)
    await checkDb.open()
    const rawRows = await checkDb.table('outbox').toArray()
    expect(rawRows).toHaveLength(5)
    expect(rawRows.every(r => r.operationId === undefined)).toBe(true)
    expect(rawRows.every(r => r.expectedVersion === undefined)).toBe(true)
    expect(rawRows.every(r => r.requiresVersionRebase === undefined)).toBe(true)
    await checkDb.close()

    // Re-open with PomodoroXIDB -- upgrade should now succeed
    const db = new PomodoroXIDB(dbName)
    await db.open()
    expect(db.verno).toBe(17)

    const upgradedRows = await db.outbox.toArray()
    expect(upgradedRows).toHaveLength(5)
    expect(upgradedRows.every(r => typeof r.operationId === 'string')).toBe(true)

    const create1 = upgradedRows.find(r => r.entityId === 't1')!
    expect(create1.expectedVersion).toBeNull()
    expect(create1.requiresVersionRebase).toBe(false)

    const update2 = upgradedRows.find(r => r.entityId === 't2')!
    expect(update2.expectedVersion).toBe(2)
    expect(update2.requiresVersionRebase).toBe(false)

    const delete3 = upgradedRows.find(r => r.entityId === 't3')!
    expect(delete3.expectedVersion).toBeNull()
    expect(delete3.requiresVersionRebase).toBe(true)

    await db.delete()
  })
})
