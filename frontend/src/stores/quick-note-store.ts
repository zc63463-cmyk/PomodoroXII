/**
 * Quick note store (F0 §7.3.8).
 *
 * Thin Zustand state wrapper. Dexie mutations live in quick-note-repository so
 * the future sync outbox boundary stays centralized.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  selectQuickNotesForExplorer,
} from '@/lib/quick-notes/quick-note-selectors'
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

export type QuickNoteFocusMode =
  | 'normal'
  | 'focus-edit'
  | 'detail-read'

export type QuickNoteTagFilterMode = 'single' | 'multi'

interface QuickNoteState {
  allQuickNotes: QuickNote[]
  quickNotes: QuickNote[]
  trashedQuickNotes: QuickNote[]
  syncStatusById: Record<string, QuickNoteSyncStatus>
  lifecycleStateById: Record<string, QuickNoteLifecycleState>
  isLoading: boolean
  error: string | null
  searchQuery: string
  selectedTagFilters: string[]
  tagFilterMode: QuickNoteTagFilterMode
  selectedDate: string | null
  focusMode: QuickNoteFocusMode
  selectedQuickNoteId: string | null
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
  toggleTagFilter: (tag: string) => void
  clearTagFilters: () => void
  setTagFilterMode: (mode: QuickNoteTagFilterMode) => void
  toggleSelectedDate: (date: string) => void
  clearSelectedDate: () => void
  toggleFocusEdit: () => void
  enterDetailRead: (id: string) => void
  exitFocus: () => void
  reset: () => void
}

type QuickNoteStore = QuickNoteState & QuickNoteActions

async function refreshLists(
  query: string,
  selectedTagFilters: string[],
  selectedDate: string | null,
) {
  const [
    allQuickNotes,
    trashedQuickNotes,
    syncStatusById,
    lifecycleStateById,
  ] = await Promise.all([
    listQuickNotes(),
    listTrashedQuickNotes(),
    listQuickNoteSyncStates(),
    listQuickNoteLifecycleStates(),
  ])
  return {
    allQuickNotes,
    quickNotes: deriveVisibleQuickNotes(allQuickNotes, query, selectedTagFilters, selectedDate),
    trashedQuickNotes,
    syncStatusById,
    lifecycleStateById,
  }
}

function deriveVisibleQuickNotes(
  allQuickNotes: QuickNote[],
  query: string,
  selectedTagFilters: string[],
  selectedDate: string | null,
): QuickNote[] {
  return selectQuickNotesForExplorer(allQuickNotes, {
    query,
    selectedTags: selectedTagFilters,
    selectedDate,
  })
}

function normalizeFilterTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').toLowerCase()
}

export const useQuickNoteStore = create<QuickNoteStore>()(
  devtools(
    (set, get) => ({
      allQuickNotes: [],
      quickNotes: [],
      trashedQuickNotes: [],
      syncStatusById: {},
      lifecycleStateById: {},
      isLoading: false,
      error: null,
      searchQuery: '',
      selectedTagFilters: [],
      tagFilterMode: 'single',
      selectedDate: null,
      focusMode: 'normal',
      selectedQuickNoteId: null,

      loadQuickNotes: async (opts) => {
        const query = opts?.query ?? get().searchQuery
        set({ isLoading: true, error: null, searchQuery: query })
        try {
          const lists = await refreshLists(
            query,
            get().selectedTagFilters,
            get().selectedDate,
          )
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
          const lists = await refreshLists(
            get().searchQuery,
            get().selectedTagFilters,
            get().selectedDate,
          )
          set({ ...lists, isLoading: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load trashed quick notes'
          set({ error: message, isLoading: false })
          throw error
        }
      },

      refreshQuickNotesFromRepository: async () => {
        try {
          const lists = await refreshLists(
            get().searchQuery,
            get().selectedTagFilters,
            get().selectedDate,
          )
          set({ ...lists, error: null })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to refresh quick notes'
          set({ error: message })
          throw error
        }
      },

      createQuickNote: async (data) => {
        const note = await createQuickNote(data)
        const lists = await refreshLists(
          get().searchQuery,
          get().selectedTagFilters,
          get().selectedDate,
        )
        set({ ...lists, error: null })
        return note
      },

      updateQuickNote: async (id, data) => {
        await updateQuickNote(id, data)
        const lists = await refreshLists(
          get().searchQuery,
          get().selectedTagFilters,
          get().selectedDate,
        )
        set({ ...lists, error: null })
      },

      deleteQuickNote: async (id) => {
        await moveQuickNoteToTrash(id)
        const lists = await refreshLists(
          get().searchQuery,
          get().selectedTagFilters,
          get().selectedDate,
        )
        set({ ...lists, error: null })
      },

      restoreQuickNote: async (id) => {
        await restoreQuickNote(id)
        const lists = await refreshLists(
          get().searchQuery,
          get().selectedTagFilters,
          get().selectedDate,
        )
        set({ ...lists, error: null })
      },

      purgeQuickNote: async (id) => {
        await purgeQuickNote(id)
        const lists = await refreshLists(
          get().searchQuery,
          get().selectedTagFilters,
          get().selectedDate,
        )
        set({ ...lists, error: null })
      },

      togglePin: async (id) => {
        const note = get().allQuickNotes.find((item) => item.id === id)
        if (!note) return
        await updateQuickNote(id, { pinned: !note.pinned })
        const lists = await refreshLists(
          get().searchQuery,
          get().selectedTagFilters,
          get().selectedDate,
        )
        set({ ...lists, error: null })
      },

      migrateToNote: async (id) => {
        const result = await convertQuickNoteToNote(id)
        const lists = await refreshLists(
          get().searchQuery,
          get().selectedTagFilters,
          get().selectedDate,
        )
        set({ ...lists, error: null })
        return result.noteId
      },

      toggleTagFilter: (tag) => {
        const normalizedTag = normalizeFilterTag(tag)
        if (!normalizedTag) return

        const state = get()
        const selectedTagFilters =
          state.tagFilterMode === 'single'
            ? state.selectedTagFilters.length === 1 && state.selectedTagFilters[0] === normalizedTag
              ? []
              : [normalizedTag]
            : state.selectedTagFilters.includes(normalizedTag)
              ? state.selectedTagFilters.filter((item) => item !== normalizedTag)
              : [...state.selectedTagFilters, normalizedTag]

        set({
          selectedTagFilters,
          quickNotes: deriveVisibleQuickNotes(
            state.allQuickNotes,
            state.searchQuery,
            selectedTagFilters,
            state.selectedDate,
          ),
        })
      },

      clearTagFilters: () => {
        const state = get()
        set({
          selectedTagFilters: [],
          quickNotes: deriveVisibleQuickNotes(
            state.allQuickNotes,
            state.searchQuery,
            [],
            state.selectedDate,
          ),
        })
      },

      setTagFilterMode: (mode) => {
        const state = get()
        const selectedTagFilters =
          mode === 'single' ? state.selectedTagFilters.slice(0, 1) : state.selectedTagFilters
        set({
          tagFilterMode: mode,
          selectedTagFilters,
          quickNotes: deriveVisibleQuickNotes(
            state.allQuickNotes,
            state.searchQuery,
            selectedTagFilters,
            state.selectedDate,
          ),
        })
      },

      toggleSelectedDate: (date) => {
        const state = get()
        const selectedDate = state.selectedDate === date ? null : date
        set({
          selectedDate,
          quickNotes: deriveVisibleQuickNotes(
            state.allQuickNotes,
            state.searchQuery,
            state.selectedTagFilters,
            selectedDate,
          ),
        })
      },

      clearSelectedDate: () => {
        const state = get()
        set({
          selectedDate: null,
          quickNotes: deriveVisibleQuickNotes(
            state.allQuickNotes,
            state.searchQuery,
            state.selectedTagFilters,
            null,
          ),
        })
      },

      toggleFocusEdit: () => {
        const nextFocusMode =
          get().focusMode === 'focus-edit' ? 'normal' : 'focus-edit'
        set({
          focusMode: nextFocusMode,
          selectedQuickNoteId: null,
        })
      },

      enterDetailRead: (id) => {
        set({
          focusMode: 'detail-read',
          selectedQuickNoteId: id,
        })
      },

      exitFocus: () => {
        set({
          focusMode: 'normal',
          selectedQuickNoteId: null,
        })
      },
      reset: () =>
        set({
          allQuickNotes: [],
          quickNotes: [],
          trashedQuickNotes: [],
          syncStatusById: {},
          lifecycleStateById: {},
          isLoading: false,
          error: null,
          searchQuery: '',
          selectedTagFilters: [],
          tagFilterMode: 'single',
          selectedDate: null,
          focusMode: 'normal',
          selectedQuickNoteId: null,
        }),
    }),
    { name: 'quick-note-store' },
  ),
)
