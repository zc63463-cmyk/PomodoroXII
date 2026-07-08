import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import {
  configureQuickNoteOutboxHook,
  convertQuickNoteToNote,
  createQuickNote,
  getQuickNoteRepositoryUserMessage,
  listQuickNoteLifecycleStates,
  listQuickNotes,
  listTrashedQuickNotes,
  moveQuickNoteToTrash,
  purgeQuickNote,
  QuickNoteRepositoryError,
  resetQuickNoteOutboxHook,
  restoreQuickNote,
  updateQuickNote,
  type QuickNoteMutationContext,
} from '@/lib/quick-notes/quick-note-repository'

describe('quick-note-repository', () => {
  beforeEach(async () => {
    resetQuickNoteOutboxHook()
    await spaceDBManager.switchTo(`quick-note-repo-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    resetQuickNoteOutboxHook()
    await db.delete()
    spaceDBManager.close()
  })

  it('creates a complete QuickNote row with sync fields', async () => {
    const note = await createQuickNote({ content: 'hello #Daily_Note', tags: ['work'] })
    const row = await db.quickNotes.get(note.id)

    expect(note.content).toBe('hello #Daily_Note')
    expect(row).toMatchObject({
      id: note.id,
      content: 'hello #Daily_Note',
      tags: ['work', 'daily_note'],
      pinned: false,
      trashed_at: null,
      migrated_to_note_id: null,
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    })
  })

  it('can disable the outbox hook for explicitly local-only tests', async () => {
    configureQuickNoteOutboxHook(null)
    const note = await createQuickNote({ content: 'local create #draft' })
    await updateQuickNote(note.id, { content: 'local update #draft' })
    await moveQuickNoteToTrash(note.id)
    await restoreQuickNote(note.id)
    await moveQuickNoteToTrash(note.id)
    await purgeQuickNote(note.id)

    expect(await db.outbox.count()).toBe(0)
  })

  it('enqueues create, update, trash, and restore in the QuickNote outbox by default', async () => {
    const note = await createQuickNote({ content: 'sync create #draft' })

    let rows = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entityType: 'quickNote',
      entityId: note.id,
      action: 'create',
      synced: false,
    })
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      id: note.id,
      content: 'sync create #draft',
      tags: ['draft'],
    })

    await updateQuickNote(note.id, { content: 'sync update #done' })
    rows = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe('create')
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      id: note.id,
      content: 'sync update #done',
      tags: ['done'],
    })

    const trashed = await moveQuickNoteToTrash(note.id)
    rows = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe('create')
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      id: note.id,
      trashed_at: trashed.trashed_at,
    })

    const restored = await restoreQuickNote(note.id)
    rows = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe('create')
    const restoredPayload = JSON.parse(rows[0]!.payload)
    expect(restoredPayload).toMatchObject({
      id: note.id,
      trashed_at: restored.trashed_at,
    })
    expect('deletion_state' in restoredPayload).toBe(false)
  })

  it('enqueues a delete tombstone when purging an already-synced trashed note', async () => {
    const note = await createQuickNote({ content: 'purge synced #draft' })
    await moveQuickNoteToTrash(note.id)
    await db.outbox.clear()

    await purgeQuickNote(note.id)

    expect(await db.quickNotes.get(note.id)).toBeUndefined()
    const rows = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entityType: 'quickNote',
      entityId: note.id,
      action: 'delete',
      synced: false,
    })
    expect(JSON.parse(rows[0]!.payload)).toEqual({ id: note.id })
  })

  it('collapses create then purge into no outbox row for never-synced notes', async () => {
    const note = await createQuickNote({ content: 'purge unsynced #draft' })
    await moveQuickNoteToTrash(note.id)

    await purgeQuickNote(note.id)

    expect(await db.quickNotes.get(note.id)).toBeUndefined()
    expect(await db.outbox.where('entityId').equals(note.id).count()).toBe(0)
  })

  it('uses the optional outbox hook as the single future sync boundary', async () => {
    const contexts: QuickNoteMutationContext[] = []
    configureQuickNoteOutboxHook((context) => {
      contexts.push({
        ...context,
        payload: { ...context.payload },
      })
    })

    const note = await createQuickNote({ content: 'hook create #draft' })
    const updated = await updateQuickNote(note.id, { content: 'hook update #done' })
    const trashed = await moveQuickNoteToTrash(note.id)
    const restored = await restoreQuickNote(note.id)
    await moveQuickNoteToTrash(note.id)
    await purgeQuickNote(note.id)

    expect(contexts.map((context) => context.action)).toEqual([
      'create',
      'update',
      'update',
      'update',
      'update',
      'delete',
    ])
    expect(contexts.every((context) => context.entityType === 'quickNote')).toBe(true)
    expect(contexts.every((context) => context.entityId === note.id)).toBe(true)
    expect(contexts[0]?.payload).toMatchObject({ id: note.id, content: 'hook create #draft' })
    expect(contexts[1]?.payload).toMatchObject({ id: note.id, content: updated.content })
    expect(contexts[2]?.payload).toMatchObject({ id: note.id, trashed_at: trashed.trashed_at })
    expect(contexts[3]?.payload).toMatchObject({ id: note.id, trashed_at: restored.trashed_at })
    expect(contexts[5]?.payload).toEqual({ id: note.id })
    expect(contexts).toHaveLength(6)
    expect(await db.outbox.count()).toBe(0)
  })

  it('converts an active quick note into a note and archives the quick note', async () => {
    const quickNote = await createQuickNote({
      id: 'convert-source',
      content: 'Converted title\nConverted body #note',
      folder_id: 'folder-1',
    })
    await db.outbox.clear()

    const result = await convertQuickNoteToNote(quickNote.id)

    const converted = await db.quickNotes.get(quickNote.id)
    const note = await db.notes.get(result.noteId)
    const outboxRows = await db.outbox.toArray()

    expect(result.quickNoteId).toBe(quickNote.id)
    expect(note).toMatchObject({
      id: result.noteId,
      title: 'Converted title',
      content: 'Converted title\nConverted body #note',
      summary: 'Converted title\nConverted body #note',
      tags: ['note'],
      folder_id: 'folder-1',
      status: 'active',
      deletion_state: 'active',
      _dirty: true,
    })
    expect(converted).toMatchObject({
      id: quickNote.id,
      archived_at: expect.any(String),
      migrated_to_note_id: result.noteId,
      deletion_state: 'active',
      _dirty: true,
    })
    expect(outboxRows).toHaveLength(2)
    expect(outboxRows.map((row) => `${row.entityType}:${row.action}`).sort()).toEqual([
      'note:create',
      'quickNote:update',
    ])
    expect((await listQuickNotes()).map((item) => item.id)).not.toContain(quickNote.id)
    expect((await listQuickNoteLifecycleStates())[quickNote.id]).toBe('converted')
  })

  it('rolls back note creation and quick note conversion when conversion sync fails', async () => {
    const quickNote = await createQuickNote({
      id: 'convert-rollback',
      content: 'rollback source',
    })
    const before = await db.quickNotes.get(quickNote.id)
    await db.outbox.clear()
    configureQuickNoteOutboxHook(async () => {
      throw new Error('convert hook failed')
    })

    await expect(convertQuickNoteToNote(quickNote.id)).rejects.toThrow('convert hook failed')

    expect(await db.quickNotes.get(quickNote.id)).toEqual(before)
    expect(await db.notes.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })

  it('rejects converting trashed archived or already converted quick notes', async () => {
    const trashed = await createQuickNote({ content: 'trashed convert' })
    await moveQuickNoteToTrash(trashed.id)
    await expect(convertQuickNoteToNote(trashed.id)).rejects.toMatchObject({
      code: 'not_active',
    } satisfies Partial<QuickNoteRepositoryError>)

    const archived = await createQuickNote({ content: 'archived convert' })
    await db.quickNotes.update(archived.id, {
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    await expect(convertQuickNoteToNote(archived.id)).rejects.toMatchObject({
      code: 'not_active',
    } satisfies Partial<QuickNoteRepositoryError>)

    const converted = await createQuickNote({ content: 'already converted' })
    await db.quickNotes.update(converted.id, {
      migrated_to_note_id: 'note-1',
    })
    await expect(convertQuickNoteToNote(converted.id)).rejects.toMatchObject({
      code: 'converted',
    } satisfies Partial<QuickNoteRepositoryError>)
  })

  it('rolls back the entity write when the outbox hook rejects', async () => {
    configureQuickNoteOutboxHook(async () => {
      throw new Error('hook failed')
    })

    await expect(
      createQuickNote({
        id: 'hook-rollback',
        content: 'should rollback',
      }),
    ).rejects.toThrow('hook failed')

    expect(await db.quickNotes.get('hook-rollback')).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('updates content for autosave and bumps version and dirty state', async () => {
    const note = await createQuickNote({ content: 'before' })
    await updateQuickNote(note.id, {
      content: 'after',
      updated_at: '2026-01-02T00:00:00.000Z',
    })
    const row = await db.quickNotes.get(note.id)

    expect(row?.content).toBe('after')
    expect(row?.updated_at).toBe('2026-01-02T00:00:00.000Z')
    expect(row?.version).toBe(2)
    expect(row?._dirty).toBe(true)
  })

  it('rejects blank creates and exposes stable user and developer messages', async () => {
    await expect(createQuickNote({ content: '   ' })).rejects.toMatchObject({
      code: 'empty_content',
      userMessage: '小记内容不能为空',
      developerMessage: 'QuickNote content must not be blank',
      message: 'QuickNote content must not be blank',
    } satisfies Partial<QuickNoteRepositoryError>)

    expect(await db.quickNotes.count()).toBe(0)
    const error = new QuickNoteRepositoryError('invalid_patch')
    expect(getQuickNoteRepositoryUserMessage(error, 'fallback')).toBe('没有可保存的小记改动')
    expect(getQuickNoteRepositoryUserMessage(new Error('raw'), 'fallback')).toBe('fallback')
  })

  it('rejects updates for missing trashed and converted quick notes', async () => {
    await expect(updateQuickNote('missing', { content: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<QuickNoteRepositoryError>)

    const trashed = await createQuickNote({ content: 'trashed' })
    await moveQuickNoteToTrash(trashed.id)
    await expect(updateQuickNote(trashed.id, { content: 'blocked' })).rejects.toMatchObject({
      code: 'not_active',
    } satisfies Partial<QuickNoteRepositoryError>)

    const converted = await createQuickNote({ content: 'converted' })
    await db.quickNotes.update(converted.id, { migrated_to_note_id: 'note-1' })
    await expect(updateQuickNote(converted.id, { content: 'blocked' })).rejects.toMatchObject({
      code: 'converted',
    } satisfies Partial<QuickNoteRepositoryError>)
  })

  it('leaves rows unchanged when transaction-scoped update validation rejects', async () => {
    const trashed = await createQuickNote({ content: 'trashed boundary' })
    await moveQuickNoteToTrash(trashed.id)
    const trashedBefore = await db.quickNotes.get(trashed.id)

    await expect(updateQuickNote(trashed.id, { content: 'blocked update' })).rejects.toMatchObject({
      code: 'not_active',
    } satisfies Partial<QuickNoteRepositoryError>)

    expect(await db.quickNotes.get(trashed.id)).toEqual(trashedBefore)

    const archived = await createQuickNote({ content: 'archived boundary' })
    await db.quickNotes.update(archived.id, {
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    const archivedBefore = await db.quickNotes.get(archived.id)

    await expect(moveQuickNoteToTrash(archived.id)).rejects.toMatchObject({
      code: 'not_active',
    } satisfies Partial<QuickNoteRepositoryError>)

    expect(await db.quickNotes.get(archived.id)).toEqual(archivedBefore)
  })

  it('rejects blank or empty updates without changing the original row', async () => {
    const note = await createQuickNote({ content: 'before #work' })
    const before = await db.quickNotes.get(note.id)

    await expect(updateQuickNote(note.id, { content: '   ' })).rejects.toMatchObject({
      code: 'empty_content',
    } satisfies Partial<QuickNoteRepositoryError>)
    await expect(updateQuickNote(note.id, { content: undefined })).rejects.toMatchObject({
      code: 'invalid_patch',
    } satisfies Partial<QuickNoteRepositoryError>)

    expect(await db.quickNotes.get(note.id)).toEqual(before)
  })

  it('ignores undefined fields when a valid update field is present', async () => {
    const note = await createQuickNote({ content: 'before #work' })

    await updateQuickNote(note.id, { content: undefined, pinned: true })

    const row = await db.quickNotes.get(note.id)
    expect(row).toMatchObject({
      content: 'before #work',
      tags: ['work'],
      pinned: true,
      version: 2,
    })
  })

  it('refreshes tags only when content or explicit tags are updated', async () => {
    const note = await createQuickNote({
      content: 'alpha #Capture #灵感42',
      tags: ['manual', 'CAPTURE'],
    })

    expect((await db.quickNotes.get(note.id))?.tags).toEqual([
      'manual',
      'capture',
      '灵感42',
    ])

    await updateQuickNote(note.id, { pinned: true })
    expect((await db.quickNotes.get(note.id))?.tags).toEqual([
      'manual',
      'capture',
      '灵感42',
    ])

    await updateQuickNote(note.id, {
      content: 'beta #产品-v1 #daily_note #Daily_Note',
    })
    expect((await db.quickNotes.get(note.id))?.tags).toEqual([
      '产品-v1',
      'daily_note',
    ])

    await updateQuickNote(note.id, {
      content: 'gamma #灵感42',
      tags: ['Manual', '#灵感42'],
    })
    expect((await db.quickNotes.get(note.id))?.tags).toEqual(['manual', '灵感42'])
  })

  it('moves to trash, restores, and purges a quick note', async () => {
    const note = await createQuickNote({ content: 'trash me' })
    const trashed = await moveQuickNoteToTrash(note.id)
    expect(trashed).toMatchObject({ id: note.id })
    expect('deletion_state' in trashed).toBe(false)
    expect(trashed.trashed_at).not.toBeNull()

    expect((await listQuickNotes()).map((item) => item.id)).toEqual([])
    expect((await listTrashedQuickNotes()).map((item) => item.id)).toEqual([note.id])

    const restored = await restoreQuickNote(note.id)
    expect(restored).toMatchObject({ id: note.id, trashed_at: null })
    expect((await listQuickNotes()).map((item) => item.id)).toEqual([note.id])
    expect(await listTrashedQuickNotes()).toEqual([])

    await moveQuickNoteToTrash(note.id)
    await purgeQuickNote(note.id)
    expect(await db.quickNotes.get(note.id)).toBeUndefined()
  })

  it('only purges trashed quick notes and leaves active rows intact', async () => {
    const active = await createQuickNote({ content: 'active' })

    await expect(purgeQuickNote(active.id)).rejects.toMatchObject({
      code: 'not_trashed',
    } satisfies Partial<QuickNoteRepositoryError>)

    expect(await db.quickNotes.get(active.id)).toBeDefined()
  })

  it('only restores trashed quick notes and rejects active or converted rows', async () => {
    const active = await createQuickNote({ content: 'active' })
    await expect(restoreQuickNote(active.id)).rejects.toMatchObject({
      code: 'not_trashed',
    } satisfies Partial<QuickNoteRepositoryError>)

    const converted = await createQuickNote({ content: 'converted' })
    await db.quickNotes.update(converted.id, {
      migrated_to_note_id: 'note-1',
      trashed_at: '2026-01-02T00:00:00.000Z',
    })
    await expect(restoreQuickNote(converted.id)).rejects.toMatchObject({
      code: 'converted',
    } satisfies Partial<QuickNoteRepositoryError>)
  })

  it('rejects update and trash for archived quick notes', async () => {
    const archived = await createQuickNote({ content: 'archived' })
    await db.quickNotes.update(archived.id, {
      archived_at: '2026-01-02T00:00:00.000Z',
    })

    await expect(updateQuickNote(archived.id, { content: 'blocked' })).rejects.toMatchObject({
      code: 'not_active',
    } satisfies Partial<QuickNoteRepositoryError>)
    await expect(moveQuickNoteToTrash(archived.id)).rejects.toMatchObject({
      code: 'not_active',
    } satisfies Partial<QuickNoteRepositoryError>)
  })
})
