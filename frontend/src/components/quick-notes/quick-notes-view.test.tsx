import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { QuickNote } from '@/types'

vi.mock('lucide-react', () => ({
  ArchiveRestoreIcon: () =>
    createElement('span', { 'data-testid': 'archive-restore-icon' }),
  PinIcon: () => createElement('span', { 'data-testid': 'pin-icon' }),
  PlusIcon: () => createElement('span', { 'data-testid': 'plus-icon' }),
  SearchIcon: () => createElement('span', { 'data-testid': 'search-icon' }),
  Trash2Icon: () => createElement('span', { 'data-testid': 'trash-icon' }),
  XIcon: () => createElement('span', { 'data-testid': 'x-icon' }),
}))

const toastMock = vi.hoisted(() =>
  Object.assign(
    vi.fn((_message: string, _options?: { action?: { onClick?: () => void } }) => undefined),
    {
      error: vi.fn((_message: string, _options?: { description?: string }) => undefined),
    },
  ),
)

vi.mock('sonner', () => ({
  toast: toastMock,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => createElement('button', props, children),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: { [key: string]: unknown }) => createElement('input', props),
}))

vi.mock('@/lib/quick-notes/quick-note-preview', () => ({
  ensureQuickNotePreviewSpace: previewMocks.ensureQuickNotePreviewSpace,
}))

vi.mock('@/lib/quick-notes/quick-note-repository', () => ({
  getQuickNoteRepositoryUserMessage: repositoryMocks.getQuickNoteRepositoryUserMessage,
}))

const previewMocks = vi.hoisted(() => ({
  ensureQuickNotePreviewSpace: vi.fn().mockResolvedValue(undefined),
}))

const repositoryMocks = vi.hoisted(() => ({
  getQuickNoteRepositoryUserMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}))

const storeMocks = vi.hoisted(() => ({
  state: {
    quickNotes: [] as QuickNote[],
    trashedQuickNotes: [] as QuickNote[],
    syncStatusById: {} as Record<string, 'pending' | 'failed'>,
    lifecycleStateById: {} as Record<
      string,
      'active' | 'trashed' | 'archived' | 'converted' | 'sync-deleted'
    >,
    isLoading: false,
    error: null as string | null,
    searchQuery: '',
  },
  loadQuickNotes: vi.fn().mockResolvedValue(undefined),
  createQuickNote: vi.fn().mockResolvedValue(undefined),
  updateQuickNote: vi.fn().mockResolvedValue(undefined),
  deleteQuickNote: vi.fn().mockResolvedValue(undefined),
  restoreQuickNote: vi.fn().mockResolvedValue(undefined),
  purgeQuickNote: vi.fn().mockResolvedValue(undefined),
  togglePin: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/stores/quick-note-store', () => ({
  useQuickNoteStore: () => ({
    ...storeMocks.state,
    loadQuickNotes: storeMocks.loadQuickNotes,
    createQuickNote: storeMocks.createQuickNote,
    updateQuickNote: storeMocks.updateQuickNote,
    deleteQuickNote: storeMocks.deleteQuickNote,
    restoreQuickNote: storeMocks.restoreQuickNote,
    purgeQuickNote: storeMocks.purgeQuickNote,
    togglePin: storeMocks.togglePin,
  }),
}))

import { QuickNotesView } from '@/components/quick-notes/quick-notes-view'

function makeQuickNote(overrides: Partial<QuickNote> = {}): QuickNote {
  const now = '2026-07-07T13:00:00.000Z'
  return {
    id: 'quick-note-1',
    content: 'memos style',
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    session_id: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('QuickNotesView', () => {
  beforeEach(() => {
    vi.useRealTimers()
    storeMocks.state.quickNotes = []
    storeMocks.state.trashedQuickNotes = []
    storeMocks.state.syncStatusById = {}
    storeMocks.state.lifecycleStateById = {}
    storeMocks.state.isLoading = false
    storeMocks.state.error = null
    storeMocks.state.searchQuery = ''
    storeMocks.loadQuickNotes.mockClear()
    storeMocks.createQuickNote.mockClear()
    storeMocks.updateQuickNote.mockClear()
    storeMocks.deleteQuickNote.mockClear()
    storeMocks.restoreQuickNote.mockClear()
    storeMocks.purgeQuickNote.mockClear()
    storeMocks.togglePin.mockClear()
    previewMocks.ensureQuickNotePreviewSpace.mockReset()
    previewMocks.ensureQuickNotePreviewSpace.mockResolvedValue(undefined)
    repositoryMocks.getQuickNoteRepositoryUserMessage.mockClear()
    repositoryMocks.getQuickNoteRepositoryUserMessage.mockImplementation(
      (_error: unknown, fallback: string) => fallback,
    )
    toastMock.mockClear()
    toastMock.error.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders empty state', async () => {
    render(createElement(QuickNotesView))

    expect(await screen.findByText('还没有小记')).toBeInTheDocument()
    expect(screen.getByText('速记')).toHaveClass('text-transparent')
    expect(screen.getByText('Quick Notes')).toHaveClass('text-[color:var(--qn-subtle)]')
    expect(screen.getByLabelText('小记内容')).toHaveClass(
      'text-[color:var(--qn-text-strong)]',
    )
  })

  it('submits composer content through the store action', async () => {
    render(createElement(QuickNotesView))

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '今天先把 QuickNote 做顺' },
    })
    fireEvent.click(screen.getByRole('button', { name: /记录/ }))

    await waitFor(() => {
      expect(storeMocks.createQuickNote).toHaveBeenCalledWith({
        content: '今天先把 QuickNote 做顺',
      })
    })
  })

  it('previews extracted tags from composer input', async () => {
    render(createElement(QuickNotesView))

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '记录 #灵感 #Daily_Note #daily_note' },
    })

    expect(screen.getByText('将写入标签')).toHaveClass('text-[color:var(--qn-muted)]')
    expect(screen.getByText('#灵感')).toHaveClass(
      'text-[color:var(--qn-accent-readable)]',
    )
    expect(screen.getByText('#daily_note')).toHaveClass(
      'text-[color:var(--qn-accent-readable)]',
    )
    expect(screen.getAllByText('#daily_note')).toHaveLength(1)
  })

  it('keeps the preview smoke path readable with composer, timeline, and trash affordance', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'saved-note',
        content: '预览测试小记\n确认页面可访问、可写入。',
        tags: ['preview'],
      }),
    ]
    storeMocks.state.trashedQuickNotes = [
      makeQuickNote({
        id: 'trash-note',
        content: '已删除小记',
        trashed_at: '2026-07-07T13:30:00.000Z',
      }),
    ]

    render(createElement(QuickNotesView))

    expect(await screen.findByText('预览测试小记')).toHaveClass(
      'text-[color:var(--qn-text-strong)]',
    )
    expect(
      screen.getByText((content, element) => {
        return (
          element?.tagName.toLowerCase() === 'p' &&
          content.includes('确认页面可访问、可写入。')
        )
      }),
    ).toHaveClass('text-[color:var(--qn-text)]')
    expect(screen.getByText('#preview')).toHaveClass(
      'text-[color:var(--qn-accent-readable)]',
    )
    expect(screen.getByRole('button', { name: /回收站 1/ })).toHaveClass(
      'text-[color:var(--qn-text)]',
    )

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '新预览 smoke 小记' },
    })
    fireEvent.click(screen.getByRole('button', { name: /记录/ }))

    await waitFor(() => {
      expect(storeMocks.createQuickNote).toHaveBeenCalledWith({
        content: '新预览 smoke 小记',
      })
    })
  })

  it.each([
    ['light default', undefined],
    ['dark', 'dark'],
    ['midnight', 'midnight'],
    ['daylight', 'daylight'],
  ])('renders a non-empty QuickNote page under %s theme class', async (_label, themeClass) => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'theme-note',
        content: 'Theme smoke title\nTheme smoke body #smoke',
        tags: ['smoke'],
      }),
    ]
    storeMocks.state.trashedQuickNotes = [
      makeQuickNote({
        id: 'theme-trash',
        content: 'Theme trash note',
        trashed_at: '2026-07-07T13:30:00.000Z',
      }),
    ]

    render(
      createElement(
        'div',
        themeClass ? { className: themeClass } : null,
        createElement(QuickNotesView),
      ),
    )

    expect(await screen.findByText('速记')).toBeInTheDocument()
    expect(screen.getByLabelText('小记内容')).toBeInTheDocument()
    expect(screen.getByLabelText('搜索小记')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /回收站 1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Theme smoke title/ })).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('Theme smoke body'))).toHaveClass(
      'text-[color:var(--qn-text)]',
    )
    expect(screen.getByRole('button', { name: '#smoke' })).toHaveClass(
      'text-[color:var(--qn-accent-readable)]',
    )
  })

  it('renders timeline notes and dispatches search query changes', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'memos',
        content: 'memos style',
        tags: ['capture'],
      }),
      makeQuickNote({
        id: 'other',
        content: 'other idea',
        updated_at: '2026-07-07T14:00:00.000Z',
      }),
    ]

    render(createElement(QuickNotesView))

    expect(await screen.findAllByText('memos style')).toHaveLength(2)
    expect(screen.getAllByText('other idea')).toHaveLength(2)

    fireEvent.change(screen.getByLabelText('搜索小记'), {
      target: { value: 'other' },
    })

    expect(storeMocks.loadQuickNotes).toHaveBeenCalledWith({ query: 'other' })
    expect(screen.getAllByText('other idea')[0]).toHaveClass(
      'text-[color:var(--qn-text-strong)]',
    )
    expect(screen.getAllByText('other idea')[1]).toHaveClass('text-[color:var(--qn-text)]')
  })

  it('searches by tag when a note tag is clicked', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'tagged',
        content: 'Tagged note',
        tags: ['capture'],
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: '#capture' }))

    expect(storeMocks.loadQuickNotes).toHaveBeenCalledWith({ query: '#capture' })
  })

  it('shows readable edit state and dispatches autosave update', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'edit-note',
        content: '编辑前标题\n编辑前内容',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: /编辑前标题/ }))

    expect(screen.getByText(/已保存：编辑前标题/)).toHaveClass(
      'text-[color:var(--qn-muted)]',
    )
    expect(screen.getByRole('button', { name: /取消/ })).toHaveClass(
      'text-[color:var(--qn-muted)]',
    )
    expect(screen.getByRole('button', { name: /保存修改/ })).toHaveClass(
      'text-[color:var(--qn-accent-foreground)]',
    )

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '编辑后标题\n编辑后内容' },
    })
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }))

    await waitFor(() => {
      expect(storeMocks.updateQuickNote).toHaveBeenCalledWith('edit-note', {
        content: '编辑后标题\n编辑后内容',
      })
    })
  })

  it('autosaves edited content after debounce and exposes save states', async () => {
    vi.useFakeTimers()
    let resolveUpdate: (() => void) | null = null
    storeMocks.updateQuickNote.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve
        }),
    )
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'autosave-note',
        content: '旧标题\n旧内容',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /旧标题/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '自动保存标题\n自动保存内容' },
    })

    expect(screen.getByText(/未保存：旧标题/)).toBeInTheDocument()
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(899)
    })
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByText(/保存中：旧标题/)).toBeInTheDocument()

    expect(storeMocks.updateQuickNote).toHaveBeenCalledWith('autosave-note', {
      content: '自动保存标题\n自动保存内容',
    })
    await act(async () => {
      resolveUpdate?.()
      await Promise.resolve()
    })
    expect(screen.getByText(/已保存：自动保存标题/)).toBeInTheDocument()
  })

  it('keeps the editor unsaved when a newer draft appears before autosave resolves', async () => {
    vi.useFakeTimers()
    let resolveUpdate: (() => void) | null = null
    storeMocks.updateQuickNote.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve
        }),
    )
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'race-note',
        content: 'race old',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /race old/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'first save body' },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(screen.getByText(/保存中：race old/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'second newer body' },
    })
    await act(async () => {
      resolveUpdate?.()
      await Promise.resolve()
    })

    expect(screen.getByText(/未保存：race old/)).toBeInTheDocument()
    expect(storeMocks.updateQuickNote).toHaveBeenCalledWith('race-note', {
      content: 'first save body',
    })
  })

  it('retries a failed edited save with Ctrl/Cmd+Enter and reaches saved state', async () => {
    vi.useFakeTimers()
    storeMocks.updateQuickNote
      .mockRejectedValueOnce(new Error('first write failed'))
      .mockResolvedValueOnce(undefined)
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'retry-note',
        content: 'retry before',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /retry before/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'retry after' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    expect(screen.getByText(/保存失败：retry before/)).toBeInTheDocument()

    fireEvent.keyDown(screen.getByLabelText('小记内容'), {
      ctrlKey: true,
      key: 'Enter',
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(storeMocks.updateQuickNote).toHaveBeenCalledTimes(2)
    expect(storeMocks.updateQuickNote).toHaveBeenLastCalledWith('retry-note', {
      content: 'retry after',
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/已保存：retry after/)).toBeInTheDocument()
  })

  it('skips a stale queued autosave before it writes', async () => {
    vi.useFakeTimers()
    let resolveFirstSave: (() => void) | null = null
    storeMocks.updateQuickNote.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstSave = resolve
        }),
    )
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'stale-note',
        content: 'stale old',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /stale old/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'first queued body' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(storeMocks.updateQuickNote).toHaveBeenCalledWith('stale-note', {
      content: 'first queued body',
    })

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'second latest body' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    expect(storeMocks.updateQuickNote).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'third final body' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    await act(async () => {
      resolveFirstSave?.()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(storeMocks.updateQuickNote).toHaveBeenCalledTimes(2)
    expect(storeMocks.updateQuickNote).toHaveBeenLastCalledWith('stale-note', {
      content: 'third final body',
    })
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalledWith('stale-note', {
      content: 'second latest body',
    })
  })

  it('shows failed state and toast when edited save fails', async () => {
    vi.useFakeTimers()
    storeMocks.updateQuickNote.mockRejectedValueOnce(new Error('disk full'))
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'fail-note',
        content: '失败前标题',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /失败前标题/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '失败后标题' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    expect(screen.getByText(/保存失败：失败前标题/)).toBeInTheDocument()
    expect(toastMock.error).toHaveBeenCalledWith(
      '小记保存失败',
      expect.objectContaining({ description: '请稍后重试' }),
    )
  })

  it('cancels editing with Escape without writing unsaved changes', async () => {
    vi.useFakeTimers()
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'cancel-note',
        content: '取消前标题',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /取消前标题/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '这段不应该保存' },
    })
    fireEvent.keyDown(screen.getByLabelText('小记内容'), {
      key: 'Escape',
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(screen.queryByRole('button', { name: /保存修改/ })).not.toBeInTheDocument()
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()
  })

  it('keeps editing when saved content no longer matches the current search', async () => {
    vi.useFakeTimers()
    storeMocks.state.searchQuery = 'keep'
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'filtered-note',
        content: 'keep this result',
      }),
    ]
    storeMocks.updateQuickNote.mockImplementationOnce(async () => {
      storeMocks.state.quickNotes = []
    })

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /keep this result/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'no longer matches search' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    expect(storeMocks.updateQuickNote).toHaveBeenCalledWith('filtered-note', {
      content: 'no longer matches search',
    })
    expect(screen.queryByRole('button', { name: /记录/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存修改/ })).toBeInTheDocument()
    expect(screen.getByText(/已保存：no longer matches search/)).toBeInTheDocument()
  })

  it('shows a toast when creating a quick note fails', async () => {
    storeMocks.createQuickNote.mockRejectedValueOnce(new Error('write blocked'))

    render(createElement(QuickNotesView))

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '创建失败小记' },
    })
    fireEvent.click(screen.getByRole('button', { name: /记录/ }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记创建失败',
        expect.objectContaining({ description: '请稍后重试' }),
      )
    })
    expect(screen.getByLabelText('小记内容')).toHaveValue('创建失败小记')
  })

  it('uses repository user messages for action failure toasts', async () => {
    repositoryMocks.getQuickNoteRepositoryUserMessage.mockReturnValue('用户可读错误')
    storeMocks.createQuickNote.mockRejectedValueOnce(new Error('developer details'))

    render(createElement(QuickNotesView))

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '创建失败小记' },
    })
    fireEvent.click(screen.getByRole('button', { name: /记录/ }))

    await waitFor(() => {
      expect(repositoryMocks.getQuickNoteRepositoryUserMessage).toHaveBeenCalledWith(
        expect.any(Error),
        '请稍后重试',
      )
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记创建失败',
        expect.objectContaining({ description: '用户可读错误' }),
      )
    })
  })

  it('shows a toast instead of silently ignoring empty manual saves', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'empty-note',
        content: '不能清空',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /不能清空/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }))

    expect(toastMock.error).toHaveBeenCalledWith('小记内容不能为空')
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()
  })

  it('renders a readable preview initialization error instead of throwing', async () => {
    previewMocks.ensureQuickNotePreviewSpace.mockRejectedValueOnce(
      new Error('space db unavailable'),
    )

    render(createElement(QuickNotesView))

    expect(
      await screen.findByText('预览初始化失败：space db unavailable'),
    ).toBeInTheDocument()
    expect(storeMocks.loadQuickNotes).not.toHaveBeenCalled()
  })

  it('supports Ctrl/Cmd+Enter submit, Esc cancel, clear search, highlight, and undo trash toast', async () => {
    storeMocks.state.searchQuery = 'memo'
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'memos',
        content: 'Memos capture\nsearch body',
        tags: ['capture'],
      }),
    ]

    render(createElement(QuickNotesView))

    expect(await screen.findAllByText('Memo')).toHaveLength(2)
    expect(screen.getAllByText('Memo')[0]).toHaveClass('rounded')
    fireEvent.change(screen.getByLabelText('搜索小记'), {
      target: { value: '#cap' },
    })
    expect(storeMocks.loadQuickNotes).toHaveBeenCalledWith({ query: '#cap' })

    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(storeMocks.loadQuickNotes).toHaveBeenCalledWith({ query: '' })

    fireEvent.click(screen.getByRole('button', { name: /Memos capture/ }))
    expect(screen.getByText(/已保存：Memos capture/)).toBeInTheDocument()

    fireEvent.keyDown(screen.getByLabelText('小记内容'), {
      key: 'Escape',
    })
    expect(screen.queryByRole('button', { name: /保存修改/ })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '快捷键新建小记' },
    })
    fireEvent.keyDown(screen.getByLabelText('小记内容'), {
      ctrlKey: true,
      key: 'Enter',
    })

    await waitFor(() => {
      expect(storeMocks.createQuickNote).toHaveBeenCalledWith({
        content: '快捷键新建小记',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }))

    await waitFor(() => {
      expect(storeMocks.deleteQuickNote).toHaveBeenCalledWith('memos')
    })

    const toastOptions = toastMock.mock.calls.at(-1)?.[1]
    expect(toastMock).toHaveBeenCalledWith(
      '小记已移到回收站',
      expect.objectContaining({
        action: expect.objectContaining({ label: '撤销' }),
      }),
    )

    toastOptions?.action?.onClick?.()
    expect(storeMocks.restoreQuickNote).toHaveBeenCalledWith('memos')
  })

  it('opens trash panel and confirms purge before dispatching the destructive action', async () => {
    storeMocks.state.trashedQuickNotes = [
      makeQuickNote({
        id: 'trash-note',
        content: '回收站测试小记',
        trashed_at: '2026-07-07T13:30:00.000Z',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /回收站 1/ }))

    expect(await screen.findByRole('heading', { name: '回收站' })).toHaveClass(
      'text-[color:var(--qn-text-strong)]',
    )
    expect(screen.getByText('回收站测试小记')).toHaveClass(
      'text-[color:var(--qn-text-strong)]',
    )

    fireEvent.click(screen.getByRole('button', { name: '彻底删除小记' }))

    expect(storeMocks.purgeQuickNote).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '确认彻底删除小记' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认彻底删除小记' }))

    await waitFor(() => {
      expect(storeMocks.purgeQuickNote).toHaveBeenCalledWith('trash-note')
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '恢复小记' })).not.toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', { name: '恢复小记' }))
    await waitFor(() => {
      expect(storeMocks.restoreQuickNote).toHaveBeenCalledWith('trash-note')
    })
  })

  it('prevents duplicate delete clicks while the note action is pending', async () => {
    let resolveDelete: (() => void) | null = null
    storeMocks.deleteQuickNote.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'pending-delete',
        content: 'pending delete',
      }),
    ]

    render(createElement(QuickNotesView))

    const deleteButton = await screen.findByRole('button', { name: '移到回收站' })
    fireEvent.click(deleteButton)
    fireEvent.click(deleteButton)

    expect(storeMocks.deleteQuickNote).toHaveBeenCalledTimes(1)
    expect(deleteButton).toBeDisabled()

    await act(async () => {
      resolveDelete?.()
      await Promise.resolve()
    })
  })

  it('keeps purge pending disabled and allows retry after failure', async () => {
    storeMocks.state.trashedQuickNotes = [
      makeQuickNote({
        id: 'retry-purge',
        content: '重试彻删小记',
        trashed_at: '2026-07-07T13:30:00.000Z',
      }),
    ]
    storeMocks.purgeQuickNote
      .mockRejectedValueOnce(new Error('purge failed'))
      .mockResolvedValueOnce(undefined)

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /回收站 1/ }))
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除小记' }))
    const confirmButton = await screen.findByRole('button', { name: '确认彻底删除小记' })
    fireEvent.click(confirmButton)

    expect(confirmButton).toBeDisabled()
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记彻底删除失败',
        expect.objectContaining({ description: '请稍后重试' }),
      )
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认彻底删除小记' })).not.toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', { name: '确认彻底删除小记' }))
    await waitFor(() => {
      expect(storeMocks.purgeQuickNote).toHaveBeenCalledTimes(2)
    })
  })

  it('exits editing when the edited quick note is moved to trash', async () => {
    const note = makeQuickNote({
      id: 'editing-delete',
      content: '编辑中删除',
    })
    storeMocks.state.quickNotes = [note]
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /编辑中删除/ }))
    expect(screen.getByRole('button', { name: /保存修改/ })).toBeInTheDocument()

    storeMocks.state.quickNotes = []
    storeMocks.state.trashedQuickNotes = [
      {
        ...note,
        trashed_at: '2026-07-07T13:30:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /保存修改/ })).not.toBeInTheDocument()
    })
    expect(toastMock).toHaveBeenCalledWith('当前小记已在同步中移除/移入回收站')
  })

  it('keeps the local draft when a remote update arrives while editing', async () => {
    const note = makeQuickNote({
      id: 'remote-update-edit',
      content: '远端更新前',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /远端更新前/ }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '我正在写的本地草稿' },
    })

    storeMocks.state.quickNotes = [
      {
        ...note,
        content: '远端已经改过',
        updated_at: '2026-07-07T13:05:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    expect(screen.getByLabelText('小记内容')).toHaveValue('我正在写的本地草稿')
    expect(screen.getByText(/未保存：远端更新前/)).toBeInTheDocument()
    expect(toastMock).toHaveBeenCalledWith('有远端更新，已保留你的本地草稿')
  })

  it('adopts remote content when it changes before the local draft is edited', async () => {
    const note = makeQuickNote({
      id: 'remote-update-clean',
      content: '干净草稿旧内容',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /干净草稿旧内容/ }))

    storeMocks.state.quickNotes = [
      {
        ...note,
        content: '远端新内容',
        updated_at: '2026-07-07T13:05:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.getByLabelText('小记内容')).toHaveValue('远端新内容')
    })
    expect(toastMock).not.toHaveBeenCalledWith('有远端更新，已保留你的本地草稿')
  })

  it('exits editing when sync converts the edited quick note', async () => {
    const note = makeQuickNote({
      id: 'sync-converted',
      content: '将被迁移的小记',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /将被迁移的小记/ }))
    expect(screen.getByRole('button', { name: /保存修改/ })).toBeInTheDocument()

    storeMocks.state.quickNotes = []
    storeMocks.state.lifecycleStateById = { [note.id]: 'converted' }
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /保存修改/ })).not.toBeInTheDocument()
    })
    expect(toastMock).toHaveBeenCalledWith('当前小记已迁移为笔记')
  })

  it('exits editing with an archived toast when sync archives the edited quick note', async () => {
    const note = makeQuickNote({
      id: 'sync-archived',
      content: '将被归档的小记',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: /将被归档的小记/ }))
    expect(screen.getByRole('button', { name: /保存修改/ })).toBeInTheDocument()

    storeMocks.state.quickNotes = []
    storeMocks.state.lifecycleStateById = { [note.id]: 'archived' }
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /保存修改/ })).not.toBeInTheDocument()
    })
    expect(toastMock).toHaveBeenCalledWith('当前小记已归档')
    expect(toastMock).not.toHaveBeenCalledWith('当前小记已迁移为笔记')
  })

  it('refreshes from a visible synced card to the empty state', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'sync-removed',
        content: '同步前卡片\n这条会被远端 tombstone 移除',
      }),
    ]
    storeMocks.state.trashedQuickNotes = []

    const { rerender } = render(createElement(QuickNotesView))

    expect(await screen.findByRole('button', { name: /同步前卡片/ })).toBeInTheDocument()

    storeMocks.state.quickNotes = []
    storeMocks.state.trashedQuickNotes = []
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /同步前卡片/ })).not.toBeInTheDocument()
    })
    expect(screen.getByText('还没有小记')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回收站' })).toBeInTheDocument()
  })

  it('refreshes active and trash lists when sync moves a note to trash', async () => {
    const note = makeQuickNote({
      id: 'sync-soft-delete',
      content: '同步软删卡片\n远端删除后应进入回收站',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.trashedQuickNotes = []

    const { rerender } = render(createElement(QuickNotesView))

    expect(await screen.findByRole('button', { name: /同步软删卡片/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回收站' })).toBeInTheDocument()

    storeMocks.state.quickNotes = []
    storeMocks.state.trashedQuickNotes = [
      {
        ...note,
        trashed_at: '2026-07-07T13:30:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /同步软删卡片/ })).not.toBeInTheDocument()
    })
    expect(screen.getByText('还没有小记')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /回收站 1/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /回收站 1/ }))
    expect(await screen.findByText('同步软删卡片')).toHaveClass(
      'text-[color:var(--qn-text-strong)]',
    )
  })

  it('refreshes an open trash panel when sync removes trashed notes', async () => {
    storeMocks.state.quickNotes = []
    storeMocks.state.trashedQuickNotes = [
      makeQuickNote({
        id: 'sync-trash-gone',
        content: '同步后消失的回收站小记',
        trashed_at: '2026-07-07T13:30:00.000Z',
      }),
    ]

    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: /回收站 1/ }))
    expect(await screen.findByText('同步后消失的回收站小记')).toBeInTheDocument()

    storeMocks.state.trashedQuickNotes = []
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.queryByText('同步后消失的回收站小记')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '回收站' })).toBeInTheDocument()
    expect(screen.getByText('回收站是空的。')).toBeInTheDocument()
  })

  it('shows failure toasts for delete restore and purge actions', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'delete-fail',
        content: '删除失败小记',
      }),
    ]
    storeMocks.state.trashedQuickNotes = [
      makeQuickNote({
        id: 'trash-fail',
        content: '回收站失败小记',
        trashed_at: '2026-07-07T13:30:00.000Z',
      }),
    ]
    storeMocks.deleteQuickNote.mockRejectedValueOnce(new Error('delete blocked'))
    storeMocks.restoreQuickNote.mockRejectedValueOnce(new Error('restore blocked'))
    storeMocks.purgeQuickNote.mockRejectedValueOnce(new Error('purge blocked'))

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: '移到回收站' }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记删除失败',
        expect.objectContaining({ description: '请稍后重试' }),
      )
    })

    fireEvent.click(screen.getByRole('button', { name: /回收站 1/ }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复小记' }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记恢复失败',
        expect.objectContaining({ description: '请稍后重试' }),
      )
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '恢复小记' })).not.toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', { name: '彻底删除小记' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认彻底删除小记' }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记彻底删除失败',
        expect.objectContaining({ description: '请稍后重试' }),
      )
    })
  })
})
