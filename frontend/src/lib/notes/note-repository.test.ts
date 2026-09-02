import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import { parseRetainedLwwOutboxPostImage } from '@/lib/sync/response-schema'
import {
  ENTITY_TYPE_TO_TABLE,
  FINAL_SYNC_ENTITY_TYPE_SET,
} from '@/lib/sync/types'
import {
  createNote,
  getNote,
  listNotes,
  listPendingNoteIds,
  listTrashedNotes,
  moveNoteToTrash,
  purgeNote,
  restoreNote,
  updateNote,
  updateNoteContent,
} from './note-repository'

/**
 * 让 enqueueOutbox 可控地失败，用于验证「写本地行 + 写 outbox 同事务」。
 * 若两者被拆成两个事务，入队失败时本地行会残留——那正是铁律要防的事故。
 */
const failureSwitch = vi.hoisted(() => ({ shouldFail: false }))

vi.mock('@/lib/sync/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync/outbox')>()
  return {
    ...actual,
    enqueueOutbox: async (...args: Parameters<typeof actual.enqueueOutbox>) => {
      if (failureSwitch.shouldFail) throw new Error('outbox enqueue failed (test)')
      return actual.enqueueOutbox(...args)
    },
  }
})

class FakeLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    const result = previous.then(callback)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(name, tail)
    void tail.finally(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name)
    })
    return result
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

function installLocks(locks: FakeLockManager | undefined): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
}

describe('note-repository', () => {
  beforeEach(async () => {
    failureSwitch.shouldFail = false
    installLocks(new FakeLockManager())
    await spaceDBManager.switchTo(`note-repo-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    failureSwitch.shouldFail = false
    await db.delete()
    spaceDBManager.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  it('写入完整行并标记 _dirty，同时入队 create', async () => {
    const note = await createNote({ id: 'n1', title: 'T', content: 'body' })
    const row = await db.notes.get('n1')

    expect(note).toMatchObject({ id: 'n1', title: 'T', content: 'body', status: 'active' })
    expect(row).toMatchObject({
      version: 1,
      deletion_state: 'active',
      _dirty: true,
      trashed_at: null,
    })

    const pending = await db.outbox.toArray()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ entityType: 'note', entityId: 'n1', action: 'create' })
  })

  it('update 自增 version；同一待推窗口内与 create 合并为一行', async () => {
    await createNote({ id: 'n2', title: 'before', content: 'c' })
    await updateNote('n2', { title: 'after' })

    const row = await db.notes.get('n2')
    expect(row?.title).toBe('after')
    expect(row?.version).toBe(2)

    // 实体尚未推送就再次变更 → enqueueOutbox 合并为一行，action 仍为 create。
    // 净效果是"创建这条最终内容"，不会堆出多条待推事件。
    const pending = await db.outbox.toArray()
    expect(pending).toHaveLength(1)
    expect(pending[0].action).toBe('create')
  })

  it('更新正文时 payload 保留 content —— 服务端靠它写 .md 与 FTS5', async () => {
    await createNote({ id: 'n3', title: 'T', content: 'v1' })
    await updateNoteContent('n3', 'v2 body')

    expect((await getNote('n3'))?.content).toBe('v2 body')

    // outbox 的 payload 以 JSON 字符串存储
    const row = (await db.outbox.toArray())[0]
    const stored = JSON.parse(row.payload as string) as Record<string, unknown>
    expect(stored).toMatchObject({ content: 'v2 body' })
  })

  it('已推送过的笔记再变更 → 新增独立行并携带 expectedVersion', async () => {
    await createNote({ id: 'n7', title: 'T', content: 'c' })
    // attemptCount > 0 的行不参与合并，模拟该 create 已推送出去
    await db.outbox.toCollection().modify((row) => {
      ;(row as { attemptCount?: number }).attemptCount = 1
    })

    await updateNote('n7', { title: 'v2' })

    const updateRow = (await db.outbox.toArray()).find((e) => e.action === 'update')
    expect(updateRow).toBeDefined()
    expect(updateRow?.expectedVersion).toBe(1)
  })

  it('软删除与恢复往返，不产生硬删除墓碑', async () => {
    await createNote({ id: 'n4', title: 'T', content: 'c' })

    await moveNoteToTrash('n4')
    expect((await db.notes.get('n4'))?.trashed_at).not.toBeNull()
    expect(await listNotes()).toHaveLength(0)
    expect(await listTrashedNotes()).toHaveLength(1)

    await restoreNote('n4')
    expect((await db.notes.get('n4'))?.trashed_at).toBeNull()
    expect(await listNotes()).toHaveLength(1)

    const actions = (await db.outbox.toArray()).map((e) => e.action)
    expect(actions).not.toContain('delete')
    expect((await db.notes.get('n4'))?.deletion_state).toBe('active')
  })

  it('purge 未推送过的笔记 → 合并为 drop_existing，本地与队列一并清除', async () => {
    await createNote({ id: 'n5', title: 'T', content: 'c' })
    await purgeNote('n5')

    // 创建尚未推送就删除 → 净效果是"什么都没发生过"。
    // 因此不该留下墓碑，实体行也应被物理删除（enqueueOutbox 的 drop_existing 分支）。
    expect(await db.notes.get('n5')).toBeUndefined()
    expect(await db.outbox.toArray()).toHaveLength(0)
  })

  describe('同步联调（无需服务端）', () => {
    it('note 已注册为同步实体，且映射到 notes 表', () => {
      expect(FINAL_SYNC_ENTITY_TYPE_SET.has('note')).toBe(true)
      expect(ENTITY_TYPE_TO_TABLE.note).toBe('notes')
    })

    it('create 的 payload 能通过同步引擎的 strictObject 校验', async () => {
      // note 的 post-image schema 是 z.strictObject —— 多一个字段就会被拒。
      // 这条断言把「仓储产出」与「同步引擎期望」钉在一起，不需要起服务端。
      await createNote({ id: 'n8', title: 'T', content: 'body', tags: ['a'] })

      const row = (await db.outbox.toArray())[0]
      const payload = JSON.parse(row.payload as string)

      expect(() =>
        parseRetainedLwwOutboxPostImage('note', 'create' as const, payload),
      ).not.toThrow()

      // 反向确认：多塞一个字段必须被拒（证明 strictObject 真的生效）
      expect(() =>
        parseRetainedLwwOutboxPostImage('note', 'create' as const, {
          ...payload,
          content_hash: 'x',
        }),
      ).toThrow()
    })

    it('delete 的 payload 也能通过校验', async () => {
      await createNote({ id: 'n9', title: 'T', content: 'c' })
      // 让 create 变为不可合并，purge 才会真的产生 delete 行
      await db.outbox.toCollection().modify((row) => {
        ;(row as { attemptCount?: number }).attemptCount = 1
      })
      await purgeNote('n9')

      const deleteRow = (await db.outbox.toArray()).find((e) => e.action === 'delete')
      expect(deleteRow).toBeDefined()

      const payload = JSON.parse(deleteRow!.payload as string)
      expect(() =>
        parseRetainedLwwOutboxPostImage('note', 'delete' as const, payload),
      ).not.toThrow()
    })
  })

  it('同事务铁律：入队失败时本地行不得残留', async () => {
    failureSwitch.shouldFail = true

    await expect(createNote({ id: 'n6', title: 'T', content: 'c' })).rejects.toThrow()

    // 若写行与入队被拆成两个事务，这里会拿到一条 _dirty=true 却永远推不出去的孤儿行。
    expect(await db.notes.get('n6')).toBeUndefined()
    expect(await listPendingNoteIds()).toEqual([])
  })
})
