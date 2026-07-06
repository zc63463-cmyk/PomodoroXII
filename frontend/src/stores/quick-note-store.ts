/**
 * Quick note store (F0 §7.3.8).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { QuickNote } from '@/types'

interface QuickNoteState {
  quickNotes: QuickNote[]
  isLoading: boolean
  error: string | null
}

interface QuickNoteActions {
  loadQuickNotes: (opts?: { pinnedOnly?: boolean }) => Promise<void>
  createQuickNote: (data: Partial<QuickNote>) => Promise<QuickNote>
  updateQuickNote: (id: string, data: Partial<QuickNote>) => Promise<void>
  deleteQuickNote: (id: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  migrateToNote: (id: string) => Promise<string>
  reset: () => void
}

type QuickNoteStore = QuickNoteState & QuickNoteActions

export const useQuickNoteStore = create<QuickNoteStore>()(
  devtools(
    (set) => ({
      quickNotes: [],
      isLoading: false,
      error: null,

      loadQuickNotes: async () => { /* S0 stub */ },
      createQuickNote: async () => ({} as QuickNote),
      updateQuickNote: async () => { /* S0 stub */ },
      deleteQuickNote: async () => { /* S0 stub */ },
      togglePin: async () => { /* S0 stub */ },
      migrateToNote: async () => '',
      reset: () => set({ quickNotes: [], isLoading: false, error: null }),
    }),
    { name: 'quick-note-store' },
  ),
)
