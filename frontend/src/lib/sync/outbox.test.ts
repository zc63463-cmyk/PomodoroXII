import { afterEach, describe, expect, it } from 'vitest'
import type { PomodoroXIDB } from '@/services/database'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import type { OutboxEvent } from '@/types'
import {
  buildOutboxIdentity,
  boundedChildOperationId,
  countUnsyncedOutbox,
  deleteOutboxByIds,
  enqueueOutbox,
  listUnsyncedOutbox,
  markOutboxEventsFailed,
  resolveOutboxMerge,
} from './outbox'
import { ENTITY_TYPE_TO_TABLE, type OutboxAction, type SyncEntityType } from './types'

const createdAt = (millis: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, millis)).toISOString()

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
  transportState: OutboxEvent['transportState'] = 'ready',
  timestamp = createdAt(0),
): Promise<void> {
  const identity = await buildOutboxIdentity(payload, {
    operationId: crypto.randomUUID(),
    expectedVersion,
    transportState,
    createdAt: timestamp,
  })
  await enqueueOutbox(db, db.spaceId, entityType, entityId, action, payload, identity)
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
    await expect(enqueueOutbox(
      db, db.spaceId, 'note', 'note-hash', 'create', payload,
      { ...identity, payloadHash: 'f'.repeat(64) },
    )).rejects.toThrow('payloadHash_mismatch')
    await expect(enqueueOutbox(
      db, db.spaceId, 'note', 'note-time', 'create', payload,
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
    await enqueueOutbox(db, db.spaceId, 'workItem', 'wi-1', 'create', payload, identity)
    expect(await countUnsyncedOutbox(db)).toBe(0)
    expect(await listUnsyncedOutbox(db)).toEqual([])
    await expect(enqueueOutbox(
      db, 'other-space', 'note', 'n', 'create', payload, identity,
    )).rejects.toThrow('outbox_space_database_mismatch')
  })

  it('supports a command hash projection for complete post-image payloads', async () => {
    db = await openTestDb()
    const payload = { noteId: 'note-1', document: { contentVersion: 1, blocks: [] }, version: 4 }
    const hashPayload = { document: payload.document }
    const identity = await buildOutboxIdentity(payload, {
      operationId: 'note-projection', expectedVersion: 4,
      transportState: 'awaiting_s4', createdAt: createdAt(0), hashPayload,
    })
    await enqueueOutbox(db, db.spaceId, 'workItemNote', 'note-1', 'update', payload, identity)
    expect((await db.outbox.get(1))?.payloadHash)
      .toBe(await hashCommandPayload(hashPayload))
    expect(JSON.parse((await db.outbox.get(1))!.payload)).toEqual(payload)
  })

  it('records retry failure without deleting the immutable row', async () => {
    db = await openTestDb()
    await db.outbox.add(storedEvent(db, { entityId: 'failed' }))
    const row = await db.outbox.where('entityId').equals('failed').first()
    await markOutboxEventsFailed(db, [{ outboxId: row!.id!, error: 'version_mismatch' }])
    expect(await db.outbox.get(row!.id!)).toMatchObject({
      lastError: 'version_mismatch', lastErrorCode: 'version_mismatch', attemptCount: 1,
    })
  })

  it('orders ready rows by canonical createdAt and supports deletion by id', async () => {
    db = await openTestDb()
    const rows = await db.outbox.bulkAdd([
      storedEvent(db, { entityId: 'later', createdAt: createdAt(2) }),
      storedEvent(db, { entityId: 'earlier', createdAt: createdAt(1) }),
      storedEvent(db, { entityId: 'held', transportState: 'blocked_conflict', createdAt: createdAt(0) }),
    ], { allKeys: true })
    expect((await listUnsyncedOutbox(db)).map((row) => row.entityId)).toEqual(['earlier', 'later'])
    await deleteOutboxByIds(db, [rows[0]!])
    expect(await db.outbox.get(rows[0]!)).toBeUndefined()
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

describe('sync entity table inventory', () => {
  it('contains only final sync-enabled entity tables', () => {
    expect(Object.keys(ENTITY_TYPE_TO_TABLE)).toEqual([
      'note', 'folder', 'quickNote', 'reflection', 'habit', 'habitCheckIn',
      'schedule', 'timeBlock', 'memoComment', 'scheduleQuickNote',
    ])
  })
})
