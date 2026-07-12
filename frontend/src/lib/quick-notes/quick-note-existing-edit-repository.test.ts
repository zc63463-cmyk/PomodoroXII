import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import type { CachedQuickNote, QuickNote } from '@/types'
import {
  configureQuickNoteOutboxHook,
  resetQuickNoteOutboxHook,
  type QuickNoteMutationContext,
} from '@/lib/quick-notes/quick-note-repository'
import {
  QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY,
  QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION,
  createDexieQuickNoteExistingEditAdapter,
  type ExistingEditSaveCapture,
  type QuickNoteExistingEditSnapshotV1,
  type QuickNoteExistingEditStorageAdapter,
} from '@/lib/quick-notes/quick-note-existing-edit-repository'

const BASE_UPDATED_AT = '2026-07-12T00:00:00.000Z'
const RECOVERY_UPDATED_AT = '2026-07-12T00:00:01.000Z'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeSnapshot(
  overrides: Partial<QuickNoteExistingEditSnapshotV1> = {},
): QuickNoteExistingEditSnapshotV1 {
  return {
    version: QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION,
    editId: 'edit-1',
    revision: 1,
    noteId: 'note-1',
    baseContent: 'base',
    baseUpdatedAt: BASE_UPDATED_AT,
    draft: 'local draft',
    updatedAt: RECOVERY_UPDATED_AT,
    ...overrides,
  }
}

function makeQuickNote(overrides: Partial<QuickNote> = {}): QuickNote {
  return {
    id: 'note-1',
    content: 'base',
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    session_id: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: BASE_UPDATED_AT,
    updated_at: BASE_UPDATED_AT,
    ...overrides,
  }
}

function makeCapture(
  note: QuickNote,
  overrides: Partial<ExistingEditSaveCapture> = {},
): ExistingEditSaveCapture {
  return {
    noteId: note.id,
    baseContent: note.content,
    baseUpdatedAt: note.updated_at,
    draft: 'local draft',
    ...overrides,
  }
}

async function seedQuickNote(
  database: PomodoroXIDB,
  note: QuickNote,
  syncOverrides: Partial<
    Pick<CachedQuickNote, 'content_hash' | 'deletion_state' | 'version' | '_dirty'>
  > = {},
): Promise<void> {
  await database.quickNotes.put({
    ...note,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...syncOverrides,
  })
}

async function putRawRecovery(
  database: PomodoroXIDB,
  value: string,
): Promise<void> {
  await database.settings.put({
    key: QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY,
    value,
  })
}

async function getRawRecovery(
  database: PomodoroXIDB,
): Promise<string | undefined> {
  return (await database.settings.get(QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY))?.value
}

describe('quick-note-existing-edit-repository', () => {
  let database: PomodoroXIDB
  let adapter: QuickNoteExistingEditStorageAdapter

  beforeEach(async () => {
    resetQuickNoteOutboxHook()
    database = new PomodoroXIDB(
      `existing-edit-adapter-${crypto.randomUUID()}`,
    )
    await database.open()
    adapter = createDexieQuickNoteExistingEditAdapter(database)
  })

  afterEach(async () => {
    resetQuickNoteOutboxHook()
    await database.delete()
  })

  describe('recovery storage', () => {
    it('reports an absent recovery row', async () => {
      await expect(adapter.load()).resolves.toEqual({ kind: 'absent' })
    })

    it('loads a valid recovery row and active target from one concrete database', async () => {
      const snapshot = makeSnapshot()
      const note = makeQuickNote()
      await Promise.all([
        adapter.checkpoint(snapshot),
        seedQuickNote(database, note),
      ])

      await expect(adapter.load()).resolves.toEqual({
        kind: 'valid',
        snapshot,
        owner: { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
        note,
        lifecycle: 'active',
      })
      expect(await getRawRecovery(database)).toBe(JSON.stringify(snapshot))
    })

    it.each([
      ['damaged JSON', '{damaged-json'],
      ['future version', JSON.stringify({ ...makeSnapshot(), version: 2 })],
      ['null', 'null'],
      ['array', '[]'],
      ['blank edit ID', JSON.stringify(makeSnapshot({ editId: '   ' }))],
      ['zero revision', JSON.stringify(makeSnapshot({ revision: 0 }))],
      ['fractional revision', JSON.stringify(makeSnapshot({ revision: 1.5 }))],
      ['blank note ID', JSON.stringify(makeSnapshot({ noteId: '' }))],
      ['non-string base content', JSON.stringify({ ...makeSnapshot(), baseContent: 42 })],
      ['blank base timestamp', JSON.stringify(makeSnapshot({ baseUpdatedAt: ' ' }))],
      ['non-string draft', JSON.stringify({ ...makeSnapshot(), draft: null })],
      ['blank recovery timestamp', JSON.stringify(makeSnapshot({ updatedAt: '\t' }))],
    ])('returns %s as an invalid exact raw owner without deleting it', async (_label, raw) => {
      await putRawRecovery(database, raw)

      await expect(adapter.load()).resolves.toEqual({
        kind: 'invalid',
        owner: { kind: 'raw', value: raw },
      })
      expect(await getRawRecovery(database)).toBe(raw)
    })

    it('accepts a blank draft as a valid recovery snapshot', async () => {
      const snapshot = makeSnapshot({ draft: '' })
      await adapter.checkpoint(snapshot)

      await expect(adapter.load()).resolves.toEqual({
        kind: 'valid',
        snapshot,
        owner: { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
        note: null,
        lifecycle: 'missing',
      })
    })

    it('checkpoints the exact JSON representation including whitespace', async () => {
      const snapshot = makeSnapshot({
        baseContent: '  base with space  ',
        draft: '   ',
      })

      await adapter.checkpoint(snapshot)

      expect(await getRawRecovery(database)).toBe(JSON.stringify(snapshot))
    })

    it('clears an invalid row only when its exact raw owner matches', async () => {
      const raw = '{damaged-json'
      await putRawRecovery(database, raw)

      await expect(
        adapter.clearIfOwned([{ kind: 'raw', value: raw }]),
      ).resolves.toBe('cleared')
      expect(await getRawRecovery(database)).toBeUndefined()
    })

    it('preserves an invalid row when a raw owner differs byte for byte', async () => {
      const raw = '{ "damaged": true '
      await putRawRecovery(database, raw)

      await expect(
        adapter.clearIfOwned([{ kind: 'raw', value: '{"damaged":true' }]),
      ).resolves.toBe('different-edit')
      expect(await getRawRecovery(database)).toBe(raw)
    })

    it('clears a valid row only when both edit ID and revision match', async () => {
      const snapshot = makeSnapshot()
      await adapter.checkpoint(snapshot)

      await expect(
        adapter.clearIfOwned([
          { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
        ]),
      ).resolves.toBe('cleared')
      expect(await getRawRecovery(database)).toBeUndefined()
    })

    it('does not clear a newer revision owned by the same edit', async () => {
      const older = makeSnapshot({ revision: 1 })
      const newer = makeSnapshot({ revision: 2, draft: 'newer' })
      await adapter.checkpoint(newer)

      await expect(
        adapter.clearIfOwned([
          { kind: 'v1', editId: older.editId, revision: older.revision },
        ]),
      ).resolves.toBe('different-edit')
      await expect(
        database.settings.get(QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY),
      ).resolves.toMatchObject({ value: JSON.stringify(newer) })
    })

    it('reports absent when cleanup finds no recovery row', async () => {
      await expect(
        adapter.clearIfOwned([{ kind: 'v1', editId: 'edit-1', revision: 1 }]),
      ).resolves.toBe('absent')
    })

    it('runs cleanup in one read-write transaction over settings only', async () => {
      await adapter.checkpoint(makeSnapshot())
      const transactionSpy = vi.spyOn(database, 'transaction')

      try {
        await adapter.clearIfOwned([
          { kind: 'v1', editId: 'edit-1', revision: 1 },
        ])

        expect(transactionSpy).toHaveBeenCalledOnce()
        expect(transactionSpy).toHaveBeenCalledWith(
          'rw',
          database.settings,
          expect.any(Function),
        )
      } finally {
        transactionSpy.mockRestore()
      }
    })

    it('runs load in one read transaction containing settings and quickNotes', async () => {
      await adapter.checkpoint(makeSnapshot())
      const transactionSpy = vi.spyOn(database, 'transaction')

      try {
        await adapter.load()

        expect(transactionSpy).toHaveBeenCalledOnce()
        expect(transactionSpy).toHaveBeenCalledWith(
          'r',
          database.settings,
          database.quickNotes,
          expect.any(Function),
        )
      } finally {
        transactionSpy.mockRestore()
      }
    })

    it('keeps settings rows isolated between concrete Space databases', async () => {
      const databaseB = new PomodoroXIDB(
        `existing-edit-adapter-b-${crypto.randomUUID()}`,
      )
      await databaseB.open()
      const adapterB = createDexieQuickNoteExistingEditAdapter(databaseB)
      const snapshotA = makeSnapshot({ editId: 'edit-a', draft: 'Space A' })
      const snapshotB = makeSnapshot({ editId: 'edit-b', draft: 'Space B' })

      try {
        await Promise.all([
          adapter.checkpoint(snapshotA),
          adapterB.checkpoint(snapshotB),
        ])

        expect(await getRawRecovery(database)).toBe(JSON.stringify(snapshotA))
        expect(await getRawRecovery(databaseB)).toBe(JSON.stringify(snapshotB))
      } finally {
        await databaseB.delete()
      }
    })

    it('reads a missing target authoritatively without a recovery row', async () => {
      await expect(adapter.readTarget('missing-note')).resolves.toEqual({
        note: null,
        lifecycle: 'missing',
      })
    })

    it.each([
      ['active', {}, {}],
      ['trashed', { trashed_at: RECOVERY_UPDATED_AT }, { deletion_state: 'deleted' }],
      ['archived', { archived_at: RECOVERY_UPDATED_AT }, {}],
      [
        'converted',
        {
          archived_at: RECOVERY_UPDATED_AT,
          trashed_at: RECOVERY_UPDATED_AT,
          migrated_to_note_id: 'converted-note',
        },
        { deletion_state: 'deleted' },
      ],
      ['sync-deleted', {}, { deletion_state: 'deleted' }],
    ] as const)(
      'reads and classifies an authoritative %s target without sync fields',
      async (lifecycle, noteOverrides, syncOverrides) => {
        const note = makeQuickNote({
          id: `target-${lifecycle}`,
          ...noteOverrides,
        })
        await seedQuickNote(database, note, syncOverrides)

        await expect(adapter.readTarget(note.id)).resolves.toEqual({
          note,
          lifecycle,
        })
      },
    )

    it('loads a consistent pre-write settings and target pair during a competing write', async () => {
      const snapshot = makeSnapshot()
      const originalNote = makeQuickNote()
      await Promise.all([
        adapter.checkpoint(snapshot),
        seedQuickNote(database, originalNote),
      ])

      const competing = new PomodoroXIDB(database.name)
      await competing.open()
      const settingsRead = createDeferred<void>()
      const releaseRead = createDeferred<void>()
      const writeRequested = createDeferred<void>()
      const originalGet = database.settings.get.bind(database.settings)
      const getSpy = vi.spyOn(database.settings, 'get').mockImplementation(
        () => originalGet(QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY).then((row) => {
          settingsRead.resolve(undefined)
          return Dexie.waitFor(releaseRead.promise).then(() => row)
        }),
      )
      let loadPromise: ReturnType<QuickNoteExistingEditStorageAdapter['load']> | undefined
      let competingWrite: Promise<number> | undefined

      try {
        loadPromise = adapter.load()
        await settingsRead.promise
        competingWrite = Dexie.ignoreTransaction(async () => {
          writeRequested.resolve(undefined)
          return competing.quickNotes.update(originalNote.id, {
            content: 'remote update',
            updated_at: RECOVERY_UPDATED_AT,
          })
        })
        await writeRequested.promise
        releaseRead.resolve(undefined)

        const loaded = await loadPromise
        expect(loaded).toEqual({
          kind: 'valid',
          snapshot,
          owner: { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
          note: originalNote,
          lifecycle: 'active',
        })
        await expect(competingWrite).resolves.toBe(1)
        await expect(database.quickNotes.get(originalNote.id)).resolves.toMatchObject({
          content: 'remote update',
          updated_at: RECOVERY_UPDATED_AT,
        })
      } finally {
        releaseRead.resolve(undefined)
        await Promise.allSettled([
          ...(loadPromise ? [loadPromise] : []),
          ...(competingWrite ? [competingWrite] : []),
        ])
        getSpy.mockRestore()
        competing.close()
      }
    })
  })

  describe('optimistic entity update', () => {
    it('updates a matching active target with repository invariants and preserves recovery', async () => {
      const note = makeQuickNote({
        id: 'matching-update',
        tags: ['old'],
      })
      const snapshot = makeSnapshot({
        noteId: note.id,
        baseContent: note.content,
        baseUpdatedAt: note.updated_at,
      })
      await seedQuickNote(database, note)
      await adapter.checkpoint(snapshot)
      await database.outbox.clear()
      const transactionSpy = vi.spyOn(database, 'transaction')

      try {
        const result = await adapter.updateEntity(
          makeCapture(note, { draft: '  updated body #Next  ' }),
        )

        expect(result).toMatchObject({
          kind: 'updated',
          note: {
            id: note.id,
            content: 'updated body #Next',
            tags: ['next'],
          },
        })
        if (result.kind !== 'updated') {
          throw new Error('Expected a successful existing-edit update')
        }
        expect(await database.quickNotes.get(note.id)).toEqual({
          ...result.note,
          content_hash: undefined,
          deletion_state: 'active',
          version: 2,
          _dirty: true,
        })
        expect(await database.outbox.toArray()).toEqual([{
          id: expect.any(Number),
          entityType: 'quickNote',
          entityId: note.id,
          action: 'update',
          payload: JSON.stringify(result.note),
          createdAt: expect.any(Number),
          synced: false,
          lastError: null,
          lastErrorCode: null,
          failedAt: null,
          attemptCount: 0,
        }])
        expect(await getRawRecovery(database)).toBe(JSON.stringify(snapshot))
        expect(transactionSpy).toHaveBeenCalledOnce()
        expect(transactionSpy).toHaveBeenCalledWith(
          'rw',
          database.quickNotes,
          database.outbox,
          expect.any(Function),
        )
      } finally {
        transactionSpy.mockRestore()
      }
    })

    it('returns the current note without writing when content differs from the base', async () => {
      const note = makeQuickNote({ id: 'content-conflict', content: 'remote content' })
      await seedQuickNote(database, note)
      await database.outbox.clear()
      const before = await database.quickNotes.get(note.id)
      const quickNotePutSpy = vi.spyOn(database.quickNotes, 'put')
      const outboxAddSpy = vi.spyOn(database.outbox, 'add')

      try {
        await expect(adapter.updateEntity(makeCapture(note, {
          baseContent: 'stale base',
          draft: 'local content',
        }))).resolves.toEqual({ kind: 'conflict', note })

        expect(quickNotePutSpy).not.toHaveBeenCalled()
        expect(outboxAddSpy).not.toHaveBeenCalled()
      } finally {
        quickNotePutSpy.mockRestore()
        outboxAddSpy.mockRestore()
      }
      expect(await database.quickNotes.get(note.id)).toEqual(before)
      expect(await database.outbox.count()).toBe(0)
    })

    it('returns the current note without writing when updated_at differs from the base', async () => {
      const note = makeQuickNote({
        id: 'timestamp-conflict',
        updated_at: RECOVERY_UPDATED_AT,
      })
      await seedQuickNote(database, note)
      await database.outbox.clear()
      const before = await database.quickNotes.get(note.id)

      await expect(adapter.updateEntity(makeCapture(note, {
        baseUpdatedAt: BASE_UPDATED_AT,
      }))).resolves.toEqual({ kind: 'conflict', note })

      expect(await database.quickNotes.get(note.id)).toEqual(before)
      expect(await database.outbox.count()).toBe(0)
    })

    it('reports a missing target as unavailable without writing', async () => {
      await expect(adapter.updateEntity({
        noteId: 'missing-target',
        baseContent: 'base',
        baseUpdatedAt: BASE_UPDATED_AT,
        draft: 'local content',
      })).resolves.toEqual({ kind: 'unavailable', lifecycle: 'missing' })

      expect(await database.quickNotes.count()).toBe(0)
      expect(await database.outbox.count()).toBe(0)
    })

    it.each([
      [
        'trashed',
        { trashed_at: RECOVERY_UPDATED_AT },
        { deletion_state: 'deleted' },
      ],
      ['archived', { archived_at: RECOVERY_UPDATED_AT }, {}],
      [
        'converted',
        {
          archived_at: RECOVERY_UPDATED_AT,
          migrated_to_note_id: 'converted-target',
        },
        {},
      ],
      ['sync-deleted', {}, { deletion_state: 'deleted' }],
    ] as const)(
      'classifies an inactive %s target before comparing the expected base',
      async (lifecycle, noteOverrides, syncOverrides) => {
        const note = makeQuickNote({
          id: `unavailable-${lifecycle}`,
          content: `remote ${lifecycle}`,
          updated_at: RECOVERY_UPDATED_AT,
          ...noteOverrides,
        })
        await seedQuickNote(database, note, syncOverrides)
        await database.outbox.clear()
        const before = await database.quickNotes.get(note.id)

        await expect(adapter.updateEntity(makeCapture(note, {
          baseContent: 'different content',
          baseUpdatedAt: '2026-01-01T00:00:00.000Z',
        }))).resolves.toEqual({ kind: 'unavailable', lifecycle })

        expect(await database.quickNotes.get(note.id)).toEqual(before)
        expect(await database.outbox.count()).toBe(0)
      },
    )

    it('rolls back the entity byte for byte when the default Outbox write fails', async () => {
      const note = makeQuickNote({ id: 'default-outbox-rollback' })
      await seedQuickNote(database, note)
      await database.outbox.clear()
      const before = await database.quickNotes.get(note.id)
      const beforeBytes = JSON.stringify(before)
      const addSpy = vi.spyOn(database.outbox, 'add')
        .mockRejectedValueOnce(new Error('outbox add failed'))

      try {
        await expect(
          adapter.updateEntity(makeCapture(note, { draft: 'changed' })),
        ).rejects.toThrow('outbox add failed')
      } finally {
        addSpy.mockRestore()
      }

      const after = await database.quickNotes.get(note.id)
      expect(after).toEqual(before)
      expect(JSON.stringify(after)).toBe(beforeBytes)
      expect(await database.outbox.count()).toBe(0)
    })

    it('updates without an Outbox event when the configured hook is disabled', async () => {
      configureQuickNoteOutboxHook(null)
      const note = makeQuickNote({ id: 'disabled-outbox-update' })
      await seedQuickNote(database, note)
      await database.outbox.clear()

      const result = await adapter.updateEntity(
        makeCapture(note, { draft: 'local only #Offline' }),
      )

      expect(result).toMatchObject({
        kind: 'updated',
        note: { content: 'local only #Offline', tags: ['offline'] },
      })
      expect(await database.quickNotes.get(note.id)).toMatchObject({
        content: 'local only #Offline',
        version: 2,
        _dirty: true,
      })
      expect(await database.outbox.count()).toBe(0)
    })

    it('awaits a custom update hook with the complete mutation context', async () => {
      const note = makeQuickNote({ id: 'custom-outbox-update' })
      await seedQuickNote(database, note)
      await database.outbox.clear()
      let hookCompleted = false
      const hook = vi.fn(async (_context: QuickNoteMutationContext) => {
        await database.quickNotes.get(note.id)
        hookCompleted = true
      })
      configureQuickNoteOutboxHook(hook)

      const result = await adapter.updateEntity(
        makeCapture(note, { draft: 'custom hook #Hooked' }),
      )

      expect(result.kind).toBe('updated')
      if (result.kind !== 'updated') {
        throw new Error('Expected custom-hook update to succeed')
      }
      expect(hookCompleted).toBe(true)
      expect(hook).toHaveBeenCalledOnce()
      expect(hook).toHaveBeenCalledWith({
        entityType: 'quickNote',
        entityId: note.id,
        action: 'update',
        payload: result.note,
      })
      expect(await database.outbox.count()).toBe(0)
    })

    it('rolls back the entity when a custom update hook throws', async () => {
      const note = makeQuickNote({ id: 'custom-hook-rollback' })
      await seedQuickNote(database, note)
      await database.outbox.clear()
      const before = await database.quickNotes.get(note.id)
      configureQuickNoteOutboxHook(async () => {
        await database.quickNotes.get(note.id)
        throw new Error('custom update hook failed')
      })

      await expect(
        adapter.updateEntity(makeCapture(note, { draft: 'should rollback' })),
      ).rejects.toThrow('custom update hook failed')

      expect(await database.quickNotes.get(note.id)).toEqual(before)
      expect(await database.outbox.count()).toBe(0)
    })

    it('updates only Space A when Space A and B contain the same note ID', async () => {
      const databaseB = new PomodoroXIDB(
        `existing-edit-update-b-${crypto.randomUUID()}`,
      )
      await databaseB.open()
      const adapterB = createDexieQuickNoteExistingEditAdapter(databaseB)
      const sharedId = 'shared-note'
      const noteA = makeQuickNote({
        id: sharedId,
        content: 'Space A base',
        updated_at: BASE_UPDATED_AT,
      })
      const noteB = makeQuickNote({
        id: sharedId,
        content: 'Space B base',
        updated_at: RECOVERY_UPDATED_AT,
      })
      const snapshotA = makeSnapshot({
        editId: 'edit-a',
        noteId: sharedId,
        baseContent: noteA.content,
        baseUpdatedAt: noteA.updated_at,
      })
      const snapshotB = makeSnapshot({
        editId: 'edit-b',
        noteId: sharedId,
        baseContent: noteB.content,
        baseUpdatedAt: noteB.updated_at,
      })

      try {
        await Promise.all([
          seedQuickNote(database, noteA),
          seedQuickNote(databaseB, noteB),
          adapter.checkpoint(snapshotA),
          adapterB.checkpoint(snapshotB),
        ])
        await Promise.all([database.outbox.clear(), databaseB.outbox.clear()])
        const beforeB = await databaseB.quickNotes.get(sharedId)

        await expect(adapter.updateEntity(makeCapture(noteA, {
          draft: 'Space A update #Alpha',
        }))).resolves.toMatchObject({
          kind: 'updated',
          note: { id: sharedId, content: 'Space A update #Alpha' },
        })

        expect(await database.quickNotes.get(sharedId)).toMatchObject({
          content: 'Space A update #Alpha',
          tags: ['alpha'],
          version: 2,
          _dirty: true,
        })
        expect(await database.outbox.where('entityId').equals(sharedId).count()).toBe(1)
        expect(await getRawRecovery(database)).toBe(JSON.stringify(snapshotA))
        expect(await databaseB.quickNotes.get(sharedId)).toEqual(beforeB)
        expect(await databaseB.outbox.count()).toBe(0)
        expect(await getRawRecovery(databaseB)).toBe(JSON.stringify(snapshotB))
      } finally {
        await databaseB.delete()
      }
    })
  })
})
