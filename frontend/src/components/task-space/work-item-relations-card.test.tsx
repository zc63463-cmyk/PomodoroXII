import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedRelation } from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'

vi.mock('lucide-react', () => ({}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) =>
    createElement('button', props, children as never),
}))
import { WorkItemRelationsCard } from './work-item-relations-card'

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

const edge = (
  fromWorkItemId: string,
  toWorkItemId: string,
  relationType: CachedRelation['relationType'] = 'depends_on',
): CachedRelation => ({
  id: `rel_${fromWorkItemId}_${toWorkItemId}`,
  fromWorkItemId,
  toWorkItemId,
  relationType,
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

const definitions = {
  statuses: [{ id: 'status-open', label: 'In progress', category: 'in_progress' }],
}

describe('WorkItemRelationsCard', () => {
  it('renders empty states for both directions', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
    }))
    expect(screen.getByText('暂无上游依赖')).toBeInTheDocument()
    expect(screen.getByText('暂无下游依赖')).toBeInTheDocument()
  })

  it('splits edges into upstream (blockers) and downstream (blocking)', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1'), edge('down1', 'l2')],
    }))
    expect(screen.getByText('up1')).toBeInTheDocument()
    expect(screen.getByText('down1')).toBeInTheDocument()
  })

  it('prefers the server minimal projection for the endpoint name', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      relationSet: {
        blockers: [{
          relation: { ...edge('l2', 'up1'), spaceId: 'space-a' },
          workItem: {
            id: 'up1', displayKey: 'OTHER-7', projectId: 'project-2',
            title: 'Foreign upstream', statusDefinitionId: 'status-open',
          },
        }],
        blocking: [],
      },
      definitions,
    }))
    expect(screen.getByText('OTHER-7 Foreign upstream')).toBeInTheDocument()
    // The status badge comes from the definitions, not from raw ids.
    expect(screen.getByText('In progress')).toBeInTheDocument()
  })

  it('marks non-blocking relation types explicitly', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1', 'relates_to')],
    }))
    expect(screen.getByText('不阻塞')).toBeInTheDocument()
  })

  it('creates an edge through onAdd with the chosen endpoint', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      candidates: [item('cand')],
      onAdd,
    }))
    fireEvent.click(screen.getByText('添加依赖'))
    fireEvent.change(screen.getByLabelText('选择上游工作项'), { target: { value: 'cand' } })
    fireEvent.click(screen.getByText('建立依赖'))

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({
      toWorkItemId: 'cand', relationType: 'depends_on',
    }))
  })

  it('filters candidates by title or display key', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      candidates: [item('alpha'), item('beta')],
      onAdd: vi.fn(),
    }))
    fireEvent.click(screen.getByText('添加依赖'))
    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: 'alp' } })
    const options = screen.getAllByRole('option').map((node) => node.textContent)
    expect(options).toContain('RM-alpha Item alpha')
    expect(options).not.toContain('RM-beta Item beta')
  })

  it('removes an edge through onRemove with the full logical identity', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      onRemove,
    }))
    fireEvent.click(screen.getByRole('button', { name: '解除与 up1 的依赖' }))

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    }))
  })

  it('disables mutation actions for an archived item', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2', { archivedAt: '2026-08-01T00:00:00.000Z' }),
      relations: [edge('l2', 'up1')],
      onAdd: vi.fn(),
      onRemove: vi.fn(),
    }))
    expect(screen.getByText('添加依赖').closest('button')).toBeDisabled()
    expect(screen.getByRole('button', { name: '解除与 up1 的依赖' })).toBeDisabled()
  })

  it('keeps the panel open when a creation fails', async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('cycle_detected'))
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      candidates: [item('cand')],
      onAdd,
    }))
    fireEvent.click(screen.getByText('添加依赖'))
    fireEvent.change(screen.getByLabelText('选择上游工作项'), { target: { value: 'cand' } })
    fireEvent.click(screen.getByText('建立依赖'))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    expect(document.querySelector('[data-add-relation-panel]')).not.toBeNull()
  })
})
