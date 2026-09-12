import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'
import type { CachedRelation } from '@/lib/contracts/task-space'
import { selectBlockedMap, useTaskSpaceStore, type TaskSpaceRepositoryLike } from './task-space-store'

const workItem = (id: string, parentId: string | null, depth: 1 | 2 | 3, statusDefinitionId = 'status-open'): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId,
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

const edge = (
  fromWorkItemId: string,
  toWorkItemId: string,
  relationType: CachedRelation['relationType'] = 'depends_on',
  resolution: CachedRelation['resolution'] = null,
): CachedRelation => ({
  id: `rel_${fromWorkItemId}_${toWorkItemId}`,
  fromWorkItemId,
  toWorkItemId,
  relationType,
  // ★ D2 / ADR-0004：确认两列（默认未确认）。
  resolution,
  resolvedAt: resolution === null ? null : '2026-07-15T09:00:00.000Z',
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

function repositoryFixture(overrides: Partial<TaskSpaceRepositoryLike> = {}): TaskSpaceRepositoryLike {
  return {
    readCachedOverview: vi.fn().mockResolvedValue({ projects: [], workItems: [], definitions: null }),
    refreshOverview: vi.fn().mockResolvedValue({ projects: [], workItems: [], definitions: { statuses: [], types: [], labels: [] } }),
    loadTree: vi.fn().mockResolvedValue({ cached: [], remote: [] }),
    createProject: vi.fn(),
    createWorkItem: vi.fn(),
    updateWorkItem: vi.fn(),
    moveWorkItem: vi.fn(),
    transitionWorkItem: vi.fn(),
    trashWorkItem: vi.fn(),
    restoreWorkItem: vi.fn(),
    listRelations: vi.fn().mockResolvedValue({ blockers: [], blocking: [] }),
    listBlockedMap: vi.fn().mockResolvedValue({ items: {} }),
    createRelation: vi.fn().mockResolvedValue(edge('l2', 'up1')),
    removeRelation: vi.fn().mockResolvedValue(edge('l2', 'up1')),
    // ★ D2 / ADR-0004：解除确认（默认回一个已确认行）。
    resolveRelation: vi.fn().mockResolvedValue(edge('l2', 'up1', 'depends_on', 'confirmed_not_required')),
    addWorkItemLabels: vi.fn(),
    removeWorkItemLabel: vi.fn(),
    createLabel: vi.fn(),
    updateLabel: vi.fn(),
    archiveLabel: vi.fn(),
    resumePendingDirectCommandIntents: vi.fn().mockResolvedValue({ failed: [] }),
    ...overrides,
  } as unknown as TaskSpaceRepositoryLike
}

describe('task-space store: dependency domain', () => {
  beforeEach(() => useTaskSpaceStore.getState().reset())

  it('loadRelations replaces only the selected item edges', async () => {
    const repository = repositoryFixture({
      listRelations: vi.fn().mockResolvedValue({
        blockers: [{ relation: { ...edge('l2', 'up1'), spaceId: 'space-a' }, workItem: { id: 'up1', displayKey: 'RM-up1', projectId: 'p1', title: 'Up', statusDefinitionId: 'status-open' } }],
        blocking: [],
      }),
    })
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a', selectedWorkItemId: 'l2',
      relations: [edge('other', 'up9')],
    })

    await useTaskSpaceStore.getState().loadRelations('l2')

    const ids = useTaskSpaceStore.getState().relations.map((row) => row.id)
    expect(ids).toContain('rel_l2_up1')
    // The unrelated cached edge survives the reload.
    expect(ids).toContain('rel_other_up9')
  })

  it('createRelation adopts the server row and clears the error', async () => {
    const repository = repositoryFixture()
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a' })

    await useTaskSpaceStore.getState().createRelation({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    })

    expect(repository.createRelation).toHaveBeenCalledWith({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    })
    expect(useTaskSpaceStore.getState().relations).toHaveLength(1)
  })

  it('removeRelation drops the local edge', async () => {
    const repository = repositoryFixture()
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a', relations: [edge('l2', 'up1')] })

    await useTaskSpaceStore.getState().removeRelation({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    })

    expect(repository.removeRelation).toHaveBeenCalled()
    expect(useTaskSpaceStore.getState().relations).toHaveLength(0)
  })

  it('resolveRelation replaces the edge with the confirmed row（store 重算为准）', async () => {
    const repository = repositoryFixture()
    useTaskSpaceStore.setState({
      repository, spaceId: 'space-a',
      relations: [edge('l2', 'up1'), edge('other', 'up9')],
    })

    await useTaskSpaceStore.getState().resolveRelation({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    })

    expect(repository.resolveRelation).toHaveBeenCalledWith({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    })
    const rows = useTaskSpaceStore.getState().relations
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === 'rel_l2_up1')?.resolution)
      .toBe('confirmed_not_required')
    // 无关边不受影响。
    expect(rows.find((row) => row.id === 'rel_other_up9')?.resolution).toBeNull()
    expect(useTaskSpaceStore.getState().error).toBeNull()
  })

  it('surfaces a stable cycle message without leaking transport text', async () => {
    const repository = repositoryFixture({
      createRelation: vi.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with status code 409'), {
          isAxiosError: true,
          response: {
            status: 409,
            data: { code: 'cycle_detected', message: 'cycle', retryable: false, details: {} },
          },
        }),
      ),
    })
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a' })

    await expect(useTaskSpaceStore.getState().createRelation({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    })).rejects.toBeTruthy()

    expect(useTaskSpaceStore.getState().mutationError)
      .toEqual({ targetId: 'l2', code: 'cycle_detected' })
    expect(useTaskSpaceStore.getState().error).toMatch(/循环依赖/)
  })

  it('loadBlockedMap stores the derived projection', async () => {
    const repository = repositoryFixture({
      listBlockedMap: vi.fn().mockResolvedValue({
        items: { l2: { blockedByDependency: true, isBlocked: true } },
      }),
    })
    useTaskSpaceStore.setState({ repository, spaceId: 'space-a' })

    await useTaskSpaceStore.getState().loadBlockedMap('project-1')

    expect(useTaskSpaceStore.getState().blockedMap).toEqual({
      l2: { blockedByDependency: true, isBlocked: true },
    })
  })
})

describe('selectBlockedMap', () => {
  it('requires every upstream to close before unblocking (AND semantics)', () => {
    const items = [
      workItem('root', null, 1),
      workItem('l2', 'root', 2),
      workItem('a', 'root', 2, 'status-open'),
      workItem('b', 'root', 2, 'status-open'),
    ]
    const relations = [edge('l2', 'a'), edge('l2', 'b')]

    const allOpen = selectBlockedMap(items, relations, {
      a: 'in_progress', b: 'not_started',
    })
    expect(allOpen.l2).toEqual({ blockedByDependency: true, isBlocked: true })

    const oneClosed = selectBlockedMap(items, relations, {
      a: 'completed', b: 'in_progress',
    })
    expect(oneClosed.l2.blockedByDependency).toBe(true)

    // ★ D2（ADR-0004）：cancelled 未确认 = broken_requires_resolution → 仍阻塞。
    const cancelledUnconfirmed = selectBlockedMap(items, relations, {
      a: 'completed', b: 'cancelled',
    })
    expect(cancelledUnconfirmed.l2.blockedByDependency).toBe(true)

    // 确认「不再需要」后才解除。
    const bothClosed = selectBlockedMap(
      items,
      [edge('l2', 'a'), edge('l2', 'b', 'depends_on', 'confirmed_not_required')],
      { a: 'completed', b: 'cancelled' },
    )
    expect(bothClosed.l2).toBeUndefined()
  })

  it('treats an edge whose work item has not hydrated as blocking', () => {
    const items = [workItem('root', null, 1), workItem('l2', 'root', 2)]
    const result = selectBlockedMap(items, [edge('l2', 'ghost')], {})
    expect(result.l2).toEqual({ blockedByDependency: true, isBlocked: true })
  })

  it('never flags a level-1 container as blocked', () => {
    const items = [workItem('root', null, 1)]
    // A container still carries the blockedByDependency fact, but the
    // aggregated isBlocked flag is only defined at level 2.
    expect(selectBlockedMap(items, [edge('root', 'up')], {})).toEqual({
      root: { blockedByDependency: true, isBlocked: false },
    })
  })
})
