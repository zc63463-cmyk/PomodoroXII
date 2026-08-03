import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { dexieDbNameForSpace } from '@/lib/platform'
import { atomicDexieV18Cutover, openPomodoroXIDB } from './dexie-v18-cutover'
import { DEXIE_V18_NATIVE_VERSION, expectedV18SchemaInventory, V18_REMOVED_STORE_NAMES } from './dexie-v18-schema'

const v17Stores = {
  tasks: 'id', sessions: 'id', sessionEvents: 'id', sessionContexts: 'id', cognitiveMarks: 'id',
  taskTags: 'id', taskRelations: 'id', focusPatterns: 'id', taskQuickNotes: 'id', sessionQuickNotes: 'id',
  quickNotes: 'id, session_id', timeBlocks: 'id, task_id', reflections: 'id', reports: 'id', reportTemplates: 'id',
  notes: 'id', schedules: 'id', habits: 'id', habitCheckIns: 'id', memoComments: 'id',
  scheduleQuickNotes: 'id, schedule_id, quick_note_id, [schedule_id+quick_note_id]',
  outbox: '++id, entityType, entityId, synced, createdAt', settings: 'key', syncMeta: 'key',
}

const openRaw = async (name: string) => {
  const db = new Dexie(name)
  db.version(17).stores(v17Stores)
  await db.open()
  return db
}

describe('Dexie v18 native cutover', () => {
  it('opens a clean Space with the exact final inventory and no removed stores', async () => {
    const spaceId = `v18-clean-${crypto.randomUUID()}`
    const db = await openPomodoroXIDB(spaceId)
    expect(db.verno).toBe(18)
    const names = db.tables.map((table) => table.name).sort()
    expect(names).toEqual(expectedV18SchemaInventory().map((entry) => entry.name))
    for (const removed of V18_REMOVED_STORE_NAMES) expect(names).not.toContain(removed)
    expect(db.quickNotes.schema.indexes.map((entry) => entry.name)).not.toContain('session_id')
    expect(db.timeBlocks.schema.indexes.map((entry) => entry.name)).not.toContain('task_id')
    await db.delete()
  })

  it('upgrades an empty native v17 database to native v18', async () => {
    const spaceId = `v18-empty-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = await openRaw(name)
    old.close()
    await atomicDexieV18Cutover(name)
    const probe = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(probe.version).toBe(DEXIE_V18_NATIVE_VERSION)
    expect(Array.from(probe.objectStoreNames).sort()).toEqual(expectedV18SchemaInventory().map((entry) => entry.name))
    probe.close()
    await Dexie.delete(name)
  })

  it.each(['tasks', 'sessions', 'outbox'] as const)('rejects populated %s before any DDL', async (store) => {
    const spaceId = `v18-reject-${store}-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = await openRaw(name)
    await old.table(store).put(store === 'outbox' ? { entityType: 'note', entityId: 'n', createdAt: '2026-07-15T08:00:00Z' } : { id: 'legacy' })
    old.close()
    await expect(atomicDexieV18Cutover(name)).rejects.toThrow(`legacy_client_data_present:${store}`)
    const probe = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(probe.version).toBe(170)
    expect(Array.from(probe.objectStoreNames)).toContain(store)
    probe.close()
    await Dexie.delete(name)
  })

  it('preserves a surviving row without a legacy Task/Session reference', async () => {
    const spaceId = `v18-preserve-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = await openRaw(name)
    const row = { id: 'quick-1', content: 'Keep', tags: ['focus'] }
    await old.table('quickNotes').put(row)
    old.close()
    const upgraded = await openPomodoroXIDB(spaceId)
    await expect(upgraded.quickNotes.get('quick-1')).resolves.toEqual(row)
    await upgraded.delete()
  })

  it('rejects a surviving legacy reference even when its value is null', async () => {
    const spaceId = `v18-reference-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = await openRaw(name)
    await old.table('quickNotes').put({ id: 'quick-1', session_id: null })
    old.close()
    await expect(atomicDexieV18Cutover(name)).rejects.toThrow('legacy_client_data_present:quickNotes.session_id')
    await Dexie.delete(name)
  })
})
