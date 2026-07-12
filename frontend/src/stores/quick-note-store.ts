/**
 * Quick note store (F0 §7.3.8).
 *
 * Thin Zustand state wrapper. Dexie mutations live in quick-note-repository so
 * the future sync outbox boundary stays centralized.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  isActiveQuickNote,
  selectActiveQuickNotes,
  selectQuickNotesForExplorer,
} from '@/lib/quick-notes/quick-note-selectors'
import {
  cleanupQuickNoteTags as cleanupQuickNoteTagList,
  normalizeQuickNoteTag,
  renameQuickNoteTagInList,
  replaceInlineQuickNoteHashtag,
} from '@/lib/quick-notes/quick-note-tags'
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
  projectRecordedQuickNote: (note: QuickNote) => undefined
  createQuickNote: (data: QuickNoteCreateInput) => Promise<QuickNote>
  updateQuickNote: (id: string, data: QuickNoteUpdateInput) => Promise<void>
  deleteQuickNote: (id: string) => Promise<void>
  restoreQuickNote: (id: string) => Promise<void>
  purgeQuickNote: (id: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  migrateToNote: (id: string) => Promise<string>
  renameQuickNoteTag: (from: string, to: string) => Promise<void>
  cleanupQuickNoteTags: () => Promise<number>
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

interface QuickNoteListFilters {
  query: string
  selectedTagFilters: string[]
  selectedDate: string | null
}

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
  return normalizeQuickNoteTag(tag)
}

export const useQuickNoteStore = create<QuickNoteStore>()(
  devtools(
    (set, get) => {
      let storeEpoch = 0
      let projectionRevision = 0

      const getCurrentFilters = (): QuickNoteListFilters => {
        const state = get()
        return {
          query: state.searchQuery,
          selectedTagFilters: state.selectedTagFilters,
          selectedDate: state.selectedDate,
        }
      }

      const publishIfStable = (
        actionEpoch: number,
        revision: number,
        createUpdate: () => Partial<QuickNoteStore>,
      ): 'published' | 'retry' | 'stale' => {
        let outcome: 'published' | 'retry' | 'stale' = 'published'
        set((state) => {
          if (actionEpoch !== storeEpoch) {
            outcome = 'stale'
            return state
          }
          if (revision !== projectionRevision) {
            outcome = 'retry'
            return state
          }
          return createUpdate()
        })
        return outcome
      }

      const readStableLists = async (
        actionEpoch: number,
        getFilters: () => QuickNoteListFilters,
        publish: (
          lists: Awaited<ReturnType<typeof refreshLists>>,
          filters: QuickNoteListFilters,
        ) => Partial<QuickNoteStore>,
        publishFailure?: (error: unknown) => Partial<QuickNoteStore>,
      ): Promise<boolean> => {
        if (actionEpoch !== storeEpoch) return false

        while (true) {
          const revision = projectionRevision
          const filters = getFilters()
          let lists: Awaited<ReturnType<typeof refreshLists>>

          try {
            lists = await refreshLists(
              filters.query,
              filters.selectedTagFilters,
              filters.selectedDate,
            )
          } catch (error) {
            if (actionEpoch !== storeEpoch) return false
            if (revision !== projectionRevision) continue
            if (!publishFailure) throw error

            const outcome = publishIfStable(actionEpoch, revision, () =>
              publishFailure(error),
            )
            if (outcome === 'stale') return false
            if (outcome === 'retry') continue
            throw error
          }

          const outcome = publishIfStable(actionEpoch, revision, () => {
            const currentFilters = getFilters()
            const currentLists = {
              ...lists,
              quickNotes: deriveVisibleQuickNotes(
                lists.allQuickNotes,
                currentFilters.query,
                currentFilters.selectedTagFilters,
                currentFilters.selectedDate,
              ),
            }
            return publish(currentLists, currentFilters)
          })
          if (outcome === 'stale') return false
          if (outcome === 'retry') continue
          return true
        }
      }

      return {
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
        const actionEpoch = storeEpoch
        const query = opts?.query ?? get().searchQuery
        set({ isLoading: true, error: null, searchQuery: query })
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, isLoading: false }),
          (error) => ({
            error: error instanceof Error ? error.message : 'Failed to load quick notes',
            isLoading: false,
          }),
        )
      },

      loadTrashedQuickNotes: async () => {
        const actionEpoch = storeEpoch
        set({ isLoading: true, error: null })
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, isLoading: false }),
          (error) => ({
            error:
              error instanceof Error ? error.message : 'Failed to load trashed quick notes',
            isLoading: false,
          }),
        )
      },

      refreshQuickNotesFromRepository: async () => {
        const actionEpoch = storeEpoch
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
          (error) => ({
            error: error instanceof Error ? error.message : 'Failed to refresh quick notes',
          }),
        )
      },

      projectRecordedQuickNote: (note) => {
        projectionRevision += 1
        set((state) => {
          const allQuickNotes = selectActiveQuickNotes([
            ...state.allQuickNotes.filter((item) => item.id !== note.id),
            note,
          ])
          return {
            allQuickNotes,
            quickNotes: deriveVisibleQuickNotes(
              allQuickNotes,
              state.searchQuery,
              state.selectedTagFilters,
              state.selectedDate,
            ),
            lifecycleStateById: {
              ...state.lifecycleStateById,
              [note.id]: 'active',
            },
            syncStatusById: {
              ...state.syncStatusById,
              [note.id]: 'pending',
            },
            error: null,
          }
        })
        return undefined
      },

      createQuickNote: async (data) => {
        const actionEpoch = storeEpoch
        const note = await createQuickNote(data)
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
        )
        return note
      },

      updateQuickNote: async (id, data) => {
        const actionEpoch = storeEpoch
        await updateQuickNote(id, data)
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
        )
      },

      deleteQuickNote: async (id) => {
        const actionEpoch = storeEpoch
        await moveQuickNoteToTrash(id)
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
        )
      },

      restoreQuickNote: async (id) => {
        const actionEpoch = storeEpoch
        await restoreQuickNote(id)
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
        )
      },

      purgeQuickNote: async (id) => {
        const actionEpoch = storeEpoch
        await purgeQuickNote(id)
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
        )
      },

      togglePin: async (id) => {
        const actionEpoch = storeEpoch
        const note = get().allQuickNotes.find((item) => item.id === id)
        if (!note) return
        await updateQuickNote(id, { pinned: !note.pinned })
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
        )
      },

      migrateToNote: async (id) => {
        const actionEpoch = storeEpoch
        const result = await convertQuickNoteToNote(id)
        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists) => ({ ...lists, error: null }),
        )
        return result.noteId
      },

      renameQuickNoteTag: async (from, to) => {
        const fromTag = normalizeQuickNoteTag(from)
        const toTag = normalizeQuickNoteTag(to)
        if (!fromTag || !toTag) return

        const actionEpoch = storeEpoch
        const state = get()
        const getRenamedFilters = (): QuickNoteListFilters => {
          const currentState = get()
          return {
            query: currentState.searchQuery,
            selectedTagFilters:
              fromTag === toTag
                ? normalizeFilterTags(currentState.selectedTagFilters)
                : renameQuickNoteTagInList(currentState.selectedTagFilters, fromTag, toTag),
            selectedDate: currentState.selectedDate,
          }
        }

        if (fromTag !== toTag) {
          const activeNotes = state.allQuickNotes.filter(isActiveQuickNote)
          for (const note of activeNotes) {
            const hasFromTag = note.tags.some(
              (tag) => normalizeQuickNoteTag(tag) === fromTag,
            )
            if (!hasFromTag) continue

            const tags = renameQuickNoteTagInList(note.tags, fromTag, toTag)
            const content = replaceInlineQuickNoteHashtag(note.content, fromTag, toTag)
            const patch: QuickNoteUpdateInput = {}

            if (!areStringArraysEqual(note.tags, tags)) patch.tags = tags
            if (note.content !== content) patch.content = content

            if (Object.keys(patch).length > 0) {
              await updateQuickNote(note.id, patch)
            }
          }
        }

        await readStableLists(
          actionEpoch,
          getRenamedFilters,
          (lists, filters) => ({
            ...lists,
            selectedTagFilters: filters.selectedTagFilters,
            error: null,
          }),
        )
      },

      cleanupQuickNoteTags: async () => {
        const actionEpoch = storeEpoch
        const state = get()
        let changedCount = 0

        for (const note of state.allQuickNotes.filter(isActiveQuickNote)) {
          const tags = cleanupQuickNoteTagList(note.tags)
          if (areStringArraysEqual(note.tags, tags)) continue
          await updateQuickNote(note.id, { tags })
          changedCount += 1
        }

        await readStableLists(
          actionEpoch,
          getCurrentFilters,
          (lists, filters) => {
            const selectedTagFilters = keepExistingFilterTags(
              filters.selectedTagFilters,
              lists.allQuickNotes,
            )
            return {
              ...lists,
              selectedTagFilters,
              quickNotes: deriveVisibleQuickNotes(
                lists.allQuickNotes,
                filters.query,
                selectedTagFilters,
                filters.selectedDate,
              ),
              error: null,
            }
          },
        )
        return changedCount
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
      reset: () => {
        storeEpoch += 1
        projectionRevision += 1
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
        })
      },
      }
    },
    { name: 'quick-note-store' },
  ),
)

function normalizeFilterTags(tags: string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const tag of tags) {
    const normalizedTag = normalizeFilterTag(tag)
    if (!normalizedTag || seen.has(normalizedTag)) continue
    seen.add(normalizedTag)
    normalized.push(normalizedTag)
  }

  return normalized
}

function keepExistingFilterTags(filters: string[], notes: QuickNote[]): string[] {
  const activeTags = new Set(
    notes
      .filter(isActiveQuickNote)
      .flatMap((note) => note.tags.map(normalizeQuickNoteTag))
      .filter(Boolean),
  )

  return normalizeFilterTags(filters).filter((tag) => activeTags.has(tag))
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
