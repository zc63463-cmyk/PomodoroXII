/**
 * Task store (F0 §7.3.6).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Task, Tag, TaskTag, TaskRelation } from '@/types'

interface TaskState {
  tasks: Task[]
  tags: Tag[]
  taskTags: TaskTag[]
  taskRelations: TaskRelation[]
  isLoading: boolean
  error: string | null
}

interface TaskActions {
  loadTasks: () => Promise<void>
  createTask: (data: Partial<Task>) => Promise<Task>
  updateTask: (id: string, data: Partial<Task>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  loadTags: () => Promise<void>
  createTag: (name: string, parentId?: string) => Promise<Tag>
  deleteTag: (id: string) => Promise<void>
  assignTag: (taskId: string, tagId: string) => Promise<void>
  removeTag: (taskId: string, tagId: string) => Promise<void>
  createRelation: (fromId: string, toId: string, type: string) => Promise<void>
  deleteRelation: (id: string) => Promise<void>
  reset: () => void
}

type TaskStore = TaskState & TaskActions

export const useTaskStore = create<TaskStore>()(
  devtools(
    (set) => ({
      tasks: [],
      tags: [],
      taskTags: [],
      taskRelations: [],
      isLoading: false,
      error: null,

      loadTasks: async () => { /* S0 stub */ },
      createTask: async () => ({} as Task),
      updateTask: async () => { /* S0 stub */ },
      deleteTask: async () => { /* S0 stub */ },
      loadTags: async () => { /* S0 stub */ },
      createTag: async () => ({} as Tag),
      deleteTag: async () => { /* S0 stub */ },
      assignTag: async () => { /* S0 stub */ },
      removeTag: async () => { /* S0 stub */ },
      createRelation: async () => { /* S0 stub */ },
      deleteRelation: async () => { /* S0 stub */ },
      reset: () => set({ tasks: [], tags: [], taskTags: [], taskRelations: [], isLoading: false, error: null }),
    }),
    { name: 'task-store' },
  ),
)
