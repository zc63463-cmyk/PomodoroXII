import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'

vi.mock('lucide-react', () => ({
  Plus: (props: Record<string, unknown>) => createElement('span', props),
  ChevronRight: (props: Record<string, unknown>) => createElement('span', props),
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))
import { WorkItemTree } from './work-item-tree'

const item = (id: string, title: string, parentId: string | null, depth: 1 | 2 | 3, overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title,
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
  ...overrides,
})

const definitions = {
  statuses: [{ id: 'status-open', label: 'Open', category: 'in_progress' }],
  types: [{ id: 'type-task', label: 'Task' }],
  labels: [],
}

describe('WorkItemTree', () => {
  it('renders semantic levels and exposes only a valid next-level create action', () => {
    const createChild = vi.fn()
    render(createElement(WorkItemTree, {
      items: [
        item('l1', 'L1 Alpha', null, 1),
        item('l2', 'L2 Build', 'l1', 2),
        item('l3', 'L3 Verify', 'l2', 3),
      ],
      selectedId: 'l2',
      onSelect: vi.fn(),
      onCreateChild: createChild,
    }))

    expect(screen.getByRole('treeitem', { name: /L1 Alpha/ })).toHaveAttribute('aria-level', '1')
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toHaveAttribute('aria-level', '2')
    expect(screen.getByRole('treeitem', { name: /L3 Verify/ })).toHaveAttribute('aria-level', '3')
    fireEvent.click(screen.getByRole('button', { name: 'Create child under L2 Build' }))
    expect(createChild).toHaveBeenCalledWith('l2')
    expect(screen.queryByRole('button', { name: 'Create child under L3 Verify' })).toBeNull()
  })

  it('orders siblings by childRank and does not leak old nodes after a data switch', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: [
        item('l2', 'Second', null, 1, { childRank: 1 }),
        item('l1', 'First', null, 1, { childRank: 0 }),
      ],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
    }))
    const labels = screen.getAllByRole('treeitem').map((node) => node.getAttribute('aria-label'))
    expect(labels).toEqual(['RM-l1 First', 'RM-l2 Second'])

    rerender(createElement(WorkItemTree, {
      items: [item('other', 'Other Project', null, 1)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
    }))
    expect(screen.queryByRole('treeitem', { name: /First/ })).toBeNull()
    expect(screen.getByRole('treeitem', { name: /Other Project/ })).toBeInTheDocument()
  })

  it('shows type, status and priority labels on every node', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Labelled', null, 1, { priority: 'high' })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions,
    }))
    const node = screen.getByRole('treeitem', { name: /Labelled/ })
    expect(node).toHaveTextContent('Task')
    expect(node).toHaveTextContent('Open')
    expect(node).toHaveTextContent('high')
  })

  it('renders distinct empty, loading and failure states', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: [], selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
    }))
    expect(screen.getByText('No work items')).toBeInTheDocument()

    rerender(createElement(WorkItemTree, {
      items: [], selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), isLoading: true,
    }))
    expect(screen.getByText('Loading work items')).toBeInTheDocument()
    expect(screen.queryByText('No work items')).toBeNull()

    rerender(createElement(WorkItemTree, {
      items: [], selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
      error: '无法加载工作项，请检查服务连接后重试。',
    }))
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载工作项，请检查服务连接后重试。')
  })

  it('disables the create-child button while that parent has a pending mutation', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Busy', null, 1)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      pendingMutations: { l1: true },
    }))
    expect(screen.getByRole('button', { name: 'Create child under Busy' })).toBeDisabled()
  })

  it('still renders the cached tree when a refresh error occurs with data present', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Cached Row', null, 1)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      error: '部分本地操作未能同步，请刷新后重试。',
    }))
    expect(screen.getByRole('treeitem', { name: /Cached Row/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('WorkItemTree collapse', () => {
  const baseItems = [
    item('l1', 'L1 Alpha', null, 1),
    item('l2', 'L2 Build', 'l1', 2),
  ]

  it('toggles a single branch collapsed and expanded via the chevron', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
    }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse children of L1 Alpha' }))
    expect(screen.queryByRole('treeitem', { name: /L2 Build/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand children of L1 Alpha' }))
      .toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Expand children of L1 Alpha' }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()
    void rerender
  })

  it('honours a collapse/expand signal from the page shortcuts', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
    }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()

    rerender(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
      collapseSignal: { seq: 1, mode: 'collapse' },
    }))
    expect(screen.queryByRole('treeitem', { name: /L2 Build/ })).toBeNull()

    rerender(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
      collapseSignal: { seq: 2, mode: 'expand' },
    }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()
  })
})

describe('WorkItemTree drag & drop move', () => {
  const dragItems = [
    item('l1', 'L1 Alpha', null, 1),
    item('l2a', 'L2 One', 'l1', 2),
    item('l2b', 'L2 Two', 'l1', 2),
  ]

  const rowOf = (name: string): HTMLElement => {
    const li = screen.getByRole('treeitem', { name: new RegExp(name) })
    const row = li.querySelector('div[draggable="true"]')
    if (!row) throw new Error(`no draggable row for ${name}`)
    return row as HTMLElement
  }

  const dragStart = (row: HTMLElement) => fireEvent.dragStart(row, {
    dataTransfer: { setData: vi.fn(), effectAllowed: '' },
  })

  it('moves an item under a valid sibling parent on drop', () => {
    const onMove = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove,
    }))
    dragStart(rowOf('L2 One'))
    const target = rowOf('L2 Two')
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    expect(onMove).toHaveBeenCalledWith('l2a', 'l2b')
  })

  it('moves an item to the top level when dropped on the tree background', () => {
    const onMove = vi.fn()
    const { container } = render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove,
    }))
    dragStart(rowOf('L2 One'))
    const tree = container.querySelector('ul[role="tree"]') as HTMLElement
    fireEvent.dragOver(tree)
    fireEvent.drop(tree)
    expect(onMove).toHaveBeenCalledWith('l2a', null)
  })

  it('never moves onto the dragged item itself or its descendant', () => {
    const onMove = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove,
    }))
    // Self drop: invalid.
    dragStart(rowOf('L1 Alpha'))
    fireEvent.dragOver(rowOf('L1 Alpha'))
    fireEvent.drop(rowOf('L1 Alpha'))
    // Descendant drop: invalid.
    dragStart(rowOf('L1 Alpha'))
    fireEvent.dragOver(rowOf('L2 One'))
    fireEvent.drop(rowOf('L2 One'))
    expect(onMove).not.toHaveBeenCalled()
  })

  it('rejects a drop that would push the subtree past three levels', () => {
    const onMove = vi.fn()
    render(createElement(WorkItemTree, {
      items: [
        item('r1', 'R One', null, 1),
        item('d2', 'Deep Two', 'r1', 2),
        item('l1', 'L1 Alpha', null, 1),
        item('l2a', 'L2 One', 'l1', 2),
        item('l3', 'L3 Leaf', 'l2a', 3),
      ],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      onMove,
    }))
    // L1 Alpha carries a depth-3 leaf (relative depth 2): under Deep Two
    // (depth 2) the subtree would reach depth 5 > 3.
    dragStart(rowOf('L1 Alpha'))
    fireEvent.dragOver(rowOf('Deep Two'))
    fireEvent.drop(rowOf('Deep Two'))
    expect(onMove).not.toHaveBeenCalled()
  })
})
