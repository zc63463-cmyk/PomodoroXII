import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedProject, CachedWorkItem } from '@/types'
import { useTaskSpaceStore, type TaskSpaceRepositoryLike } from './task-space-store'

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
    moveWorkItem: vi.fn().mockResolvedValue(workItem('l3', 'l1', 2)),
    transitionWorkItem: vi.fn().mockResolvedValue(workItem('l1', null, 1)),
    resumePendingDirectCommandIntents: vi.fn().mockResolvedValue(undefined),
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
})
