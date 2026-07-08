import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import {
  configureQuickNoteSyncFailureReader,
  resetQuickNoteSyncFailureReader,
  useQuickNoteStore,
} from '@/stores/quick-note-store'

describe('useQuickNoteStore', () => {
  beforeEach(async () => {
    resetQuickNoteSyncFailureReader()
    useQuickNoteStore.getState().reset()
    await spaceDBManager.switchTo(`quick-note-store-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    resetQuickNoteSyncFailureReader()
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

  it('derives pending and failed sync status from dirty rows and outbox', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({
      id: 'sync-status',
      content: 'pending sync memo',
    })

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBe('pending')

    await db.outbox.clear()
    await db.quickNotes.update(note.id, { _dirty: false })
    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBeUndefined()

    configureQuickNoteSyncFailureReader(() => true)
    await useQuickNoteStore.getState().updateQuickNote(note.id, {
      content: 'pending failed memo',
    })

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBe('failed')
  })

  it('rejects migrateToNote until conversion is implemented', async () => {
    await expect(
      useQuickNoteStore.getState().migrateToNote('quick-note-id'),
    ).rejects.toThrow('QuickNote migrateToNote is not implemented in the local MVP')
  })
})
