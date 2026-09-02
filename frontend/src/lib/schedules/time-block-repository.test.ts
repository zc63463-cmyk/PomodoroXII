import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import { parseRetainedLwwOutboxPostImage } from '@/lib/sync/response-schema'

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
    _options: { mode: 'exclusive' },
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

async function flushOutbox(): Promise<void> {
  await db.outbox.toCollection().modify((row) => {
    ;(row as { attemptCount?: number }).attemptCount = 1
  })
}

describe('time-block-repository', () => {
  beforeEach(async () => {
    failureSwitch.shouldFail = false
    installLocks(new FakeLockManager())
    await spaceDBManager.switchTo(`tb-repo-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    failureSwitch.shouldFail = false
    await db.delete()
    spaceDBManager.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  const repo = () => import('./time-block-repository')

  it('createTimeBlock 写入完整行并入队', async () => {
    const { createTimeBlock, listTimeBlocks } = await repo()

    await createTimeBlock({
      id: 't1',
      title: '专注',
      date: '2026-09-10',
      start_time: '09:00',
      end_time: '10:00',
    })
    const row = await db.timeBlocks.get('t1')

    expect(row).toMatchObject({
      title: '专注',
      date: '2026-09-10',
      start_time: '09:00',
      end_time: '10:00',
      block_type: 'work',
      status: 'planned',
      actual_duration: 0,
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    })
    expect(await listTimeBlocks()).toHaveLength(1)

    const pending = await db.outbox.toArray()
    expect(pending[0]).toMatchObject({ entityType: 'timeBlock', action: 'create' })
  })

  it('★ payload 能通过同步引擎 strictObject 校验', async () => {
    // TimeBlock 字段多（10 个业务字段），最容易与 schema 错配 —— 这条就是保险
    const { createTimeBlock } = await repo()
    await createTimeBlock({
      id: 't2',
      title: 'X',
      date: '2026-09-10',
      start_time: '09:00',
      end_time: '10:00',
    })

    const payload = JSON.parse((await db.outbox.toArray())[0].payload as string)
    expect(() =>
      parseRetainedLwwOutboxPostImage('timeBlock', 'create', payload),
    ).not.toThrow()

    // 反向确认 strictObject 真的生效
    expect(() =>
      parseRetainedLwwOutboxPostImage('timeBlock', 'create', { ...payload, extra: 1 }),
    ).toThrow()
  })

  it('listTimeBlocks 可按日期筛选，并按开始时间升序', async () => {
    const { createTimeBlock, listTimeBlocks } = await repo()

    await createTimeBlock({
      id: 'late', title: '晚', date: '2026-09-10', start_time: '14:00', end_time: '15:00',
    })
    await flushOutbox()
    await createTimeBlock({
      id: 'early', title: '早', date: '2026-09-10', start_time: '09:00', end_time: '10:00',
    })
    await flushOutbox()
    await createTimeBlock({
      id: 'other', title: '另一天', date: '2026-09-11', start_time: '09:00', end_time: '10:00',
    })

    expect((await listTimeBlocks('2026-09-10')).map((b) => b.id)).toEqual(['early', 'late'])
    expect(await listTimeBlocks()).toHaveLength(3)
  })

  it('updateTimeBlock 自增 version', async () => {
    const { createTimeBlock, updateTimeBlock, getTimeBlock } = await repo()

    await createTimeBlock({
      id: 't3', title: 'A', date: '2026-09-10', start_time: '09:00', end_time: '10:00',
    })
    await flushOutbox()
    await updateTimeBlock('t3', { actual_duration: 3600, status: 'completed' })

    expect((await getTimeBlock('t3'))?.actual_duration).toBe(3600)
    expect((await db.timeBlocks.get('t3'))?.version).toBe(2)
  })

  it('deleteTimeBlock 置 deletion_state 并从列表移除', async () => {
    const { createTimeBlock, deleteTimeBlock, getTimeBlock, listTimeBlocks } = await repo()

    await createTimeBlock({
      id: 't4', title: 'A', date: '2026-09-10', start_time: '09:00', end_time: '10:00',
    })
    await flushOutbox()
    await deleteTimeBlock('t4')

    expect(await listTimeBlocks()).toHaveLength(0)
    expect(await getTimeBlock('t4')).toBeNull()

    const deleteRow = (await db.outbox.toArray()).find((e) => e.action === 'delete')
    expect(deleteRow).toBeDefined()
  })

  it('同事务铁律：入队失败时本地行不得残留', async () => {
    const { createTimeBlock } = await repo()

    failureSwitch.shouldFail = true
    await expect(
      createTimeBlock({
        id: 't5', title: 'A', date: '2026-09-10', start_time: '09:00', end_time: '10:00',
      }),
    ).rejects.toThrow()

    expect(await db.timeBlocks.get('t5')).toBeUndefined()
  })
})
