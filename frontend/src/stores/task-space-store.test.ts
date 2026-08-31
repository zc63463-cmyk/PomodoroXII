import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedProject, CachedWorkItem } from '@/types'
import type { CachedWorkItemNote, WorkItemNoteConflictRow } from '@/types'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { resolveTaskSpaceNoteError, selectMoveCandidates, useTaskSpaceStore, type TaskSpaceNoteRepositoryLike, type TaskSpaceRepositoryLike } from './task-space-store'

const workItem = (id: string, parentId: string | null, depth: 1 | 2 | 3): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: null,
  parentId,
  childRank: 0,
  depth,
  completionWindowStart: null,
  completionWindowEnd: null,
  reviewPoint: null,
  hardDeadline: null,
  effortEstimateLowerSeconds: null,
  effortEstimateUpperSeconds: null,
  effortActualSeconds: 0,
  confidence: null,
  completedAt: null,
  cancelledAt: null,
  archivedAt: null,
  markedAsAttention: false,
  labelIds: [],
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

const project = (id = 'project-1'): CachedProject => ({
  id,
  key: 'RM',
  name: 'Roadmap',
  description: null,
  nextWorkItemNumber: 2,
  rank: 0,
  archivedAt: null,
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

function repositoryFixture(overrides: Partial<TaskSpaceRepositoryLike> = {}): TaskSpaceRepositoryLike {
  return {
    readCachedOverview: vi.fn().mockResolvedValue({
      projects: [project()],
      workItems: [workItem('l1', null, 1)],
      definitions: null,
    }),
    refreshOverview: vi.fn().mockResolvedValue({
      projects: [project()],
      workItems: [workItem('l1', null, 1), workItem('l2', 'l1', 2)],
      definitions: { statuses: [], types: [], labels: [] },
    }),
    loadTree: vi.fn().mockResolvedValue({
      cached: [workItem('l1', null, 1)],
      remote: [workItem('l1', null, 1), workItem('l2', 'l1', 2)],
    }),
    createProject: vi.fn().mockResolvedValue(project('project-2')),
    createWorkItem: vi.fn().mockResolvedValue(workItem('new', 'l2', 3)),
    updateWorkItem: vi.fn().mockResolvedValue(workItem('l1', null, 1)),
    moveWorkItem: vi.fn().mockResolvedValue(workItem('l3', 'l1', 2)),
    transitionWorkItem: vi.fn().mockResolvedValue(workItem('l1', null, 1)),
    addWorkItemLabels: vi.fn().mockResolvedValue(workItem('l1', null, 1)),
    removeWorkItemLabel: vi.fn().mockResolvedValue(workItem('l1', null, 1)),
    createLabel: vi.fn().mockResolvedValue({ id: 'label-1', name: 'Focus', color: null, archivedAt: null, version: 1, createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z' }),
    updateLabel: vi.fn().mockResolvedValue({ id: 'label-1', name: 'Renamed', color: null, archivedAt: null, version: 2, createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z' }),
    archiveLabel: vi.fn().mockResolvedValue({ id: 'label-1', name: 'Focus', color: null, archivedAt: '2026-07-15T08:00:00.000Z', version: 2, createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z' }),
    resumePendingDirectCommandIntents: vi.fn().mockResolvedValue({ failed: [] }),
    ...overrides,
  }
}

const noteDocument = (text: string): WorkItemNoteDocument => ({
  contentVersion: 1,
  blocks: [{ type: 'paragraph', blockId: 'paragraph-1', text }],
})

const note = (text = 'Cached', localRevision = 0): CachedWorkItemNote => ({
  noteId: 'note-1',
  workItemId: 'l2',
  document: noteDocument(text),
  version: 3,
  localRevision,
  syncState: 'clean',
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

const conflict = (): WorkItemNoteConflictRow => ({
  spaceId: 'space-a',
  workItemId: 'l2',
  noteId: 'note-1',
  localDocument: noteDocument('Local'),
  localRevision: 2,
  baseVersion: 3,
  remoteDocument: noteDocument('Remote'),
  remoteVersion: 4,
  detectedAt: '2026-07-15T08:04:00.000Z',
})

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function axiosError(status: number, code: string): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { detail: { code, retryable: false, details: {} } } },
  })
}

function noteRepositoryFixture(overrides: Partial<TaskSpaceNoteRepositoryLike> = {}): TaskSpaceNoteRepositoryLike {
  const current = note()
  return {
    read: vi.fn().mockResolvedValue(current),
    saveLocal: vi.fn().mockImplementation(async (input) => ({
      ...current,
      document: input.document,
      localRevision: input.expectedLocalRevision + 1,
      syncState: 'dirty',
      updatedAt: input.now,
    })),
    dispatchReplace: vi.fn().mockResolvedValue(undefined),
    resolveReloadRemote: vi.fn().mockResolvedValue(undefined),
    resolveOverwriteLocal: vi.fn().mockResolvedValue(undefined),
    readConflict: vi.fn().mockResolvedValue(null),
    retryDraft: vi.fn().mockResolvedValue(null),
    persistDraft: vi.fn(),
    ...overrides,
  }
}

describe('task-space-store projection', () => {
  beforeEach(() => useTaskSpaceStore.getState().reset())

  it('shows cached rows first and replaces them with parsed remote rows', async () => {
    type RefreshResult = Awaited<ReturnType<TaskSpaceRepositoryLike['refreshOverview']>>
    let resolveRefresh: ((value: RefreshResult) => void) | undefined
    const refreshOverview = () => new Promise<RefreshResult>((resolve) => {
      resolveRefresh = resolve
    })
    const repository = repositoryFixture({
      refreshOverview,
    })
    const promise = useTaskSpaceStore.getState().hydrate('space-a', repository)

    await vi.waitFor(() => {
      expect(useTaskSpaceStore.getState().workItems.map((item) => item.id)).toEqual(['l1'])
    })
    resolveRefresh?.({
      projects: [project()],
      workItems: [workItem('l1', null, 1), workItem('l2', 'l1', 2)],
      definitions: { statuses: [], types: [], labels: [] },
    })
    await promise

    expect(useTaskSpaceStore.getState().workItems.map((item) => item.id)).toEqual(['l1', 'l2'])
    expect(useTaskSpaceStore.getState().isLoading).toBe(false)
  })

  it('maps a failed reconciliation to a stable message without leaking axios text', async () => {
    const conflict = axiosError(409, 'version_conflict')
    const repository = repositoryFixture({
      resumePendingDirectCommandIntents: vi.fn().mockRejectedValue(conflict),
    })
    await useTaskSpaceStore.getState().hydrate('space-a', repository)

    const state = useTaskSpaceStore.getState()
    expect(state.error).not.toMatch(/Request failed/)
    expect(state.error).not.toBeNull()
    // The cached rows are still projected into the store.
    expect(state.workItems.length).toBeGreaterThan(0)
  })

  it('reports terminalized reconciliation conflicts without replaying them', async () => {
    const repository = repositoryFixture({
      resumePendingDirectCommandIntents: vi.fn().mockResolvedValue({
        failed: [{ operationId: 'op-rejected', code: 'project_key_conflict' }],
      }),
    })

    await useTaskSpaceStore.getState().hydrate('space-a', repository)

    expect(useTaskSpaceStore.getState().error).toBe('部分本地操作未能同步，请刷新页面重试。')
    expect(repository.resumePendingDirectCommandIntents).toHaveBeenCalledTimes(1)
  })

  it('selecting a level-3 item preserves its level-2 parent for Session launch', () => {
    useTaskSpaceStore.setState({
      workItems: [workItem('l1', null, 1), workItem('l2', 'l1', 2), workItem('l3', 'l2', 3)],
    })

    useTaskSpaceStore.getState().selectWorkItem('l3')

    expect(useTaskSpaceStore.getState()).toMatchObject({
      selectedWorkItemId: 'l3',
      selectedLevel2WorkItemId: 'l2',
    })
  })

  it('loads the selected project tree through the repository', async () => {
    const repository = repositoryFixture()
    useTaskSpaceStore.setState({ repository })

    await useTaskSpaceStore.getState().selectProject('project-1')

    expect(repository.loadTree).toHaveBeenCalledWith('project-1')
    expect(useTaskSpaceStore.getState().selectedProjectId).toBe('project-1')
    expect(useTaskSpaceStore.getState().workItems.map((item) => item.id)).toEqual(['l1', 'l2'])
  })

  it('loads a Note, saves edits through autosave, and dispatches after a forced flush', async () => {
    const repository = repositoryFixture()
    const noteRepository = noteRepositoryFixture()
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a', selectedWorkItemId: 'l2' })
    useTaskSpaceStore.getState().attachNoteRepository(noteRepository)

    await useTaskSpaceStore.getState().loadNote('l2')
    expect(useTaskSpaceStore.getState().selectedNote).toMatchObject({ noteId: 'note-1', localRevision: 0 })

    useTaskSpaceStore.getState().updateNoteDocument(noteDocument('Edited'))
    await useTaskSpaceStore.getState().flushNote('blur')
    expect(noteRepository.saveLocal).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'l2',
      expectedLocalRevision: 0,
      document: noteDocument('Edited'),
      operationId: expect.any(String),
      now: expect.any(String),
    }))
    expect(useTaskSpaceStore.getState().selectedNote?.document).toEqual(noteDocument('Edited'))

    await useTaskSpaceStore.getState().dispatchNote('l2')
    expect(noteRepository.dispatchReplace).toHaveBeenCalledWith('l2')
  })

  it('persists a lightweight durable draft synchronously on edit (before the debounce flush)', async () => {
    const repository = repositoryFixture()
    const noteRepository = noteRepositoryFixture()
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a', selectedWorkItemId: 'l2' })
    useTaskSpaceStore.getState().attachNoteRepository(noteRepository)

    await useTaskSpaceStore.getState().loadNote('l2')
    useTaskSpaceStore.getState().updateNoteDocument(noteDocument('Edited'))
    expect(noteRepository.persistDraft).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'l2',
      expectedLocalRevision: 0,
      document: noteDocument('Edited'),
      operationId: expect.any(String),
      now: expect.any(String),
    }))
  })

  it('hydrates a conflict and exposes only repository-owned resolution actions', async () => {
    const repository = repositoryFixture()
    const noteRepository = noteRepositoryFixture({ readConflict: vi.fn().mockResolvedValue(conflict()) })
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a', selectedWorkItemId: 'l2' })
    useTaskSpaceStore.getState().attachNoteRepository(noteRepository)

    await useTaskSpaceStore.getState().loadNote('l2')
    expect(useTaskSpaceStore.getState().noteConflict).toMatchObject({ localRevision: 2, remoteVersion: 4 })
    await useTaskSpaceStore.getState().resolveReloadRemoteNote('l2')
    expect(noteRepository.resolveReloadRemote).toHaveBeenCalledWith('l2')
    await useTaskSpaceStore.getState().resolveOverwriteLocalNote('l2')
    expect(noteRepository.resolveOverwriteLocal).toHaveBeenCalledWith('l2')
  })

  it('does not let an older save response replace a newer local edit', async () => {
    let resolveFirst: ((value: CachedWorkItemNote) => void) | undefined
    const noteRepository = noteRepositoryFixture({
      saveLocal: vi.fn()
        .mockImplementationOnce(() => new Promise<CachedWorkItemNote>((resolve) => { resolveFirst = resolve }))
        .mockImplementation(async (input) => ({
          ...note(),
          document: input.document,
          localRevision: input.expectedLocalRevision + 1,
          syncState: 'dirty',
          updatedAt: input.now,
        })),
    })
    useTaskSpaceStore.setState({ spaceId: 'space-a', selectedWorkItemId: 'l2' })
    useTaskSpaceStore.getState().attachNoteRepository(noteRepository)
    await useTaskSpaceStore.getState().loadNote('l2')

    useTaskSpaceStore.getState().updateNoteDocument(noteDocument('First'))
    const firstFlush = useTaskSpaceStore.getState().flushNote('blur')
    await vi.waitFor(() => expect(noteRepository.saveLocal).toHaveBeenCalledOnce())
    useTaskSpaceStore.getState().updateNoteDocument(noteDocument('Second'))
    resolveFirst?.({ ...note('First', 1), syncState: 'dirty' })
    await firstFlush

    expect(useTaskSpaceStore.getState().selectedNote?.document).toEqual(noteDocument('Second'))
  })

  it('flushes a pending debounced edit before detaching the note repository', async () => {
    const repository = repositoryFixture()
    const noteRepository = noteRepositoryFixture()
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a', selectedWorkItemId: 'l2' })
    useTaskSpaceStore.getState().attachNoteRepository(noteRepository)
    await useTaskSpaceStore.getState().loadNote('l2')

    // Edit within the debounce window, then detach (space switch/unmount).
    useTaskSpaceStore.getState().updateNoteDocument(noteDocument('Dirty'))
    useTaskSpaceStore.getState().attachNoteRepository(null)

    // The pending edit must be persisted to local storage before unbinding.
    await vi.waitFor(() => expect(noteRepository.saveLocal).toHaveBeenCalled())
    expect(noteRepository.saveLocal).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'l2',
      document: noteDocument('Dirty'),
    }))
  })

  it('retains a retryable draft and never leaks raw text when the unbind flush fails', async () => {
    const repository = repositoryFixture()
    const saveLocal = vi.fn()
      .mockRejectedValueOnce(new Error('QuotaExceededError'))
      .mockImplementation(async (input: { document: WorkItemNoteDocument }) => ({
        ...note(), document: input.document, localRevision: 1, syncState: 'dirty',
      }))
    const noteRepository = noteRepositoryFixture({ saveLocal })
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a', selectedWorkItemId: 'l2' })
    useTaskSpaceStore.getState().attachNoteRepository(noteRepository)
    await useTaskSpaceStore.getState().loadNote('l2')

    useTaskSpaceStore.getState().updateNoteDocument(noteDocument('Dirty'))
    // Detach (space switch/unmount): the controlled flush fails once, but the
    // controller retains the re-pended edit as a retryable draft.
    useTaskSpaceStore.getState().attachNoteRepository(null)
    await vi.waitFor(() => expect(saveLocal).toHaveBeenCalledTimes(1))

    // A later flush retries the retained draft against its captured repository.
    await useTaskSpaceStore.getState().flushNote('blur')
    expect(saveLocal).toHaveBeenCalledTimes(2)
    expect(useTaskSpaceStore.getState().error ?? '').not.toMatch(/QuotaExceededError/)
  })

  it('maps note-autosave failures to closed messages without leaking error text', () => {
    expect(resolveTaskSpaceNoteError(new Error('QuotaExceededError')).message).not.toMatch(/Quota/)
    expect(resolveTaskSpaceNoteError(new Error('version_conflict')).message).toMatch(/其他设备|刷新/)
    expect(resolveTaskSpaceNoteError({ response: { status: 409, data: { detail: { code: 'version_conflict' } } } }).message).toMatch(/其他设备|刷新/)
  })

  it('recovers a durable failed-flush draft through a NEW repository on load (space switch back / re-login)', async () => {
    const repository = repositoryFixture()
    const recovered = note('Recovered', 2)
    // A brand-new repository instance (no shared closure with the one that
    // failed the flush) re-applies the durable draft via retryDraft.
    const freshNoteRepository = noteRepositoryFixture({
      retryDraft: vi.fn().mockResolvedValue(recovered),
    })
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a', selectedWorkItemId: 'l2' })
    useTaskSpaceStore.getState().attachNoteRepository(freshNoteRepository)

    await useTaskSpaceStore.getState().loadNote('l2')

    expect(freshNoteRepository.retryDraft).toHaveBeenCalledWith('l2')
    expect(useTaskSpaceStore.getState().selectedNote).toMatchObject({
      noteId: 'note-1',
      localRevision: 2,
      document: noteDocument('Recovered'),
    })
    expect(useTaskSpaceStore.getState().noteConflict).toBeNull()
    expect(useTaskSpaceStore.getState().error).toBeNull()
  })

  it('has no Note Item promotion action or WorkItem-reference projection', () => {
    const files = [
      'src/stores/task-space-store.ts',
      'src/services/task-space-api.ts',
      'src/lib/task-space/work-item-note-repository.ts',
      'src/components/task-space/work-item-note-editor.tsx',
      'src/components/task-space/note-block-editor.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(/promoteListItem|promoteNoteItem|expectedSourceWorkItemVersion/)
      expect(source).not.toMatch(/work_item_ref|titleSnapshot/)
      expect(source).not.toMatch(/contentEditable|ordered_list|unordered_list|workItemReference|Markdown/)
    }
  })
})

describe('task-space-store mutation lifecycle', () => {
  beforeEach(() => useTaskSpaceStore.getState().reset())

  it('guards against same-tick double submit for the same work item', async () => {
    const pending = deferred<CachedWorkItem>()
    const moveWorkItem = vi.fn(() => pending.promise)
    const repository = repositoryFixture({ moveWorkItem })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', selectedProjectId: 'project-1',
      workItems: [workItem('l1', null, 1)],
    })

    const first = useTaskSpaceStore.getState().moveWorkItem('l1', 'l2')
    expect(useTaskSpaceStore.getState().pendingMutations).toMatchObject({ l1: true })
    await expect(
      useTaskSpaceStore.getState().moveWorkItem('l1', 'l2'),
    ).rejects.toThrow('work_item_mutation_in_flight')
    expect(moveWorkItem).toHaveBeenCalledTimes(1)

    pending.resolve({ ...workItem('l1', null, 1), parentId: 'l2', version: 2 })
    await first
    expect(useTaskSpaceStore.getState().pendingMutations).toEqual({})
  })

  it('updates the store from the server post-image on success', async () => {
    const moved = { ...workItem('l1', null, 1), parentId: 'l2', childRank: 3, version: 2 }
    const moveWorkItem = vi.fn().mockResolvedValue(moved)
    const repository = repositoryFixture({ moveWorkItem })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', workItems: [workItem('l1', null, 1)],
    })

    await useTaskSpaceStore.getState().moveWorkItem('l1', 'l2')
    expect(useTaskSpaceStore.getState().workItems.find((item) => item.id === 'l1')).toEqual(moved)
    expect(useTaskSpaceStore.getState().error).toBeNull()
    expect(useTaskSpaceStore.getState().mutationError).toBeNull()
  })

  it('preserves the prior item and maps a stable code on failure', async () => {
    const moveWorkItem = vi.fn().mockRejectedValue(axiosError(409, 'version_conflict'))
    const repository = repositoryFixture({ moveWorkItem })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', workItems: [workItem('l1', null, 1)],
    })

    await expect(useTaskSpaceStore.getState().moveWorkItem('l1', 'l2')).rejects.toThrow()
    expect(useTaskSpaceStore.getState().workItems.find((item) => item.id === 'l1')).toMatchObject({
      version: 1, parentId: null,
    })
    expect(useTaskSpaceStore.getState().mutationError).toEqual({ targetId: 'l1', code: 'version_conflict' })
    expect(useTaskSpaceStore.getState().error).not.toMatch(/Request failed/)
    expect(useTaskSpaceStore.getState().error).not.toBeNull()
  })

  it('does not block a mutation of item B while item A is pending', async () => {
    const pendingA = deferred<CachedWorkItem>()
    const moveWorkItem = vi.fn((args: { workItemId: string }) => (
      args.workItemId === 'l1'
        ? pendingA.promise
        : Promise.resolve({ ...workItem('l2', 'l1', 2), version: 2 })
    ))
    const repository = repositoryFixture({ moveWorkItem })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', workItems: [workItem('l1', null, 1), workItem('l2', 'l1', 2)],
    })

    const first = useTaskSpaceStore.getState().moveWorkItem('l1', 'l2')
    await useTaskSpaceStore.getState().moveWorkItem('l2', null)
    expect(moveWorkItem).toHaveBeenCalledTimes(2)
    pendingA.resolve({ ...workItem('l1', null, 1), version: 2 })
    await first
  })

  it('guards double create-child submission under the same parent', async () => {
    const pending = deferred<CachedWorkItem>()
    const createWorkItem = vi.fn(() => pending.promise)
    const repository = repositoryFixture({ createWorkItem })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', selectedProjectId: 'project-1',
      workItems: [workItem('l2', 'l1', 2)],
    })

    const first = useTaskSpaceStore.getState().createChild('l2', { title: 'New' })
    expect(useTaskSpaceStore.getState().pendingMutations).toMatchObject({ l2: true })
    await expect(
      useTaskSpaceStore.getState().createChild('l2', { title: 'New' }),
    ).rejects.toThrow('work_item_child_creation_in_flight')
    expect(createWorkItem).toHaveBeenCalledTimes(1)

    pending.resolve({ ...workItem('l3', 'l2', 3) })
    await first
  })

  it('creates a root work item for an empty project (parentId=null)', async () => {
    const created = workItem('root-new', null, 1)
    const createWorkItem = vi.fn().mockResolvedValue(created)
    const repository = repositoryFixture({ createWorkItem })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', selectedProjectId: 'project-1', workItems: [],
    })

    const result = await useTaskSpaceStore.getState().createRoot({ title: 'New root' })

    expect(createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', title: 'New root', parentId: null,
    }))
    expect(result).toEqual(created)
    expect(useTaskSpaceStore.getState().workItems).toEqual([created])
    expect(useTaskSpaceStore.getState().selectedWorkItemId).toBe('root-new')
  })

  it('maps a failed root creation to a stable code without leaking axios text', async () => {
    const repository = repositoryFixture({
      createWorkItem: vi.fn().mockRejectedValue(axiosError(409, 'version_conflict')),
    })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', selectedProjectId: 'project-1',
    })

    await expect(useTaskSpaceStore.getState().createRoot()).rejects.toThrow()
    expect(useTaskSpaceStore.getState().mutationError).toEqual({ targetId: '__root__', code: 'version_conflict' })
    expect(useTaskSpaceStore.getState().error).not.toMatch(/Request failed/)
  })

  it('maps transition failure to a stable code and keeps the previous status', async () => {
    const transitionWorkItem = vi.fn().mockRejectedValue(axiosError(409, 'idempotency_conflict'))
    const repository = repositoryFixture({ transitionWorkItem })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', workItems: [workItem('l1', null, 1)],
    })

    await expect(
      useTaskSpaceStore.getState().transitionWorkItem('l1', 'status-done'),
    ).rejects.toThrow()
    expect(useTaskSpaceStore.getState().workItems.find((item) => item.id === 'l1')).toMatchObject({
      version: 1, statusDefinitionId: 'status-open',
    })
    expect(useTaskSpaceStore.getState().mutationError).toEqual({ targetId: 'l1', code: 'idempotency_conflict' })
  })
})

describe('selectMoveCandidates', () => {
  it('excludes the selected item and every descendant from move parents', () => {
    const items = [
      workItem('l1', null, 1),
      workItem('l2', 'l1', 2),
      workItem('l3', 'l2', 3),
      workItem('other', null, 1),
    ]
    // Moving l2: its descendant l3 must not be offered; l1 and other remain.
    expect(selectMoveCandidates(items, 'l2').map((item) => item.id).sort()).toEqual(['l1', 'other'])
    // Moving l1 would push its l1→l2→l3 subtree to depth 4 under ANY parent,
    // so no candidate may be offered (the backend rejects with
    // invalid_work_item_tree).
    expect(selectMoveCandidates(items, 'l1')).toEqual([])
    // No selection yields no candidates.
    expect(selectMoveCandidates(items, null)).toEqual([])
  })

  it('still applies the depth < 3 rule to remaining candidates', () => {
    const items = [
      workItem('root', null, 1),
      workItem('mid', 'root', 2),
      workItem('leaf', 'mid', 3),
    ]
    // A depth-3 item can never be a new parent for anyone.
    expect(selectMoveCandidates(items, 'leaf').map((item) => item.id)).toEqual(['root', 'mid'])
    expect(selectMoveCandidates(items, 'mid').map((item) => item.id)).toEqual(['root'])
  })

  it('never offers a sibling L2 as a new parent for an L2 carrying an L3 child', () => {
    const items = [
      workItem('root', null, 1),
      workItem('l2-a', 'root', 2),
      workItem('l2-b', 'root', 2),
      workItem('l3', 'l2-a', 3),
    ]
    // Moving l2-a (subtreeMaxDepth=3) under l2-b would create depth 4:
    // 2 + 1 + (3 - 2) = 4 > 3.  Only root (depth 1) fits.
    expect(selectMoveCandidates(items, 'l2-a').map((item) => item.id)).toEqual(['root'])
    // A leaf L3 may still move under an L1 root (a legal move); its current
    // parent l2-a remains offered as a no-op target.
    expect(selectMoveCandidates(items, 'l3').map((item) => item.id).sort()).toEqual(['l2-a', 'l2-b', 'root'])
  })

  it('offers legal three-level moves only', () => {
    const items = [
      workItem('root-a', null, 1),
      workItem('root-b', null, 1),
      workItem('l2', 'root-a', 2),
      workItem('l3', 'l2', 3),
    ]
    // Moving the leaf l3 under root-b is legal (2 <= 3); under root-a too;
    // its current parent l2 is offered as a no-op target.
    expect(selectMoveCandidates(items, 'l3').map((item) => item.id).sort()).toEqual(['l2', 'root-a', 'root-b'])
    // Moving l2 (with its leaf l3, subtreeMaxDepth=3) under another root is
    // legal (1 + 1 + (3-2) = 3); root-a is l2's current parent (a no-op move,
    // still within 3 levels) and remains offered like the backend allows.
    expect(selectMoveCandidates(items, 'l2').map((item) => item.id).sort()).toEqual(['root-a', 'root-b'])
  })
})
