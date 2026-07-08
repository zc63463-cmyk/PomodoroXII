import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import { useQuickNoteStore } from '@/stores/quick-note-store'

describe('useQuickNoteStore', () => {
  beforeEach(async () => {
    useQuickNoteStore.getState().reset()
    await spaceDBManager.switchTo(`quick-note-store-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    useQuickNoteStore.getState().reset()
    await db.delete()
    spaceDBManager.close()
  })

  it('loads active notes filtered by search and sorted by pinned/updated', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'old',
      content: 'old memo',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'new',
      content: 'new memo',
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'pin',
      content: 'memo pin',
      pinned: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })

    await useQuickNoteStore.getState().loadQuickNotes({ query: 'memo' })

    expect(useQuickNoteStore.getState().quickNotes.map((note) => note.id)).toEqual([
      'pin',
      'new',
      'old',
    ])
  })

  it('soft deletes and restores through store actions', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({ content: 'delete me' })

    await useQuickNoteStore.getState().deleteQuickNote(note.id)
    expect(useQuickNoteStore.getState().quickNotes).toEqual([])
    expect(useQuickNoteStore.getState().trashedQuickNotes.map((item) => item.id)).toEqual([note.id])

    await useQuickNoteStore.getState().restoreQuickNote(note.id)
    expect(useQuickNoteStore.getState().quickNotes.map((item) => item.id)).toEqual([note.id])
    expect(useQuickNoteStore.getState().trashedQuickNotes).toEqual([])
  })

  it('switches focus modes and clears selection on exit/reset', () => {
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().toggleFocusEdit()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'focus-edit',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().toggleFocusEdit()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().enterFocusRead('quick-note-a')
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'focus-read',
      selectedQuickNoteId: 'quick-note-a',
    })

    useQuickNoteStore.getState().enterDetailRead('quick-note-b')
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'detail-read',
      selectedQuickNoteId: 'quick-note-b',
    })

    useQuickNoteStore.getState().toggleFocusEdit()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'focus-edit',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().enterDetailRead('quick-note-c')
    useQuickNoteStore.getState().exitFocus()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().enterFocusRead('quick-note-d')
    useQuickNoteStore.getState().reset()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })
  })

  it('silently refreshes after sync tombstones without hiding local trash', async () => {
    const active = await useQuickNoteStore.getState().createQuickNote({
      id: 'active-sync',
      content: 'active memo',
    })
    const trashed = await useQuickNoteStore.getState().createQuickNote({
      id: 'local-trash',
      content: 'local trash memo',
    })
    await useQuickNoteStore.getState().deleteQuickNote(trashed.id)
    await db.quickNotes.update(active.id, {
      deletion_state: 'deleted',
      _dirty: false,
    })

    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    expect(useQuickNoteStore.getState().quickNotes.map((item) => item.id)).toEqual([])
    expect(useQuickNoteStore.getState().trashedQuickNotes.map((item) => item.id)).toEqual([
      trashed.id,
    ])
    expect(useQuickNoteStore.getState().isLoading).toBe(false)
  })

  it('derives pending and failed sync status from dirty rows and outbox events', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({
      id: 'sync-status',
      content: 'pending sync memo',
    })
    const other = await useQuickNoteStore.getState().createQuickNote({
      id: 'sync-status-other',
      content: 'another pending sync memo',
    })

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBe('pending')
    expect(useQuickNoteStore.getState().syncStatusById[other.id]).toBe('pending')

    const failedOutbox = await db.outbox
      .where('entityId')
      .equals(note.id)
      .first()
    await db.outbox.update(failedOutbox!.id!, {
      lastError: 'server_rejected_quick_note',
      lastErrorCode: 'push_error',
      failedAt: '2026-07-07T13:10:00.000Z',
      attemptCount: 1,
    })
    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBe('failed')
    expect(useQuickNoteStore.getState().syncStatusById[other.id]).toBe('pending')

    await db.outbox.clear()
    await db.quickNotes.update(note.id, { _dirty: false })
    await db.quickNotes.update(other.id, { _dirty: false })
    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBeUndefined()
    expect(useQuickNoteStore.getState().syncStatusById[other.id]).toBeUndefined()
  })

  it('migrates a quick note to a note and refreshes visible lifecycle state', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({
      id: 'store-convert',
      content: 'Store convert\nbody',
    })
    await db.outbox.clear()

    const noteId = await useQuickNoteStore.getState().migrateToNote(note.id)

    expect(await db.notes.get(noteId)).toMatchObject({
      title: 'Store convert',
      content: 'Store convert\nbody',
    })
    expect(useQuickNoteStore.getState().quickNotes.map((item) => item.id)).not.toContain(note.id)
    expect(useQuickNoteStore.getState().lifecycleStateById[note.id]).toBe('converted')
  })
})
