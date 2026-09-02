import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import { parseRetainedLwwOutboxPostImage } from '@/lib/sync/response-schema'
import { ENTITY_TYPE_TO_TABLE } from '@/lib/sync/types'

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
  // 让首条事件变为不可合并（模拟已推送），后续动作才会另起一行
  await db.outbox.toCollection().modify((row) => {
    ;(row as { attemptCount?: number }).attemptCount = 1
  })
}

describe('folder-repository', () => {
  beforeEach(async () => {
    failureSwitch.shouldFail = false
    installLocks(new FakeLockManager())
    await spaceDBManager.switchTo(`folder-repo-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    failureSwitch.shouldFail = false
    await db.delete()
    spaceDBManager.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  // 延迟 import，确保 spaceDBManager 已切换后再取仓储
  const repo = () => import('./folder-repository')

  it('folder 已注册为同步实体并映射到 folders 表', () => {
    expect(ENTITY_TYPE_TO_TABLE.folder).toBe('folders')
  })

  it('create 写入完整行并入队', async () => {
    const { createFolder, listFolders } = await repo()

    const folder = await createFolder({ id: 'f1', name: '工作' })
    const row = await db.folders.get('f1')

    expect(folder.name).toBe('工作')
    expect(row).toMatchObject({
      parent_id: null,
      is_system: false,
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    })
    expect(await listFolders()).toHaveLength(1)

    const pending = await db.outbox.toArray()
    expect(pending[0]).toMatchObject({ entityType: 'folder', action: 'create' })
  })

  it('rename / move 自增 version', async () => {
    const { createFolder, renameFolder, moveFolder, getFolder } = await repo()

    await createFolder({ id: 'f1', name: 'A' })
    await flushOutbox()
    await renameFolder('f1', 'B')
    await flushOutbox()
    await moveFolder('f1', 'some-parent')

    const folder = await getFolder('f1')
    expect(folder?.name).toBe('B')
    expect(folder?.parent_id).toBe('some-parent')
    expect((await db.folders.get('f1'))?.version).toBe(3)
  })

  it('trash 后从列表移除，但仍可取到', async () => {
    const { createFolder, trashFolder, getFolder, listFolders } = await repo()

    await createFolder({ id: 'f1', name: 'A' })
    await trashFolder('f1')

    expect(await listFolders()).toHaveLength(0)
    expect((await getFolder('f1'))?.trashed_at).not.toBeNull()
  })

  it('create 的 payload 能通过同步引擎 strictObject 校验', async () => {
    const { createFolder } = await repo()
    await createFolder({ id: 'f2', name: 'X' })

    const payload = JSON.parse((await db.outbox.toArray())[0].payload as string)
    expect(() =>
      parseRetainedLwwOutboxPostImage('folder', 'create', payload),
    ).not.toThrow()

    // 反向确认 strictObject 真的生效
    expect(() =>
      parseRetainedLwwOutboxPostImage('folder', 'create', { ...payload, extra: 1 }),
    ).toThrow()
  })

  it('同事务铁律：入队失败时本地行不得残留', async () => {
    const { createFolder } = await repo()

    failureSwitch.shouldFail = true
    await expect(createFolder({ id: 'f3', name: 'A' })).rejects.toThrow()
    expect(await db.folders.get('f3')).toBeUndefined()
  })
})
