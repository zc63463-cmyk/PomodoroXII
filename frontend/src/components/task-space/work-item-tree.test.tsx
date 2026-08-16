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

const item = (id: string, title: string, parentId: string | null, depth: 1 | 2 | 3): CachedWorkItem => ({
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
})

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
})
