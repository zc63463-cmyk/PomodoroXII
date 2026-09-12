import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedProject, CachedWorkItem } from '@/types'
import { useTaskSpaceStore, type TaskSpaceRepositoryLike } from './task-space-store'

/**
 * 回归（2026-09-11 实测）：服务端「投入物化」经 sync pull 写进本地 Dexie，
 * 但任务页的 workItems 是挂载时 hydrate 的快照 —— 同步不会重读，界面永远
 * 显示旧值（复盘后 52 分钟已进库，任务空间投入仍是 0，只能手动刷新才发现）。
 */

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

const workItem = (
  id: string,
  effortActualSeconds: number,
): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: null,
  parentId: 'l1',
  childRank: 0,
  depth: 2,
  completionWindowStart: null,
  completionWindowEnd: null,
  reviewPoint: null,
  hardDeadline: null,
  effortEstimateLowerSeconds: null,
  effortEstimateUpperSeconds: null,
  effortActualSeconds,
  confidence: null,
  completedAt: null,
  cancelledAt: null,
  archivedAt: null,
  markedAsAttention: false,
  labelIds: [],
  version: 3,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

interface Overview {
  projects: CachedProject[]
  workItems: CachedWorkItem[]
  definitions: { statuses: []; types: []; labels: [] } | null
}

const overview = (
  projects: CachedProject[],
  workItems: CachedWorkItem[],
): Overview => ({
  projects, workItems, definitions: { statuses: [], types: [], labels: [] },
})

/**
 * 缓存与远端返回同一份（测试里只改「缓存」模拟 sync 落表；
 * hydrate 的 refreshOverview 用同一快照，避免把已 hydrate 的状态清空）。
 */
function repositoryFixture(getOverview: () => Overview): TaskSpaceRepositoryLike {
  return {
    readCachedOverview: vi.fn().mockImplementation(async () => getOverview()),
    refreshOverview: vi.fn().mockImplementation(async () => getOverview()),
    resumePendingDirectCommandIntents: vi.fn().mockResolvedValue({ failed: [] }),
  } as unknown as TaskSpaceRepositoryLike
}

describe('task-space-store 同步后刷新', () => {
  beforeEach(() => useTaskSpaceStore.getState().reset())

  it('重读本地缓存：投入更新不再等手动刷新，且保持选中项', async () => {
    let cached = overview([project()], [workItem('l2', 0)])
    const repository = repositoryFixture(() => cached)
    await useTaskSpaceStore.getState().hydrate('space-a', repository)
    useTaskSpaceStore.getState().selectWorkItem('l2')
    expect(useTaskSpaceStore.getState().workItems[0]?.effortActualSeconds).toBe(0)

    // sync pull 把服务端投入（3134 秒）写进本地表；下一次重读应看到它。
    cached = overview([project()], [workItem('l2', 3134)])
    await useTaskSpaceStore.getState().refreshCachedOverview()

    const state = useTaskSpaceStore.getState()
    expect(state.workItems[0]?.effortActualSeconds).toBe(3134)
    // 远端刷新不该把用户从详情面板里踢出来。
    expect(state.selectedWorkItemId).toBe('l2')
    expect(state.selectedProjectId).toBe('project-1')
    // 只读缓存：绝不触发网络刷新（refreshOverview 仅 hydrate 那一次）。
    expect(repository.refreshOverview).toHaveBeenCalledTimes(1)
  })

  it('选中的项目被远端删除时回落到第一个项目', async () => {
    let cached = overview([project('project-1')], [workItem('l2', 0)])
    const repository = repositoryFixture(() => cached)
    await useTaskSpaceStore.getState().hydrate('space-a', repository)
    expect(useTaskSpaceStore.getState().selectedProjectId).toBe('project-1')

    cached = overview([project('project-2')], [])
    await useTaskSpaceStore.getState().refreshCachedOverview()

    expect(useTaskSpaceStore.getState().selectedProjectId).toBe('project-2')
  })

  it('未 hydrate（无 repository）时是 no-op', async () => {
    await expect(useTaskSpaceStore.getState().refreshCachedOverview()).resolves.toBeUndefined()
    expect(useTaskSpaceStore.getState().workItems).toEqual([])
  })
})
