import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QuickNoteEditorToolbar } from './quick-note-editor-toolbar'

describe('QuickNoteEditorToolbar', () => {
  it('renders all quick-edit buttons with accessible labels', () => {
    render(createElement(QuickNoteEditorToolbar, { onInsert: vi.fn() }))
    for (const label of ['标签', '标题', '粗体', '斜体', '删除线', '无序列表', '有序列表', '任务列表', '引用', '代码块', '链接']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('emits the markdown insert for a wrap-mode button', () => {
    const onInsert = vi.fn()
    render(createElement(QuickNoteEditorToolbar, { onInsert }))
    fireEvent.click(screen.getByRole('button', { name: '粗体' }))
    expect(onInsert).toHaveBeenCalledWith({
      before: '**', after: '**', placeholder: '粗体', mode: 'wrap',
    })
  })

  it('emits the line-prefix insert for a list button', () => {
    const onInsert = vi.fn()
    render(createElement(QuickNoteEditorToolbar, { onInsert }))
    fireEvent.click(screen.getByRole('button', { name: '任务列表' }))
    expect(onInsert).toHaveBeenCalledWith({
      before: '- [ ] ', placeholder: '任务', mode: 'line',
    })
  })
})
