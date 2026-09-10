import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'

vi.mock('lucide-react', () => ({}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) =>
    createElement('button', props, children as never),
}))
import { BlockerAckModal } from './blocker-ack-modal'

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

describe('BlockerAckModal', () => {
  it('renders nothing while closed or without a work item', () => {
    const { rerender } = render(createElement(BlockerAckModal, {
      open: false, workItem: item('l2'), blockers: [],
    }))
    expect(document.querySelector('[data-blocker-ack]')).toBeNull()
    rerender(createElement(BlockerAckModal, {
      open: true, workItem: null, blockers: [],
    }))
    expect(document.querySelector('[data-blocker-ack]')).toBeNull()
  })

  it('lists every unfinished upstream blocker', () => {
    render(createElement(BlockerAckModal, {
      open: true,
      workItem: item('l2'),
      blockers: [item('up1'), item('up2')],
    }))
    const list = document.querySelector('[data-blocker-list]')
    expect(list?.textContent).toContain('RM-up1 Item up1')
    expect(list?.textContent).toContain('RM-up2 Item up2')
    expect(screen.getByText(/建议先完成上游工作/)).toBeInTheDocument()
  })

  it('asks the user to acknowledge before forcing a start', () => {
    const onProceed = vi.fn()
    render(createElement(BlockerAckModal, {
      open: true, workItem: item('l2'), blockers: [item('up1')], onProceed,
    }))
    fireEvent.click(screen.getByText('强制继续'))
    expect(onProceed).toHaveBeenCalledTimes(1)
  })

  it('routes the cancel path back to the upstream work', () => {
    const onCancel = vi.fn()
    render(createElement(BlockerAckModal, {
      open: true, workItem: item('l2'), blockers: [item('up1')], onCancel,
    }))
    fireEvent.click(screen.getByText('返回处理上游'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when no blocker row has hydrated yet', () => {
    render(createElement(BlockerAckModal, {
      open: true, workItem: item('l2'), blockers: [],
    }))
    expect(screen.getByText('存在未完成的依赖项')).toBeInTheDocument()
  })
})
