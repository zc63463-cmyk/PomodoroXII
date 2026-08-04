import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionWorkspace } from './session-workspace'

const session = { sessionId: 'session-a', sessionNote: '', clockState: 'running' } as never
const plans = [
  { id: 'plan-a', workItemId: 'l3-a', titleSnapshot: 'Verify output', currentDuringSession: true, completionDraft: false },
  { id: 'plan-b', workItemId: 'l3-b', titleSnapshot: 'Build output', currentDuringSession: false, completionDraft: false },
] as never
const candidates = [{ id: 'l3-c', title: 'Test output' }] as never

describe('SessionWorkspace', () => {
  it('switches current level 3 without reallocating Session minutes', () => {
    const setCurrent = vi.fn()
    const allocate = vi.fn()
    render(createElement(SessionWorkspace, { session, plans,
      onSetCurrent: setCurrent, onAllocateMinutes: allocate }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Verify output' }))

    expect(setCurrent).toHaveBeenCalledWith('l3-a')
    expect(allocate).not.toHaveBeenCalled()
  })

  it('keeps Session note separate from WorkItemNote', () => {
    const updateSessionNote = vi.fn()
    const updateWorkItemNote = vi.fn()
    render(createElement(SessionWorkspace, { session, plans,
      onUpdateSessionNote: updateSessionNote, onUpdateWorkItemNote: updateWorkItemNote }))

    fireEvent.change(screen.getByLabelText('Session note'), { target: { value: 'Felt focused' } })

    expect(updateSessionNote).toHaveBeenCalledWith('Felt focused')
    expect(updateWorkItemNote).not.toHaveBeenCalled()
  })

  it('exposes current, completion-draft, add, and remove as distinct plan commands', () => {
    const actions = {
      onSetCurrent: vi.fn(), onSetCompletionDraft: vi.fn(),
      onAddPlanItem: vi.fn(), onRemovePlanItem: vi.fn(),
    }
    render(createElement(SessionWorkspace, { session, plans,
      availableLevel3: candidates, ...actions }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Verify output' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Build output complete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Test output to plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Build output from plan' }))

    expect(actions.onSetCurrent).toHaveBeenCalledWith('l3-a')
    expect(actions.onSetCompletionDraft).toHaveBeenCalledWith('plan-b', true)
    expect(actions.onAddPlanItem).toHaveBeenCalledWith('l3-c')
    expect(actions.onRemovePlanItem).toHaveBeenCalledWith('plan-b')
  })

  it('keeps the previous current item when the Note switch flush fails', async () => {
    const setCurrent = vi.fn()
    render(createElement(SessionWorkspace, { session, plans,
      onSetCurrent: setCurrent,
      onSwitchWorkItemNote: vi.fn().mockRejectedValue(new Error('draft_flush_failed')) }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Build output' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('draft_flush_failed')
    expect(setCurrent).not.toHaveBeenCalled()
  })

  it('rolls the composer back when the authoritative current-item write fails', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined)
    const setCurrent = vi.fn().mockRejectedValue(new Error('current_item_conflict'))
    render(createElement(SessionWorkspace, { session, plans,
      onSetCurrent: setCurrent,
      onSwitchWorkItemNote: vi.fn().mockResolvedValue(rollback) }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Build output' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('current_item_conflict')
    expect(rollback).toHaveBeenCalledOnce()
  })
})
