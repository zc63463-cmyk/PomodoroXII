/**
 * Note store (F0 §7.3.7) —— 方案 A 阶段 2。
 *
 * 所有写操作先落本地 Dexie（note-repository 保证「写行 + 入队 outbox」同一事务），
 * 再由同步引擎推上去。Store 只负责编排与状态，不直接碰 Dexie，也不发 HTTP 写请求。
 *
 * 评论（loadComments / addComment / deleteComment）不属于方案 A 范围，
 * 仍是 S0 stub —— 刻意保留标记，避免高估完成度。
 *
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Note, MemoComment } from '@/types'
import {
  createNote as createNoteLocally,
  getNote as readNote,
  listNotes,
  moveNoteToTrash,
  updateNote as updateNoteMetadata,
  updateNoteContent,
} from '@/lib/notes/note-repository'

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
    (set, get) => ({
      notes: [],
      comments: [],
      currentNoteId: null,
      isLoading: false,
      error: null,

      loadNotes: async () => {
        set({ isLoading: true, error: null })
        try {
          set({ notes: await listNotes(), isLoading: false })
        } catch (error) {
          set({ isLoading: false, error: toMessage(error) })
        }
      },

      getNote: async (id) => {
        set({ error: null })
        try {
          return await readNote(id)
        } catch (error) {
          set({ error: toMessage(error) })
          return null
        }
      },

      createNote: async (data) => {
        set({ error: null })
        try {
          const note = await createNoteLocally({
            id: data.id ?? crypto.randomUUID(),
            title: data.title,
            content: data.content,
            summary: data.summary,
            tags: data.tags,
            category: data.category,
            folder_id: data.folder_id,
          })
          set({ notes: await listNotes(), currentNoteId: note.id })
          return note
        } catch (error) {
          set({ error: toMessage(error) })
          throw error
        }
      },

      updateNote: async (id, data) => {
        set({ error: null })
        try {
          // 正文与元数据分两条写入，对应服务端 PATCH /{id} 与 PUT /{id}/content。
          const { content, ...metadata } = data
          if (content !== undefined) {
            await updateNoteContent(id, content)
          }
          if (Object.keys(metadata).length > 0) {
            await updateNoteMetadata(id, metadata)
          }
          set({ notes: await listNotes() })
        } catch (error) {
          set({ error: toMessage(error) })
          throw error
        }
      },

      // 与 REST 一致：默认软删除（置 trashed_at，可恢复），不是物理删除。
      deleteNote: async (id) => {
        set({ error: null })
        try {
          await moveNoteToTrash(id)
          const { currentNoteId } = get()
          set({
            notes: await listNotes(),
            currentNoteId: currentNoteId === id ? null : currentNoteId,
          })
        } catch (error) {
          set({ error: toMessage(error) })
          throw error
        }
      },

      loadComments: async () => { /* S0 stub */ },
      addComment: async () => { /* S0 stub */ },
      deleteComment: async () => { /* S0 stub */ },
      reset: () => set({ notes: [], comments: [], currentNoteId: null, isLoading: false, error: null }),
    }),
    { name: 'note-store' },
  ),
)

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
