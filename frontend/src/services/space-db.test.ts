import { describe, it, expect, afterEach, vi } from 'vitest'
import { liveQuery } from 'dexie'
import { spaceDBManager, db } from '@/services/space-db'
import { PomodoroXIDB } from '@/services/database'
import { dexieDbNameForSpace, PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'

describe('SpaceDBManager', () => {
  afterEach(() => {
    spaceDBManager.close()
  })

  it('T25: throws when accessing db.tasks without switchTo', () => {
    expect(() => db.tasks).toThrow('No space selected')
  })

  it('T26: db.tasks is accessible after switchTo', async () => {
    await spaceDBManager.switchTo('test-t26')
    const tasks = await db.tasks.toArray()
    expect(tasks).toEqual([])
  })

  it('T27: switching A to B makes db point to B', async () => {
    await spaceDBManager.switchTo('test-t27-a')
    await db.tasks.put({
      id: 't1',
      title: 'in A',
      status: 'todo',
    } as unknown as Parameters<typeof db.tasks.put>[0])

    await spaceDBManager.switchTo('test-t27-b')
    const tasksInB = await db.tasks.toArray()
    expect(tasksInB).toEqual([])
    expect(db.name).toBe(dexieDbNameForSpace('test-t27-b'))
  })

  it('T29: Proxy supports dexie liveQuery', async () => {
    await spaceDBManager.switchTo('test-t29')
    await db.tasks.put({
      id: 't29',
      title: 'livequery test',
      status: 'todo',
    } as unknown as Parameters<typeof db.tasks.put>[0])

    const observable = liveQuery(() => db.tasks.toArray())
    const result = await new Promise<unknown[]>((resolve, reject) => {
      const sub = observable.subscribe({
        next: (val) => {
          sub.unsubscribe()
          resolve(val)
        },
        error: reject,
      })
    })
    expect(result).toHaveLength(1)
    expect((result[0] as { id: string }).id).toBe('t29')
  })

  it('dispatches pxii:space-switched event after switchTo completes', async () => {
    let eventDetail: string | null = null
    const handler = (e: Event) => {
      eventDetail = (e as CustomEvent<{ spaceId: string }>).detail.spaceId
    }
    window.addEventListener(PXII_SPACE_SWITCHED_EVENT, handler)
    await spaceDBManager.switchTo('test-event')
    window.removeEventListener(PXII_SPACE_SWITCHED_EVENT, handler)
    expect(eventDetail).toBe('test-event')
  })

  it('can switch spaces without dispatching pxii:space-switched', async () => {
    let eventDetail: string | null = null
    const handler = (e: Event) => {
      eventDetail = (e as CustomEvent<{ spaceId: string }>).detail.spaceId
    }
    window.addEventListener(PXII_SPACE_SWITCHED_EVENT, handler)
    await spaceDBManager.switchTo('test-silent-event', { dispatchEvent: false })
    window.removeEventListener(PXII_SPACE_SWITCHED_EVENT, handler)
    expect(eventDetail).toBeNull()
    expect(spaceDBManager.currentSpaceId).toBe('test-silent-event')
  })

  it('onSwitch listener receives spaceId and can unsubscribe', async () => {
    let received: string | null = null
    const unsub = spaceDBManager.onSwitch((id) => {
      received = id
    })
    await spaceDBManager.switchTo('test-listener')
    expect(received).toBe('test-listener')
    unsub()
    received = null
    await spaceDBManager.switchTo('test-listener-2')
    expect(received).toBeNull()
  })

  it('awaits before-switch listeners while the previous Space DB is still writable', async () => {
    await spaceDBManager.switchTo('test-before-switch-a')
    const previousDB = spaceDBManager.current
    let observedTarget: string | null = null
    let observedCurrent: string | null = null

    const unsubscribe = spaceDBManager.onBeforeSwitch(async ({ fromSpaceId, toSpaceId, database }) => {
      observedTarget = toSpaceId
      observedCurrent = fromSpaceId
      expect(database).toBe(previousDB)
      expect(spaceDBManager.currentSpaceId).toBe('test-before-switch-a')
      await database.settings.put({ key: 'before-switch', value: 'flushed' })
    })

    await spaceDBManager.switchTo('test-before-switch-b')
    unsubscribe()

    expect(observedCurrent).toBe('test-before-switch-a')
    expect(observedTarget).toBe('test-before-switch-b')
    await previousDB.open()
    expect(await previousDB.settings.get('before-switch')).toEqual({
      key: 'before-switch',
      value: 'flushed',
    })
    previousDB.close()
  })

  it('flushes before-close listeners while the current Space DB is still writable', async () => {
    await spaceDBManager.switchTo('test-before-close')
    const currentDB = spaceDBManager.current

    const unsubscribe = spaceDBManager.onBeforeSwitch(async ({ fromSpaceId, toSpaceId, database }) => {
      expect(fromSpaceId).toBe('test-before-close')
      expect(toSpaceId).toBeNull()
      expect(database).toBe(currentDB)
      await database.settings.put({ key: 'before-close', value: 'flushed' })
    })

    await spaceDBManager.flushBeforeClose()
    unsubscribe()

    expect(spaceDBManager.current).toBe(currentDB)
    expect(await currentDB.settings.get('before-close')).toEqual({
      key: 'before-close',
      value: 'flushed',
    })
  })

  it('does not reject flushBeforeClose when a listener fails', async () => {
    await spaceDBManager.switchTo('test-before-close-reject')
    const unsubscribe = spaceDBManager.onBeforeSwitch(async () => {
      throw new Error('flush failed')
    })

    await expect(spaceDBManager.flushBeforeClose()).resolves.toBeUndefined()
    unsubscribe()
  })

  it('continues switching when a before-switch listener throws synchronously', async () => {
    await spaceDBManager.switchTo('test-before-switch-sync-throw-a')
    const unsubscribe = spaceDBManager.onBeforeSwitch(() => {
      throw new Error('listener threw synchronously')
    })

    await expect(spaceDBManager.switchTo('test-before-switch-sync-throw-b')).resolves.toBeUndefined()
    expect(spaceDBManager.currentSpaceId).toBe('test-before-switch-sync-throw-b')
    unsubscribe()
  })

  it('serializes concurrent switchTo calls and keeps the final DB aligned with its Space id', async () => {
    const first = spaceDBManager.switchTo('test-concurrent-a')
    const second = spaceDBManager.switchTo('test-concurrent-b')

    await Promise.all([first, second])

    expect(spaceDBManager.currentSpaceId).toBe('test-concurrent-b')
    expect(spaceDBManager.current.name).toBe(dexieDbNameForSpace('test-concurrent-b'))
  })

  it('keeps the previous Space usable when opening the target Space fails', async () => {
    await spaceDBManager.switchTo('test-open-failure-a')
    const previousDB = spaceDBManager.current
    vi.spyOn(PomodoroXIDB.prototype, 'open').mockImplementationOnce(() => {
      throw new Error('target open failed')
    })

    await expect(spaceDBManager.switchTo('test-open-failure-b')).rejects.toThrow('target open failed')

    expect(spaceDBManager.currentSpaceId).toBe('test-open-failure-a')
    expect(spaceDBManager.current).toBe(previousDB)
    await previousDB.open()
    expect(await previousDB.settings.toArray()).toEqual([])
    vi.mocked(PomodoroXIDB.prototype.open).mockRestore()
  })

  it('continues switching when a before-switch listener rejects', async () => {
    await spaceDBManager.switchTo('test-before-switch-reject-a')
    const unsubscribe = spaceDBManager.onBeforeSwitch(async () => {
      throw new Error('listener rejected')
    })

    await expect(spaceDBManager.switchTo('test-before-switch-reject-b')).resolves.toBeUndefined()
    expect(spaceDBManager.currentSpaceId).toBe('test-before-switch-reject-b')
    unsubscribe()
  })
})
