import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { dexieDbNameForSpace } from '@/lib/platform'
import { openPomodoroXIDB } from './dexie-v18-cutover'
import { INITIAL_S4_OUTBOX_FIELDS, PomodoroXIDB } from './database'
import {
  V18_STORE_DEFINITIONS,
  expectedV18SchemaInventory,
  toDexieStoreStrings,
} from './dexie-v18-schema'

const v17Stores = {
  tasks: 'id',
  sessions: 'id',
  sessionEvents: 'id',
  sessionContexts: 'id',
  cognitiveMarks: 'id',
  taskTags: 'id',
  taskRelations: 'id',
  focusPatterns: 'id',
  taskQuickNotes: 'id',
  sessionQuickNotes: 'id',
  quickNotes: 'id, session_id',
  timeBlocks: 'id, task_id',
  reflections: 'id',
  reports: 'id',
  reportTemplates: 'id',
  outbox: '++id, entityType, entityId, synced, createdAt',
} as const

const removedV18Stores = [
  'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
  'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes',
  'sessionQuickNotes',
]

const openV17 = async (spaceId: string): Promise<Dexie> => {
  const database = new Dexie(dexieDbNameForSpace(spaceId))
  database.version(17).stores(v17Stores)
  await database.open()
  return database
}

afterEach(async () => {
  // Each test uses a unique name. Closing/deleting is still explicit so a
  // failed assertion cannot leave a versionchange blocker for later tests.
  for (const name of Array.from(indexedDB.databases ? await indexedDB.databases() : [])) {
    if (name.name?.startsWith('pxii_space_v18_')) await Dexie.delete(name.name)
  }
})

describe('PomodoroXIDB v18 schema', () => {
  it('opens a clean Space through the v18 cutover into v19', async () => {
    const spaceId = `v18-${crypto.randomUUID()}`
    const database = await openPomodoroXIDB(spaceId)

    expect(database.spaceId).toBe(spaceId)
    expect(database.name).toBe(dexieDbNameForSpace(spaceId))
    expect(database.verno).toBe(19)
    expect(database.tables.map((table) => table.name)).toEqual(expect.arrayContaining(
      expectedV18SchemaInventory().map((store) => store.name),
    ))
    expect(database.tables.map((table) => table.name)).not.toEqual(
      expect.arrayContaining(removedV18Stores),
    )
    await database.delete()
  })

  it('upgrades an empty v17 database atomically through v18 into v19', async () => {
    const spaceId = `v18-empty-${crypto.randomUUID()}`
    const old = await openV17(spaceId)
    old.close()

    const database = await openPomodoroXIDB(spaceId)
    expect(database.verno).toBe(19)
    expect(database.quickNotes.schema.indexes.map((index) => index.name))
      .not.toContain('session_id')
    expect(database.timeBlocks.schema.indexes.map((index) => index.name))
      .not.toContain('task_id')
    await database.delete()
  })

  it('preserves surviving rows that have no legacy Task/Session references', async () => {
    const spaceId = `v18-survivors-${crypto.randomUUID()}`
    const old = await openV17(spaceId)
    await old.table('quickNotes').put({ id: 'quick-clean', content: 'Keep' })
    await old.table('timeBlocks').put({ id: 'block-clean', title: 'Keep' })
    await old.table('reflections').put({ id: 'reflection-clean', content: 'Keep' })
    await old.table('reports').put({ id: 'report-clean', config: { dimensions: ['tags'] } })
    old.close()

    const database = await openPomodoroXIDB(spaceId)
    await expect(database.quickNotes.get('quick-clean')).resolves.toMatchObject({ content: 'Keep' })
    await expect(database.timeBlocks.get('block-clean')).resolves.toMatchObject({ title: 'Keep' })
    await expect(database.reflections.get('reflection-clean')).resolves.toMatchObject({ content: 'Keep' })
    await expect(database.reports.get('report-clean')).resolves.toMatchObject({ id: 'report-clean' })
    await database.delete()
  })

  it.each(removedV18Stores)('rejects populated removed store %s before DDL', async (store) => {
    const spaceId = `v18-reject-${crypto.randomUUID()}`
    const old = await openV17(spaceId)
    await old.table(store).put({ id: 'legacy-row' })
    old.close()

    await expect(openPomodoroXIDB(spaceId))
      .rejects.toThrow(`legacy_client_data_present:${store}`)

    const unchanged = await new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
      const request = indexedDB.open(dexieDbNameForSpace(spaceId))
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        resolve({ version: database.version, stores: Array.from(database.objectStoreNames).sort() })
        database.close()
      }
    })
    expect(unchanged.version).toBe(170)
    expect(unchanged.stores).toContain(store)
    await Dexie.delete(dexieDbNameForSpace(spaceId))
  })

  it.each([
    ['quickNotes', { id: 'quick-ref', session_id: null }],
    ['timeBlocks', { id: 'block-ref', task_id: null }],
    ['reflections', { id: 'reflection-ref', related_task_ids: [] }],
    ['reports', { id: 'report-ref', config: { task_ids: [] } }],
    ['reportTemplates', { id: 'template-ref', config: { session_types: [] } }],
  ] as const)('rejects legacy reference in %s', async (store, row) => {
    const spaceId = `v18-reference-${crypto.randomUUID()}`
    const old = await openV17(spaceId)
    await old.table(store).put(row)
    old.close()

    await expect(openPomodoroXIDB(spaceId)).rejects.toThrow('legacy_client_data_present')
    await Dexie.delete(dexieDbNameForSpace(spaceId))
  })
})

describe('PomodoroXIDB v19 Sync protocol staging', () => {
  it('opens a clean v19 database without dropping v18 business stores', async () => {
    const spaceId = `v19-clean-${crypto.randomUUID()}`
    const database = new PomodoroXIDB(spaceId)
    await database.open()

    expect(database.verno).toBe(19)
    expect(database.tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      ...expectedV18SchemaInventory().map((store) => store.name),
      'syncAdmissionState',
      'syncRecoveryState',
      'syncRecoveryChunks',
      'syncPushBatches',
      'syncTerminalApplications',
    ]))
    expect(database.tables.map((table) => table.name)).toContain('workItems')
    await database.delete()
  })

  it('upgrades a valid v18 outbox row atomically with S4 defaults', async () => {
    const spaceId = `v19-upgrade-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = new Dexie(name)
    old.version(18).stores(toDexieStoreStrings(V18_STORE_DEFINITIONS))
    await old.open()
    await old.table('outbox').put({
      id: 1,
      spaceId,
      entityType: 'note',
      entityId: 'note-a',
      action: 'create',
      payload: '{"id":"note-a"}',
      payloadHash: 'a'.repeat(64),
      operationId: 'operation-a',
      compoundOperationId: null,
      compoundOrder: null,
      expectedVersion: null,
      requiresVersionRebase: false,
      transportState: 'ready',
      createdAt: '2026-08-07T01:00:00.000Z',
      synced: false,
      lastError: null,
      lastErrorCode: null,
      failedAt: null,
      attemptCount: 0,
    })
    old.close()

    const database = new PomodoroXIDB(spaceId, name)
    await database.open()

    expect(await database.outbox.get(1)).toMatchObject(INITIAL_S4_OUTBOX_FIELDS)
    expect(await database.syncAdmissionState.get('active')).toEqual({
      key: 'active',
      state: 'pending',
      readyRoots: [],
      readyRootSetSha256: null,
      errorCode: null,
    })
    await database.delete()
  })
})
