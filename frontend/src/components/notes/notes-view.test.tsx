import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as noteRepository from '@/lib/notes/note-repository'
import { useNoteStore } from '@/stores/note-store'
import type { Note } from '@/types'
import { NotesView } from './notes-view'

/**
 * 本文件用 **JSX** 编写（而非 createElement），本身就是对
 * vitest JSX transform 的验证 —— 2026-09-02 前项目无该 transform，
 * 组件测试要么写不了，要么得手写 createElement。
 */

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'n1',
    title: '第一篇',
    content: '正文内容',
    summary: '',
    tags: [],
    category: null,
    folder_id: null,
    status: 'active',
    trashed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('NotesView', () => {
  beforeEach(() => {
    useNoteStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])
    vi.spyOn(noteRepository, 'updateNote').mockResolvedValue(makeNote())
    vi.spyOn(noteRepository, 'moveNoteToTrash').mockResolvedValue(makeNote())
  })

  afterEach(cleanup)

  it('空列表时给出引导文案', async () => {
    render(<NotesView />)

    await waitFor(() => {
      expect(screen.getByText(/还没有笔记/)).toBeTruthy()
    })
    expect(screen.getByText(/选择一篇笔记/)).toBeTruthy()
  })

  it('渲染笔记标题，并能在选中后载入编辑器', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待办', content: '买牛奶' }),
    ])

    render(<NotesView />)
    await waitFor(() => screen.getByText('待办'))

    fireEvent.click(screen.getByText('待办'))

    // CodeMirror 不用 placeholder 属性（自行渲染占位提示），
    // 故按 aria-label 定位，并断言其 contenteditable 的内容而非 value。
    await waitFor(() => {
      const editor = screen.getByLabelText('笔记正文')
      expect(editor.textContent).toContain('买牛奶')
    })
  })

  it('删除走软删除，不是 purge', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      makeNote({ id: 'a', title: '待删' }),
    ])
    const trash = vi.spyOn(noteRepository, 'moveNoteToTrash').mockResolvedValue(makeNote())
    const purge = vi.spyOn(noteRepository, 'purgeNote').mockResolvedValue(undefined)

    render(<NotesView />)
    await waitFor(() => screen.getByText('待删'))
    fireEvent.click(screen.getByText('待删'))
    await waitFor(() => screen.getByText('删除'))

    fireEvent.click(screen.getByText('删除'))

    await waitFor(() => {
      expect(trash).toHaveBeenCalledWith('a')
    })
    expect(purge).not.toHaveBeenCalled()
  })
})
