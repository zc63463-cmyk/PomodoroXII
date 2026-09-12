/**
 * ★ 2026-09-12 依赖域合同 §10 端到端回归（B′：前态是**服务端事实**，ADR-0003）。
 *
 * 缺陷原状：前状态没有落库，`WaitingResumeHint` 固定切回 in_progress ——
 * 原本 paused 的项会被一键改成进行中（状态篡改，不是文案瑕疵）。
 *
 * 本文件从**页面入口**锁定修复后的整条链路（wire 读投影 → 页面判据 → 提示组件
 * → 真实迁移调用）：
 * - ① wire 行带前态（paused）→ 一键恢复回到该状态（paused → paused）；
 * - ② 无记录 → 不给一键入口、不自动改状态，用户必须显式选择；
 * - ③ 陈旧/不可用记录（不在定义中 / 已归档 / 终态 / waiting 类目）→ 未命中且不冒充；
 * - ④ 上游未全部完成 → 提示根本不出现（回归保护）。
 *
 * 「本地 Dexie 行带值不消费」在 task-space-repository.test.ts 的读取边界用例里锁定。
 */
import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'
import type { CachedRelation, TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { TaskSpaceRepositoryLike } from '@/stores/task-space-store'
import { useTaskSpaceStore } from '@/stores/task-space-store'
import { useSpaceStore } from '@/stores/space-store'

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) =>
    createElement('button', props, children as never),
}))

// 重子组件只保留接线：本文件锁定的是「页面解析 wire 前态 → 真实提示组件 → 真实迁移调用」。
vi.mock('@/components/task-space/project-rail', () => ({ ProjectRail: () => null }))
vi.mock('@/components/task-space/launch-session-button', () => ({ LaunchSessionButton: () => null }))
vi.mock('@/components/task-space/work-item-relations-card', () => ({ WorkItemRelationsCard: () => null }))
vi.mock('@/components/task-space/blocker-ack-modal', () => ({ BlockerAckModal: () => null }))
vi.mock('@/components/task-space/work-item-tree', () => ({ WorkItemTree: () => null }))
vi.mock('@/components/task-space/work-item-note-editor', () => ({ WorkItemNoteEditor: () => null }))
// 真实 WaitingResumeHint 必须在场 —— 它是本单的被测对象。
vi.mock('@/components/task-space/work-item-detail', () => ({
  WorkItemDetail: (props: { statusHint?: ReactNode }) => createElement(
    'div',
    { 'data-testid': 'work-item-detail' },
    props.statusHint ?? null,
  ),
}))

import TasksPage from './page'

const definitions: TaskSpaceDefinitions = {
  statuses: [
    { id: 'sys-status-not-started', category: 'not_started', name: 'Not started' },
    { id: 'sys-status-in-progress', category: 'in_progress', name: 'In progress' },
    { id: 'sys-status-paused', category: 'paused', name: 'Paused' },
    { id: 'sys-status-waiting', category: 'waiting', name: 'Waiting' },
    { id: 'sys-status-completed', category: 'completed', name: 'Completed' },
    { id: 'sys-status-archived-custom', category: 'paused', name: 'Retired', archived_at: '2026-09-01T00:00:00.000Z' },
  ],
  types: [],
  labels: [],
}

const item = (id: string, overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'sys-status-not-started',
  priority: null,
  parentId: null,
  childRank: 0,
  depth: 2,
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
  ...overrides,
})

/** 二级项（停在 Waiting）依赖一个上游；上游的类目决定提示是否出现。 */
const dependencyEdge = (
  resolution: CachedRelation['resolution'] = null,
): CachedRelation => ({
  id: 'rel_l2_up1',
  fromWorkItemId: 'l2',
  toWorkItemId: 'up1',
  relationType: 'depends_on',
  // ★ D2 / ADR-0004：确认两列（默认未确认）。
  resolution,
  resolvedAt: resolution === null ? null : '2026-07-15T09:00:00.000Z',
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

const repositoryFixture = (overrides: Partial<TaskSpaceRepositoryLike> = {}): TaskSpaceRepositoryLike => ({
  transitionWorkItem: vi.fn().mockResolvedValue(item('l2', { version: 2 })),
  listRelations: vi.fn().mockResolvedValue({
    blockers: [{ relation: dependencyEdge() }],
    blocking: [],
  }),
  listBlockedMap: vi.fn().mockResolvedValue({ items: {} }),
  ...overrides,
} as unknown as TaskSpaceRepositoryLike)

/**
 * 上游类目 = 提示是否出现的开关；被测项固定停在 Waiting。
 * `l2Overrides` 模拟 wire 读投影携带的等待前态（preWaitingStatusDefinitionId）。
 */
const seed = (
  repository: TaskSpaceRepositoryLike,
  upstreamStatus: string,
  l2Overrides: Partial<CachedWorkItem> = {},
) => {
  useTaskSpaceStore.setState({
    spaceId: 'space-a',
    definitions,
    workItems: [
      item('l2', { statusDefinitionId: 'sys-status-waiting', parentId: 'l1', ...l2Overrides }),
      item('up1', { statusDefinitionId: upstreamStatus, projectId: 'project-1' }),
    ],
    selectedWorkItemId: 'l2',
    selectedProjectId: null,
    repository,
    isLoading: false,
    error: null,
    mutationError: null,
    relations: [],
  })
}

const hintText = () => document.querySelector('[data-waiting-resume-hint]')?.textContent ?? null

describe('TasksPage Waiting 恢复目标（服务端前态 B′）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTaskSpaceStore.getState().reset()
    // spaceId 非空且 spaceDBManager 未切换到该空间：页面只挂事件监听，不会 reset 注入的 store。
    useSpaceStore.setState({ currentSpaceId: 'space-a' })
  })

  it('① wire 前态为 paused 时恢复到 paused，而不是 in_progress', async () => {
    const transitionWorkItem = vi.fn().mockResolvedValue(item('l2', { version: 2 }))
    seed(repositoryFixture({ transitionWorkItem }), 'sys-status-completed', {
      preWaitingStatusDefinitionId: 'sys-status-paused',
    })

    render(createElement(TasksPage))

    await waitFor(() => expect(hintText()).toContain('上游依赖已全部完成（1 项）'))
    expect(hintText()).toContain('建议把状态恢复为「Paused」')
    expect(document.querySelector('[data-waiting-resume-target]')?.getAttribute('data-waiting-resume-target')).toBe('sys-status-paused')
    expect(screen.queryByText('恢复为进行中')).toBeNull()

    fireEvent.click(screen.getByText('恢复为Paused'))

    await waitFor(() => expect(transitionWorkItem).toHaveBeenCalledWith({
      workItemId: 'l2', statusDefinitionId: 'sys-status-paused',
    }))
    // 唯一一次写入就是这一次 CAS transition。
    expect(transitionWorkItem).toHaveBeenCalledTimes(1)
  })

  it('② wire 无前态时不自动改状态，用户必须在本页「状态」中显式选择', async () => {
    const transitionWorkItem = vi.fn().mockResolvedValue(item('l2', { version: 2 }))
    seed(repositoryFixture({ transitionWorkItem }), 'sys-status-completed')

    render(createElement(TasksPage))

    await waitFor(() => expect(hintText()).toContain('上游依赖已全部完成（1 项）'))
    expect(hintText()).toContain('没有记录到进入「等待」前的状态')
    expect(hintText()).toContain('自行选择')
    // 绝不默认切 in_progress：没有记录就没有任何一键入口，也不产生任何迁移。
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
    expect(screen.queryByText('恢复为进行中')).toBeNull()
    expect(transitionWorkItem).not.toHaveBeenCalled()
  })

  it('③a 前态 id 不在本空间定义中（已不存在）→ 未命中且不冒充', async () => {
    const transitionWorkItem = vi.fn()
    seed(repositoryFixture({ transitionWorkItem }), 'sys-status-completed', {
      preWaitingStatusDefinitionId: 'sys-status-removed',
    })

    render(createElement(TasksPage))

    await waitFor(() => expect(hintText()).toContain('上游依赖已全部完成（1 项）'))
    expect(hintText()).toContain('自行选择')
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
    expect(document.querySelector('[data-waiting-resume-hint]')?.getAttribute('data-waiting-resume-target')).toBe('unknown')
    expect(transitionWorkItem).not.toHaveBeenCalled()
  })

  it('③b 前态已归档 → 未命中且不冒充', async () => {
    const transitionWorkItem = vi.fn()
    seed(repositoryFixture({ transitionWorkItem }), 'sys-status-completed', {
      preWaitingStatusDefinitionId: 'sys-status-archived-custom',
    })

    render(createElement(TasksPage))

    await waitFor(() => expect(hintText()).toContain('上游依赖已全部完成（1 项）'))
    expect(hintText()).toContain('自行选择')
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
    expect(transitionWorkItem).not.toHaveBeenCalled()
  })

  it('③c 前态为终态（completed）→ 未命中且不冒充', async () => {
    const transitionWorkItem = vi.fn()
    seed(repositoryFixture({ transitionWorkItem }), 'sys-status-completed', {
      preWaitingStatusDefinitionId: 'sys-status-completed',
    })

    render(createElement(TasksPage))

    await waitFor(() => expect(hintText()).toContain('上游依赖已全部完成（1 项）'))
    expect(hintText()).toContain('自行选择')
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
    expect(transitionWorkItem).not.toHaveBeenCalled()
  })

  it('③d 前态为 waiting 类目 → 未命中且不冒充', async () => {
    const transitionWorkItem = vi.fn()
    seed(repositoryFixture({ transitionWorkItem }), 'sys-status-completed', {
      preWaitingStatusDefinitionId: 'sys-status-waiting',
    })

    render(createElement(TasksPage))

    await waitFor(() => expect(hintText()).toContain('上游依赖已全部完成（1 项）'))
    expect(hintText()).toContain('自行选择')
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
    expect(transitionWorkItem).not.toHaveBeenCalled()
  })

  it('④ 上游未全部完成时不出现提示（回归）', async () => {
    const transitionWorkItem = vi.fn()
    seed(repositoryFixture({ transitionWorkItem }), 'sys-status-in-progress', {
      preWaitingStatusDefinitionId: 'sys-status-paused',
    })

    render(createElement(TasksPage))

    // 等页面把本次选中项的边加载完，再断言提示确实缺席。
    await waitFor(() => expect(useTaskSpaceStore.getState().relationsForWorkItemId).toBe('l2'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('[data-waiting-resume-hint]')).toBeNull()
    expect(transitionWorkItem).not.toHaveBeenCalled()
  })
})
