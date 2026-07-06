import { describe, it, expect, afterEach } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import type { OutboxEvent } from '@/types'
import {
  resolveOutboxMerge,
  enqueueOutbox,
  countUnsyncedOutbox,
  deleteOutboxByIds,
} from './outbox'
import type { OutboxAction } from './types'

/**
 * outbox.ts 单测。
 *
 * A. resolveOutboxMerge 纯函数矩阵（M1–M9，无 db 依赖）
 * B. enqueueOutbox 集成（T9–T14 + E1 非法类型）
 * C. 辅助函数（H1 countUnsyncedOutbox / H2 deleteOutboxByIds）
 *
 * 测试范式：随机 dbName + db.open() + afterEach db.delete()（对齐 database.test.ts）。
 */

async function openTestDb(): Promise<PomodoroXIDB> {
  const db = new PomodoroXIDB('outbox-test-' + crypto.randomUUID())
  await db.open()
  return db
}

/** 最小 task 行（Dexie tasks 表 primary key = id） */
function makeTask(id: string, title = 'Test') {
  return { id, title, status: 'todo' } as unknown as Parameters<
    PomodoroXIDB['tasks']['put']
  >[0]
}

// ===== A. resolveOutboxMerge 纯函数矩阵 =====

describe('resolveOutboxMerge', () => {
  const cases: Array<{
    name: string
    existing: OutboxAction
    incoming: OutboxAction
    action: string
    newAction?: OutboxAction
  }> = [
    { name: 'M1: create+delete → drop_existing', existing: 'create', incoming: 'delete', action: 'drop_existing' },
    { name: 'M2: create+create → replace', existing: 'create', incoming: 'create', action: 'replace' },
    { name: 'M3: create+update → replace', existing: 'create', incoming: 'update', action: 'replace' },
    { name: 'M4: update+delete → replace(newAction=delete)', existing: 'update', incoming: 'delete', action: 'replace', newAction: 'delete' },
    { name: 'M5: update+create → replace', existing: 'update', incoming: 'create', action: 'replace' },
    { name: 'M6: update+update → replace', existing: 'update', incoming: 'update', action: 'replace' },
    { name: 'M7: delete+create → replace(newAction=update)', existing: 'delete', incoming: 'create', action: 'replace', newAction: 'update' },
    { name: 'M8: delete+update → keep_existing', existing: 'delete', incoming: 'update', action: 'keep_existing' },
    { name: 'M9: delete+delete → keep_existing', existing: 'delete', incoming: 'delete', action: 'keep_existing' },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const result = resolveOutboxMerge(c.existing, c.incoming)
      expect(result.action).toBe(c.action)
      expect(result.newAction).toBe(c.newAction)
    })
  }
})

// ===== B. enqueueOutbox 集成 + C. 辅助函数 =====

describe('outbox integration', () => {
  let db: PomodoroXIDB

  afterEach(async () => {
    if (db) await db.delete()
  })

  // --- T9: create 入队 ---
  it('T9: enqueueOutbox create — 1 行 action=create synced=false', async () => {
    db = await openTestDb()
    await enqueueOutbox(db, 'task', 't1', 'create', { id: 't1', title: 'X' })

    const rows = await db.outbox.toArray()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.entityType).toBe('task')
    expect(row.entityId).toBe('t1')
    expect(row.action).toBe('create')
    expect(row.payload).toBe(JSON.stringify({ id: 't1', title: 'X' }))
    expect(row.synced).toBe(false)
    expect(typeof row.createdAt).toBe('number')
  })

  // --- T10: create→update 去重 ---
  it('T10: create→update — 仍 1 行 action=create (replace 无 newAction)', async () => {
    db = await openTestDb()
    const task1 = makeTask('t1', 'Task1')
    const task2 = makeTask('t1', 'Task2')
    await enqueueOutbox(db, 'task', 't1', 'create', task1)
    await enqueueOutbox(db, 'task', 't1', 'update', task2)

    const rows = await db.outbox.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('create')
    expect(rows[0]!.payload).toBe(JSON.stringify(task2))
  })

  // --- T11: create→delete drop_existing (含实体行删除) ---
  it('T11: create→delete — drop_existing: outbox 空 + tasks 表行被删', async () => {
    db = await openTestDb()
    const task = makeTask('t1', 'Task')
    await db.tasks.put(task)
    await enqueueOutbox(db, 'task', 't1', 'create', task)
    await enqueueOutbox(db, 'task', 't1', 'delete', { id: 't1' })

    const outboxRows = await db.outbox.where('entityId').equals('t1').toArray()
    expect(outboxRows).toHaveLength(0)
    expect(await db.tasks.get('t1')).toBeUndefined()
  })

  // --- T12: create→delete 无实体行 (不抛错) ---
  it('T12: create→delete 无实体行 — outbox 空，不抛错', async () => {
    db = await openTestDb()
    await enqueueOutbox(db, 'task', 't2', 'create', { id: 't2' })
    await enqueueOutbox(db, 'task', 't2', 'delete', {})

    const outboxRows = await db.outbox.where('entityId').equals('t2').toArray()
    expect(outboxRows).toHaveLength(0)
  })

  // --- T13: delete→create resurrect ---
  it('T13: delete→create — 1 行 action=update (resurrect)', async () => {
    db = await openTestDb()
    const task = makeTask('t1', 'Task')
    await enqueueOutbox(db, 'task', 't1', 'delete', { id: 't1' })
    await enqueueOutbox(db, 'task', 't1', 'create', task)

    const rows = await db.outbox.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('update')
    expect(rows[0]!.payload).toBe(JSON.stringify(task))
  })

  // --- T14: 事务内回滚 ---
  it('T14: 事务内 put task + enqueue → throw → 两者都回滚', async () => {
    db = await openTestDb()
    const task = makeTask('t1', 'Task')

    await expect(
      db.transaction('rw', db.tasks, db.outbox, async () => {
        await db.tasks.put(task)
        await enqueueOutbox(db, 'task', 't1', 'create', task)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect(await db.tasks.get('t1')).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  // --- E1: 非法 entityType ---
  it('E1: 非法 entityType → throw', async () => {
    db = await openTestDb()
    await expect(
      enqueueOutbox(db, 'invalid' as never, 'x', 'create', {}),
    ).rejects.toThrow()
  })

  // --- H1: countUnsyncedOutbox ---
  it('H1: countUnsyncedOutbox — 仅计 synced=false 的行', async () => {
    db = await openTestDb()
    const baseEvent: Omit<OutboxEvent, 'id'> = {
      entityType: 'task',
      entityId: 'e1',
      action: 'create',
      payload: '{}',
      createdAt: Date.now(),
      synced: false,
    }
    // 3 行未同步
    await db.outbox.bulkAdd([
      { ...baseEvent, entityId: 'e1' },
      { ...baseEvent, entityId: 'e2' },
      { ...baseEvent, entityId: 'e3' },
    ])
    // 2 行已同步
    await db.outbox.bulkAdd([
      { ...baseEvent, entityId: 'e4', synced: true },
      { ...baseEvent, entityId: 'e5', synced: true },
    ])

    expect(await countUnsyncedOutbox(db)).toBe(3)
  })

  // --- H2: deleteOutboxByIds ---
  it('H2: deleteOutboxByIds — 批删 + 空数组不抛', async () => {
    db = await openTestDb()
    const baseEvent: Omit<OutboxEvent, 'id'> = {
      entityType: 'task',
      entityId: 'e1',
      action: 'create',
      payload: '{}',
      createdAt: Date.now(),
      synced: false,
    }
    const ids = await db.outbox.bulkAdd([
      { ...baseEvent, entityId: 'e1' },
      { ...baseEvent, entityId: 'e2' },
      { ...baseEvent, entityId: 'e3' },
    ], { allKeys: true })

    expect(ids).toHaveLength(3)
    await deleteOutboxByIds(db, [ids[0]!, ids[1]!])
    expect(await db.outbox.count()).toBe(1)

    // 空数组不抛
    await deleteOutboxByIds(db, [])
    expect(await db.outbox.count()).toBe(1)
  })
})
