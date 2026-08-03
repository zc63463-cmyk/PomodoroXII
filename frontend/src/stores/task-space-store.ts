import { create } from 'zustand'
import type { CachedProject, CachedWorkItem, CachedWorkItemNote } from '@/types'

interface TaskSpaceState {
  projects: CachedProject[]
  workItems: CachedWorkItem[]
  selectedProjectId: string | null
  selectedWorkItemId: string | null
  selectedNote: CachedWorkItemNote | null
  reset: () => void
}

const initialState = (): Omit<TaskSpaceState, 'reset'> => ({
  projects: [],
  workItems: [],
  selectedProjectId: null,
  selectedWorkItemId: null,
  selectedNote: null,
})

export const useTaskSpaceStore = create<TaskSpaceState>()((set) => ({
  ...initialState(),
  reset: () => set(initialState()),
}))
