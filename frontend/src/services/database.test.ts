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



  it('v17 upgrade backfills operationId + expectedVersion for create rows', async () => {

    const dbName = 'pomodoroxi-v17-create-' + crypto.randomUUID()



    // Arrange: raw Dexie v16 with an outbox create row (no operationId/expectedVersion)

    const oldDb = new Dexie(dbName)

    oldDb.version(16).stores({

      outbox: '++id, entityType, entityId, synced, createdAt',

    })

    await oldDb.open()

    await oldDb.table('outbox').put({

      entityType: 'task',

      entityId: 't1',

      action: 'create',

      payload: JSON.stringify({ id: 't1', title: 'X' }),

      createdAt: 100,

      synced: false,

    })

    await oldDb.close()



    // Act: open with PomodoroXIDB → triggers v16→v17 upgrade

    const db = new PomodoroXIDB(dbName)

    await db.open()



    // Assert: create row gets operationId, expectedVersion=null, requiresVersionRebase=false

    const row = await db.outbox.where('entityId').equals('t1').first()

    expect(row).toBeDefined()

    expect(row!.operationId).toEqual(expect.any(String))

    expect(row!.operationId).toHaveLength(36)

    expect(row!.expectedVersion).toBeNull()

    expect(row!.requiresVersionRebase).toBe(false)



    await db.delete()

  })



  it('v17 upgrade backfills expectedVersion for update rows with payload version >= 2', async () => {

    const dbName = 'pomodoroxi-v17-update-' + crypto.randomUUID()



    const oldDb = new Dexie(dbName)

    oldDb.version(16).stores({

      outbox: '++id, entityType, entityId, synced, createdAt',

    })

    await oldDb.open()

    await oldDb.table('outbox').put({

      entityType: 'task',

      entityId: 't2',

      action: 'update',

      payload: JSON.stringify({ id: 't2', title: 'Updated', version: 5 }),

      createdAt: 200,

      synced: false,

    })

    await oldDb.close()



    const db = new PomodoroXIDB(dbName)

    await db.open()



    const row = await db.outbox.where('entityId').equals('t2').first()

    expect(row).toBeDefined()

    expect(row!.operationId).toEqual(expect.any(String))

    expect(row!.expectedVersion).toBe(4) // version 5 - 1 = 4

    expect(row!.requiresVersionRebase).toBe(false)



    await db.delete()

  })



  it('v17 upgrade marks unknown legacy update rows as requiresVersionRebase=true', async () => {

    const dbName = 'pomodoroxi-v17-legacy-' + crypto.randomUUID()



    const oldDb = new Dexie(dbName)

    oldDb.version(16).stores({

      outbox: '++id, entityType, entityId, synced, createdAt',

    })

    await oldDb.open()

    // Legacy update row without version in payload → fail closed

    await oldDb.table('outbox').put({

      entityType: 'task',

      entityId: 't3',

      action: 'delete',

      payload: JSON.stringify({ id: 't3' }),

      createdAt: 300,

      synced: false,

    })

    await oldDb.close()



    const db = new PomodoroXIDB(dbName)

    await db.open()



    const row = await db.outbox.where('entityId').equals('t3').first()

    expect(row).toBeDefined()

    expect(row!.operationId).toEqual(expect.any(String))

    expect(row!.expectedVersion).toBeNull()

    expect(row!.requiresVersionRebase).toBe(true)



    await db.delete()

  })



  it('v17 upgrade is atomic — all rows get backfilled in one transaction', async () => {

    const dbName = 'pomodoroxi-v17-atomic-' + crypto.randomUUID()



    const oldDb = new Dexie(dbName)

    oldDb.version(16).stores({

      outbox: '++id, entityType, entityId, synced, createdAt',

    })

    await oldDb.open()

    await oldDb.table('outbox').bulkPut([

      {

        entityType: 'task', entityId: 'a1', action: 'create',

        payload: JSON.stringify({ id: 'a1' }), createdAt: 1, synced: false,

      },

      {

        entityType: 'task', entityId: 'a2', action: 'update',

        payload: JSON.stringify({ id: 'a2', version: 3 }), createdAt: 2, synced: false,

      },

      {

        entityType: 'task', entityId: 'a3', action: 'delete',

        payload: JSON.stringify({ id: 'a3' }), createdAt: 3, synced: false,

      },

    ])

    await oldDb.close()



    const db = new PomodoroXIDB(dbName)

    await db.open()



    const rows = await db.outbox.toArray()

    expect(rows).toHaveLength(3)

    // Every row must have operationId (no partial backfill)

    for (const row of rows) {

      expect(row.operationId).toEqual(expect.any(String))

      expect(row.operationId).toHaveLength(36)

    }

    // create → expectedVersion=null, rebase=false

    const createRow = rows.find((r) => r.entityId === 'a1')!

    expect(createRow.expectedVersion).toBeNull()

    expect(createRow.requiresVersionRebase).toBe(false)

    // update with version=3 → expectedVersion=2, rebase=false

    const updateRow = rows.find((r) => r.entityId === 'a2')!

    expect(updateRow.expectedVersion).toBe(2)

    expect(updateRow.requiresVersionRebase).toBe(false)

    // delete without version → expectedVersion=null, rebase=true

    const deleteRow = rows.find((r) => r.entityId === 'a3')!

    expect(deleteRow.expectedVersion).toBeNull()

    expect(deleteRow.requiresVersionRebase).toBe(true)



    await db.delete()

  })



})
