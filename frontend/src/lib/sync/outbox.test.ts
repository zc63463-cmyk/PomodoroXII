import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INITIAL_S4_OUTBOX_FIELDS, type PomodoroXIDB } from '@/services/database'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import type { OutboxEvent } from '@/types'
import {
  buildOutboxIdentity,
  boundedChildOperationId,
  countUnsyncedOutbox,
  enqueueOutbox,
  prepareHeldProvisionalBatch,
  resolveOutboxMerge,
} from './outbox'
import type { OutboxIdentity } from './outbox'
import { withSpaceAuthorityFence } from './space-authority-fence'
import {
  ENTITY_TYPE_TO_TABLE,
  FINAL_SYNC_ENTITY_TO_TABLE,
  FINAL_SYNC_ENTITY_TYPES,
  type OutboxAction,
  type SyncEntityType,
} from './types'

const createdAt = (millis: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, millis)).toISOString()
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
class FakeLockManager {
  request<T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    return callback()
  }
}
beforeEach(() => Object.defineProperty(navigator, 'locks', {
  configurable: true, value: new FakeLockManager(),
}))
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

async function openTestDb(): Promise<PomodoroXIDB> {
  return openPomodoroXIDB(`outbox-${crypto.randomUUID()}`)
}

async function enqueueTest(
  db: PomodoroXIDB,
  entityType: SyncEntityType,
  entityId: string,
  action: OutboxAction,
  payload: unknown,
  expectedVersion: number | null = action === 'create' ? null : 1,
  transportState: OutboxIdentity['transportState'] = 'ready',
  timestamp = createdAt(0),
): Promise<void> {
  const identity = await buildOutboxIdentity(payload, {
    operationId: crypto.randomUUID(),
    expectedVersion,
    transportState,
    createdAt: timestamp,
  })
  await withSpaceAuthorityFence(db.spaceId, (token) =>
    enqueueOutbox(db, db.spaceId, token, entityType, entityId, action, payload, identity))
}

async function enqueueWithFence(
  db: PomodoroXIDB,
  entityType: SyncEntityType,
  entityId: string,
  action: OutboxAction,
  payload: unknown,
  identity: OutboxIdentity,
): Promise<void> {
  await withSpaceAuthorityFence(db.spaceId, (token) =>
    enqueueOutbox(db, db.spaceId, token, entityType, entityId, action, payload, identity))
}

function storedEvent(
  db: PomodoroXIDB,
  overrides: Partial<Omit<OutboxEvent, 'id'>> = {},
): Omit<OutboxEvent, 'id'> {
  return {
    spaceId: db.spaceId,
    entityType: 'note',
    entityId: 'note-1',
    action: 'create',
    payload: '{}',
    payloadHash: '0'.repeat(64),
    operationId: crypto.randomUUID(),
    compoundOperationId: null,
    compoundOrder: null,
    expectedVersion: null,
    requiresVersionRebase: false,
    transportState: 'ready',
    createdAt: createdAt(0),
    synced: false,
    lastError: null,
    lastErrorCode: null,
    failedAt: null,
    attemptCount: 0,
    ...INITIAL_S4_OUTBOX_FIELDS,
    ...overrides,
  }
}

afterEach(() => undefined)

describe('resolveOutboxMerge', () => {
  it.each([
    ['create', 'delete', { action: 'drop_existing' }],
    ['create', 'update', { action: 'replace' }],
    ['update', 'delete', { action: 'replace', newAction: 'delete' }],
    ['update', 'update', { action: 'replace' }],
    ['delete', 'create', { action: 'replace', newAction: 'update' }],
    ['delete', 'delete', { action: 'keep_existing' }],
  ] as const)('%s + %s follows the locked merge matrix', (existing, incoming, expected) => {
    expect(resolveOutboxMerge(existing, incoming)).toEqual(expected)
  })
})

describe('v18 outbox identity and atomic enqueue', () => {
  let db: PomodoroXIDB | undefined

  afterEach(async () => {
    if (db) await db.delete()
    db = undefined
  })

  it('writes the complete v18 identity on create', async () => {
    db = await openTestDb()
    const payload = { id: 'note-1', title: 'A' }
    await enqueueTest(db, 'note', 'note-1', 'create', payload)
    const row = await db.outbox.toCollection().first()
    expect(row).toMatchObject({
      spaceId: db.spaceId,
      entityType: 'note',
      entityId: 'note-1',
      action: 'create',
      payload: JSON.stringify(payload),
      expectedVersion: null,
      transportState: 'ready',
      synced: false,
      ...INITIAL_S4_OUTBOX_FIELDS,
    })
    expect(row?.createdAt).toBe(createdAt(0))
    expect(row?.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.operationId).toBeTruthy()
  })

  it('merges create/update and drops create/delete without duplicate rows', async () => {
    db = await openTestDb()
    await enqueueTest(db, 'note', 'note-1', 'create', { id: 'note-1', title: 'A' }, null, 'ready', createdAt(0))
    await enqueueTest(db, 'note', 'note-1', 'update', { id: 'note-1', title: 'B' }, 1, 'ready', createdAt(1))
    expect(await db.outbox.where('entityId').equals('note-1').count()).toBe(1)
    expect((await db.outbox.where('entityId').equals('note-1').first())?.action).toBe('create')

    await enqueueTest(db, 'note', 'note-1', 'delete', { id: 'note-1' }, 1, 'ready', createdAt(2))
    expect(await db.outbox.where('entityId').equals('note-1').count()).toBe(0)
  })

  it('keeps local entity and outbox atomic when the transaction aborts', async () => {
    db = await openTestDb()
    const database = db
    await expect(database.transaction('rw', database.notes, database.outbox, async () => {
      await database.notes.put({ id: 'note-atomic', title: 'A', content: 'A' } as never)
      await enqueueTest(database, 'note', 'note-atomic', 'create', { id: 'note-atomic' })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await db.notes.get('note-atomic')).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('rejects missing, negative, and fractional update base versions', async () => {
    db = await openTestDb()
    await expect(enqueueTest(db, 'note', 'n', 'update', { id: 'n' }, null))
      .rejects.toThrow('expectedVersion')
    await expect(enqueueTest(db, 'note', 'n', 'update', { id: 'n' }, -1))
      .rejects.toThrow('expectedVersion')
    await expect(enqueueTest(db, 'note', 'n', 'update', { id: 'n' }, 1.5))
      .rejects.toThrow('expectedVersion')
  })

  it('rejects mismatched payload hashes and non-canonical timestamps', async () => {
    db = await openTestDb()
    const payload = { id: 'note-hash' }
    const identity = await buildOutboxIdentity(payload, {
      operationId: 'op-hash', expectedVersion: null,
      transportState: 'ready', createdAt: createdAt(0),
    })
    await expect(enqueueWithFence(
      db, 'note', 'note-hash', 'create', payload,
      { ...identity, payloadHash: 'f'.repeat(64) },
    )).rejects.toThrow('payloadHash_mismatch')
    await expect(enqueueWithFence(
      db, 'note', 'note-time', 'create', payload,
      { ...identity, operationId: 'op-time', createdAt: '2026-01-01T00:00:00Z' },
    )).rejects.toThrow('canonical UTC RFC3339')
  })

  it('requires the database binding and hides final-entity rows from S4 transport', async () => {
    db = await openTestDb()
    const payload = { id: 'wi-1' }
    const identity = await buildOutboxIdentity(payload, {
      operationId: 'op-awaiting', expectedVersion: null,
      transportState: 'awaiting_s4', createdAt: createdAt(0),
    })
    await enqueueWithFence(db, 'workItem', 'wi-1', 'create', payload, identity)
    expect(await countUnsyncedOutbox(db)).toBe(0)
    const database = db
    await expect(withSpaceAuthorityFence('other-space', (token) => enqueueOutbox(
      database, 'other-space', token, 'note', 'n', 'create', payload, identity,
    ))).rejects.toThrow('space_database_binding_mismatch')
  })

  it('supports a command hash projection for complete post-image payloads', async () => {
    db = await openTestDb()
    const payload = { noteId: 'note-1', document: { contentVersion: 1, blocks: [] }, version: 4 }
    const hashPayload = { document: payload.document }
    const identity = await buildOutboxIdentity(payload, {
      operationId: 'note-projection', expectedVersion: 4,
      transportState: 'awaiting_s4', createdAt: createdAt(0), hashPayload,
    })
    await enqueueWithFence(db, 'workItemNote', 'note-1', 'update', payload, identity)
    expect((await db.outbox.get(1))?.payloadHash)
      .toBe(await hashCommandPayload(hashPayload))
    expect(JSON.parse((await db.outbox.get(1))!.payload)).toEqual(payload)
  })

})

describe('child operation IDs', () => {
  it('keeps plain IDs bounded and hashes overflow deterministically', async () => {
    await expect(boundedChildOperationId('parent', 'suffix')).resolves.toBe('childp:6:parent:suffix')
    const first = await boundedChildOperationId('p'.repeat(128), 's'.repeat(128))
    const second = await boundedChildOperationId('p'.repeat(128), 's'.repeat(128))
    expect(first).toBe(second)
    expect(first).toMatch(/^childh:[0-9a-f]{64}$/)
  })
})

describe('held provisional compound authority', () => {
  it('preserves persisted root and parent-before-child operation order', async () => {
    const db = await openTestDb()
    const root = 'compound-a'
    const rows = [
      storedEvent(db, { entityType: 'focusSession', entityId: 'session-a' }),
      storedEvent(db, { entityType: 'sessionTaskContext', entityId: 'context-a' }),
      storedEvent(db, { entityType: 'sessionAttributionRevision', entityId: 'attribute-a' }),
      storedEvent(db, {
        entityType: 'sessionWorkItemPlan', entityId: 'plan-a',
        payload: JSON.stringify({ planRank: 2 }),
      }),
    ].map((row, index) => ({
      ...row, id: index + 1, operationId: `operation-${index}`,
      compoundOperationId: root, compoundOrder: index,
      transportState: 'awaiting_s4' as const,
    }))

    expect(prepareHeldProvisionalBatch(rows)).toMatchObject({
      batchId: root,
      items: rows.map((row, requestIndex) => ({
        requestIndex, operationId: row.operationId, entityType: row.entityType,
      })),
    })
    await db.delete()
  })

  it('rejects a missing compound child or an order gap', async () => {
    const db = await openTestDb()
    const rows = [0, 2, 3].map((compoundOrder, index) => ({
      ...storedEvent(db), id: index + 1, operationId: `operation-${index}`,
      entityType: ['focusSession', 'sessionTaskContext', 'sessionAttributionRevision'][index]!,
      compoundOperationId: 'compound-a', compoundOrder,
      transportState: 'awaiting_s4' as const,
    }))
    expect(() => prepareHeldProvisionalBatch(rows))
      .toThrow('provisional_compound_order_or_operation_id_invalid')
    await db.delete()
  })
})

describe('sync entity table inventory', () => {
  it('contains exactly the 22 final Sync v2 entity keys', () => {
    expect(FINAL_SYNC_ENTITY_TYPES).toEqual([
      'note', 'folder', 'quickNote', 'reflection', 'habit', 'habitCheckIn',
      'schedule', 'timeBlock', 'memoComment', 'scheduleQuickNote',
      'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
      'workItem', 'workItemNote', 'focusSession', 'sessionTaskContext',
      'sessionAttributionRevision', 'sessionWorkItemPlan', 'sessionWorkItemOutcome',
    ])
    expect(Object.keys(FINAL_SYNC_ENTITY_TO_TABLE)).toEqual(FINAL_SYNC_ENTITY_TYPES)
  })

  it('contains only final sync-enabled entity tables', () => {
    expect(Object.keys(ENTITY_TYPE_TO_TABLE)).toEqual([
      'note', 'folder', 'quickNote', 'reflection', 'habit', 'habitCheckIn',
      'schedule', 'timeBlock', 'memoComment', 'scheduleQuickNote',
    ])
  })
})
