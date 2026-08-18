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
})
