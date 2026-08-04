import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NoteBlock } from '@/lib/contracts/task-space'

vi.mock('lucide-react', () => ({
  ArrowDown: (props: Record<string, unknown>) => createElement('span', props),
  ArrowUp: (props: Record<string, unknown>) => createElement('span', props),
  IndentDecrease: (props: Record<string, unknown>) => createElement('span', props),
  IndentIncrease: (props: Record<string, unknown>) => createElement('span', props),
  Plus: (props: Record<string, unknown>) => createElement('span', props),
  Trash2: (props: Record<string, unknown>) => createElement('span', props),
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))

import { NoteBlockEditor } from './note-block-editor'

describe('NoteBlockEditor', () => {
  it('edits paragraph text with a plain textarea', () => {
    const onChange = vi.fn()
    const block: NoteBlock = { type: 'paragraph', blockId: 'p-1', text: 'Draft' }
    render(createElement(NoteBlockEditor, { block, onChange }))

    const textarea = screen.getByRole('textbox', { name: 'Paragraph text' })
    fireEvent.change(textarea, { target: { value: 'Ready' } })
    expect(onChange).toHaveBeenCalledWith({ ...block, text: 'Ready' })
    expect(textarea.tagName).toBe('TEXTAREA')
  })

  it('edits checklist text and checked state using independent controls', () => {
    const onChange = vi.fn()
    const block: NoteBlock = {
      type: 'checklist',
      blockId: 'c-1',
      items: [{ itemId: 'item-1', text: 'Ship', checked: false, children: [] }],
    }
    render(createElement(NoteBlockEditor, { block, onChange }))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship' }))
    expect(onChange.mock.calls.at(-1)![0].items[0]).toMatchObject({ itemId: 'item-1', checked: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Checklist item item-1' }), { target: { value: 'Ship now' } })
    expect(onChange.mock.calls.at(-1)![0].items[0]).toMatchObject({ itemId: 'item-1', text: 'Ship now' })
    expect(screen.queryByRole('textbox', { name: 'Markdown' })).toBeNull()
  })

  it('adds a schema-valid Checklist item without a blank transient value', () => {
    const onChange = vi.fn()
    const block: NoteBlock = { type: 'checklist', blockId: 'c-1', items: [] }
    render(createElement(NoteBlockEditor, { block, onChange }))

    fireEvent.click(screen.getByRole('button', { name: 'Add checklist item' }))
    expect(onChange.mock.calls.at(-1)![0].items[0]).toMatchObject({
      text: 'New checklist item',
      checked: false,
    })
  })
})
