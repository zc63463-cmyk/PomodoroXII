import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { taskSpaceApi } from '@/services/task-space-api'
import { WorkItemNoteRepository } from './work-item-note-repository'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []
const timestamp = '2026-07-15T08:00:00.000Z'

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
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
      noteId: 'note-1',
      workItemId: 'wi-1',
      document: saved.document,
      version: 4,
      createdAt: timestamp,
      updatedAt: '2026-07-15T08:01:00.000Z',
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
})
