/**
 * Trash store (F0 §7.3.16).
 *
 * Unified local trash facade for Notes, Folders, and QuickNotes.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { db } from '@/services/space-db'
import {
  listTrashedQuickNotes,
  purgeQuickNote,
  restoreQuickNote,
} from '@/lib/quick-notes/quick-note-repository'
import { enqueueOutbox } from '@/lib/sync/outbox'
import type { CachedFolder, CachedNote, Folder, Note, QuickNote } from '@/types'

interface TrashState {
  trashedNotes: Note[]
  trashedQuickNotes: QuickNote[]
  trashedFolders: Folder[]
  isLoading: boolean
  error: string | null
}

interface TrashActions {
  loadTrashed: () => Promise<void>
  restoreNote: (id: string) => Promise<void>
  restoreQuickNote: (id: string) => Promise<void>
  restoreFolder: (id: string) => Promise<void>
  purgeNote: (id: string) => Promise<void>
  purgeQuickNote: (id: string) => Promise<void>
  purgeFolder: (id: string) => Promise<void>
  emptyTrash: () => Promise<void>
  reset: () => void
}

type TrashStore = TrashState & TrashActions

async function readQuickNoteTrash(): Promise<QuickNote[]> {
  return listTrashedQuickNotes()
}

async function readNoteTrash(): Promise<Note[]> {
  const rows = await db.notes.toArray()
  return rows
    .filter((row) => row.trashed_at !== null)
    .sort(sortByTrashTime)
    .map(stripNoteSyncFields)
}

async function readFolderTrash(): Promise<Folder[]> {
  const rows = await db.folders.toArray()
  return rows
    .filter((row) => row.trashed_at !== null)
    .sort(sortByTrashTime)
    .map(stripFolderSyncFields)
}

async function readAllTrash() {
  const [trashedNotes, trashedQuickNotes, trashedFolders] = await Promise.all([
    readNoteTrash(),
    readQuickNoteTrash(),
    readFolderTrash(),
  ])
  return { trashedNotes, trashedQuickNotes, trashedFolders }
}

function getTrashStoreErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export const useTrashStore = create<TrashStore>()(
  devtools(
    (set) => ({
      trashedNotes: [],
      trashedQuickNotes: [],
      trashedFolders: [],
      isLoading: false,
      error: null,

      loadTrashed: async () => {
        set({ isLoading: true, error: null })
        try {
          const trash = await readAllTrash()
          set({ ...trash, isLoading: false, error: null })
        } catch (error) {
          set({
            error: getTrashStoreErrorMessage(error, 'Failed to load trash'),
            isLoading: false,
          })
          throw error
        }
      },
      restoreNote: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await restoreNoteFromTrash(id)
          const trash = await readAllTrash()
          set({ ...trash, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to restore note') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      restoreQuickNote: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await restoreQuickNote(id)
          const trash = await readAllTrash()
          set({ ...trash, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to restore quick note') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      restoreFolder: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await restoreFolderFromTrash(id)
          const trash = await readAllTrash()
          set({ ...trash, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to restore folder') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      purgeNote: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await purgeNoteFromTrash(id)
          const trash = await readAllTrash()
          set({ ...trash, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to purge note') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      purgeQuickNote: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await purgeQuickNote(id)
          const trash = await readAllTrash()
          set({ ...trash, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to purge quick note') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      purgeFolder: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await purgeFolderFromTrash(id)
          const trash = await readAllTrash()
          set({ ...trash, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to purge folder') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      emptyTrash: async () => {
        set({ isLoading: true, error: null })
        try {
          const trash = await readAllTrash()
          await Promise.all([
            ...trash.trashedNotes.map((note) => purgeNoteFromTrash(note.id)),
            ...trash.trashedQuickNotes.map((note) => purgeQuickNote(note.id)),
            ...trash.trashedFolders.map((folder) => purgeFolderFromTrash(folder.id)),
          ])
          const remainingTrash = await readAllTrash()
          set({ ...remainingTrash, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to empty trash') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      reset: () =>
        set({
          trashedNotes: [],
          trashedQuickNotes: [],
          trashedFolders: [],
          isLoading: false,
          error: null,
        }),
    }),
    { name: 'trash-store' },
  ),
)

async function restoreNoteFromTrash(id: string): Promise<void> {
  await db.transaction('rw', db.notes, db.outbox, async () => {
    const existing = await db.notes.get(id)
    if (!existing) throw new Error('Note was not found in the local repository')
    if (existing.trashed_at === null) throw new Error('Only trashed notes can be restored')

    const now = new Date().toISOString()
    const row: CachedNote = {
      ...existing,
      trashed_at: null,
      updated_at: now,
      deletion_state: 'active',
      version: (existing.version ?? 1) + 1,
      _dirty: true,
    }
    await db.notes.put(row)
    await enqueueOutbox(db, 'note', id, 'update', stripNoteSyncFields(row))
  })
}

async function purgeNoteFromTrash(id: string): Promise<void> {
  await db.transaction('rw', db.notes, db.outbox, async () => {
    const existing = await db.notes.get(id)
    if (!existing) throw new Error('Note was not found in the local repository')
    if (existing.trashed_at === null) throw new Error('Only trashed notes can be purged')

    await db.notes.delete(id)
    await enqueueOutbox(db, 'note', id, 'delete', { id })
  })
}

async function restoreFolderFromTrash(id: string): Promise<void> {
  await db.transaction('rw', db.folders, db.outbox, async () => {
    const existing = await db.folders.get(id)
    if (!existing) throw new Error('Folder was not found in the local repository')
    if (existing.trashed_at === null) throw new Error('Only trashed folders can be restored')

    const now = new Date().toISOString()
    const row: CachedFolder = {
      ...existing,
      trashed_at: null,
      updated_at: now,
      deletion_state: 'active',
      version: (existing.version ?? 1) + 1,
      _dirty: true,
    }
    await db.folders.put(row)
    await enqueueOutbox(db, 'folder', id, 'update', stripFolderSyncFields(row))
  })
}

async function purgeFolderFromTrash(id: string): Promise<void> {
  await db.transaction('rw', db.folders, db.outbox, async () => {
    const existing = await db.folders.get(id)
    if (!existing) throw new Error('Folder was not found in the local repository')
    if (existing.trashed_at === null) throw new Error('Only trashed folders can be purged')

    await db.folders.delete(id)
    await enqueueOutbox(db, 'folder', id, 'delete', { id })
  })
}

function sortByTrashTime(
  left: { trashed_at: string | null; updated_at: string },
  right: { trashed_at: string | null; updated_at: string },
): number {
  return (right.trashed_at ?? right.updated_at).localeCompare(left.trashed_at ?? left.updated_at)
}

function stripNoteSyncFields(row: CachedNote): Note {
  const { content_hash, deletion_state, version, _dirty, ...note } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return note
}

function stripFolderSyncFields(row: CachedFolder): Folder {
  const { content_hash, deletion_state, version, _dirty, ...folder } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return folder
}
