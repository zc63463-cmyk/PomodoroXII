/**
 * Folder store (F0 §7.3.9).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Folder } from '@/types'

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
    (set) => ({
      folders: [],
      noteCounts: {},
      isLoading: false,

      loadFolders: async () => { /* S0 stub */ },
      createFolder: async () => ({} as Folder),
      renameFolder: async () => { /* S0 stub */ },
      moveFolder: async () => { /* S0 stub */ },
      deleteFolder: async () => { /* S0 stub */ },
      refreshNoteCounts: async () => { /* S0 stub */ },
      reset: () => set({ folders: [], noteCounts: {}, isLoading: false }),
    }),
    { name: 'folder-store' },
  ),
)
