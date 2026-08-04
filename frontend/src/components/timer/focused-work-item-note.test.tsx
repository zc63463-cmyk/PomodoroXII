import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FocusedWorkItemNote } from './focused-work-item-note'

const note = {
  noteId: 'note-a', workItemId: 'wi-a', version: 2, localRevision: 0,
  syncState: 'clean', createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  document: {
    contentVersion: 1,
    blocks: [
      { type: 'paragraph', blockId: 'existing-p', text: 'Read only paragraph' },
      { type: 'checklist', blockId: 'existing-c', items: [{ itemId: 'existing-i', text: 'Read only checklist', checked: false, children: [] }] },
    ],
  },
} as never

describe('FocusedWorkItemNote', () => {
  it('allows Timer WorkItemNote interaction only through paragraph/checklist append', async () => {
    const append = vi.fn()
    render(createElement(FocusedWorkItemNote, { note, spaceId: 'space-a', workItemId: 'wi-a', onAppendBlocks: append }))

    expect(screen.queryByRole('textbox', { name: /existing paragraph/i })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /existing checklist/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Checklist' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New checklist item 1' }), {
      target: { value: 'Verify output' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add child under Verify output' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Child of Verify output' }), {
      target: { value: 'Record evidence' },
    })
    expect(append).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Append checklist' }))
    await waitFor(() => expect(append).toHaveBeenCalledWith('wi-a', [expect.objectContaining({
      type: 'checklist', blockId: expect.any(String),
      items: [expect.objectContaining({
        text: 'Verify output', checked: false,
        children: [expect.objectContaining({ text: 'Record evidence', checked: false })],
      })],
    })], expect.any(String)))
  })

  it('appends a nonempty paragraph only after explicit submit and clears the draft', async () => {
    const append = vi.fn().mockResolvedValue(undefined)
    render(createElement(FocusedWorkItemNote, { note, spaceId: 'space-a', workItemId: 'wi-a', onAppendBlocks: append }))
    const draft = screen.getByRole('textbox', { name: 'New paragraph' })

    expect(screen.getByRole('button', { name: 'Append paragraph' })).toBeDisabled()
    fireEvent.change(draft, { target: { value: 'Investigate retry ordering' } })
    fireEvent.click(screen.getByRole('button', { name: 'Append paragraph' }))

    await waitFor(() => expect(append).toHaveBeenCalledWith('wi-a', [
      expect.objectContaining({ type: 'paragraph', text: 'Investigate retry ordering' }),
    ], expect.any(String)))
    expect(draft).toHaveValue('')
  })

  it('retains the composer draft when append fails', async () => {
    const append = vi.fn().mockRejectedValue(new Error('offline append failed'))
    render(createElement(FocusedWorkItemNote, { note, spaceId: 'space-a', workItemId: 'wi-a', onAppendBlocks: append }))
    const draft = screen.getByRole('textbox', { name: 'New paragraph' })
    fireEvent.change(draft, { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Append paragraph' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('offline append failed')
    expect(draft).toHaveValue('Keep this draft')
  })
})
