/**
 * Folder store (F0 §7.3.9) —— 方案 A 阶段 3。
 *
 * 所有写操作先落本地 Dexie（folder-repository 保证「写行 + 入队 outbox」
 * 同一事务），再由同步引擎推上去。Store 只负责编排与状态。
 *
 * 注意 deleteFolder 是**软删除**（置 trashed_at，可恢复），与 REST 一致。
 * 层级约束（不能移进自己的后代）由服务端 FolderDomainPolicy 裁决，
 * 这里不预判 —— 避免两处重复实现规则。
 *
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Folder } from '@/types'
import { collectFolderSubtree } from '@/lib/folders/folder-selectors'
import {
  createFolder as createFolderLocally,
  listFolders,
  moveFolder as moveFolderLocally,
  renameFolder as renameFolderLocally,
  trashFolder,
} from '@/lib/folders/folder-repository'
import { listNotes, updateNote } from '@/lib/notes/note-repository'

interface FolderState {
  folders: Folder[]
  noteCounts: Record<string, number>
  isLoading: boolean
}

interface FolderActions {
  loadFolders: () => Promise<void>
  createFolder: (name: string, parentId?: string | null) => Promise<Folder>
  renameFolder: (id: string, name: string) => Promise<void>
  moveFolder: (id: string, newParentId: string | null) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  refreshNoteCounts: () => Promise<void>
  reset: () => void
}

type FolderStore = FolderState & FolderActions

export const useFolderStore = create<FolderStore>()(
  devtools(
    (set, get) => ({
      folders: [],
      noteCounts: {},
      isLoading: false,

      loadFolders: async () => {
        set({ isLoading: true })
        try {
          const folders = await listFolders()
          set({ folders, isLoading: false })
        } catch {
          set({ isLoading: false })
        }
      },

      createFolder: async (name, parentId = null) => {
        const folder = await createFolderLocally({
          id: crypto.randomUUID(),
          name,
          parent_id: parentId,
        })
        set({ folders: await listFolders() })
        return folder
      },

      renameFolder: async (id, name) => {
        await renameFolderLocally(id, name)
        set({ folders: await listFolders() })
      },

      moveFolder: async (id, newParentId) => {
        await moveFolderLocally(id, newParentId)
        set({ folders: await listFolders() })
      },

      deleteFolder: async (id) => {
        await trashFolder(id)

        // 必须把子树内的笔记改为未归类。服务端 FolderDomainPolicy 会拒绝
        // folder_id 指向已回收文件夹的笔记（relation_endpoint_missing），
        // 不清的话这些笔记在之后每次同步都会被拒 —— 等于永久失联。
        const affected = collectFolderSubtree(get().folders, id)
        const notes = await listNotes()
        for (const note of notes) {
          if (note.folder_id == null) continue
          if (!affected.has(note.folder_id)) continue
          await updateNote(note.id, { folder_id: null })
        }

        set({ folders: await listFolders() })
      },

      refreshNoteCounts: async () => {
        const notes = await listNotes()
        const counts: Record<string, number> = {}
        for (const note of notes) {
          if (note.trashed_at != null || note.folder_id == null) continue
          counts[note.folder_id] = (counts[note.folder_id] ?? 0) + 1
        }
        set({ noteCounts: counts })
      },

      reset: () => set({ folders: [], noteCounts: {}, isLoading: false }),
    }),
    { name: 'folder-store' },
  ),
)
