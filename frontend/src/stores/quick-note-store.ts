/**
 * Quick note store (F0 §7.3.8).
 *
 * Thin Zustand state wrapper. Dexie mutations live in quick-note-repository so
 * the future sync outbox boundary stays centralized.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  createQuickNote,
  convertQuickNoteToNote,
  listQuickNoteLifecycleStates,
  listQuickNoteSyncStates,
  listQuickNotes,
  listTrashedQuickNotes,
  moveQuickNoteToTrash,
  purgeQuickNote,
  restoreQuickNote,
  updateQuickNote,
  type QuickNoteLifecycleState,
  type QuickNoteCreateInput,
  type QuickNoteSyncStatus,
  type QuickNoteUpdateInput,
} from '@/lib/quick-notes/quick-note-repository'
import type { QuickNote } from '@/types'

interface QuickNoteState {
  quickNotes: QuickNote[]
  trashedQuickNotes: QuickNote[]
  syncStatusById: Record<string, QuickNoteSyncStatus>
  lifecycleStateById: Record<string, QuickNoteLifecycleState>
  isLoading: boolean
  error: string | null
  searchQuery: string
}

interface QuickNoteActions {
  loadQuickNotes: (opts?: { query?: string }) => Promise<void>
  loadTrashedQuickNotes: () => Promise<void>
  refreshQuickNotesFromRepository: () => Promise<void>
  createQuickNote: (data: QuickNoteCreateInput) => Promise<QuickNote>
  updateQuickNote: (id: string, data: QuickNoteUpdateInput) => Promise<void>
  deleteQuickNote: (id: string) => Promise<void>
  restoreQuickNote: (id: string) => Promise<void>
  purgeQuickNote: (id: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  migrateToNote: (id: string) => Promise<string>
  reset: () => void
}

type QuickNoteStore = QuickNoteState & QuickNoteActions

async function refreshLists(query: string) {
  const [
    quickNotes,
    trashedQuickNotes,
    syncStatusById,
    lifecycleStateById,
  ] = await Promise.all([
    listQuickNotes(query),
    listTrashedQuickNotes(),
    listQuickNoteSyncStates(),
    listQuickNoteLifecycleStates(),
  ])
  return {
    quickNotes,
    trashedQuickNotes,
    syncStatusById,
    lifecycleStateById,
  }
}

export const useQuickNoteStore = create<QuickNoteStore>()(
  devtools(
    (set, get) => ({
      quickNotes: [],
      trashedQuickNotes: [],
      syncStatusById: {},
      lifecycleStateById: {},
      isLoading: false,
      error: null,
      searchQuery: '',

      loadQuickNotes: async (opts) => {
        const query = opts?.query ?? get().searchQuery
        set({ isLoading: true, error: null, searchQuery: query })
        try {
          const lists = await refreshLists(query)
          set({ ...lists, isLoading: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load quick notes'
          set({ error: message, isLoading: false })
          throw error
        }
      },

      loadTrashedQuickNotes: async () => {
        set({ isLoading: true, error: null })
        try {
          const lists = await refreshLists(get().searchQuery)
          set({ ...lists, isLoading: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load trashed quick notes'
          set({ error: message, isLoading: false })
          throw error
        }
      },

      refreshQuickNotesFromRepository: async () => {
        try {
          const lists = await refreshLists(get().searchQuery)
          set({ ...lists, error: null })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to refresh quick notes'
          set({ error: message })
          throw error
        }
      },

      createQuickNote: async (data) => {
        const note = await createQuickNote(data)
        const lists = await refreshLists(get().searchQuery)
        set({ ...lists, error: null })
        return note
      },

      updateQuickNote: async (id, data) => {
        await updateQuickNote(id, data)
        const lists = await refreshLists(get().searchQuery)
        set({ ...lists, error: null })
      },

      deleteQuickNote: async (id) => {
        await moveQuickNoteToTrash(id)
        const lists = await refreshLists(get().searchQuery)
        set({ ...lists, error: null })
      },

      restoreQuickNote: async (id) => {
        await restoreQuickNote(id)
        const lists = await refreshLists(get().searchQuery)
        set({ ...lists, error: null })
      },

      purgeQuickNote: async (id) => {
        await purgeQuickNote(id)
        const lists = await refreshLists(get().searchQuery)
        set({ ...lists, error: null })
      },

      togglePin: async (id) => {
        const note = get().quickNotes.find((item) => item.id === id)
        if (!note) return
        await updateQuickNote(id, { pinned: !note.pinned })
        const lists = await refreshLists(get().searchQuery)
        set({ ...lists, error: null })
      },

      migrateToNote: async (id) => {
        const result = await convertQuickNoteToNote(id)
        const lists = await refreshLists(get().searchQuery)
        set({ ...lists, error: null })
        return result.noteId
      },
      reset: () =>
        set({
          quickNotes: [],
          trashedQuickNotes: [],
          syncStatusById: {},
          lifecycleStateById: {},
          isLoading: false,
          error: null,
          searchQuery: '',
        }),
    }),
    { name: 'quick-note-store' },
  ),
)
