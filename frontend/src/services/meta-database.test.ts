import { afterEach, describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { canonicalize } from 'json-canonicalize'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import {
  buildProvisionalOperationRow,
  INITIAL_S4_PROVISIONAL_FIELDS,
  MetaDB,
  type CanonicalProvisionalStartIntent,
  type ProvisionalOperationRow,
} from './meta-database'

const databases: MetaDB[] = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.delete()))
})

const openMeta = async (prefix: string): Promise<MetaDB> => {
  const db = new MetaDB(`pxii-meta-${prefix}-${crypto.randomUUID()}`)
  databases.push(db)
  await db.open()
  return db
}

const provisionalOperationFixture = (
  overrides: Partial<ProvisionalOperationRow> = {},
): ProvisionalOperationRow => ({
  operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
  spaceId: 'space-a', sessionId: 'fs-a', cachedOwnershipEpoch: null,
  intentJson: '{"spaceId":"space-a","sessionId":"fs-a"}',
  payloadHash: 'a'.repeat(64), state: 'pending',
  createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  ...INITIAL_S4_PROVISIONAL_FIELDS,
  ...overrides,
})

const provisionalIntentFixture = (
  overrides: Partial<CanonicalProvisionalStartIntent> = {},
): CanonicalProvisionalStartIntent => ({
  operationId: 'offline-a',
  spaceId: 'space-a',
  sessionId: 'fs-a',
  deviceId: 'device-a',
  tabId: 'tab-a',
  level2WorkItemId: 'l2-a',
  level3WorkItemIds: ['l3-a'],
  plannedSeconds: 1500,
  startedAt: '2026-07-15T08:00:00Z',
  expectedWorkItemVersions: { 'l2-a': 3, 'l3-a': 4 },
  ...overrides,
})

describe('MetaDB v3 coordination mirrors', () => {
  it('defines the v3 locator, identity, Tab, and provisional stores', async () => {
    const db = await openMeta('schema')

    expect(db.verno).toBe(3)
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      'activeSessionLocator', 'deviceIdentity', 'provisionalOperations', 'sessionTabs', 'spaces',
    ])
  })

  it('strictly upgrades a v2 resolved provisional row with four null bindings', async () => {
    const name = `pxii-meta-upgrade-${crypto.randomUUID()}`
    const old = new Dexie(name)
    old.version(2).stores({
      spaces: 'id, name, is_default',
      activeSessionLocator: 'key, spaceId, sessionId, state, ownershipEpoch',
      deviceIdentity: 'key, deviceId',
      sessionTabs: 'tabId, deviceId, lastSeenAt, closedAt',
      provisionalOperations: 'operationId, deviceId, spaceId, sessionId, state, createdAt',
    })
    await old.open()
    await old.table('provisionalOperations').put({
      operationId: 'operation-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'session-a', cachedOwnershipEpoch: null,
      intentJson: '{"spaceId":"space-a"}', payloadHash: 'a'.repeat(64),
      state: 'resolved', createdAt: '2026-08-07T01:00:00.000Z',
      updatedAt: '2026-08-07T01:01:00.000Z',
    })
    old.close()

    const upgraded = new MetaDB(name)
    databases.push(upgraded)
    await upgraded.open()

    expect(await upgraded.provisionalOperations.get('operation-a')).toMatchObject({
      state: 'activation_resolved',
      ...INITIAL_S4_PROVISIONAL_FIELDS,
    })
  })

  it('atomically rejects a v2 row with pre-existing partial S4 fields', async () => {
    const name = `pxii-meta-partial-${crypto.randomUUID()}`
    const old = new Dexie(name)
    old.version(2).stores({
      spaces: 'id, name, is_default',
      activeSessionLocator: 'key, spaceId, sessionId, state, ownershipEpoch',
      deviceIdentity: 'key, deviceId',
      sessionTabs: 'tabId, deviceId, lastSeenAt, closedAt',
      provisionalOperations: 'operationId, deviceId, spaceId, sessionId, state, createdAt',
    })
    await old.open()
    await old.table('provisionalOperations').put({
      operationId: 'operation-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'session-a', cachedOwnershipEpoch: null,
      intentJson: '{"spaceId":"space-a"}', payloadHash: 'a'.repeat(64), state: 'awaiting_s4',
      createdAt: '2026-08-07T01:00:00.000Z', updatedAt: '2026-08-07T01:01:00.000Z',
      terminalEvidenceId: null,
    })
    old.close()

    const upgraded = new MetaDB(name)
    databases.push(upgraded)
    await expect(upgraded.open()).rejects.toThrow('meta_v3_provisional_fields_preexist_or_partial')

    const probe = new Dexie(name)
    probe.version(2).stores({ provisionalOperations: 'operationId' })
    await probe.open()
    expect(probe.verno).toBe(2)
    probe.close()
  })

  it('stores locator identity without Session business content', async () => {
    const db = await openMeta('locator')
    await db.activeSessionLocator.put({
      key: 'active', spaceId: 'space-a', sessionId: 'fs-1', operationId: 'start-1',
      state: 'active', ownerDeviceId: 'device-a', ownerTabId: 'tab-a',
      ownershipEpoch: 3, leaseExpiresAt: '2026-07-15T08:01:00Z',
      updatedAt: '2026-07-15T08:00:00Z',
    })
    const row = await db.activeSessionLocator.get('active')
    expect(Object.keys(row!).sort()).toEqual([
      'key', 'leaseExpiresAt', 'operationId', 'ownerDeviceId', 'ownerTabId',
      'ownershipEpoch', 'sessionId', 'spaceId', 'state', 'updatedAt',
    ])
    expect(row).not.toHaveProperty('title')
    expect(row).not.toHaveProperty('startedAt')
  })

  it('persists one device identity and a separate Session-scoped Tab mirror', async () => {
    const db = await openMeta('identity')
    await db.deviceIdentity.put({
      key: 'device', deviceId: 'device-a', createdAt: '2026-07-15T08:00:00Z',
    })
    await db.sessionTabs.put({
      tabId: 'tab-a', deviceId: 'device-a', openedAt: '2026-07-15T08:00:00Z',
      lastSeenAt: '2026-07-15T08:00:01Z', closedAt: null,
    })

    expect(await db.deviceIdentity.get('device')).toMatchObject({ deviceId: 'device-a' })
    expect(await db.sessionTabs.get('tab-a')).toMatchObject({
      deviceId: 'device-a', closedAt: null,
    })
  })

  it('builds a canonical provisional intent hash over the complete start intent', async () => {
    const input = provisionalIntentFixture()
    const row = await buildProvisionalOperationRow(input, null)
    const canonicalIntent = {
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      tabId: input.tabId,
      level2WorkItemId: input.level2WorkItemId,
      level3WorkItemIds: input.level3WorkItemIds,
      plannedSeconds: input.plannedSeconds,
      startedAt: input.startedAt,
      expectedWorkItemVersions: input.expectedWorkItemVersions,
    }

    expect(row.intentJson).toBe(canonicalize(canonicalIntent))
    expect(row.payloadHash).toBe(await hashCommandPayload(canonicalIntent))
    expect(row.intentJson).not.toContain(input.operationId)
    expect(row.intentJson).toContain('expectedWorkItemVersions')
  })

  it('prevents two unresolved same-device provisional starts', async () => {
    const db = await openMeta('active-block')
    await db.provisionalOperations.add(provisionalOperationFixture({
      operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'fs-a', state: 'pending',
      createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
    }))
    await expect(db.claimProvisional(provisionalOperationFixture({
      operationId: 'offline-b', deviceId: 'device-a', tabId: 'tab-b',
      spaceId: 'space-b', sessionId: 'fs-b', state: 'pending',
      createdAt: '2026-07-15T08:01:00Z', updatedAt: '2026-07-15T08:01:00Z',
    }))).rejects.toThrow('active_session_exists')
  })

  it('does not treat the same Session ID in another Space as the same claim', async () => {
    const db = await openMeta('composite')
    await db.claimProvisional(provisionalOperationFixture({
      operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'shared-1', state: 'pending',
    }))
    await expect(db.claimProvisional(provisionalOperationFixture({
      operationId: 'offline-b', deviceId: 'device-a', tabId: 'tab-b',
      spaceId: 'space-b', sessionId: 'shared-1', state: 'pending',
    }))).rejects.toThrow('active_session_exists')
  })

  it('accepts only an identical operation intent as an idempotent claim', async () => {
    const db = await openMeta('idempotent')
    const intent = provisionalOperationFixture({
      operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'fs-a', state: 'pending',
    })
    await expect(db.claimProvisional(intent)).resolves.toMatchObject({ disposition: 'created' })
    await expect(db.claimProvisional({ ...intent })).resolves.toMatchObject({ disposition: 'existing' })
    expect(await db.provisionalOperations.count()).toBe(1)
    await expect(db.claimProvisional({
      ...intent, intentJson: '{"spaceId":"space-b","sessionId":"fs-a"}',
      payloadHash: 'b'.repeat(64),
    })).rejects.toThrow('idempotency_conflict')
  })

  it('retains an awaiting_s4 terminal operation without letting it occupy the active slot', async () => {
    const db = await openMeta('terminal')
    await db.provisionalOperations.add(provisionalOperationFixture({
      operationId: 'closed-op', spaceId: 'space-a', sessionId: 'closed-1',
      state: 'awaiting_s4',
    }))
    await expect(db.claimProvisional(provisionalOperationFixture({
      operationId: 'next-op', spaceId: 'space-b', sessionId: 'next-1', state: 'pending',
    }))).resolves.toMatchObject({ disposition: 'created' })
    expect(await db.provisionalOperations.get('closed-op')).toMatchObject({ state: 'awaiting_s4' })
    expect(await db.provisionalOperations.get('next-op')).toMatchObject({ state: 'pending' })
  })

  it('never rebinds an operation ID or downgrades terminal evidence', async () => {
    const db = await openMeta('operation-binding')
    const terminal = provisionalOperationFixture({ state: 'awaiting_s4' })
    await db.provisionalOperations.add(terminal)
    const claim = await db.claimProvisional(provisionalOperationFixture())
    expect(claim).toMatchObject({ disposition: 'existing', row: { state: 'awaiting_s4' } })
    expect(await db.provisionalOperations.get(terminal.operationId)).toEqual(terminal)
    await expect(db.claimProvisional(provisionalOperationFixture({
      intentJson: '{"spaceId":"space-b","sessionId":"fs-a"}',
      payloadHash: 'b'.repeat(64),
    }))).rejects.toThrow('idempotency_conflict')
    expect(await db.provisionalOperations.get(terminal.operationId)).toEqual(terminal)
  })
})
