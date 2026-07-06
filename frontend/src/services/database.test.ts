import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'
import { PomodoroXIDB } from '@/services/database'

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

  it('latest database version is 16', async () => {
    const dbName = 'pomodoroxi-ver-' + crypto.randomUUID()
    const db = new PomodoroXIDB(dbName)
    await db.open()
    expect(db.verno).toBe(16)
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
})
