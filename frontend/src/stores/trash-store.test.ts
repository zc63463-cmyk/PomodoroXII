import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, spaceDBManager } from '@/services/space-db'
import { createQuickNote } from '@/lib/quick-notes/quick-note-repository'
import { useTrashStore } from '@/stores/trash-store'
import type { CachedFolder, CachedNote } from '@/types'

class FakeLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(
    name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    const result = previous.then(callback)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(name, tail)
    void tail.finally(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name)
    })
    return result
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

describe('useTrashStore QuickNote actions', () => {
  beforeEach(async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new FakeLockManager(),
    })
    useTrashStore.getState().reset()
    await spaceDBManager.switchTo(`trash-store-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    useTrashStore.getState().reset()
    await db.delete()
    spaceDBManager.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
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

  it('loads trashed notes and folders alongside quick notes', async () => {
    const quickNote = await createQuickNote({ id: 'trash-load-qn', content: 'trash quick note' })
    await db.quickNotes.update(quickNote.id, {
      trashed_at: '2026-07-07T13:30:00.000Z',
      deletion_state: 'deleted',
      _dirty: false,
    })
    await db.notes.put(makeCachedNote({
      id: 'trash-load-note',
      title: 'Trash note',
      trashed_at: '2026-07-07T13:31:00.000Z',
      deletion_state: 'deleted',
    }))
    await db.folders.put(makeCachedFolder({
      id: 'trash-load-folder',
      name: 'Trash folder',
      trashed_at: '2026-07-07T13:32:00.000Z',
      deletion_state: 'deleted',
    }))

    await useTrashStore.getState().loadTrashed()

    expect(useTrashStore.getState().trashedQuickNotes.map((item) => item.id)).toEqual([
      quickNote.id,
    ])
    expect(useTrashStore.getState().trashedNotes.map((item) => item.id)).toEqual([
      'trash-load-note',
    ])
    expect(useTrashStore.getState().trashedFolders.map((item) => item.id)).toEqual([
      'trash-load-folder',
    ])
  })

  it('restores a trashed note and enqueues a note update event', async () => {
    await db.notes.put(makeCachedNote({
      id: 'trash-note-restore',
      title: 'Restore note',
      trashed_at: '2026-07-07T13:31:00.000Z',
      deletion_state: 'deleted',
      version: 2,
    }))
    await useTrashStore.getState().loadTrashed()

    await useTrashStore.getState().restoreNote('trash-note-restore')

    const note = await db.notes.get('trash-note-restore')
    const outbox = await db.outbox.where('entityId').equals('trash-note-restore').first()
    expect(note).toMatchObject({
      trashed_at: null,
      deletion_state: 'active',
      _dirty: true,
      version: 3,
    })
    expect(outbox).toMatchObject({
      entityType: 'note',
      action: 'update',
      synced: false,
      expectedVersion: 2,
      requiresVersionRebase: false,
    })
    expect(useTrashStore.getState().trashedNotes).toEqual([])
  })

  it('purges a trashed folder and enqueues a folder delete event', async () => {
    await db.folders.put(makeCachedFolder({
      id: 'trash-folder-purge',
      name: 'Purge folder',
      trashed_at: '2026-07-07T13:32:00.000Z',
      deletion_state: 'deleted',
    }))
    await useTrashStore.getState().loadTrashed()

    await useTrashStore.getState().purgeFolder('trash-folder-purge')

    const outbox = await db.outbox.where('entityId').equals('trash-folder-purge').first()
    expect(await db.folders.get('trash-folder-purge')).toBeUndefined()
    expect(outbox).toMatchObject({
      entityType: 'folder',
      action: 'delete',
      synced: false,
      expectedVersion: 1,
      requiresVersionRebase: false,
    })
    expect(useTrashStore.getState().trashedFolders).toEqual([])
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

  it('empties notes, quick notes, and folders together', async () => {
    const quickNote = await createQuickNote({ id: 'trash-empty-qn', content: 'empty quick note' })
    await db.quickNotes.update(quickNote.id, {
      trashed_at: '2026-07-07T13:30:00.000Z',
      deletion_state: 'deleted',
      _dirty: false,
    })
    await db.notes.put(makeCachedNote({
      id: 'trash-empty-note',
      title: 'Empty note',
      trashed_at: '2026-07-07T13:31:00.000Z',
      deletion_state: 'deleted',
    }))
    await db.folders.put(makeCachedFolder({
      id: 'trash-empty-folder',
      name: 'Empty folder',
      trashed_at: '2026-07-07T13:32:00.000Z',
      deletion_state: 'deleted',
    }))
    await useTrashStore.getState().loadTrashed()

    await useTrashStore.getState().emptyTrash()

    expect(await db.quickNotes.get(quickNote.id)).toBeUndefined()
    expect(await db.notes.get('trash-empty-note')).toBeUndefined()
    expect(await db.folders.get('trash-empty-folder')).toBeUndefined()
    expect(useTrashStore.getState()).toMatchObject({
      trashedNotes: [],
      trashedQuickNotes: [],
      trashedFolders: [],
      isLoading: false,
      error: null,
    })
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

function makeCachedNote(overrides: Partial<CachedNote> = {}): CachedNote {
  const now = '2026-07-07T12:00:00.000Z'
  return {
    id: 'note-id',
    title: 'Note title',
    content: 'Note content',
    summary: 'Note summary',
    tags: [],
    category: null,
    folder_id: null,
    status: 'active',
    trashed_at: null,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...overrides,
  }
}

function makeCachedFolder(overrides: Partial<CachedFolder> = {}): CachedFolder {
  const now = '2026-07-07T12:00:00.000Z'
  return {
    id: 'folder-id',
    name: 'Folder name',
    parent_id: null,
    icon: null,
    color: null,
    sort_order: 0,
    is_system: false,
    trashed_at: null,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...overrides,
  }
}
