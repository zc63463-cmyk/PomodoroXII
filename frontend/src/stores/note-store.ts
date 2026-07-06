/**
 * Note store (F0 §7.3.7).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Note, MemoComment } from '@/types'

interface NoteState {
  notes: Note[]
  comments: MemoComment[]
  currentNoteId: string | null
  isLoading: boolean
  error: string | null
}

interface NoteActions {
  loadNotes: () => Promise<void>
  getNote: (id: string) => Promise<Note | null>
  createNote: (data: Partial<Note>) => Promise<Note>
  updateNote: (id: string, data: Partial<Note>) => Promise<void>
  deleteNote: (id: string) => Promise<void>
  loadComments: (noteId: string) => Promise<void>
  addComment: (noteId: string, content: string) => Promise<void>
  deleteComment: (commentId: string) => Promise<void>
  reset: () => void
}

type NoteStore = NoteState & NoteActions

export const useNoteStore = create<NoteStore>()(
  devtools(
    (set) => ({
      notes: [],
      comments: [],
      currentNoteId: null,
      isLoading: false,
      error: null,

      loadNotes: async () => { /* S0 stub */ },
      getNote: async () => null,
      createNote: async () => ({} as Note),
      updateNote: async () => { /* S0 stub */ },
      deleteNote: async () => { /* S0 stub */ },
      loadComments: async () => { /* S0 stub */ },
      addComment: async () => { /* S0 stub */ },
      deleteComment: async () => { /* S0 stub */ },
      reset: () => set({ notes: [], comments: [], currentNoteId: null, isLoading: false, error: null }),
    }),
    { name: 'note-store' },
  ),
)
