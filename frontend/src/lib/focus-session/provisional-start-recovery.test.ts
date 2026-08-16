import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { buildProvisionalOperationRow, MetaDB } from '@/services/meta-database'
import { recoverProvisionalStarts } from './provisional-start-recovery'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>> | MetaDB> = []
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
class FakeLockManager {
  request<T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    return callback()
  }
}
beforeEach(() => Object.defineProperty(navigator, 'locks', {
  configurable: true, value: new FakeLockManager(),
}))

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

async function operation(db: MetaDB, spaceId: string, state: 'pending' | 'activating') {
  const row = await buildProvisionalOperationRow({
    operationId: `op-${state}`, spaceId, sessionId: `session-${state}`,
    deviceId: 'device-a', tabId: 'tab-a', level2WorkItemId: 'l2',
    level3WorkItemIds: [], plannedSeconds: 1500,
    startedAt: '2026-07-15T08:00:00.000Z', expectedWorkItemVersions: { l2: 1 },
  }, null)
  await db.provisionalOperations.put({ ...row, state })
  return row
}

describe('provisional start recovery', () => {
  it('removes an orphaned pending Meta claim when its Space snapshot never committed', async () => {
    const meta = new MetaDB(`meta-recovery-${crypto.randomUUID()}`)
    const db = await openPomodoroXIDB(`recovery-${crypto.randomUUID()}`)
    databases.push(meta, db)
    await meta.open()
    await operation(meta, db.spaceId, 'pending')

    await recoverProvisionalStarts(meta, async () => db)

    expect(await meta.provisionalOperations.count()).toBe(0)
  })

  it('fails closed for an activating operation without an application receipt', async () => {
    const meta = new MetaDB(`meta-recovery-flight-${crypto.randomUUID()}`)
    const db = await openPomodoroXIDB(`recovery-flight-${crypto.randomUUID()}`)
    databases.push(meta, db)
    await meta.open()
    await operation(meta, db.spaceId, 'activating')
    await db.focusSessions.put({
      id: 'session-activating', sessionId: 'session-activating',
      ownershipState: 'local_provisional', clockState: 'running',
    })

    await expect(recoverProvisionalStarts(meta, async () => db))
      .rejects.toThrow('activation_application_recovery_error')
    expect(await meta.provisionalOperations.get('op-activating')).toMatchObject({ state: 'activating' })
  })
})
