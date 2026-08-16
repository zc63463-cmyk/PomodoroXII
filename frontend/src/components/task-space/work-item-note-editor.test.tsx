import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'

vi.mock('lucide-react', () => ({
  CheckSquare: (props: Record<string, unknown>) => createElement('span', props),
  IndentDecrease: (props: Record<string, unknown>) => createElement('span', props),
  IndentIncrease: (props: Record<string, unknown>) => createElement('span', props),
  Pilcrow: (props: Record<string, unknown>) => createElement('span', props),
  Plus: (props: Record<string, unknown>) => createElement('span', props),
  Trash2: (props: Record<string, unknown>) => createElement('span', props),
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))

import { WorkItemNoteEditor } from './work-item-note-editor'

const emptyDocument = (): WorkItemNoteDocument => ({ contentVersion: 1, blocks: [] })
const checklistDocument = (checked: boolean): WorkItemNoteDocument => ({
  contentVersion: 1,
  blocks: [{
    type: 'checklist',
    blockId: 'checklist-1',
    items: [{ itemId: 'item-1', text: 'Ship', checked, children: [] }],
  }],
})

describe('WorkItemNoteEditor', () => {
  it('offers only paragraph and Checklist Block commands', () => {
    const onChange = vi.fn()
    render(createElement(WorkItemNoteEditor, {
      document: emptyDocument(),
      onChange,
      conflict: null,
    }))

    for (const name of ['Add paragraph', 'Add checklist']) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
    for (const name of ['Add heading', 'Add ordered list', 'Add unordered list']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add checklist' }))
    expect(onChange.mock.calls.at(-1)![0].blocks[0].type).toBe('checklist')
  })

  it('toggles checklist content without invoking a WorkItem transition', () => {
    const onChange = vi.fn()
    const onTransition = vi.fn()
    render(createElement(WorkItemNoteEditor, {
      document: checklistDocument(false),
      onChange,
      onWorkItemTransition: onTransition,
      conflict: null,
    }))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship' }))
    expect(onChange.mock.calls.at(-1)![0].blocks[0].items[0].checked).toBe(true)
    expect(onTransition).not.toHaveBeenCalled()
  })

  it('exposes no Note Item promotion action', () => {
    render(createElement(WorkItemNoteEditor, {
      document: checklistDocument(false),
      onChange: vi.fn(),
      conflict: null,
    }))

    expect(screen.queryByRole('button', { name: /promote/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /work item/i })).toBeNull()
  })
})
