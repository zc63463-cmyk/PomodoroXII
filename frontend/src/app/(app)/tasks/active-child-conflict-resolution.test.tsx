/**
 * ★ 2026-09-11 缺陷回归锁定：「父项带未完成子项」冲突弹窗的静默空转。
 *
 * 背景：空间自定义 status_definitions **可以合法地**不含 cancelled /
 * completed 类目（用户自建空间可能没有「已取消」状态，也可能有但缺
 * 「已完成」）。旧实现里两个主按钮的 handler 直接
 * `if (!statusId) return` —— 用户点下去毫无反应、没有任何反馈。
 *
 * 本文件从页面入口（注入 definitions + 触发真实 active_child_conflict
 * 冲突流）锁定修复后的行为：
 * - 缺类目 → 两个按钮 disabled + 中文原因可见，且点击不产生任何 mutation；
 * - 类目齐全 → 取消 / 迁移两条解决方案照旧执行（成功路径回归保护）。
 */
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
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

// 重子组件只保留接线：本文件锁定的是「页面 handler + 真实冲突弹窗」的反馈行为。
vi.mock('@/components/task-space/project-rail', () => ({ ProjectRail: () => null }))
vi.mock('@/components/task-space/launch-session-button', () => ({ LaunchSessionButton: () => null }))
vi.mock('@/components/task-space/work-item-relations-card', () => ({ WorkItemRelationsCard: () => null }))
vi.mock('@/components/task-space/blocker-ack-modal', () => ({ BlockerAckModal: () => null }))
vi.mock('@/components/task-space/waiting-resume-hint', () => ({ WaitingResumeHint: () => null }))
vi.mock('@/components/task-space/work-item-tree', () => ({ WorkItemTree: () => null }))
vi.mock('@/components/task-space/work-item-note-editor', () => ({ WorkItemNoteEditor: () => null }))
vi.mock('@/components/task-space/work-item-detail', () => ({
  WorkItemDetail: (props: { onTransition?: (statusDefinitionId: string) => unknown }) => createElement(
    'button',
    {
      type: 'button',
      'data-testid': 'complete-parent-trigger',
      onClick: () => { void props.onTransition?.('status-done') },
    },
    'complete-parent',
  ),
}))

import TasksPage from './page'

const item = (id: string, overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
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

const parent = item('l2', { parentId: 'l1' })
const children = [item('l3a', { depth: 3, parentId: 'l2' }), item('l3b', { depth: 3, parentId: 'l2' })]
const relocationTarget = item('l2-other', { parentId: 'l1', childRank: 1 })

/** 构造空间定义；省略的类目即「该空间没有这个类目的状态」（合法空间状态）。 */
const definitionsWithout = (...missingCategories: string[]): TaskSpaceDefinitions => ({
  statuses: [
    { id: 'status-open', category: 'in_progress', name: '进行中' },
    { id: 'status-cancelled', category: 'cancelled', name: '已取消' },
    { id: 'status-completed', category: 'completed', name: '已完成' },
  ].filter((entry) => !missingCategories.includes(entry.category)),
  types: [],
  labels: [],
})

const activeChildConflictError = (childIds: string[]): Error => Object.assign(
  new Error('Request failed with status code 409'),
  {
    isAxiosError: true,
    response: {
      status: 409,
      data: {
        code: 'active_child_conflict',
        message: 'rejected: active_child_conflict',
        retryable: false,
        request_id: 'req-1',
        details: { work_item_ids: childIds },
      },
    },
  },
)

const repositoryWith = (overrides: Partial<TaskSpaceRepositoryLike> = {}): TaskSpaceRepositoryLike => ({
  transitionWorkItem: vi.fn(),
  moveWorkItem: vi.fn(),
  listRelations: vi.fn().mockResolvedValue({ blockers: [], blocking: [] }),
  listBlockedMap: vi.fn().mockResolvedValue({ items: {} }),
  ...overrides,
} as unknown as TaskSpaceRepositoryLike)

const seedConflictScenario = (
  repository: TaskSpaceRepositoryLike,
  definitions: TaskSpaceDefinitions,
) => {
  useTaskSpaceStore.setState({
    spaceId: 'space-a',
    workItems: [parent, ...children, relocationTarget],
    definitions,
    selectedWorkItemId: 'l2',
    selectedProjectId: null,
    repository,
    isLoading: false,
    error: null,
    mutationError: null,
    relations: [],
  })
}

/** 渲染页面 → 触发父项完成 → 后端以 active_child_conflict 拒绝 → 弹窗出现。 */
const openConflictDialog = async () => {
  render(createElement(TasksPage))
  fireEvent.click(screen.getByTestId('complete-parent-trigger'))
  await waitFor(() => expect(document.querySelector('[data-active-child-conflict]')).not.toBeNull())
}

const conflictDialogIsOpen = () => document.querySelector('[data-active-child-conflict]') !== null

/**
 * 等待某个解决动作按钮真正可用后再点击。
 * 弹窗的迁移目标（select 的 value）在 mount 后的 effect 里初始化，整套并发跑
 * 时可能在「弹窗已出现但按钮仍 disabled」的短暂窗口内派发 click，被 jsdom
 * 按 disabled 语义抑制 —— 这不是产品缺陷，但会让测试假红。
 */
const waitForEnabledResolutionButton = async (label: string) => {
  await waitFor(
    () => expect(screen.getByText(label).closest('button')).not.toBeDisabled(),
    { timeout: 3000 },
  )
  return screen.getByText(label).closest('button')!
}

describe('TasksPage active-child conflict resolution feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTaskSpaceStore.getState().reset()
    // spaceId 非空且 spaceDBManager 未切换到该空间：页面只挂事件监听，不会 reset 注入的 store。
    useSpaceStore.setState({ currentSpaceId: 'space-a' })
  })

  it('缺少 cancelled/completed 类目：两个按钮禁用并展示中文原因，点击不产生任何 mutation', async () => {
    const transitionWorkItem = vi.fn().mockRejectedValue(activeChildConflictError(['l3a', 'l3b']))
    const moveWorkItem = vi.fn()
    seedConflictScenario(
      repositoryWith({ transitionWorkItem, moveWorkItem }),
      definitionsWithout('cancelled', 'completed'),
    )
    await openConflictDialog()

    // 可读反馈必须出现在弹窗里 —— 旧实现是静默 return，用户看不到任何东西。
    expect(await screen.findByText('当前空间缺少「已取消」与「已完成」类目的状态，无法执行此操作。')).toBeInTheDocument()
    expect(screen.getByText('当前空间缺少「已完成」类目的状态，无法执行此操作。')).toBeInTheDocument()

    const cancelButton = screen.getByText('取消未完成三级并完成').closest('button')
    const moveButton = screen.getByText('迁移并完成').closest('button')
    expect(cancelButton).toBeDisabled()
    expect(moveButton).toBeDisabled()

    // 对禁用按钮的点击不得产生副作用（不伪造回退状态、不调用仓储）。
    transitionWorkItem.mockClear()
    moveWorkItem.mockClear()
    fireEvent.click(cancelButton!)
    fireEvent.click(moveButton!)
    expect(transitionWorkItem).not.toHaveBeenCalled()
    expect(moveWorkItem).not.toHaveBeenCalled()
    expect(conflictDialogIsOpen()).toBe(true)
  })

  it('只缺 completed 类目：取消与迁移两个按钮都禁用并给出原因', async () => {
    seedConflictScenario(
      repositoryWith({ transitionWorkItem: vi.fn().mockRejectedValue(activeChildConflictError(['l3a', 'l3b'])) }),
      definitionsWithout('completed'),
    )
    await openConflictDialog()

    expect(await screen.findByText('当前空间缺少「已完成」类目的状态，无法执行此操作。')).toBeInTheDocument()
    expect(screen.getByText('取消未完成三级并完成').closest('button')).toBeDisabled()
    expect(screen.getByText('迁移并完成').closest('button')).toBeDisabled()
  })

  it('只缺 cancelled 类目：取消按钮禁用并给出原因，迁移路径不受影响', async () => {
    seedConflictScenario(
      repositoryWith({ transitionWorkItem: vi.fn().mockRejectedValue(activeChildConflictError(['l3a', 'l3b'])) }),
      definitionsWithout('cancelled'),
    )
    await openConflictDialog()

    expect(await screen.findByText('当前空间缺少「已取消」类目的状态，无法执行此操作。')).toBeInTheDocument()
    expect(screen.getByText('取消未完成三级并完成').closest('button')).toBeDisabled()
    // completed 类目仍在 → 迁移路径不受缺「已取消」影响。
    expect(await waitForEnabledResolutionButton('迁移并完成')).not.toBeDisabled()
  })

  it('类目齐全：取消未完成子级并完成父项照旧执行（成功路径）', async () => {
    const transitionWorkItem = vi.fn()
      .mockRejectedValueOnce(activeChildConflictError(['l3a', 'l3b']))
      .mockImplementation(async ({ workItemId }: { workItemId: string }) => item(workItemId, { version: 2 }))
    seedConflictScenario(repositoryWith({ transitionWorkItem }), definitionsWithout())
    await openConflictDialog()

    fireEvent.click(await waitForEnabledResolutionButton('取消未完成三级并完成'))

    // 第 1 次是触发弹窗的父项完成尝试；随后是 2 个子级 + 1 次父项完成。
    await waitFor(() => expect(transitionWorkItem).toHaveBeenCalledTimes(4))
    expect(transitionWorkItem).toHaveBeenNthCalledWith(2, { workItemId: 'l3a', statusDefinitionId: 'status-cancelled' })
    expect(transitionWorkItem).toHaveBeenNthCalledWith(3, { workItemId: 'l3b', statusDefinitionId: 'status-cancelled' })
    expect(transitionWorkItem).toHaveBeenNthCalledWith(4, { workItemId: 'l2', statusDefinitionId: 'status-completed' })
    await waitFor(() => expect(conflictDialogIsOpen()).toBe(false))
  })

  it('类目齐全：迁移未完成子级并完成父项照旧执行（成功路径）', async () => {
    const transitionWorkItem = vi.fn()
      .mockRejectedValueOnce(activeChildConflictError(['l3a', 'l3b']))
      .mockImplementation(async ({ workItemId }: { workItemId: string }) => item(workItemId, { version: 2 }))
    const moveWorkItem = vi.fn().mockImplementation(
      async ({ workItemId }: { workItemId: string }) => item(workItemId, { parentId: 'l2-other', depth: 3, version: 2 }),
    )
    seedConflictScenario(repositoryWith({ transitionWorkItem, moveWorkItem }), definitionsWithout())
    await openConflictDialog()

    fireEvent.click(await waitForEnabledResolutionButton('迁移并完成'))

    await waitFor(() => expect(moveWorkItem).toHaveBeenCalledTimes(2))
    expect(moveWorkItem).toHaveBeenNthCalledWith(1, { projectId: 'project-1', workItemId: 'l3a', newParentId: 'l2-other' })
    expect(moveWorkItem).toHaveBeenNthCalledWith(2, { projectId: 'project-1', workItemId: 'l3b', newParentId: 'l2-other' })
    expect(transitionWorkItem).toHaveBeenCalledWith({ workItemId: 'l2', statusDefinitionId: 'status-completed' })
    await waitFor(() => expect(conflictDialogIsOpen()).toBe(false))
  })
})
