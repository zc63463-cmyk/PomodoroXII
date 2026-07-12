import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import {
  configureQuickNoteOutboxHook,
  resetQuickNoteOutboxHook,
  type QuickNoteMutationContext,
} from '@/lib/quick-notes/quick-note-repository'
import {
  QUICK_NOTE_NEW_DRAFT_KEY,
  createDexieQuickNoteDraftAdapter,
  type QuickNoteNewDraftSnapshotV2,
} from '@/lib/quick-notes/quick-note-draft-repository'

const UPDATED_AT = '2026-07-10T04:00:00.000Z'

function createSnapshot(
  draftId: string,
  content = '尚未记录的小记 #draft',
  updatedAt = UPDATED_AT,
): QuickNoteNewDraftSnapshotV2 {
  return {
    version: 2,
    draftId,
    content,
    updatedAt,
  }
}

async function putRawDraft(database: PomodoroXIDB, value: string): Promise<void> {
  await database.settings.put({ key: QUICK_NOTE_NEW_DRAFT_KEY, value })
}

async function getRawDraft(database: PomodoroXIDB): Promise<string | undefined> {
  return (await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY))?.value
}

describe('quick-note-draft-repository', () => {
  let dbA: PomodoroXIDB
  let dbB: PomodoroXIDB

  beforeEach(async () => {
    resetQuickNoteOutboxHook()
    dbA = new PomodoroXIDB(`quick-note-draft-a-${crypto.randomUUID()}`)
    dbB = new PomodoroXIDB(`quick-note-draft-b-${crypto.randomUUID()}`)
    await Promise.all([dbA.open(), dbB.open()])
  })

  afterEach(async () => {
    resetQuickNoteOutboxHook()
    await Promise.all([dbA.delete(), dbB.delete()])
  })

  describe('owner-aware Dexie adapter', () => {
    it('loads a valid v1 snapshot with its exact raw owner without mutating storage', async () => {
      const raw = '{"version":1,"content":"legacy draft","updatedAt":"2026-07-10T04:00:00.000Z"}'
      await putRawDraft(dbA, raw)

      await expect(createDexieQuickNoteDraftAdapter(dbA).load()).resolves.toEqual({
        kind: 'valid',
        snapshot: {
          version: 1,
          content: 'legacy draft',
          updatedAt: UPDATED_AT,
        },
        owner: { kind: 'raw', value: raw },
      })
      expect(await getRawDraft(dbA)).toBe(raw)
    })

    it('clears a v1 row when its exact raw owner still matches', async () => {
      const raw = '{ "version": 1, "content": "legacy owned", "updatedAt": "2026-07-10T04:00:00.000Z" }'
      await putRawDraft(dbA, raw)
      const adapter = createDexieQuickNoteDraftAdapter(dbA)

      const loaded = await adapter.load()
      expect(loaded).toEqual({
        kind: 'valid',
        snapshot: {
          version: 1,
          content: 'legacy owned',
          updatedAt: UPDATED_AT,
        },
        owner: { kind: 'raw', value: raw },
      })
      if (loaded.kind !== 'valid') throw new Error('Expected a valid v1 draft')

      await expect(adapter.clearIfOwned([loaded.owner])).resolves.toBe('cleared')
      expect(await getRawDraft(dbA)).toBeUndefined()
    })

    it('loads a valid v2 snapshot with its stable draft owner without mutating storage', async () => {
      const snapshot = createSnapshot('draft-load-v2')
      const raw = JSON.stringify(snapshot)
      await putRawDraft(dbA, raw)

      await expect(createDexieQuickNoteDraftAdapter(dbA).load()).resolves.toEqual({
        kind: 'valid',
        snapshot,
        owner: { kind: 'v2', draftId: snapshot.draftId },
      })
      expect(await getRawDraft(dbA)).toBe(raw)
    })

    it('reports an absent row', async () => {
      await expect(createDexieQuickNoteDraftAdapter(dbA).load()).resolves.toEqual({
        kind: 'absent',
      })
    })

    it.each([
      ['blank', '   '],
      ['damaged JSON', '{damaged-json'],
      ['unsupported version', JSON.stringify({ version: 99, content: 'future', updatedAt: UPDATED_AT })],
      ['structurally invalid v1', JSON.stringify({ version: 1, content: '   ', updatedAt: UPDATED_AT })],
      ['structurally invalid v2', JSON.stringify({ version: 2, draftId: '', content: 'draft', updatedAt: UPDATED_AT })],
    ])('reports %s rows as invalid raw owners without deleting them', async (_label, raw) => {
      await putRawDraft(dbA, raw)

      await expect(createDexieQuickNoteDraftAdapter(dbA).load()).resolves.toEqual({
        kind: 'invalid',
        owner: { kind: 'raw', value: raw },
      })
      expect(await getRawDraft(dbA)).toBe(raw)
    })

    it('saves the exact JSON representation of the supplied v2 snapshot', async () => {
      const snapshot = createSnapshot('draft-save-exact', '  keep surrounding space  ')

      await createDexieQuickNoteDraftAdapter(dbA).save(snapshot)

      expect(await getRawDraft(dbA)).toBe(JSON.stringify(snapshot))
    })

    it('does not turn a blank v2 save into an unconditional delete', async () => {
      const snapshot = createSnapshot('draft-save-blank', '   ')

      await createDexieQuickNoteDraftAdapter(dbA).save(snapshot)

      expect(await getRawDraft(dbA)).toBe(JSON.stringify(snapshot))
    })

    it('clears a newer revision when the stable v2 draft owner matches', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-owned', 'first revision')
      await adapter.save(snapshot)
      const loaded = await adapter.load()
      if (loaded.kind !== 'valid') throw new Error('Expected a valid v2 draft')
      await adapter.save(createSnapshot(snapshot.draftId, 'newer revision'))

      await expect(adapter.clearIfOwned([loaded.owner])).resolves.toBe('cleared')
      expect(await getRawDraft(dbA)).toBeUndefined()
    })

    it('preserves a different v2 draft when given a stale owner', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const newer = createSnapshot('draft-newer', 'newer draft')
      await adapter.save(newer)

      await expect(adapter.clearIfOwned([
        { kind: 'v2', draftId: 'draft-stale' },
      ])).resolves.toBe('different-draft')
      expect(await getRawDraft(dbA)).toBe(JSON.stringify(newer))
    })

    it('preserves a newer v2 save when cleanup holds only a stale raw owner', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const legacyRaw = JSON.stringify({
        version: 1,
        content: 'legacy',
        updatedAt: UPDATED_AT,
      })
      await putRawDraft(dbA, legacyRaw)
      const loaded = await adapter.load()
      if (loaded.kind !== 'valid') throw new Error('Expected a valid v1 draft')
      const newer = createSnapshot('draft-after-legacy')
      await adapter.save(newer)

      await expect(adapter.clearIfOwned([loaded.owner])).resolves.toBe('different-draft')
      expect(await getRawDraft(dbA)).toBe(JSON.stringify(newer))
    })

    it('reports absent when clearing an owner from empty storage', async () => {
      await expect(createDexieQuickNoteDraftAdapter(dbA).clearIfOwned([
        { kind: 'v2', draftId: 'missing-draft' },
      ])).resolves.toBe('absent')
    })

    it('records the QuickNote, default Outbox event, and draft deletion atomically', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-record-default', 'record me #Captured')
      await adapter.save(snapshot)

      const note = await adapter.record(snapshot)

      expect(note).toEqual({
        id: snapshot.draftId,
        content: snapshot.content,
        mood: null,
        tags: ['captured'],
        pinned: false,
        archived_at: null,
        archive_file_path: null,
        session_id: null,
        folder_id: null,
        trashed_at: null,
        migrated_to_note_id: null,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
      expect(note.updated_at).toBe(note.created_at)
      expect(await dbA.quickNotes.get(snapshot.draftId)).toEqual({
        ...note,
        content_hash: undefined,
        deletion_state: 'active',
        version: 1,
        _dirty: true,
      })
      const outboxRows = await dbA.outbox.toArray()
      expect(outboxRows).toEqual([{
        id: expect.any(Number),
        entityType: 'quickNote',
        entityId: snapshot.draftId,
        action: 'create',
        payload: JSON.stringify(note),
        createdAt: expect.any(Number),
        synced: false,
        lastError: null,
        lastErrorCode: null,
        failedAt: null,
        attemptCount: 0,
      }])
      expect(await getRawDraft(dbA)).toBeUndefined()
    })

    it('rolls back the entity and Outbox when draft deletion fails', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-delete-rollback')
      await adapter.save(snapshot)
      const raw = await getRawDraft(dbA)
      const deleteSpy = vi.spyOn(dbA.settings, 'delete')
        .mockRejectedValueOnce(new Error('settings delete failed'))

      try {
        await expect(adapter.record(snapshot)).rejects.toThrow('settings delete failed')
      } finally {
        deleteSpy.mockRestore()
      }

      expect(await dbA.quickNotes.get(snapshot.draftId)).toBeUndefined()
      expect(await dbA.outbox.count()).toBe(0)
      expect(await getRawDraft(dbA)).toBe(raw)
    })

    it('rolls back the entity and preserves the draft when default Outbox add fails', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-outbox-rollback')
      await adapter.save(snapshot)
      const raw = await getRawDraft(dbA)
      const addSpy = vi.spyOn(dbA.outbox, 'add')
        .mockRejectedValueOnce(new Error('outbox add failed'))

      try {
        await expect(adapter.record(snapshot)).rejects.toThrow('outbox add failed')
      } finally {
        addSpy.mockRestore()
      }

      expect(await dbA.quickNotes.get(snapshot.draftId)).toBeUndefined()
      expect(await dbA.outbox.count()).toBe(0)
      expect(await getRawDraft(dbA)).toBe(raw)
    })

    it('records and clears the draft without an Outbox event when disabled', async () => {
      configureQuickNoteOutboxHook(null)
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-record-local')
      await adapter.save(snapshot)

      const note = await adapter.record(snapshot)

      expect(await dbA.quickNotes.get(snapshot.draftId)).toEqual({
        ...note,
        content_hash: undefined,
        deletion_state: 'active',
        version: 1,
        _dirty: true,
      })
      expect(await dbA.outbox.count()).toBe(0)
      expect(await getRawDraft(dbA)).toBeUndefined()
    })

    it('awaits a custom hook with the complete create context and no default Outbox', async () => {
      let hookCompleted = false
      const hook = vi.fn(async (_context: QuickNoteMutationContext) => {
        await dbA.quickNotes.get('draft-record-hook')
        hookCompleted = true
      })
      configureQuickNoteOutboxHook(hook)
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-record-hook', 'hook content #HookTag')
      await adapter.save(snapshot)

      const note = await adapter.record(snapshot)

      expect(hookCompleted).toBe(true)
      expect(hook).toHaveBeenCalledOnce()
      expect(hook).toHaveBeenCalledWith({
        entityType: 'quickNote',
        entityId: note.id,
        action: 'create',
        payload: note,
      })
      expect(await dbA.quickNotes.get(note.id)).toEqual({
        ...note,
        content_hash: undefined,
        deletion_state: 'active',
        version: 1,
        _dirty: true,
      })
      expect(await dbA.outbox.count()).toBe(0)
      expect(await getRawDraft(dbA)).toBeUndefined()
    })

    it('rolls back the entity and preserves the draft when a custom hook throws', async () => {
      configureQuickNoteOutboxHook(async () => {
        await dbA.quickNotes.get('draft-hook-rollback')
        throw new Error('custom hook failed')
      })
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-hook-rollback')
      await adapter.save(snapshot)
      const raw = await getRawDraft(dbA)

      await expect(adapter.record(snapshot)).rejects.toThrow('custom hook failed')

      expect(await dbA.quickNotes.get(snapshot.draftId)).toBeUndefined()
      expect(await dbA.outbox.count()).toBe(0)
      expect(await getRawDraft(dbA)).toBe(raw)
    })

    it('rolls back local writes when a custom hook rejects after a macrotask', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const snapshot = createSnapshot('draft-delayed-hook-rollback')
      await adapter.save(snapshot)
      const raw = await getRawDraft(dbA)
      configureQuickNoteOutboxHook(async () => {
        await dbA.outbox.add({
          entityType: 'quickNote',
          entityId: snapshot.draftId,
          action: 'create',
          payload: JSON.stringify({ id: snapshot.draftId, content: snapshot.content }),
          createdAt: Date.now(),
          synced: false,
          lastError: null,
          lastErrorCode: null,
          failedAt: null,
          attemptCount: 0,
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        throw new Error('delayed custom hook failed')
      })

      await expect(adapter.record(snapshot)).rejects.toThrow('delayed custom hook failed')

      expect(await dbA.outbox.where('entityId').equals(snapshot.draftId).count()).toBe(0)
      expect(await dbA.quickNotes.get(snapshot.draftId)).toBeUndefined()
      expect(await getRawDraft(dbA)).toBe(raw)
    })

    it('rejects an ownership mismatch before any entity, Outbox, or delete mutation', async () => {
      const adapter = createDexieQuickNoteDraftAdapter(dbA)
      const requested = createSnapshot('draft-requested')
      const current = createSnapshot('draft-current')
      await adapter.save(current)
      const deleteSpy = vi.spyOn(dbA.settings, 'delete')

      try {
        await expect(adapter.record(requested)).rejects.toThrow(
          'QuickNote draft ownership changed before record',
        )
        expect(deleteSpy).not.toHaveBeenCalled()
      } finally {
        deleteSpy.mockRestore()
      }

      expect(await dbA.quickNotes.count()).toBe(0)
      expect(await dbA.outbox.count()).toBe(0)
      expect(await getRawDraft(dbA)).toBe(JSON.stringify(current))
    })

    it('keeps Space A and Space B adapter storage and record writes isolated', async () => {
      const adapterA = createDexieQuickNoteDraftAdapter(dbA)
      const adapterB = createDexieQuickNoteDraftAdapter(dbB)
      const snapshotA = createSnapshot('draft-space-a', 'Space A #alpha')
      const snapshotB = createSnapshot('draft-space-b', 'Space B #beta')
      await Promise.all([adapterA.save(snapshotA), adapterB.save(snapshotB)])

      await adapterA.record(snapshotA)

      expect(await dbA.quickNotes.get(snapshotA.draftId)).toBeDefined()
      expect(await dbA.outbox.where('entityId').equals(snapshotA.draftId).count()).toBe(1)
      expect(await getRawDraft(dbA)).toBeUndefined()
      expect(await dbB.quickNotes.count()).toBe(0)
      expect(await dbB.outbox.count()).toBe(0)
      await expect(adapterB.load()).resolves.toEqual({
        kind: 'valid',
        snapshot: snapshotB,
        owner: { kind: 'v2', draftId: snapshotB.draftId },
      })
      expect(await getRawDraft(dbB)).toBe(JSON.stringify(snapshotB))
    })
  })
})
