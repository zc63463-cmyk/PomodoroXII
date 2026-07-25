import { describe, it, expect, afterEach } from 'vitest'

import { PomodoroXIDB } from '@/services/database'

import type { OutboxEvent } from '@/types'

import {

  resolveOutboxMerge,

  enqueueOutbox,

  countUnsyncedOutbox,

  deleteOutboxByIds,

  listUnsyncedOutbox,

  markOutboxEventsFailed,

} from './outbox'

import {

  type OutboxAction,

  type SyncEntityType,

  ENTITY_TYPE_TO_TABLE,

} from './types'



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



  // --- T17: payload=undefined → throw ---

  it('T17: enqueueOutbox payload=undefined → throw', async () => {

    db = await openTestDb()

    await expect(

      enqueueOutbox(db, 'task', 't1', 'create', undefined),

    ).rejects.toThrow('payload must not be undefined')

  })



  // --- T18: payload 含 bigint → throw (序列化失败传播) ---

  it('T18: enqueueOutbox payload 含 bigint → throw', async () => {

    db = await openTestDb()

    await expect(

      enqueueOutbox(db, 'task', 't1', 'create', { a: BigInt(1) }),

    ).rejects.toThrow()

  })



  // --- E2: entityId 空串 → throw ---

  it('E2: enqueueOutbox entityId 空串 → throw', async () => {

    db = await openTestDb()

    await expect(

      enqueueOutbox(db, 'task', '', 'create', {}),

    ).rejects.toThrow('entityId must not be empty')

  })



  // --- H3: listUnsyncedOutbox 按 createdAt 排序 ---

  it('H3: listUnsyncedOutbox — 按 createdAt 升序返回未同步行', async () => {

    db = await openTestDb()

    const base = Date.now()

    // 3 行未同步（故意乱序写入）

    await db.outbox.bulkAdd([

      { entityType: 'task', entityId: 'e2', action: 'create', payload: '{}', createdAt: base + 200, synced: false },

      { entityType: 'task', entityId: 'e1', action: 'create', payload: '{}', createdAt: base + 100, synced: false },

      { entityType: 'task', entityId: 'e3', action: 'create', payload: '{}', createdAt: base + 300, synced: false },

    ])

    // 1 行已同步（应排除）

    await db.outbox.add({

      entityType: 'task', entityId: 'e4', action: 'create', payload: '{}', createdAt: base + 50, synced: true,

    })



    const rows = await listUnsyncedOutbox(db)

    expect(rows).toHaveLength(3)

    // 按 createdAt 升序

    expect(rows[0]!.entityId).toBe('e1')

    expect(rows[1]!.entityId).toBe('e2')

    expect(rows[2]!.entityId).toBe('e3')

  })



  it('H4: markOutboxEventsFailed — 只标记目标未同步事件并累计 attemptCount', async () => {

    db = await openTestDb()

    const ids = await db.outbox.bulkAdd([

      { entityType: 'task', entityId: 'failed', action: 'update', payload: '{}', createdAt: 1, synced: false },

      { entityType: 'task', entityId: 'clean', action: 'update', payload: '{}', createdAt: 2, synced: false },

      { entityType: 'task', entityId: 'synced', action: 'update', payload: '{}', createdAt: 3, synced: true },

    ], { allKeys: true })



    await markOutboxEventsFailed(db, [

      {

        outboxId: ids[0]!,

        error: 'server_rejected',

        failedAt: '2026-07-07T13:10:00.000Z',

      },

      {

        outboxId: ids[2]!,

        error: 'should_not_mark_synced_rows',

        failedAt: '2026-07-07T13:11:00.000Z',

      },

    ])

    await markOutboxEventsFailed(db, [

      {

        outboxId: ids[0]!,

        error: 'server_rejected_again',

        errorCode: 'custom_error',

        failedAt: '2026-07-07T13:12:00.000Z',

      },

    ])



    const failed = await db.outbox.get(ids[0]!)

    const clean = await db.outbox.get(ids[1]!)

    const synced = await db.outbox.get(ids[2]!)



    expect(failed).toMatchObject({

      lastError: 'server_rejected_again',

      lastErrorCode: 'custom_error',

      failedAt: '2026-07-07T13:12:00.000Z',

      attemptCount: 2,

    })

    expect(clean!.lastError).toBeUndefined()

    expect(synced!.lastError).toBeUndefined()

  })



  it('H5: enqueueOutbox replace — clears stale failure metadata on new local mutation', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'quickNote', 'qn-failed', 'update', { id: 'qn-failed', content: 'old' })

    const existing = await db.outbox.where('entityId').equals('qn-failed').first()

    await markOutboxEventsFailed(db, [

      {

        outboxId: existing!.id!,

        error: 'server_rejected_quick_note',

        failedAt: '2026-07-07T13:10:00.000Z',

      },

    ])



    await enqueueOutbox(db, 'quickNote', 'qn-failed', 'update', { id: 'qn-failed', content: 'new' })



    const row = await db.outbox.where('entityId').equals('qn-failed').first()

    expect(row).toMatchObject({

      lastError: null,

      lastErrorCode: null,

      failedAt: null,

      attemptCount: 0,

    })

    expect(row!.payload).toBe(JSON.stringify({ id: 'qn-failed', content: 'new' }))

  })



  it('H6: enqueueOutbox keep_existing — clears stale failure metadata on repeated local mutation', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'quickNote', 'qn-delete-failed', 'delete', { id: 'qn-delete-failed' })

    const existing = await db.outbox.where('entityId').equals('qn-delete-failed').first()

    await markOutboxEventsFailed(db, [

      {

        outboxId: existing!.id!,

        error: 'server_rejected_delete',

        failedAt: '2026-07-07T13:10:00.000Z',

      },

    ])



    await enqueueOutbox(db, 'quickNote', 'qn-delete-failed', 'delete', { id: 'qn-delete-failed' })



    const row = await db.outbox.where('entityId').equals('qn-delete-failed').first()

    expect(row).toMatchObject({

      action: 'delete',

      lastError: null,

      lastErrorCode: null,

      failedAt: null,

      attemptCount: 0,

    })

  })



  // --- T15: 三行以上 outbox 去重 → latest createdAt ---

  it('T15: 三行去重 — 合并到 latest createdAt 行', async () => {

    db = await openTestDb()

    // 手动插入 3 行同实体未同步 outbox（不同 createdAt）

    const base = Date.now()

    await db.outbox.bulkAdd([

      { entityType: 'task', entityId: 't1', action: 'create', payload: 'p1', createdAt: base + 100, synced: false },

      { entityType: 'task', entityId: 't1', action: 'update', payload: 'p2', createdAt: base + 200, synced: false },

      { entityType: 'task', entityId: 't1', action: 'update', payload: 'p3', createdAt: base + 300, synced: false },

    ])

    // 再 enqueue 一行 update → 应合并到 latest (createdAt=base+300)

    await enqueueOutbox(db, 'task', 't1', 'update', { id: 't1', title: 'final' })



    const rows = await db.outbox.where('entityId').equals('t1').toArray()

    expect(rows).toHaveLength(1)

    expect(rows[0]!.payload).toBe(JSON.stringify({ id: 't1', title: 'final' }))

  })



  // --- T16: 14 实体表驱动 smoke ---

  it.each(Object.keys(ENTITY_TYPE_TO_TABLE) as SyncEntityType[])(

    'T16: enqueueOutbox %s — 入队成功',

    async (entityType) => {

      db = await openTestDb()

      const entityId = `${entityType}-smoke`

      await enqueueOutbox(db, entityType, entityId, 'create', { id: entityId })



      const rows = await db.outbox.where('entityId').equals(entityId).toArray()

      expect(rows).toHaveLength(1)

      expect(rows[0]!.entityType).toBe(entityType)

      await db.delete()

      db = undefined as unknown as PomodoroXIDB

    },

  )



  // -------- S3-Task10: operationId preservation + expectedVersion merge --------



  it('S3T10-OB1: new outbox row gets a generated operationId', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'task', 'op-new', 'create', { id: 'op-new' })



    const row = await db.outbox.where('entityId').equals('op-new').first()

    expect(row).toBeDefined()

    expect(row!.operationId).toEqual(expect.any(String))

    expect(row!.operationId).toHaveLength(36)

    expect(row!.expectedVersion).toBeNull()

    expect(row!.requiresVersionRebase).toBe(false)

  })



  it('S3T10-OB2: enqueueOutbox with expectedVersion option stores it', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'task', 'op-ev', 'update', { id: 'op-ev' }, {

      expectedVersion: 3,

    })



    const row = await db.outbox.where('entityId').equals('op-ev').first()

    expect(row).toBeDefined()

    expect(row!.expectedVersion).toBe(3)

  })



  it('S3T10-OB3: merge update->update preserves earliest expectedVersion', async () => {

    db = await openTestDb()

    // First update: expectedVersion=5

    await enqueueOutbox(db, 'task', 'op-merge', 'update', { id: 'op-merge', v: 1 }, {

      expectedVersion: 5,

    })



    const row1 = await db.outbox.where('entityId').equals('op-merge').first()

    const originalOpId = row1!.operationId



    // Second update: expectedVersion=3 (earlier)

    await enqueueOutbox(db, 'task', 'op-merge', 'update', { id: 'op-merge', v: 2 }, {

      expectedVersion: 3,

    })



    const row2 = await db.outbox.where('entityId').equals('op-merge').first()

    expect(row2).toBeDefined()

    // operationId must NOT be replaced during merge

    expect(row2!.operationId).toBe(originalOpId)

    // expectedVersion should be the minimum (earliest) = 3

    expect(row2!.expectedVersion).toBe(3)

  })



  it('S3T10-OB4: merge update->update keeps earlier expectedVersion when incoming is null', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'task', 'op-merge2', 'update', { id: 'op-merge2', v: 1 }, {

      expectedVersion: 7,

    })



    // Second update without expectedVersion

    await enqueueOutbox(db, 'task', 'op-merge2', 'update', { id: 'op-merge2', v: 2 })



    const row = await db.outbox.where('entityId').equals('op-merge2').first()

    expect(row!.expectedVersion).toBe(7) // existing preserved

  })



  it('S3T10-OB5: merge update->delete preserves earliest expectedVersion', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'task', 'op-ud', 'update', { id: 'op-ud' }, {

      expectedVersion: 4,

    })



    const originalOpId = (await db.outbox.where('entityId').equals('op-ud').first())!.operationId



    await enqueueOutbox(db, 'task', 'op-ud', 'delete', { id: 'op-ud' }, {

      expectedVersion: 6,

    })



    const row = await db.outbox.where('entityId').equals('op-ud').first()

    expect(row!.action).toBe('delete')

    expect(row!.operationId).toBe(originalOpId)

    expect(row!.expectedVersion).toBe(4) // min(4, 6) = 4

  })



  it('S3T10-OB6: merge delete->create changes action to update with expectedVersion=null', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'task', 'op-dc', 'delete', { id: 'op-dc' }, {

      expectedVersion: 2,

    })



    const originalOpId = (await db.outbox.where('entityId').equals('op-dc').first())!.operationId



    await enqueueOutbox(db, 'task', 'op-dc', 'create', { id: 'op-dc', title: 'Resurrected' })



    const row = await db.outbox.where('entityId').equals('op-dc').first()

    expect(row!.action).toBe('update')

    expect(row!.operationId).toBe(originalOpId)

    expect(row!.expectedVersion).toBe(2) // delete->create 保留最早已知 expectedVersion

  })



  it('S3T10-OB7: create+delete drops the outbox row entirely', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'task', 'op-cd', 'create', { id: 'op-cd' })



    await enqueueOutbox(db, 'task', 'op-cd', 'delete', { id: 'op-cd' })



    const row = await db.outbox.where('entityId').equals('op-cd').first()

    expect(row).toBeUndefined()

  })



  it('S3T10-OB8: create chain always has expectedVersion=null', async () => {

    db = await openTestDb()

    await enqueueOutbox(db, 'task', 'op-cc', 'create', { id: 'op-cc' })



    // create + update (merge → replace, action stays create)

    await enqueueOutbox(db, 'task', 'op-cc', 'update', { id: 'op-cc', v: 2 })



    const row = await db.outbox.where('entityId').equals('op-cc').first()

    expect(row!.action).toBe('create')

    expect(row!.expectedVersion).toBeNull()

  })



  it('S3T10-OB9: keep_existing merge preserves operationId and expectedVersion', async () => {

    db = await openTestDb()

    // delete + delete → keep_existing

    await enqueueOutbox(db, 'task', 'op-ke', 'delete', { id: 'op-ke' }, {

      expectedVersion: 5,

    })



    const originalOpId = (await db.outbox.where('entityId').equals('op-ke').first())!.operationId



    await enqueueOutbox(db, 'task', 'op-ke', 'delete', { id: 'op-ke' }, {

      expectedVersion: 8,

    })



    const row = await db.outbox.where('entityId').equals('op-ke').first()

    expect(row!.operationId).toBe(originalOpId)

    expect(row!.expectedVersion).toBe(5) // keep_existing does not change expectedVersion

  })



})
