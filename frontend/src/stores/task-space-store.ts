import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { NoteAutosaveController, type FlushReason } from '@/lib/task-space/note-autosave-controller'
import type { CachedProject, CachedWorkItem, CachedWorkItemNote, WorkItemNoteConflictRow } from '@/types'

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
  updateWorkItem: (input: {
    workItemId: string
    title?: string
    description?: string | null
    priority?: string | null
    typeDefinitionId?: string | null
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

export interface TaskSpaceNoteRepositoryLike {
  read: (workItemId: string) => Promise<CachedWorkItemNote | null>
  saveLocal: (input: {
    workItemId: string
    expectedLocalRevision: number
    document: WorkItemNoteDocument
    operationId: string
    now: string
  }) => Promise<CachedWorkItemNote>
  dispatchReplace: (workItemId: string) => Promise<void>
  resolveReloadRemote: (workItemId: string) => Promise<void>
  resolveOverwriteLocal: (workItemId: string) => Promise<void>
  readConflict: (workItemId: string) => Promise<WorkItemNoteConflictRow | null>
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
  noteConflict: WorkItemNoteConflictRow | null
  isLoading: boolean
  error: string | null
  repository: TaskSpaceRepositoryLike | null
  noteRepository: TaskSpaceNoteRepositoryLike | null
  /** Work item ids (or parent ids for child creation) with an in-flight mutation. */
  pendingMutations: Record<string, boolean>
  /** Stable, user-safe code of the last failed mutation (never raw Axios text). */
  mutationError: { targetId: string; code: string } | null
}

export interface TaskSpaceActions {
  hydrate: (spaceId: string, repository: TaskSpaceRepositoryLike) => Promise<void>
  attachNoteRepository: (repository: TaskSpaceNoteRepositoryLike | null) => void
  loadNote: (workItemId: string) => Promise<void>
  updateNoteDocument: (document: WorkItemNoteDocument) => void
  flushNote: (reason: FlushReason) => Promise<void>
  dispatchNote: (workItemId: string) => Promise<void>
  resolveReloadRemoteNote: (workItemId: string) => Promise<void>
  resolveOverwriteLocalNote: (workItemId: string) => Promise<void>
  loadTree: (projectId: string) => Promise<void>
  selectProject: (projectId: string) => Promise<void>
  selectWorkItem: (workItemId: string) => void
  createProject: (input: { name: string; key: string; description: string | null }) => Promise<CachedProject>
  createChild: (parentId: string, input?: CreateChildInput) => Promise<CachedWorkItem>
  updateWorkItem: (workItemId: string, input: {
    title?: string
    description?: string | null
    priority?: string | null
    typeDefinitionId?: string | null
  }) => Promise<CachedWorkItem>
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
  noteConflict: null,
  isLoading: false,
  error: null,
  repository: null,
  noteRepository: null,
  pendingMutations: {},
  mutationError: null,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const MUTATION_ERROR_MESSAGES: Record<string, string> = {
  version_conflict: '该项目项已被其他操作更新，请刷新后重试。',
  idempotency_conflict: '该操作已被使用，请重试或刷新。',
  invalid_work_item_tree: '当前树结构不允许该操作。',
  active_child_conflict: '存在进行中的子项，无法完成该操作。',
  not_found: '项目项不存在或已被删除。',
  invalid_payload_hash: '请求校验失败，请刷新后重试。',
}

const GENERIC_MUTATION_ERROR = '操作失败，请检查服务连接后重试。'

/**
 * Map a failed mutation to a stable error code and a closed, user-safe
 * message. Never surfaces raw Axios text, exception messages, response
 * objects, tokens, or paths. Handles canonical ({code, ...}), legacy
 * ({detail: string | {code, ...}}) and error-code header shapes.
 */
export function resolveTaskSpaceMutationError(error: unknown): { code: string; message: string } {
  const response = isRecord(error) ? error.response : undefined
  const data = isRecord(response) ? response.data : undefined
  const headers = isRecord(response) ? response.headers : undefined

  let code: unknown = isRecord(data) ? data.code : undefined
  if (!code && isRecord(data) && isRecord(data.detail)) code = data.detail.code
  if (code === undefined && isRecord(headers)) code = headers['x-pomodoroxii-error-code']

  const stableCode = typeof code === 'string' && code.length > 0 ? code : 'unknown'
  return {
    code: stableCode,
    message: MUTATION_ERROR_MESSAGES[stableCode] ?? GENERIC_MUTATION_ERROR,
  }
}

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
    type PendingNoteEdit = {
      revision: number
      workItemId: string
      expectedLocalRevision: number
      document: WorkItemNoteDocument
      operationId: string
      now: string
    }
    let noteAutosave: NoteAutosaveController<PendingNoteEdit> | null = null
    // Synchronous per-target single-flight guard: state updates are async, so
    // a second mutation in the same tick would still see stale state. The Set
    // is written synchronously before any await and cleared in finally.
    const mutationGuards = new Set<string>()

    const beginMutation = (targetId: string, inFlightCode: string): void => {
      if (mutationGuards.has(targetId)) throw new Error(inFlightCode)
      mutationGuards.add(targetId)
      set((state) => ({ pendingMutations: { ...state.pendingMutations, [targetId]: true } }))
    }

    const endMutation = (targetId: string): void => {
      mutationGuards.delete(targetId)
      set((state) => {
        const next = { ...state.pendingMutations }
        delete next[targetId]
        return { pendingMutations: next }
      })
    }

    const ensureNoteAutosave = (): NoteAutosaveController<PendingNoteEdit> => {
      if (noteAutosave) return noteAutosave
      noteAutosave = new NoteAutosaveController<PendingNoteEdit>(
        async (edit) => {
          const repository = get().noteRepository
          if (!repository) throw new Error('task_space_note_repository_not_ready')
          const saved = await repository.saveLocal(edit)
          const current = get().selectedNote
          if (!current || current.noteId !== saved.noteId) return
          if (current.localRevision <= saved.localRevision) {
            set({ selectedNote: saved })
          } else {
            set({ selectedNote: {
              ...current,
              version: saved.version,
              createdAt: saved.createdAt,
            } })
          }
        },
        800,
        (error) => set({ error: (error as Error).message }),
      )
      return noteAutosave
    }

    return {
      ...initialState(),

      async hydrate(spaceId, repository) {
        const sequence = ++hydrationSequence
        set({
          spaceId,
          repository,
          isLoading: true,
          error: null,
          mutationError: null,
          selectedProjectId: null,
          selectedWorkItemId: null,
          selectedLevel2WorkItemId: null,
          selectedNote: null,
          noteConflict: null,
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

      attachNoteRepository(repository) {
        noteAutosave?.cancel()
        noteAutosave = null
        set({ noteRepository: repository, selectedNote: null, noteConflict: null })
      },

      async loadNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) return
        try {
          const [selectedNote, noteConflict] = await Promise.all([
            repository.read(workItemId),
            repository.readConflict(workItemId),
          ])
          if (get().selectedWorkItemId !== workItemId) return
          set({ selectedNote, noteConflict, error: null })
        } catch (error) {
          set({ error: (error as Error).message })
        }
      },

      updateNoteDocument(document) {
        const current = get().selectedNote
        if (!current) throw new Error('work_item_note_not_loaded')
        const now = canonicalNow()
        const nextRevision = current.localRevision + 1
        set({
          selectedNote: {
            ...current,
            document,
            localRevision: nextRevision,
            syncState: 'dirty',
            updatedAt: now,
          },
        })
        ensureNoteAutosave().schedule({
          revision: nextRevision,
          workItemId: current.workItemId,
          expectedLocalRevision: current.localRevision,
          document,
          operationId: crypto.randomUUID(),
          now,
        })
      },

      async flushNote(reason) {
        try {
          await noteAutosave?.flush(reason)
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
        }
      },

      async dispatchNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        try {
          await get().flushNote('current-item-change')
          await repository.dispatchReplace(workItemId)
          await get().loadNote(workItemId)
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
        }
      },

      async resolveReloadRemoteNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        try {
          await repository.resolveReloadRemote(workItemId)
          await get().loadNote(workItemId)
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
        }
      },

      async resolveOverwriteLocalNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        try {
          await repository.resolveOverwriteLocal(workItemId)
          await get().loadNote(workItemId)
        } catch (error) {
          set({ error: (error as Error).message })
          throw error
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
          mutationError: null,
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
        beginMutation(parentId, 'work_item_child_creation_in_flight')
        const repository = get().repository
        const state = get()
        const parent = state.workItems.find((item) => item.id === parentId)
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!state.selectedProjectId) throw new Error('task_space_project_not_selected')
          if (!parent || parent.depth >= 3) throw new Error('work_item_child_depth_exceeded')
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
            mutationError: null,
          }))
          return created
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: parentId, code: mapped.code } })
          throw error
        } finally {
          endMutation(parentId)
        }
      },

      async updateWorkItem(workItemId, input) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        const state = get()
        const item = state.workItems.find((candidate) => candidate.id === workItemId)
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!item) throw new Error('work_item_not_loaded')
          const updated = await repository.updateWorkItem({ workItemId, ...input })
          set((current) => ({
            workItems: current.workItems.map((candidate) => candidate.id === updated.id ? updated : candidate),
            error: null,
            mutationError: null,
          }))
          return updated
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      async moveWorkItem(workItemId, newParentId, childRank = 0) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        const state = get()
        const item = state.workItems.find((candidate) => candidate.id === workItemId)
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!item) throw new Error('work_item_not_loaded')
          const moved = await repository.moveWorkItem({
            projectId: item.projectId,
            workItemId,
            newParentId,
            childRank,
          })
          set((current) => ({
            workItems: current.workItems.map((candidate) => candidate.id === moved.id ? moved : candidate),
            error: null,
            mutationError: null,
          }))
          return moved
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      async transitionWorkItem(workItemId, statusDefinitionId) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const transitioned = await repository.transitionWorkItem({ workItemId, statusDefinitionId })
          set((state) => ({
            workItems: state.workItems.map((item) => item.id === transitioned.id ? transitioned : item),
            error: null,
            mutationError: null,
          }))
          return transitioned
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      reset() {
        hydrationSequence += 1
        mutationGuards.clear()
        noteAutosave?.cancel()
        noteAutosave = null
        set(initialState())
      },
    }
  }, { name: 'task-space-store' }),
)
