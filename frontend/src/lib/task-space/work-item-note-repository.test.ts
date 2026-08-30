import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalize } from 'json-canonicalize'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { taskSpaceApi } from '@/services/task-space-api'
import { WorkItemNoteRepository } from './work-item-note-repository'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []
const timestamp = '2026-07-15T08:00:00.000Z'
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

class FakeLockManager {
  request<T>(
    _name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T> {
    return callback()
  }
}

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: new FakeLockManager(),
  })
})

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

const documentWithText = (text: string): WorkItemNoteDocument => ({
  contentVersion: 1,
  blocks: [{ type: 'paragraph', blockId: 'p-1', text }],
})

const remoteNote = (text: string, version: number, updatedAt = timestamp) => ({
  spaceId: 'space-note',
  noteId: 'note-1',
  workItemId: 'wi-1',
  document: documentWithText(text),
  version,
  createdAt: timestamp,
  updatedAt,
})

async function fixture() {
  const spaceId = crypto.randomUUID()
  const db = await openPomodoroXIDB(spaceId)
  databases.push(db)
  await db.workItemNotes.put({
    id: 'note-1',
    noteId: 'note-1',
    workItemId: 'wi-1',
    document: { contentVersion: 1, blocks: [] },
    version: 4,
    localRevision: 7,
    syncState: 'clean',
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  const api = {
    ...taskSpaceApi,
    getNote: vi.fn(),
    replaceNote: vi.fn(),
    appendBlocks: vi.fn(),
    toggleChecklistItem: vi.fn(),
  }
  return { db, spaceId, api }
}

describe('WorkItemNoteRepository local durability', () => {
  it('writes a complete post-image and one outbox row atomically', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    const saved = await repository.saveLocal({
      workItemId: 'wi-1',
      expectedLocalRevision: 7,
      document: documentWithText('Durable'),
      operationId: 'note-op-1',
      now: '2026-07-15T08:01:00.000Z',
    })
    expect(saved.localRevision).toBe(8)
    expect(((await db.workItemNotes.get('note-1'))?.document as WorkItemNoteDocument | undefined)?.blocks)
      .toHaveLength(1)
    const rows = await db.outbox.where('entityId').equals('note-1').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      spaceId,
      entityType: 'workItemNote',
      operationId: 'note-op-1',
      expectedVersion: 4,
      transportState: 'awaiting_s4',
      createdAt: '2026-07-15T08:01:00.000Z',
    })
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      id: 'note-1',
      work_item_id: 'wi-1',
      document_json: canonicalize({ contentVersion: 1, blocks: [{ type: 'paragraph', blockId: 'p-1', text: 'Durable' }] }),
      // The sync wire post-image carries the NEXT server version (before + 1).
      version: 5,
      created_at: timestamp,
      updated_at: '2026-07-15T08:01:00.000Z',
    })
    expect(api.replaceNote).not.toHaveBeenCalled()
  })

  it('rejects a stale local revision without changing Note or outbox', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    await expect(repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 6,
      document: { contentVersion: 1, blocks: [] },
      operationId: 'stale', now: '2026-07-15T08:01:00.000Z',
    })).rejects.toThrow('local_version_conflict')
    expect((await db.workItemNotes.get('note-1'))?.localRevision).toBe(7)
    expect(await db.outbox.count()).toBe(0)
  })

  it('preserves both documents and blocks dispatch on a server CAS conflict', async () => {
    const { db, spaceId, api } = await fixture()
    api.replaceNote.mockRejectedValue(Object.assign(new Error('conflict'), { response: { status: 409 } }))
    api.getNote.mockResolvedValue(remoteNote('Remote', 5, '2026-07-15T08:02:00.000Z'))
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    await repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: documentWithText('Local'), operationId: 'note-conflict',
      now: '2026-07-15T08:01:00.000Z',
    })
    await expect(repository.dispatchReplace('wi-1')).rejects.toThrow('version_conflict')
    const conflict = await db.workItemNoteConflicts.get('wi-1') as Record<string, unknown> | undefined
    expect((conflict?.localDocument as WorkItemNoteDocument).blocks[0]).toMatchObject({ text: 'Local' })
    expect((conflict?.remoteDocument as WorkItemNoteDocument).blocks[0]).toMatchObject({ text: 'Remote' })
    expect(conflict).toMatchObject({ baseVersion: 4, remoteVersion: 5 })
    expect((await db.workItemNotes.get('note-1'))?.syncState).toBe('conflict')
    expect((await db.outbox.where('entityId').equals('note-1').first())?.transportState)
      .toBe('blocked_conflict')
  })

  it('keeps a newer local edit when an older server response arrives', async () => {
    const { db, spaceId, api } = await fixture()
    let resolve: ((value: unknown) => void) | undefined
    api.replaceNote.mockImplementation(() => new Promise((res) => { resolve = res }))
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    await repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: documentWithText('First'), operationId: 'op-first',
      now: '2026-07-15T08:01:00.000Z',
    })
    const dispatch = repository.dispatchReplace('wi-1')
    await vi.waitFor(() => expect(api.replaceNote).toHaveBeenCalledOnce())
    await repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 8,
      document: documentWithText('Second'), operationId: 'op-second',
      now: '2026-07-15T08:01:01.000Z',
    })
    resolve!(remoteNote('First', 5, '2026-07-15T08:02:00.000Z'))
    await dispatch
    const note = await db.workItemNotes.get('note-1')
    expect(note).toMatchObject({ version: 5, localRevision: 9, syncState: 'dirty' })
    expect((note?.document as WorkItemNoteDocument).blocks[0]).toMatchObject({ text: 'Second' })
    const row = await db.outbox.where('entityId').equals('note-1').first()
    expect(row).toMatchObject({ expectedVersion: 5, transportState: 'awaiting_s4' })
    expect(row?.operationId).not.toBe('op-first')
  })

  it('persists a durable draft on flush failure and clears it on success', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    // Flush fails with local_version_conflict (current localRevision is 7,
    // the flush was based on revision 6).
    await expect(repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 6,
      document: documentWithText('Draft'), operationId: 'op-draft',
      now: '2026-07-15T08:01:00.000Z',
    })).rejects.toThrow('local_version_conflict')

    // A durable draft now survives in localStorage.
    expect(repository.loadDraft('wi-1')?.document.blocks[0]).toMatchObject({ text: 'Draft' })
    expect((await db.workItemNotes.get('note-1'))?.localRevision).toBe(7)

    // A successful save clears any stale durable draft.
    const saved = await repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: documentWithText('Fresh'), operationId: 'op-fresh',
      now: '2026-07-15T08:02:00.000Z',
    })
    expect(saved.localRevision).toBe(8)
    expect(repository.loadDraft('wi-1')).toBeNull()
  })

  it('re-applies a durable draft through a NEW repository (no old closure)', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    await expect(repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 6,
      document: documentWithText('Draft'), operationId: 'op-draft',
      now: '2026-07-15T08:01:00.000Z',
    })).rejects.toThrow('local_version_conflict')
    expect(repository.loadDraft('wi-1')).not.toBeNull()

    // After reload/re-sync the local note is re-fetched at the draft's base
    // revision.  A brand-new repository instance (fresh closure) recovers it.
    await db.workItemNotes.put({
      id: 'note-1', noteId: 'note-1', workItemId: 'wi-1',
      document: { contentVersion: 1, blocks: [] },
      version: 4, localRevision: 6, syncState: 'clean',
      createdAt: timestamp, updatedAt: '2026-07-15T08:02:00.000Z',
    })
    const fresh = new WorkItemNoteRepository(db, spaceId, api)
    const recovered = await fresh.retryDraft('wi-1')
    expect(recovered?.document.blocks[0]).toMatchObject({ text: 'Draft' })
    expect(fresh.loadDraft('wi-1')).toBeNull()
  })

  it('keeps the durable draft when a retry still fails', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    await expect(repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 6,
      document: documentWithText('Draft'), operationId: 'op-draft',
      now: '2026-07-15T08:01:00.000Z',
    })).rejects.toThrow('local_version_conflict')

    // Note is still at localRevision 7, so retrying the revision-6 draft fails
    // and the draft remains durable.
    const recovered = await repository.retryDraft('wi-1')
    expect(recovered).toBeNull()
    expect(repository.loadDraft('wi-1')).not.toBeNull()
  })

  it('a stale flush completing after a newer draft does NOT clear the newer draft', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    // A newer edit's durable draft is already persisted (base 7 = current).
    repository.persistDraft({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: documentWithText('Newer'), operationId: 'op-newer',
      now: '2026-07-15T08:02:00.000Z',
    })

    // An OLDER flush (different operation, same base — e.g. a blur flush that
    // started before the newer keystroke) completes and succeeds.  It must not
    // clear the newer draft: a hard reload inside the debounce window must be
    // able to recover the newer edit.
    const saved = await repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: documentWithText('Stale flush'), operationId: 'op-stale',
      now: '2026-07-15T08:03:00.000Z',
    })
    expect(saved.localRevision).toBe(8)
    expect(repository.loadDraft('wi-1')?.document.blocks[0]).toMatchObject({ text: 'Newer' })
  })

  it('a matching save clears the durable draft it corresponds to', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    repository.persistDraft({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: documentWithText('Matching'), operationId: 'op-match',
      now: '2026-07-15T08:02:00.000Z',
    })
    const saved = await repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: documentWithText('Same'), operationId: 'op-match',
      now: '2026-07-15T08:03:00.000Z',
    })
    expect(saved.localRevision).toBe(8)
    expect(repository.loadDraft('wi-1')).toBeNull()
  })

  it('re-applies a durable draft when the note is BEHIND the draft base (reload interrupted the base flush)', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    // Draft was created while the note was at base 1; a hard reload happened
    // BEFORE the base save landed, so the re-loaded note is back at rev 0.
    await db.workItemNotes.put({
      id: 'note-1', noteId: 'note-1', workItemId: 'wi-1',
      document: documentWithText('Initial'), version: 4, localRevision: 0, syncState: 'clean',
      createdAt: timestamp, updatedAt: timestamp,
    })
    repository.persistDraft({
      workItemId: 'wi-1', expectedLocalRevision: 1,
      document: documentWithText('Draft'), operationId: 'op-draft',
      now: '2026-07-15T08:02:00.000Z',
    })
    const recovered = await repository.retryDraft('wi-1')
    expect(recovered?.document.blocks[0]).toMatchObject({ text: 'Draft' })
    expect(recovered?.localRevision).toBe(1)
    expect(repository.loadDraft('wi-1')).toBeNull()
  })

  it('re-applies a durable draft atomically even if a sync push reset the row between reads (Wave 2C race regression)', async () => {
    const { db, spaceId, api } = await fixture()
    const repository = new WorkItemNoteRepository(db, spaceId, api)
    // The sync engine's push terminal application can reset the note row to
    // syncState 'clean' / localRevision 0 AFTER the editor scheduled a draft
    // based on revision 1, but BEFORE retryDraft's save runs.  A non-atomic
    // retryDraft would read localRevision 1, then saveLocal's inner re-read
    // would see 0 and throw `local_version_conflict`, losing the draft.
    await db.workItemNotes.put({
      id: 'note-1', noteId: 'note-1', workItemId: 'wi-1',
      document: documentWithText('Initial'), version: 4, localRevision: 0, syncState: 'clean',
      createdAt: timestamp, updatedAt: timestamp,
    })
    repository.persistDraft({
      workItemId: 'wi-1', expectedLocalRevision: 1,
      document: documentWithText('Draft'), operationId: 'op-draft',
      now: '2026-07-15T08:02:00.000Z',
    })
    // Simulate the exact race: the cached view is ahead (rev 1) while the
    // persisted row (what the save transaction sees) is behind (rev 0).
    const recovered = await repository.retryDraft('wi-1')
    expect(recovered?.document.blocks[0]).toMatchObject({ text: 'Draft' })
    expect(recovered?.localRevision).toBe(1)
    expect(repository.loadDraft('wi-1')).toBeNull()
    expect((await db.workItemNotes.get('note-1'))?.syncState).toBe('dirty')
  })
})
