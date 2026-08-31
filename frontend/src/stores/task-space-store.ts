import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { NoteAutosaveController, type FlushReason } from '@/lib/task-space/note-autosave-controller'
import type { CachedProject, CachedWorkItem, CachedWorkItemNote, WorkItemNoteConflictRow, CachedLabel } from '@/types'

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
  }) => Promise<CachedWorkItem>
  transitionWorkItem: (input: {
    workItemId: string
    statusDefinitionId: string
  }) => Promise<CachedWorkItem>
  // D5 Y: label-set mutations (idempotent set semantics + server CAS).
  addWorkItemLabels: (input: { workItemId: string; labelIds: string[] }) => Promise<CachedWorkItem>
  removeWorkItemLabel: (input: { workItemId: string; labelId: string }) => Promise<CachedWorkItem>
  createLabel: (input: { name: string; color?: string | null }) => Promise<CachedLabel>
  updateLabel: (input: { labelId: string; name?: string; color?: string | null }) => Promise<CachedLabel>
  archiveLabel: (input: { labelId: string }) => Promise<CachedLabel>
  resumePendingDirectCommandIntents: () => Promise<{ failed: Array<{ operationId: string; code: string }> }>
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
  /** Re-apply a durable failed-flush draft; returns the saved note or null. */
  retryDraft: (workItemId: string) => Promise<CachedWorkItemNote | null>
  /**
   * Synchronously persist a durable draft for an edit, BEFORE the debounced
   * flush.  This closes the hard-reload-during-debounce gap without touching
   * the note row or outbox semantics (separate draft collection).
   */
  persistDraft: (input: {
    workItemId: string
    expectedLocalRevision: number
    document: WorkItemNoteDocument
    operationId: string
    now: string
  }) => void
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
  /** Root-item creation entry for an empty project (parentId=null). */
  createRoot: (input?: CreateChildInput) => Promise<CachedWorkItem>
  updateWorkItem: (workItemId: string, input: {
    title?: string
    description?: string | null
    priority?: string | null
    typeDefinitionId?: string | null
  }) => Promise<CachedWorkItem>
  moveWorkItem: (workItemId: string, newParentId: string | null) => Promise<CachedWorkItem>
  transitionWorkItem: (workItemId: string, statusDefinitionId: string) => Promise<CachedWorkItem>
  // D5 Y: converge the work item label set (add=true union, false removal).
  toggleWorkItemLabel: (workItemId: string, labelId: string, add: boolean) => Promise<CachedWorkItem>
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

// Closed, user-safe messages for Note autosave failures.  These deliberately
// never surface raw exception text (Dexie quota errors, Axios bodies, ...).
const NOTE_ERROR_MESSAGES: Record<string, string> = {
  version_conflict: '该笔记已被其他设备更新，请刷新后重试。',
  local_version_conflict: '本地编辑版本冲突，请刷新后重试。',
  work_item_note_not_loaded: '笔记尚未加载，无法保存。',
  work_item_note_not_found: '该笔记不存在或已被删除。',
  task_space_note_repository_not_ready: '笔记存储尚未就绪，无法保存。',
}
const GENERIC_NOTE_ERROR = '笔记保存失败，请检查服务连接后重试。'

/**
 * Map a Note-autosave failure to a stable code + closed message.  Uses the
 * same canonical-wire extraction as mutations but with note-specific wording.
 */
export function resolveTaskSpaceNoteError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = error.message
    if (NOTE_ERROR_MESSAGES[code]) return { code, message: NOTE_ERROR_MESSAGES[code] }
  }
  const mapped = resolveTaskSpaceMutationError(error)
  if (mapped.code !== 'unknown') {
    return { code: mapped.code, message: NOTE_ERROR_MESSAGES[mapped.code] ?? GENERIC_NOTE_ERROR }
  }
  return { code: 'unknown', message: GENERIC_NOTE_ERROR }
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

/**
 * Same-project nodes that may become the new parent of ``selectedWorkItemId``.
 * A candidate must never be the item itself or one of its descendants, and the
 * whole selected subtree must still fit within the 3-level ceiling:
 *
 *   candidate.depth + 1 + (subtreeMaxDepth - selected.depth) <= 3
 *
 * where subtreeMaxDepth is the deepest node in the selected subtree (including
 * the selected item itself).  This mirrors the backend MoveWorkItem guard
 * ``new_parent_depth + _subtree_relative_depth(item) > 3`` exactly, so the UI
 * never offers a parent the server would reject.
 */
export function selectMoveCandidates(items: CachedWorkItem[], selectedWorkItemId: string | null): CachedWorkItem[] {
  if (!selectedWorkItemId) return []
  const selected = items.find((item) => item.id === selectedWorkItemId)
  if (!selected) return []
  const children = new Map<string | null, CachedWorkItem[]>()
  for (const item of items) {
    const group = children.get(item.parentId) ?? []
    group.push(item)
    children.set(item.parentId, group)
  }
  const descendants = new Set<string>()
  let subtreeMaxDepth: number = selected.depth
  const frontier = [selectedWorkItemId]
  while (frontier.length > 0) {
    const id = frontier.pop()!
    for (const child of children.get(id) ?? []) {
      if (descendants.has(child.id)) continue
      descendants.add(child.id)
      subtreeMaxDepth = Math.max(subtreeMaxDepth, child.depth)
      frontier.push(child.id)
    }
  }
  return items.filter((item) => (
    item.id !== selectedWorkItemId
    && !descendants.has(item.id)
    && item.depth + 1 + (subtreeMaxDepth - selected.depth) <= 3
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
      /** The note repository captured at schedule time.  A debounced edit is
       *  flushed against this exact repository even if the store later detaches
       *  it (item/space switch, unmount, logout), so a pending edit is never
       *  dropped by a controlled unbind. */
      repository: TaskSpaceNoteRepositoryLike
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
          // Always persist against the repository that captured the edit, so
          // a controlled unbind can flush without reading detached state.
          const saved = await edit.repository.saveLocal(edit)
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
        (error) => set({ error: resolveTaskSpaceNoteError(error).message }),
      )
      return noteAutosave
    }

    /**
     * Best-effort flush of any pending debounced edit against its captured
     * repository.  Returns true when a dirty flush was started; the caller must
     * then NOT discard the controller, because on failure the controller
     * re-pends the edit and keeps it as a retryable draft.
     */
    const flushPendingNoteBestEffort = (
      reason: 'unmount' | 'space-switch' | 'logout',
    ): boolean => {
      const previous = noteAutosave
      if (!previous?.isDirty()) return false
      void previous.flush(reason).then(
        () => {
          // Success: the pending edit was persisted; safe to discard.
          if (noteAutosave === previous) noteAutosave = null
        },
        () => {
          // Failure: the controller re-pended the edit.  Keep it attached so
          // a later flush can retry it instead of dropping the draft.
          if (noteAutosave === previous) noteAutosave = previous
        },
      )
      return true
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

          // Reconcile pending intents, but a rejected intent (e.g. a replayed
          // duplicate-key create) must not break the workbench: record a
          // stable recovery message and let the refresh below still rebuild
          // the view from authoritative server rows.
          let resumeFailed = false
          try {
            resumeFailed = (await repository.resumePendingDirectCommandIntents()).failed.length > 0
          } catch {
            resumeFailed = true
          }
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
            error: resumeFailed ? '部分本地操作未能同步，请刷新页面重试。' : null,
          })
        } catch (error) {
          if (sequence !== hydrationSequence || !isCurrent(get(), spaceId)) return
          // A failed reconciliation (e.g. replaying a rejected intent) must
          // surface a stable message, never raw Axios text.
          set({ isLoading: false, error: resolveTaskSpaceMutationError(error).message })
        }
      },

      attachNoteRepository(repository) {
        if (repository === null) {
          // Controlled unbind: before detaching, flush any debounced edit to
          // local persistence/outbox against the repository that captured it,
          // so switching items/spaces or unmounting never drops a dirty Note.
          // On failure the controller keeps the re-pended edit as a retryable
          // draft instead of being discarded.
          const flushing = flushPendingNoteBestEffort('unmount')
          if (!flushing) noteAutosave = null
        } else {
          noteAutosave = null
        }
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
          // Recover a durable failed-flush draft (survived reload / space
          // rebinding / logout).  retryDraft re-applies it through the NEW
          // repository and clears it on success; on failure it stays durable.
          const recovered = await repository.retryDraft(workItemId)
          if (get().selectedWorkItemId !== workItemId) return
          set({
            selectedNote: recovered ?? selectedNote,
            noteConflict: recovered ? null : noteConflict,
            error: null,
          })
        } catch (error) {
          set({ error: resolveTaskSpaceNoteError(error).message })
        }
      },

      updateNoteDocument(document) {
        const current = get().selectedNote
        if (!current) throw new Error('work_item_note_not_loaded')
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        const now = canonicalNow()
        const nextRevision = current.localRevision + 1
        const operationId = crypto.randomUUID()
        // Synchronously persist a lightweight durable draft BEFORE the debounce
        // flush, so a hard reload inside the 800ms window still recovers the
        // edit on the next load (see note-draft-store).  This is best-effort
        // and never touches the note row or outbox semantics; a successful
        // saveLocal clears the draft.
        try {
          repository.persistDraft({
            workItemId: current.workItemId,
            expectedLocalRevision: current.localRevision,
            document,
            operationId,
            now,
          })
        } catch {
          // draft persistence is best-effort; the in-memory autosave remains
        }
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
          operationId,
          now,
          repository,
        })
      },

      async flushNote(reason) {
        try {
          await noteAutosave?.flush(reason)
        } catch (error) {
          set({ error: resolveTaskSpaceNoteError(error).message })
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
          set({ error: resolveTaskSpaceNoteError(error).message })
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
          set({ error: resolveTaskSpaceNoteError(error).message })
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
          set({ error: resolveTaskSpaceNoteError(error).message })
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
          set({ error: resolveTaskSpaceMutationError(error).message })
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

      async createRoot(input = {}) {
        beginMutation('__root__', 'work_item_root_creation_in_flight')
        const repository = get().repository
        const state = get()
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!state.selectedProjectId) throw new Error('task_space_project_not_selected')
          // The repository already supports parentId=null; this is the explicit
          // root-item entry for an empty project.
          const created = await repository.createWorkItem({
            projectId: state.selectedProjectId,
            title: input.title?.trim() || 'New work item',
            description: input.description ?? null,
            parentId: null,
            typeDefinitionId: input.typeDefinitionId ?? definitionId(state.definitions, 'types'),
            statusDefinitionId: input.statusDefinitionId ?? definitionId(state.definitions, 'statuses'),
            priority: input.priority ?? null,
          })
          set((current) => ({
            workItems: [...current.workItems, created],
            selectedWorkItemId: created.id,
            selectedLevel2WorkItemId: created.depth === 2 ? created.id : current.selectedLevel2WorkItemId,
            error: null,
            mutationError: null,
          }))
          return created
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: '__root__', code: mapped.code } })
          throw error
        } finally {
          endMutation('__root__')
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

      async moveWorkItem(workItemId, newParentId) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        const state = get()
        const item = state.workItems.find((candidate) => candidate.id === workItemId)
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!item) throw new Error('work_item_not_loaded')
          // child_rank is never client-supplied online: the server assigns the
          // authoritative append-only rank for the target parent.
          const moved = await repository.moveWorkItem({
            projectId: item.projectId,
            workItemId,
            newParentId,
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

      // D5 Y: converge the label set idempotently; stale CAS surfaces a
      // stable version_conflict for manual retry (never a silent merge).
      async toggleWorkItemLabel(workItemId: string, labelId: string, add: boolean) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const updated = add
            ? await repository.addWorkItemLabels({ workItemId, labelIds: [labelId] })
            : await repository.removeWorkItemLabel({ workItemId, labelId })
          set((state) => ({
            workItems: state.workItems.map((item) => item.id === updated.id ? updated : item),
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

      reset() {
        hydrationSequence += 1
        mutationGuards.clear()
        // Flush any debounced edit before clearing so logout/reset never drops
        // a dirty Note.  The page-level before-switch listener already flushed
        // this while the space DB was still open; on failure the controller
        // keeps the re-pended edit as a retryable draft.
        const flushing = flushPendingNoteBestEffort('logout')
        if (!flushing) noteAutosave = null
        set(initialState())
      },
    }
  }, { name: 'task-space-store' }),
)
