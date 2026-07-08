/**
 * Trash store (F0 §7.3.16).
 *
 * QuickNote trash actions delegate to quick-note-repository through the
 * QuickNote store. Notes/Folders remain S0 stubs for this F2 slice.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  listTrashedQuickNotes,
  purgeQuickNote,
  restoreQuickNote,
} from '@/lib/quick-notes/quick-note-repository'
import type { Folder, Note, QuickNote } from '@/types'

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
  purgeNote: (id: string) => Promise<void>
  purgeQuickNote: (id: string) => Promise<void>
  emptyTrash: () => Promise<void>
  reset: () => void
}

type TrashStore = TrashState & TrashActions

async function readQuickNoteTrash(): Promise<QuickNote[]> {
  return listTrashedQuickNotes()
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
          const trashedQuickNotes = await readQuickNoteTrash()
          set({ trashedQuickNotes, isLoading: false, error: null })
        } catch (error) {
          set({
            error: getTrashStoreErrorMessage(error, 'Failed to load trash'),
            isLoading: false,
          })
          throw error
        }
      },
      restoreNote: async () => { /* S0 stub */ },
      restoreQuickNote: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await restoreQuickNote(id)
          const trashedQuickNotes = await readQuickNoteTrash()
          set({ trashedQuickNotes, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to restore quick note') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      purgeNote: async () => { /* S0 stub */ },
      purgeQuickNote: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await purgeQuickNote(id)
          const trashedQuickNotes = await readQuickNoteTrash()
          set({ trashedQuickNotes, error: null })
        } catch (error) {
          set({ error: getTrashStoreErrorMessage(error, 'Failed to purge quick note') })
          throw error
        } finally {
          set({ isLoading: false })
        }
      },
      emptyTrash: async () => {
        set({ isLoading: true, error: null })
        try {
          const trashedQuickNotes = await readQuickNoteTrash()
          await Promise.all(trashedQuickNotes.map((note) => purgeQuickNote(note.id)))
          const remainingQuickNotes = await readQuickNoteTrash()
          set({ trashedQuickNotes: remainingQuickNotes, error: null })
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
