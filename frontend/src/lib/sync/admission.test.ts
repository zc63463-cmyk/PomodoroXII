import { afterEach, describe, expect, it } from 'vitest'

import { INITIAL_S4_OUTBOX_FIELDS, type PomodoroXIDB } from '@/services/database'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import {
  INITIAL_S4_PROVISIONAL_FIELDS,
  MetaDB,
  buildProvisionalOperationRow,
} from '@/services/meta-database'
import type { OutboxEvent } from '@/types'
import { admitTs3AwaitingS4, assertS4AdmissionReady } from './admission'
import { recomputeEntityBusinessPayloadHash } from './entity-payload-hash'
import { withSpaceAuthorityFence } from './space-authority-fence'
import { selectOneAuthorityUnit } from './authority-identity'
import { applyTerminalResultTwoPhase } from './terminal-application'
import type { SyncEntityType } from './types'
import type { JsonValue } from '@/lib/contracts/payload-hash'

class FakeLockManager {
  request<T>(
    _name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T> { return callback() }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const databases: Array<PomodoroXIDB | MetaDB> = []
const timestamp = '2026-08-07T01:00:00.000Z'

afterEach(async () => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
  await Promise.all(databases.splice(0).map((database) => database.delete()))
})

async function fixture() {
  Object.defineProperty(navigator, 'locks', {
    configurable: true, value: new FakeLockManager(),
  })
  const spaceId = `space-${crypto.randomUUID()}`
  const db = await openPomodoroXIDB(spaceId)
  const meta = new MetaDB(`pxii-admission-${crypto.randomUUID()}`)
  await meta.open()
  databases.push(db, meta)
  return { db, meta, spaceId }
}

async function outboxRow(
  spaceId: string,
  entityType: SyncEntityType,
  entityId: string,
  payload: Record<string, unknown>,
  id: number,
  compoundOperationId: string | null = null,
): Promise<OutboxEvent> {
  return {
    id, spaceId, entityType, entityId, action: 'create',
    payload: JSON.stringify(payload),
    payloadHash: await recomputeEntityBusinessPayloadHash(
      entityType, 'create', payload as JsonValue,
    ),
    operationId: `operation-${id}`, compoundOperationId,
    compoundOrder: compoundOperationId === null ? null : id - 1,
    expectedVersion: null, requiresVersionRebase: false,
    transportState: 'awaiting_s4', createdAt: timestamp, synced: false,
    lastError: null, lastErrorCode: null, failedAt: null, attemptCount: 0,
    ...INITIAL_S4_OUTBOX_FIELDS,
  }
}

const focusPayload = () => ({
  id: 'session-a', version: 1, createdAt: timestamp, updatedAt: timestamp,
  sessionRevision: 1, startedAt: timestamp, endedAt: null, pauseStartedAt: null,
  plannedSeconds: 1500, grossSeconds: 0, pausedSeconds: 0, breakSeconds: 0,
  focusedSeconds: 0, timerCompletion: null, validity: 'pending', validityReason: null,
  overallProgress: null, mood: null, reviewState: 'pending',
  ownershipState: 'local_provisional', sessionNote: '',
})

const contextPayload = () => ({
  id: 'context-a', version: 1, createdAt: timestamp, updatedAt: timestamp,
  sessionId: 'session-a', projectId: 'project-a', level2WorkItemId: 'work-a',
  projectTitleSnapshot: 'Project', level2TitleSnapshot: 'Work',
  level2ParentIdSnapshot: null, level2StatusDefinitionIdSnapshot: 'status-a',
  level2VersionSnapshot: 1, level2EffortLowerSecondsSnapshot: null,
  level2EffortUpperSecondsSnapshot: null, linkedAt: timestamp, linkMethod: 'explicit',
})

const attributionPayload = () => ({
  id: 'attribution-a', version: 1, createdAt: timestamp, updatedAt: timestamp,
  sessionId: 'session-a', revision: 1, projectId: 'project-a',
  level2WorkItemId: 'work-a', reason: null, correctedFromRevision: null,
  effective: true,
})

async function seedCompound(db: PomodoroXIDB, meta: MetaDB, spaceId: string) {
  const root = 'compound-a'
  const rows = [
    await outboxRow(spaceId, 'focusSession', 'session-a', focusPayload(), 1, root),
    await outboxRow(spaceId, 'sessionTaskContext', 'context-a', contextPayload(), 2, root),
    await outboxRow(
      spaceId, 'sessionAttributionRevision', 'attribution-a', attributionPayload(), 3, root,
    ),
  ]
  await db.outbox.bulkPut(rows)
  const provisional = await buildProvisionalOperationRow({
    operationId: root, spaceId, sessionId: 'session-a', deviceId: 'device-a',
    tabId: 'tab-a', level2WorkItemId: 'work-a', level3WorkItemIds: [],
    plannedSeconds: 1500, startedAt: timestamp, expectedWorkItemVersions: { 'work-a': 1 },
  }, null)
  await meta.provisionalOperations.put({
    ...provisional, state: 'awaiting_s4', ...INITIAL_S4_PROVISIONAL_FIELDS,
  })
  return { root, rows }
}

describe('TS3 to S4 admission', () => {
  it('atomically admits a valid standalone row and marks readiness', async () => {
    const { db, meta, spaceId } = await fixture()
    const document = { contentVersion: 1 as const, blocks: [] }
    await db.outbox.put(await outboxRow(spaceId, 'workItemNote', 'note-a', {
      noteId: 'note-a', workItemId: 'work-a', document,
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    }, 1))

    await withSpaceAuthorityFence(spaceId, async (token) => {
      await admitTs3AwaitingS4(db, meta, spaceId, token)
      await expect(assertS4AdmissionReady(db, meta, spaceId, token)).resolves.toBeUndefined()
    })

    expect(await db.outbox.get(1)).toMatchObject({ transportState: 'ready' })
    expect(await db.syncAdmissionState.get('active')).toMatchObject({ state: 'ready' })
  })

  it('admits a complete compound and binds its Meta root digest', async () => {
    const { db, meta, spaceId } = await fixture()
    const { root } = await seedCompound(db, meta, spaceId)

    await withSpaceAuthorityFence(spaceId, async (token) => {
      await admitTs3AwaitingS4(db, meta, spaceId, token)
    })

    expect((await db.outbox.toArray()).every((row) => row.transportState === 'ready')).toBe(true)
    const marker = (await db.syncAdmissionState.get('active'))!
    expect(marker).toMatchObject({ state: 'ready' })
    expect(await meta.provisionalOperations.get(root)).toMatchObject({
      state: 'transport_ready',
      transportReadyRootSha256: marker.readyRoots[0]!.rootSha256,
    })
  })

  it('fails atomically when a compound is incomplete', async () => {
    const { db, meta, spaceId } = await fixture()
    const { rows } = await seedCompound(db, meta, spaceId)
    await db.outbox.delete(2)

    await expect(withSpaceAuthorityFence(spaceId, async (token) =>
      admitTs3AwaitingS4(db, meta, spaceId, token))).rejects.toThrow()

    expect(await db.outbox.toArray()).toEqual([rows[0], rows[2]])
    expect(await db.syncAdmissionState.get('active')).toMatchObject({ state: 'failed' })
  })

  it('detects byte drift after readiness', async () => {
    const { db, meta, spaceId } = await fixture()
    await seedCompound(db, meta, spaceId)
    await withSpaceAuthorityFence(spaceId, async (token) => {
      await admitTs3AwaitingS4(db, meta, spaceId, token)
      await db.outbox.update(1, { entityId: 'tampered' })
      await expect(assertS4AdmissionReady(db, meta, spaceId, token))
        .rejects.toThrow('ready_root_identity_drift')
    })
  })

  it('accepts a removed compound root only when exact terminal evidence explains it', async () => {
    const { db, meta, spaceId } = await fixture()
    await seedCompound(db, meta, spaceId)
    await withSpaceAuthorityFence(spaceId, async (token) => {
      await admitTs3AwaitingS4(db, meta, spaceId, token)
      const selected = await selectOneAuthorityUnit(db)
      expect(selected?.authority.kind).toBe('compound')
      await applyTerminalResultTwoPhase(db, meta, spaceId, token, selected!, {
        batch_id: selected!.authority.batchId,
        applied: selected!.frozenRows.map((row) => ({
          operation_id: row.operationId,
          entity_type: row.entityType,
          entity_id: row.entityId,
          version: 1,
          resolution: null,
        })),
        conflicts: [],
        errors: [],
      }, 'push_response')

      expect(await db.outbox.count()).toBe(0)
      await expect(assertS4AdmissionReady(db, meta, spaceId, token)).resolves.toBeUndefined()
    })
  })
})
