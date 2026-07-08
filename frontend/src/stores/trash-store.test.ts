import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import { createQuickNote } from '@/lib/quick-notes/quick-note-repository'
import { useTrashStore } from '@/stores/trash-store'

describe('useTrashStore QuickNote actions', () => {
  beforeEach(async () => {
    useTrashStore.getState().reset()
    await spaceDBManager.switchTo(`trash-store-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    useTrashStore.getState().reset()
    await db.delete()
    spaceDBManager.close()
  })

  it('loads trashed quick notes', async () => {
    const note = await createQuickNote({ id: 'trash-load', content: 'trash load' })
    await db.quickNotes.update(note.id, {
      trashed_at: '2026-07-07T13:30:00.000Z',
      deletion_state: 'deleted',
      _dirty: false,
    })

    await useTrashStore.getState().loadTrashed()

    expect(useTrashStore.getState().trashedQuickNotes.map((item) => item.id)).toEqual([
      note.id,
    ])
    expect(useTrashStore.getState().isLoading).toBe(false)
    expect(useTrashStore.getState().error).toBeNull()
  })

  it('restores a trashed quick note and refreshes the trash list', async () => {
    const note = await createQuickNote({ id: 'trash-restore', content: 'restore me' })
    await db.quickNotes.update(note.id, {
      trashed_at: '2026-07-07T13:30:00.000Z',
      deletion_state: 'deleted',
      _dirty: false,
    })
    await useTrashStore.getState().loadTrashed()

    await useTrashStore.getState().restoreQuickNote(note.id)

    expect(useTrashStore.getState().trashedQuickNotes).toEqual([])
    expect(useTrashStore.getState().isLoading).toBe(false)
    expect(useTrashStore.getState().error).toBeNull()
  })

  it('purges a trashed quick note and refreshes the trash list', async () => {
    const note = await createQuickNote({ id: 'trash-purge', content: 'purge me' })
    await db.quickNotes.update(note.id, {
      trashed_at: '2026-07-07T13:30:00.000Z',
      deletion_state: 'deleted',
      _dirty: false,
    })
    await useTrashStore.getState().loadTrashed()

    await useTrashStore.getState().purgeQuickNote(note.id)

    expect(useTrashStore.getState().trashedQuickNotes).toEqual([])
    expect(await db.quickNotes.get(note.id)).toBeUndefined()
    expect(useTrashStore.getState().isLoading).toBe(false)
    expect(useTrashStore.getState().error).toBeNull()
  })

  it('empties quick note trash and refreshes the trash list', async () => {
    const first = await createQuickNote({ id: 'trash-empty-1', content: 'empty one' })
    const second = await createQuickNote({ id: 'trash-empty-2', content: 'empty two' })
    for (const note of [first, second]) {
      await db.quickNotes.update(note.id, {
        trashed_at: '2026-07-07T13:30:00.000Z',
        deletion_state: 'deleted',
        _dirty: false,
      })
    }
    await useTrashStore.getState().loadTrashed()

    await useTrashStore.getState().emptyTrash()

    expect(useTrashStore.getState().trashedQuickNotes).toEqual([])
    expect(await db.quickNotes.count()).toBe(0)
    expect(useTrashStore.getState().isLoading).toBe(false)
    expect(useTrashStore.getState().error).toBeNull()
  })

  it('keeps loading settled and exposes errors when restore fails', async () => {
    await expect(
      useTrashStore.getState().restoreQuickNote('missing-quick-note'),
    ).rejects.toThrow('QuickNote was not found in the local repository')

    expect(useTrashStore.getState().isLoading).toBe(false)
    expect(useTrashStore.getState().error).toBe(
      'QuickNote was not found in the local repository',
    )

    useTrashStore.getState().reset()
    expect(useTrashStore.getState().error).toBeNull()
  })
})
