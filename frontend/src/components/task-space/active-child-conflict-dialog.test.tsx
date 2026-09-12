import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'

vi.mock('lucide-react', () => ({}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) =>
    createElement('button', props, children as never),
}))
import { ActiveChildConflictDialog } from './active-child-conflict-dialog'

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
const targets = [item('l2-other', { parentId: 'l1', childRank: 1 })]

function renderDialog(overrides: Partial<Parameters<typeof ActiveChildConflictDialog>[0]> = {}) {
  const props = {
    open: true,
    parentItem: parent,
    conflictChildIds: children.map((child) => child.id),
    availableLevel2Parents: targets,
    conflictChildren: children,
    onClose: vi.fn(),
    onCancelChildrenAndComplete: vi.fn().mockResolvedValue(undefined),
    onMoveChildrenAndComplete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  render(createElement(ActiveChildConflictDialog, props))
  return props
}

describe('ActiveChildConflictDialog', () => {
  it('renders nothing while closed', () => {
    renderDialog({ open: false })
    expect(document.querySelector('[data-active-child-conflict]')).toBeNull()
  })

  it('lists every conflicting child by title', () => {
    renderDialog()
    const list = document.querySelector('[data-conflict-children]')
    expect(list?.textContent).toContain('RM-l3a Item l3a')
    expect(list?.textContent).toContain('RM-l3b Item l3b')
  })

  it('option 1 cancels the children then completes the parent', async () => {
    const props = renderDialog()
    fireEvent.click(screen.getByText('取消未完成三级并完成'))
    await waitFor(() => expect(props.onCancelChildrenAndComplete).toHaveBeenCalledTimes(1))
    expect(props.onMoveChildrenAndComplete).not.toHaveBeenCalled()
  })

  it('option 2 relocates the children to the chosen level-2 parent', async () => {
    const props = renderDialog()
    fireEvent.change(screen.getByLabelText('迁移目标二级工作项'), { target: { value: 'l2-other' } })
    fireEvent.click(screen.getByText('迁移并完成'))
    await waitFor(() => expect(props.onMoveChildrenAndComplete).toHaveBeenCalledWith('l2-other'))
    expect(props.onCancelChildrenAndComplete).not.toHaveBeenCalled()
  })

  it('option 3 keeps the item in progress through the dedicated handler', () => {
    const onKeepActive = vi.fn()
    const props = renderDialog({ onKeepActive })
    fireEvent.click(screen.getByText('放弃完成，保持进行中'))
    expect(onKeepActive).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('option 4 dismisses without touching anything', () => {
    const props = renderDialog()
    fireEvent.click(screen.getByText('返回'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onCancelChildrenAndComplete).not.toHaveBeenCalled()
    expect(props.onMoveChildrenAndComplete).not.toHaveBeenCalled()
  })

  it('disables the relocation action when no destination exists', () => {
    renderDialog({ availableLevel2Parents: [] })
    const button = screen.getByText('迁移并完成').closest('button')
    expect(button).toBeDisabled()
  })

  it('stays open when a resolution fails so another path can be chosen', async () => {
    const onCancelChildrenAndComplete = vi.fn().mockRejectedValue(new Error('version_conflict'))
    renderDialog({ onCancelChildrenAndComplete })
    fireEvent.click(screen.getByText('取消未完成三级并完成'))
    await waitFor(() => expect(onCancelChildrenAndComplete).toHaveBeenCalled())
    expect(document.querySelector('[data-active-child-conflict]')).not.toBeNull()
  })

  // ★ 2026-09-11：空间可以合法地不含 cancelled / completed 类目状态。
  //   此时两个主操作必须「可见地不可用」（按钮禁用 + 中文原因），
  //   而不是点了没反应 —— 旧实现只在 handler 里静默 return。
  it('disables the cancel action and explains why when the space lacks the category', () => {
    renderDialog({
      cancelChildrenUnavailableReason: '当前空间缺少「已取消」类目的状态，无法执行此操作。',
    })
    expect(screen.getByText('当前空间缺少「已取消」类目的状态，无法执行此操作。')).toBeInTheDocument()
    expect(screen.getByText('取消未完成三级并完成').closest('button')).toBeDisabled()
  })

  it('disables the move action and explains why when the space lacks a completed category', () => {
    renderDialog({
      moveChildrenUnavailableReason: '当前空间缺少「已完成」类目的状态，无法执行此操作。',
    })
    expect(screen.getByText('当前空间缺少「已完成」类目的状态，无法执行此操作。')).toBeInTheDocument()
    expect(screen.getByText('迁移并完成').closest('button')).toBeDisabled()
  })

  it('keeps both actions available when no reason is given (success path unchanged)', () => {
    renderDialog()
    expect(screen.getByText('取消未完成三级并完成').closest('button')).not.toBeDisabled()
    expect(screen.getByText('迁移并完成').closest('button')).not.toBeDisabled()
  })
})
