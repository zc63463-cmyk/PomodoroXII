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

describe('reflection-repository', () => {
  beforeEach(async () => {
    failureSwitch.shouldFail = false
    installLocks(new FakeLockManager())
    await spaceDBManager.switchTo(`reflection-repo-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    failureSwitch.shouldFail = false
    await db.delete()
    spaceDBManager.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  const repo = () => import('./reflection-repository')

  it('createReflection 写入完整行并入队', async () => {
    const { createReflection, listReflections } = await repo()

    await createReflection({ id: 'r1', date: '2026-09-02', content: '今天做了什么' })
    const row = await db.reflections.get('r1')

    expect(row).toMatchObject({
      date: '2026-09-02',
      content: '今天做了什么',
      mood: null,
      tags: [],
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    })
    expect(await listReflections()).toHaveLength(1)

    const pending = await db.outbox.toArray()
    expect(pending[0]).toMatchObject({ entityType: 'reflection', action: 'create' })
  })

  it('★ payload 补齐 sections / is_structured 以通过同步校验', async () => {
    // 这两个字段在 TS 接口里可选，但同步 schema（strictObject）里必填。
    // 不补默认值的话 push 会被拒，且失败发生在同步阶段，界面看不出原因。
    const { createReflection } = await repo()
    await createReflection({ id: 'r2', date: '2026-09-02' })

    const payload = JSON.parse((await db.outbox.toArray())[0].payload as string)
    expect(payload.sections).toEqual([])
    expect(payload.is_structured).toBe(false)

    expect(() =>
      parseRetainedLwwOutboxPostImage('reflection', 'create', payload),
    ).not.toThrow()
  })

  it('反向确认：多一个字段会被 strictObject 拒绝', async () => {
    const { createReflection } = await repo()
    await createReflection({ id: 'r3', date: '2026-09-02' })

    const payload = JSON.parse((await db.outbox.toArray())[0].payload as string)
    expect(() =>
      parseRetainedLwwOutboxPostImage('reflection', 'create', { ...payload, extra: 1 }),
    ).toThrow()
  })

  it('update 自增 version 且 payload 仍合规', async () => {
    const { createReflection, updateReflection, getReflection } = await repo()

    await createReflection({ id: 'r4', date: '2026-09-02', content: '' })
    await flushOutbox()
    await updateReflection('r4', { content: '补充', mood: 'good' })

    expect((await getReflection('r4'))?.content).toBe('补充')
    expect((await db.reflections.get('r4'))?.version).toBe(2)

    const updateRow = (await db.outbox.toArray()).find((e) => e.action === 'update')!
    const payload = JSON.parse(updateRow.payload as string)
    expect(() =>
      parseRetainedLwwOutboxPostImage('reflection', 'update', payload),
    ).not.toThrow()
  })

  it('delete 置 deletion_state 并从列表移除', async () => {
    const { createReflection, deleteReflection, getReflection, listReflections } = await repo()

    await createReflection({ id: 'r5', date: '2026-09-02' })
    await flushOutbox()
    await deleteReflection('r5')

    expect(await listReflections()).toHaveLength(0)
    expect(await getReflection('r5')).toBeNull()
    expect((await db.reflections.get('r5'))?.deletion_state).toBe('deleted')
  })

  it('同事务铁律：入队失败时本地行不得残留', async () => {
    const { createReflection } = await repo()

    failureSwitch.shouldFail = true
    await expect(createReflection({ id: 'r6', date: '2026-09-02' })).rejects.toThrow()

    expect(await db.reflections.get('r6')).toBeUndefined()
  })
})
