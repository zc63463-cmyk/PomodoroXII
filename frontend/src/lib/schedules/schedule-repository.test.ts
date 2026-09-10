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

describe('schedule-repository', () => {
  beforeEach(async () => {
    failureSwitch.shouldFail = false
    installLocks(new FakeLockManager())
    await spaceDBManager.switchTo(`schedule-repo-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    failureSwitch.shouldFail = false
    await db.delete()
    spaceDBManager.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  const repo = () => import('./schedule-repository')

  it('createSchedule 写入完整行并入队', async () => {
    const { createSchedule, listSchedules } = await repo()

    await createSchedule({ id: 's1', title: '评审会', due_at: '2026-09-10T10:00:00.000Z' })
    const row = await db.schedules.get('s1')

    expect(row).toMatchObject({
      title: '评审会',
      due_at: '2026-09-10T10:00:00.000Z',
      completed_at: null,
      priority: 'medium',
      all_day: false,
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    })
    expect(await listSchedules()).toHaveLength(1)

    const pending = await db.outbox.toArray()
    expect(pending[0]).toMatchObject({ entityType: 'schedule', action: 'create' })
  })

  it('payload 能通过同步引擎 strictObject 校验', async () => {
    const { createSchedule } = await repo()
    await createSchedule({ id: 's2', title: 'X', due_at: '2026-09-10T10:00:00.000Z' })

    const payload = JSON.parse((await db.outbox.toArray())[0].payload as string)
    expect(() =>
      parseRetainedLwwOutboxPostImage('schedule', 'create', payload),
    ).not.toThrow()

    // 反向确认 strictObject 真的生效
    expect(() =>
      parseRetainedLwwOutboxPostImage('schedule', 'create', { ...payload, extra: 1 }),
    ).toThrow()
  })

  it('updateSchedule 自增 version', async () => {
    const { createSchedule, updateSchedule, getSchedule } = await repo()

    await createSchedule({ id: 's3', title: 'A', due_at: '2026-09-10T10:00:00.000Z' })
    await flushOutbox()
    await updateSchedule('s3', { title: 'B', priority: 'high' })

    expect((await getSchedule('s3'))?.title).toBe('B')
    expect((await getSchedule('s3'))?.priority).toBe('high')
    expect((await db.schedules.get('s3'))?.version).toBe(2)
  })

  it('★ completeSchedule 双向可用：完成与取消完成', async () => {
    const { createSchedule, completeSchedule, getSchedule } = await repo()

    await createSchedule({ id: 's4', title: 'A', due_at: '2026-09-10T10:00:00.000Z' })
    expect((await getSchedule('s4'))?.completed_at).toBeNull()

    await completeSchedule('s4', '2026-09-10T11:00:00.000Z')
    expect((await getSchedule('s4'))?.completed_at).toBe('2026-09-10T11:00:00.000Z')

    await flushOutbox()
    // 传 null 表示取消完成
    await completeSchedule('s4', null)
    expect((await getSchedule('s4'))?.completed_at).toBeNull()
  })

  it('deleteSchedule 置 deletion_state 并从列表移除', async () => {
    const { createSchedule, deleteSchedule, getSchedule, listSchedules } = await repo()

    await createSchedule({ id: 's5', title: 'A', due_at: '2026-09-10T10:00:00.000Z' })
    await flushOutbox()
    await deleteSchedule('s5')

    expect(await listSchedules()).toHaveLength(0)
    expect(await getSchedule('s5')).toBeNull()
    expect((await db.schedules.get('s5'))?.deletion_state).toBe('deleted')

    const deleteRow = (await db.outbox.toArray()).find((e) => e.action === 'delete')
    expect(deleteRow).toBeDefined()
  })

  it('listSchedules 按 due_at 升序', async () => {
    const { createSchedule, listSchedules } = await repo()

    await createSchedule({ id: 'late', title: '晚', due_at: '2026-09-20T10:00:00.000Z' })
    await flushOutbox()
    await createSchedule({ id: 'early', title: '早', due_at: '2026-09-01T10:00:00.000Z' })

    expect((await listSchedules()).map((s) => s.id)).toEqual(['early', 'late'])
  })

  it('同事务铁律：入队失败时本地行不得残留', async () => {
    const { createSchedule } = await repo()

    failureSwitch.shouldFail = true
    await expect(
      createSchedule({ id: 's6', title: 'A', due_at: '2026-09-10T10:00:00.000Z' }),
    ).rejects.toThrow()

    expect(await db.schedules.get('s6')).toBeUndefined()
  })

  describe('listSyncedSchedules 的 range 筛选', () => {
    /** 铺三条跨月日程：8/31、9/15、10/01。 */
    async function seedThree() {
      const { createSchedule } = await repo()
      await createSchedule({ id: 'aug', title: '八月末', due_at: '2026-08-31T10:00:00.000Z' })
      await flushOutbox()
      await createSchedule({ id: 'sep', title: '九月中', due_at: '2026-09-15T10:00:00.000Z' })
      await flushOutbox()
      await createSchedule({ id: 'oct', title: '十月初', due_at: '2026-10-01T10:00:00.000Z' })
    }

    it('不传 range → 全量', async () => {
      const { listSyncedSchedules } = await repo()
      await seedThree()

      expect((await listSyncedSchedules()).map((s) => s.id)).toEqual([
        'aug',
        'sep',
        'oct',
      ])
    })

    it('★ 按月份筛选，只返回当月的', async () => {
      const { listSyncedSchedules } = await repo()
      await seedThree()

      const september = await listSyncedSchedules({ from: '2026-09-01', to: '2026-09-30' })
      expect(september.map((s) => s.id)).toEqual(['sep'])
    })

    it('★ 两端都包含（闭区间）', async () => {
      const { listSyncedSchedules } = await repo()
      await seedThree()

      // 9/15 与 10/01 都要命中 —— 边界日不能被排除
      const span = await listSyncedSchedules({ from: '2026-09-15', to: '2026-10-01' })
      expect(span.map((s) => s.id)).toEqual(['sep', 'oct'])

      // 只给一端也应生效
      const fromOnly = await listSyncedSchedules({ from: '2026-09-01' })
      expect(fromOnly.map((s) => s.id)).toEqual(['sep', 'oct'])
      const toOnly = await listSyncedSchedules({ to: '2026-09-30' })
      expect(toOnly.map((s) => s.id)).toEqual(['aug', 'sep'])
    })

    it('范围内无数据 → 空数组', async () => {
      const { listSyncedSchedules } = await repo()
      await seedThree()

      expect(await listSyncedSchedules({ from: '2025-01-01', to: '2025-12-31' })).toEqual([])
    })

    it('软删除的行即便在范围内也要排除', async () => {
      const { createSchedule, deleteSchedule, listSyncedSchedules } = await repo()
      await createSchedule({ id: 'gone', title: 'X', due_at: '2026-09-15T10:00:00.000Z' })
      await flushOutbox()
      await deleteSchedule('gone')

      expect(await listSyncedSchedules({ from: '2026-09-01', to: '2026-09-30' })).toEqual([])
    })
  })
})
