import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionLauncher } from './session-launcher'

const items = [
  { id: 'l1', depth: 1, parentId: null, title: 'Project goal', displayKey: 'P-1', childRank: 0 },
  { id: 'l2', depth: 2, parentId: 'l1', title: 'Ship feature', displayKey: 'P-2', childRank: 0 },
  { id: 'l3-a', depth: 3, parentId: 'l2', title: 'Verify output', displayKey: 'P-3', childRank: 0 },
  { id: 'l3-b', depth: 3, parentId: 'l2', title: 'Record evidence', displayKey: 'P-4', childRank: 1 },
] as never

describe('SessionLauncher', () => {
  it('maps a level-3 start to its level-2 parent and freezes the selected level 3', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l3-a', onStart: start }))

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3-a'],
    }))
  })

  it('allows a level-2 Session with no level-3 plan', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ level3WorkItemIds: [] }))
  })

  it('requires selecting or creating a level-2 child for a level-1 start', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l1', onStart: vi.fn() }))

    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeDisabled()
    expect(screen.getByLabelText('Level 2 attribution')).toBeRequired()
  })

  it('rebinds attribution when the selected WorkItem changes after mount', () => {
    const start = vi.fn()
    const view = render(createElement(SessionLauncher, { items, initialWorkItemId: null, onStart: start }))

    view.rerender(createElement(SessionLauncher, { items, initialWorkItemId: 'l3-b', onStart: start }))
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3-b'],
    }))
  })
})
