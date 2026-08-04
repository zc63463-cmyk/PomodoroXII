import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { CachedProject, CachedWorkItem, CachedWorkItemNote } from '@/types'

export interface CreateChildInput {
  title?: string
  description?: string | null
  typeDefinitionId?: string | null
  statusDefinitionId?: string | null
  priority?: string | null
}

export interface TaskSpaceRepositoryLike {
  readCachedOverview: () => Promise<{
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions | null
  }>
  refreshOverview: () => Promise<{
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions
  }>
  loadTree: (projectId: string) => Promise<{
    cached: unknown[]
    remote: CachedWorkItem[]
  } | {
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions
  }>
  createProject: (input: { name: string; key: string; description: string | null }) => Promise<CachedProject>
  createWorkItem: (input: {
    projectId: string
    title: string
    description: string | null
    parentId: string | null
    typeDefinitionId: string | null
    statusDefinitionId: string | null
    priority: string | null
  }) => Promise<CachedWorkItem>
  moveWorkItem: (input: {
    projectId: string
    workItemId: string
    newParentId: string | null
    childRank: number
  }) => Promise<CachedWorkItem>
  transitionWorkItem: (input: {
    workItemId: string
    statusDefinitionId: string
  }) => Promise<CachedWorkItem>
  resumePendingDirectCommandIntents: () => Promise<void>
}

export interface TaskSpaceState {
  spaceId: string | null
  projects: CachedProject[]
  definitions: TaskSpaceDefinitions | null
  workItems: CachedWorkItem[]
  selectedProjectId: string | null
  selectedWorkItemId: string | null
  selectedLevel2WorkItemId: string | null
  selectedNote: CachedWorkItemNote | null
  isLoading: boolean
  error: string | null
  repository: TaskSpaceRepositoryLike | null
}

export interface TaskSpaceActions {
  hydrate: (spaceId: string, repository: TaskSpaceRepositoryLike) => Promise<void>
  loadTree: (projectId: string) => Promise<void>
  selectProject: (projectId: string) => Promise<void>
  selectWorkItem: (workItemId: string) => void
  createProject: (input: { name: string; key: string; description: string | null }) => Promise<CachedProject>
  createChild: (parentId: string, input?: CreateChildInput) => Promise<CachedWorkItem>
  moveWorkItem: (workItemId: string, newParentId: string | null, childRank?: number) => Promise<CachedWorkItem>
  transitionWorkItem: (workItemId: string, statusDefinitionId: string) => Promise<CachedWorkItem>
  reset: () => void
}

const initialState = (): TaskSpaceState => ({
  spaceId: null,
  projects: [],
  definitions: null,
  workItems: [],
  selectedProjectId: null,
  selectedWorkItemId: null,
  selectedLevel2WorkItemId: null,
  selectedNote: null,
  isLoading: false,
  error: null,
  repository: null,
})

const isCurrent = (state: TaskSpaceState, spaceId: string): boolean => state.spaceId === spaceId

const mergeProjectWorkItems = (
  current: CachedWorkItem[],
  projectId: string,
  replacement: CachedWorkItem[],
): CachedWorkItem[] => [
  ...current.filter((item) => item.projectId !== projectId),
  ...replacement,
]

const definitionId = (definitions: TaskSpaceDefinitions | null, group: 'statuses' | 'types'): string | null => {
  const first = definitions?.[group][0]
  if (!first || typeof first !== 'object' || first === null) return null
  const id = (first as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function selectProjectTree(items: CachedWorkItem[], projectId: string | null): CachedWorkItem[] {
  if (!projectId) return []
  return items
    .filter((item) => item.projectId === projectId && item.depth >= 1 && item.depth <= 3)
    .sort((left, right) => (
      left.depth - right.depth ||
      left.childRank - right.childRank ||
      left.id.localeCompare(right.id)
    ))
}

export const useTaskSpaceStore = create<TaskSpaceState & TaskSpaceActions>()(
  devtools((set, get) => {
    let hydrationSequence = 0

    return {
      ...initialState(),

      async hydrate(spaceId, repository) {
        const sequence = ++hydrationSequence
        set({
          spaceId,
          repository,
          isLoading: true,
          error: null,
          selectedProjectId: null,
          selectedWorkItemId: null,
          selectedLevel2WorkItemId: null,
          selectedNote: null,
        })

        try {
          const cached = await repository.readCachedOverview()
          if (sequence !== hydrationSequence || !isCurrent(get(), spaceId)) return
          const cachedProjectId = cached.projects[0]?.id ?? null
          set({
            projects: cached.projects,
            workItems: cached.workItems,
            definitions: cached.definitions,
            selectedProjectId: cachedProjectId,
          })

          await repository.resumePendingDirectCommandIntents()
          const remote = await repository.refreshOverview()
          if (sequence !== hydrationSequence || !isCurrent(get(), spaceId)) return
          const selectedProjectId = get().selectedProjectId && remote.projects.some(
            (project) => project.id === get().selectedProjectId,
          )
            ? get().selectedProjectId
            : remote.projects[0]?.id ?? null
          set({
            projects: remote.projects,
            workItems: remote.workItems,
            definitions: remote.definitions,
            selectedProjectId,
            isLoading: false,
            error: null,
          })
        } catch (error) {
          if (sequence !== hydrationSequence || !isCurrent(get(), spaceId)) return
          set({ isLoading: false, error: (error as Error).message })
        }
      },

      async loadTree(projectId) {
        const repository = get().repository
        if (!repository) return
        try {
          const result = await repository.loadTree(projectId)
          if (get().selectedProjectId !== projectId) return
          const remote = 'remote' in result
            ? result.remote
            : result.workItems.filter((item) => item.projectId === projectId)
          set((state) => ({
            workItems: mergeProjectWorkItems(state.workItems, projectId, remote),
            error: null,
          }))
        } catch (error) {
          set({ error: (error as Error).message })
        }
      },

      async selectProject(projectId) {
        set({
          selectedProjectId: projectId,
          selectedWorkItemId: null,
          selectedLevel2WorkItemId: null,
          error: null,
        })
        await get().loadTree(projectId)
      },

      selectWorkItem(workItemId) {
        const itemsById = new Map(get().workItems.map((item) => [item.id, item]))
        const item = itemsById.get(workItemId)
        let level2Id: string | null = null
        let cursor = item
        while (cursor) {
          if (cursor.depth === 2) {
            level2Id = cursor.id
            break
          }
          cursor = cursor.parentId ? itemsById.get(cursor.parentId) : undefined
        }
        set({ selectedWorkItemId: workItemId, selectedLevel2WorkItemId: level2Id })
      },

      async createProject(input) {
        const repository = get().repository
        if (!repository) throw new Error('task_space_repository_not_ready')
        try {
          const created = await repository.createProject(input)
          set((state) => ({
            projects: [...state.projects, created].sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id)),
            selectedProjectId: created.id,
            selectedWorkItemId: null,
            selectedLevel2WorkItemId: null,
            error: null,
          }))
          return created
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
        }
      },

      async createChild(parentId, input = {}) {
        const repository = get().repository
        const state = get()
        const parent = state.workItems.find((item) => item.id === parentId)
        if (!repository) throw new Error('task_space_repository_not_ready')
        if (!state.selectedProjectId) throw new Error('task_space_project_not_selected')
        if (!parent || parent.depth >= 3) throw new Error('work_item_child_depth_exceeded')
        try {
          const created = await repository.createWorkItem({
            projectId: state.selectedProjectId,
            title: input.title?.trim() || 'New work item',
            description: input.description ?? null,
            parentId,
            typeDefinitionId: input.typeDefinitionId ?? definitionId(state.definitions, 'types'),
            statusDefinitionId: input.statusDefinitionId ?? definitionId(state.definitions, 'statuses'),
            priority: input.priority ?? null,
          })
          set((current) => ({
            workItems: [...current.workItems, created],
            selectedWorkItemId: created.id,
            selectedLevel2WorkItemId: created.depth === 2 ? created.id : parent.depth === 2 ? parent.id : current.selectedLevel2WorkItemId,
            error: null,
          }))
          return created
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
        }
      },

      async moveWorkItem(workItemId, newParentId, childRank = 0) {
        const repository = get().repository
        const state = get()
        const item = state.workItems.find((candidate) => candidate.id === workItemId)
        if (!repository) throw new Error('task_space_repository_not_ready')
        if (!item) throw new Error('work_item_not_loaded')
        try {
          const moved = await repository.moveWorkItem({
            projectId: item.projectId,
            workItemId,
            newParentId,
            childRank,
          })
          set((current) => ({
            workItems: current.workItems.map((candidate) => candidate.id === moved.id ? moved : candidate),
            error: null,
          }))
          return moved
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
        }
      },

      async transitionWorkItem(workItemId, statusDefinitionId) {
        const repository = get().repository
        if (!repository) throw new Error('task_space_repository_not_ready')
        try {
          const transitioned = await repository.transitionWorkItem({ workItemId, statusDefinitionId })
          set((state) => ({
            workItems: state.workItems.map((item) => item.id === transitioned.id ? transitioned : item),
            error: null,
          }))
          return transitioned
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
        }
      },

      reset() {
        hydrationSequence += 1
        set(initialState())
      },
    }
  }, { name: 'task-space-store' }),
)
