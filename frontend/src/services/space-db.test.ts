import { describe, it, expect, afterEach } from 'vitest'
import { liveQuery } from 'dexie'
import { spaceDBManager, db } from '@/services/space-db'
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
})
