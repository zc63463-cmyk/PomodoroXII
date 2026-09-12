import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'
import {
  WORK_ITEM_PRIORITY_VALUES,
  type TaskSpaceDefinitions,
} from '@/lib/contracts/task-space'
import { ActiveChildConflictError } from '@/lib/task-space/active-child-conflict'

vi.mock('lucide-react', () => ({}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))
import { WorkItemDetail } from './work-item-detail'

const item = (overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id: 'l1',
  projectId: 'project-1',
  displayKey: 'RM-l1',
  title: 'Original title',
  description: 'Original description',
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: 'medium',
  parentId: null,
  childRank: 0,
  depth: 1,
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

const definitions: TaskSpaceDefinitions = {
  statuses: [
    { id: 'status-open', label: 'Open', category: 'in_progress' },
    { id: 'status-done', label: 'Done', category: 'completed' },
  ],
  types: [{ id: 'type-task', label: 'Task' }],
  labels: [],
}

describe('WorkItemDetail', () => {
  it('shows an empty state when nothing is selected', () => {
    render(createElement(WorkItemDetail, {
      workItem: null,
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(screen.getByText('在左侧选择一个工作项')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('renders fields from the store post-image with stable labels', () => {
    render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(screen.getByRole('heading', { name: 'Original title' })).toBeInTheDocument()
    expect(screen.getByLabelText('标题')).toHaveValue('Original title')
    expect(screen.getByLabelText('描述')).toHaveValue('Original description')
    expect(screen.getByLabelText('优先级')).toHaveValue('medium')
    expect(screen.getByLabelText('状态')).toHaveValue('status-open')
  })

  it('submits only supported fields through onUpdate with the server version', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      onUpdate,
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Edited' } })
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        title: 'Edited',
        description: 'Original description',
        priority: 'high',
      })
    })
  })

  // ★ 2026-09-11：优先级从自由文本改为受限选择 —— 表单只能产出规范英文值，
  // 中文只做展示，绝不可能把「高」写进业务载荷（那会撞 DB CHECK 报 500）。
  it('offers exactly the canonical priority domain with Chinese labels', () => {
    render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    const select = screen.getByLabelText('优先级')
    expect(select.tagName).toBe('SELECT')
    const options = Array.from((select as HTMLSelectElement).options)
    // 选项值 = 共享常量（与后端 contracts 同源），没有任何自由文本输入。
    expect(WORK_ITEM_PRIORITY_VALUES).toEqual(['low', 'medium', 'high', 'urgent'])
    expect(options.map((option) => option.value)).toEqual(['', ...WORK_ITEM_PRIORITY_VALUES])
    expect(options.map((option) => option.textContent)).toEqual(['未设置', '低', '中', '高', '紧急'])
  })

  it('maps the empty choice to null and canonical values verbatim', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemDetail, {
      workItem: item({ priority: 'urgent' }),
      definitions,
      onUpdate,
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        title: 'Original title',
        description: 'Original description',
        priority: null,
      })
    })
  })

  it('disables inputs and actions while a mutation for this item is pending', () => {
    render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      pendingMutations: { l1: true },
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(screen.getByLabelText('标题')).toBeDisabled()
    expect(screen.getByLabelText('描述')).toBeDisabled()
    expect(screen.getByLabelText('优先级')).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled()
    expect(screen.getByLabelText('状态')).toBeDisabled()
    expect(screen.getByLabelText('父任务')).toBeDisabled()
  })

  it('keeps the draft and shows a stable alert on failure without leaking axios text', async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('Request failed with status code 409'))
    render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      error: '该项目项已被其他操作更新，请刷新后重试。',
      mutationError: { targetId: 'l1', code: 'version_conflict' },
      onUpdate,
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Draft kept' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('该项目项已被其他操作更新，请刷新后重试。')
    expect(screen.getByLabelText('标题')).toHaveValue('Draft kept')
    expect(screen.queryByText('Request failed with status code 409')).toBeNull()
  })

  it('calls onTransition with the chosen status and reflects the server status', async () => {
    const onTransition = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      onUpdate: vi.fn(),
      onTransition,
      onMove: vi.fn(),
    }))
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'status-done' } })
    await waitFor(() => {
      expect(onTransition).toHaveBeenCalledWith('status-done')
    })

    rerender(createElement(WorkItemDetail, {
      workItem: item({ statusDefinitionId: 'status-done', version: 2 }),
      definitions,
      onUpdate: vi.fn(),
      onTransition,
      onMove: vi.fn(),
    }))
    expect(screen.getByLabelText('状态')).toHaveValue('status-done')
  })

  it('calls onMove with a parent from the same project only', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      availableParents: [
        item({ id: 'l2', displayKey: 'RM-l2', title: 'Parent B', depth: 1 }),
        item({ id: 'l3', displayKey: 'RM-l3', title: 'Parent C', depth: 2 }),
      ],
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove,
    }))
    fireEvent.change(screen.getByLabelText('父任务'), { target: { value: 'l2' } })
    await waitFor(() => {
      expect(onMove).toHaveBeenCalledWith('l2')
    })
  })

  it('disables editing controls for a soft-deleted item', () => {
    render(createElement(WorkItemDetail, {
      workItem: item({ archivedAt: '2026-08-01T00:00:00.000Z' }),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(screen.getByLabelText('标题')).toBeDisabled()
    expect(screen.getByLabelText('描述')).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled()
    expect(screen.getByLabelText('状态')).toBeDisabled()
    expect(screen.getByLabelText('父任务')).toBeDisabled()
  })

  it('adopts the server post-image after a successful update', async () => {
    const { rerender } = render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      onUpdate: vi.fn().mockResolvedValue(undefined),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'New title' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    rerender(createElement(WorkItemDetail, {
      workItem: item({ title: 'New title', version: 2 }),
      definitions,
      onUpdate: vi.fn().mockResolvedValue(undefined),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(screen.getByLabelText('标题')).toHaveValue('New title')
    expect(screen.getByRole('heading', { name: 'New title' })).toBeInTheDocument()
  })

  it('offers a trash action for a live item and never for an archived one', async () => {
    const onTrash = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
      onTrash,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Move work item to trash' }))
    await waitFor(() => expect(onTrash).toHaveBeenCalledTimes(1))

    rerender(createElement(WorkItemDetail, {
      workItem: item({ archivedAt: '2026-08-01T00:00:00.000Z' }),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
      onTrash,
      onRestore: vi.fn(),
    }))
    expect(screen.queryByRole('button', { name: 'Move work item to trash' })).toBeNull()
  })

  it('shows the recycle-bin banner and a restore action for an archived item', async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemDetail, {
      workItem: item({ archivedAt: '2026-08-01T00:00:00.000Z' }),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
      onRestore,
    }))
    expect(screen.getByText('该工作项已在回收站中。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore work item' }))
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
  })

  it('lets a structured active-child conflict bubble up to the page', async () => {
    const onTransition = vi.fn().mockRejectedValue(
      new ActiveChildConflictError('l2', ['l3a', 'l3b']),
    )
    let caught: unknown = null
    render(createElement(WorkItemDetail, {
      workItem: item({ depth: 2, statusDefinitionId: 'status-open' }),
      definitions,
      onUpdate: vi.fn(),
      onTransition: (statusDefinitionId: string) => Promise.resolve(onTransition(statusDefinitionId)).catch((error: unknown) => { caught = error }),
      onMove: vi.fn(),
    }))
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'status-done' } })

    await waitFor(() => expect(caught).toBeInstanceOf(ActiveChildConflictError))
    expect(caught).toMatchObject({ workItemId: 'l2', conflictChildIds: ['l3a', 'l3b'] })
  })

  it('still swallows ordinary transition failures', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (event: Event) => unhandled.push((event as PromiseRejectionEvent).reason)
    window.addEventListener('unhandledrejection', onUnhandled)
    const onTransition = vi.fn().mockRejectedValue(new Error('version_conflict'))
    render(createElement(WorkItemDetail, {
      workItem: item({ statusDefinitionId: 'status-open' }),
      definitions,
      onUpdate: vi.fn(),
      onTransition,
      onMove: vi.fn(),
    }))
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'status-done' } })

    await waitFor(() => expect(onTransition).toHaveBeenCalledWith('status-done'))
    // Let the microtask queue drain so a swallowed rejection would surface.
    await new Promise((resolve) => setTimeout(resolve, 0))
    window.removeEventListener('unhandledrejection', onUnhandled)
    expect(unhandled).toHaveLength(0)
  })

  it('surfaces the effort review for level-2 items and hides it for containers', () => {
    const { rerender } = render(createElement(WorkItemDetail, {
      workItem: item({ depth: 2, effortActualSeconds: 3600, effortEstimateUpperSeconds: 7200 }),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(document.querySelector('[data-effort-status="normal"]')).not.toBeNull()
    expect(screen.getByText('投入复核')).toBeInTheDocument()

    rerender(createElement(WorkItemDetail, {
      workItem: item({ depth: 1, effortActualSeconds: 3600, effortEstimateUpperSeconds: 7200 }),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(document.querySelector('[data-effort-status]')).toBeNull()
  })

  it('keeps the save action disabled until the draft actually differs', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemDetail, {
      workItem: item(),
      definitions,
      onUpdate,
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    const save = screen.getByRole('button', { name: '保存更改' })
    // 未改动：按钮不可用，也不显示「未保存」提示。
    expect(save).toBeDisabled()
    expect(document.querySelector('[data-dirty-hint]')).toBeNull()

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Changed' } })
    expect(save).toBeEnabled()
    expect(document.querySelector('[data-dirty-hint]')).not.toBeNull()

    fireEvent.click(save)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
  })

  it('renders the effort in human units with the estimate when present', () => {
    render(createElement(WorkItemDetail, {
      workItem: item({
        depth: 1,
        effortActualSeconds: 3660,
        effortEstimateLowerSeconds: 3600,
        effortEstimateUpperSeconds: 7200,
      }),
      definitions,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(screen.getByText(/1 小时 1 分钟/)).toBeInTheDocument()
    expect(screen.getByText(/估算 1 小时 – 2 小时/)).toBeInTheDocument()
    expect(screen.queryByText(/0s actual/)).toBeNull()
  })

  it('warns about unfinished children before the completion guard fires', () => {
    render(createElement(WorkItemDetail, {
      workItem: item({ depth: 2 }),
      definitions,
      openChildCount: 3,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    const hint = document.querySelector('[data-open-children-hint]')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toContain('还有 3 个未完成的子项')
    expect(hint?.textContent).toContain('标记「已完成」前需要先处理')
  })

  it('states the child count without the completion rule for containers', () => {
    render(createElement(WorkItemDetail, {
      workItem: item({ depth: 1 }),
      definitions,
      openChildCount: 2,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    const hint = document.querySelector('[data-open-children-hint]')
    expect(hint?.textContent).toBe('包含 2 个未完成的子项。')
  })

  it('hides the child hint when there are no open children', () => {
    render(createElement(WorkItemDetail, {
      workItem: item({ depth: 2 }),
      definitions,
      openChildCount: 0,
      onUpdate: vi.fn(),
      onTransition: vi.fn(),
      onMove: vi.fn(),
    }))
    expect(document.querySelector('[data-open-children-hint]')).toBeNull()
  })
})
