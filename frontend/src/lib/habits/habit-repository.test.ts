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

describe('habit-repository', () => {
  beforeEach(async () => {
    failureSwitch.shouldFail = false
    installLocks(new FakeLockManager())
    await spaceDBManager.switchTo(`habit-repo-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    failureSwitch.shouldFail = false
    await db.delete()
    spaceDBManager.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  const repo = () => import('./habit-repository')

  it('createHabit 写入完整行并入队', async () => {
    const { createHabit, listHabits } = await repo()

    await createHabit({ id: 'h1', title: '读书' })
    const row = await db.habits.get('h1')

    expect(row).toMatchObject({
      title: '读书',
      target_count: 1,
      archived: false,
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    })
    expect(await listHabits()).toHaveLength(1)

    const pending = await db.outbox.toArray()
    expect(pending[0]).toMatchObject({ entityType: 'habit', action: 'create' })
  })

  it('★ 同一天重复打卡递增 count，不新建行', async () => {
    const { checkIn, listCheckIns } = await repo()

    await checkIn('h1', '2026-09-02')
    await flushOutbox()
    await checkIn('h1', '2026-09-02')

    const rows = await listCheckIns('h1')
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(2)
  })

  it('不同日期各一行', async () => {
    const { checkIn, listCheckIns } = await repo()

    await checkIn('h1', '2026-09-01')
    await flushOutbox()
    await checkIn('h1', '2026-09-02')

    expect(await listCheckIns('h1')).toHaveLength(2)
  })

  it('removeCheckIn 递减，归零则删行', async () => {
    const { checkIn, removeCheckIn, listCheckIns } = await repo()

    await checkIn('h1', '2026-09-02')
    await flushOutbox()
    await checkIn('h1', '2026-09-02')
    await flushOutbox()

    await removeCheckIn('h1', '2026-09-02')
    expect((await listCheckIns('h1'))[0].count).toBe(1)

    await flushOutbox()
    await removeCheckIn('h1', '2026-09-02')
    expect(await listCheckIns('h1')).toHaveLength(0)
  })

  it('归档是软删除：默认列表不含，可显式取回', async () => {
    const { createHabit, archiveHabit, listHabits } = await repo()

    await createHabit({ id: 'h1', title: 'A' })
    await flushOutbox()
    await archiveHabit('h1')

    expect(await listHabits()).toHaveLength(0)
    expect(await listHabits({ includeArchived: true })).toHaveLength(1)
    expect((await db.habits.get('h1'))?.archived).toBe(true)
  })

  it('payload 能通过同步引擎 strictObject 校验', async () => {
    const { createHabit } = await repo()
    await createHabit({ id: 'h2', title: 'X' })

    const row = (await db.outbox.toArray()).find((e) => e.entityType === 'habit')!
    const payload = JSON.parse(row.payload as string)
    expect(() =>
      parseRetainedLwwOutboxPostImage('habit', 'create', payload),
    ).not.toThrow()

    // 反向确认 strictObject 真的生效
    expect(() =>
      parseRetainedLwwOutboxPostImage('habit', 'create', { ...payload, extra: 1 }),
    ).toThrow()
  })

  it('同事务铁律：入队失败时本地行不得残留', async () => {
    const { createHabit } = await repo()

    failureSwitch.shouldFail = true
    await expect(createHabit({ id: 'h3', title: 'A' })).rejects.toThrow()

    expect(await db.habits.get('h3')).toBeUndefined()
  })
})
