import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { CachedWorkItem } from '@/types'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))

import { LaunchSessionButton } from './launch-session-button'

const item = (overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id: 'l2',
  projectId: 'project-1',
  displayKey: 'RM-2',
  title: 'Ship feature',
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: 'medium',
  parentId: 'l1',
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

describe('LaunchSessionButton', () => {
  beforeEach(() => {
    push.mockClear()
  })

  it('is disabled with a stable accessible name while no WorkItem is selected', () => {
    render(createElement(LaunchSessionButton, { workItem: null }))
    const button = screen.getByRole('button', { name: 'Start focus session' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(push).not.toHaveBeenCalled()
  })

  it('is enabled once a WorkItem is selected and navigates to the timer page', () => {
    const workItem = item()
    render(createElement(LaunchSessionButton, { workItem }))
    const button = screen.getByRole('button', { name: /Start focus session/ })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(push).toHaveBeenCalledWith('/timer')
  })

  it('keeps a stable accessible name that identifies the selected WorkItem', () => {
    render(createElement(LaunchSessionButton, { workItem: item({ displayKey: 'RM-7', title: 'Verify output' }) }))
    expect(screen.getByRole('button', { name: 'Start focus session for RM-7 Verify output' })).not.toBeDisabled()
  })
})
