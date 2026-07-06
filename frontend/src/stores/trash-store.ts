/**
 * Trash store (F0 §7.3.16).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Note, QuickNote, Folder } from '@/types'

interface TrashState {
  trashedNotes: Note[]
  trashedQuickNotes: QuickNote[]
  trashedFolders: Folder[]
  isLoading: boolean
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

export const useTrashStore = create<TrashStore>()(
  devtools(
    (set) => ({
      trashedNotes: [],
      trashedQuickNotes: [],
      trashedFolders: [],
      isLoading: false,

      loadTrashed: async () => { /* S0 stub */ },
      restoreNote: async () => { /* S0 stub */ },
      restoreQuickNote: async () => { /* S0 stub */ },
      purgeNote: async () => { /* S0 stub */ },
      purgeQuickNote: async () => { /* S0 stub */ },
      emptyTrash: async () => { /* S0 stub */ },
      reset: () => set({ trashedNotes: [], trashedQuickNotes: [], trashedFolders: [], isLoading: false }),
    }),
    { name: 'trash-store' },
  ),
)
