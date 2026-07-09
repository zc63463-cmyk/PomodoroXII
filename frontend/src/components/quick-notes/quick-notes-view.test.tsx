import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { QuickNote } from '@/types'

vi.mock('lucide-react', () => ({
  ArchiveRestoreIcon: () =>
    createElement('span', { 'data-testid': 'archive-restore-icon' }),
  FileTextIcon: () => createElement('span', { 'data-testid': 'file-text-icon' }),
  GitMergeIcon: () => createElement('span', { 'data-testid': 'merge-icon' }),
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
    allQuickNotes: [] as QuickNote[],
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
    selectedTagFilters: [] as string[],
    tagFilterMode: 'single' as 'single' | 'multi',
    selectedDate: null as string | null,
    focusMode: 'normal' as 'normal' | 'focus-edit' | 'detail-read',
    selectedQuickNoteId: null as string | null,
  },
  loadQuickNotes: vi.fn().mockResolvedValue(undefined),
  createQuickNote: vi.fn().mockResolvedValue(undefined),
  updateQuickNote: vi.fn().mockResolvedValue(undefined),
  deleteQuickNote: vi.fn().mockResolvedValue(undefined),
  restoreQuickNote: vi.fn().mockResolvedValue(undefined),
  purgeQuickNote: vi.fn().mockResolvedValue(undefined),
  togglePin: vi.fn().mockResolvedValue(undefined),
  migrateToNote: vi.fn().mockResolvedValue('note-converted'),
  renameQuickNoteTag: vi.fn().mockResolvedValue(undefined),
  cleanupQuickNoteTags: vi.fn().mockResolvedValue(0),
  toggleTagFilter: vi.fn(),
  clearTagFilters: vi.fn(),
  setTagFilterMode: vi.fn(),
  toggleSelectedDate: vi.fn(),
  clearSelectedDate: vi.fn(),
  toggleFocusEdit: vi.fn(),
  enterDetailRead: vi.fn(),
  exitFocus: vi.fn(),
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
    migrateToNote: storeMocks.migrateToNote,
    renameQuickNoteTag: storeMocks.renameQuickNoteTag,
    cleanupQuickNoteTags: storeMocks.cleanupQuickNoteTags,
    toggleTagFilter: storeMocks.toggleTagFilter,
    clearTagFilters: storeMocks.clearTagFilters,
    setTagFilterMode: storeMocks.setTagFilterMode,
    toggleSelectedDate: storeMocks.toggleSelectedDate,
    clearSelectedDate: storeMocks.clearSelectedDate,
    toggleFocusEdit: storeMocks.toggleFocusEdit,
    enterDetailRead: storeMocks.enterDetailRead,
    exitFocus: storeMocks.exitFocus,
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
    storeMocks.state.allQuickNotes = []
    storeMocks.state.quickNotes = []
    storeMocks.state.trashedQuickNotes = []
    storeMocks.state.syncStatusById = {}
    storeMocks.state.lifecycleStateById = {}
    storeMocks.state.isLoading = false
    storeMocks.state.error = null
    storeMocks.state.searchQuery = ''
    storeMocks.state.selectedTagFilters = []
    storeMocks.state.tagFilterMode = 'single'
    storeMocks.state.selectedDate = null
    storeMocks.state.focusMode = 'normal'
    storeMocks.state.selectedQuickNoteId = null
    storeMocks.loadQuickNotes.mockClear()
    storeMocks.createQuickNote.mockClear()
    storeMocks.updateQuickNote.mockClear()
    storeMocks.deleteQuickNote.mockClear()
    storeMocks.restoreQuickNote.mockClear()
    storeMocks.purgeQuickNote.mockClear()
    storeMocks.togglePin.mockClear()
    storeMocks.migrateToNote.mockClear()
    storeMocks.renameQuickNoteTag.mockClear()
    storeMocks.renameQuickNoteTag.mockResolvedValue(undefined)
    storeMocks.cleanupQuickNoteTags.mockClear()
    storeMocks.cleanupQuickNoteTags.mockResolvedValue(0)
    storeMocks.toggleTagFilter.mockClear()
    storeMocks.clearTagFilters.mockClear()
    storeMocks.setTagFilterMode.mockClear()
    storeMocks.toggleSelectedDate.mockClear()
    storeMocks.clearSelectedDate.mockClear()
    storeMocks.toggleFocusEdit.mockClear()
    storeMocks.enterDetailRead.mockClear()
    storeMocks.exitFocus.mockClear()
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
    expect(screen.getByRole('main')).toHaveAttribute(
      'data-quicknote-visual-style',
      'apple-notes',
    )
    expect(screen.getByText('速记')).toHaveClass('text-[color:var(--qn-text-strong)]')
    expect(screen.getByText('Quick Notes')).toHaveClass('tracking-[0.18em]')
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

  it('inserts popular tags into the composer draft without duplicating them', async () => {
    const notes = [
      makeQuickNote({
        id: 'popular-a',
        content: 'Popular A',
        tags: ['work'],
      }),
      makeQuickNote({
        id: 'popular-b',
        content: 'Popular B',
        tags: ['work', 'life'],
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes

    render(createElement(QuickNotesView))

    const editor = screen.getByLabelText('小记内容')
    fireEvent.click(await screen.findByRole('button', { name: '插入常用标签 #work' }))
    expect(editor).toHaveValue('#work ')

    fireEvent.click(screen.getByRole('button', { name: '插入常用标签 #work' }))
    expect(editor).toHaveValue('#work ')

    fireEvent.change(editor, { target: { value: 'draft body' } })
    fireEvent.click(screen.getByRole('button', { name: '插入常用标签 #life' }))
    expect(editor).toHaveValue('draft body #life')
    expect(storeMocks.createQuickNote).not.toHaveBeenCalled()
  })

  it('shows typing then dirty status for a new composer draft', async () => {
    vi.useFakeTimers()
    render(createElement(QuickNotesView))

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '正在写一条新的小记' },
    })

    const typingStatus = screen.getByText('正在输入…').closest(
      '[data-quick-note-editor-status]',
    )
    expect(typingStatus).toHaveAttribute('data-status', 'typing')
    expect(typingStatus).toHaveAttribute('aria-live', 'off')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })

    const dirtyStatus = screen.getByText('草稿未保存').closest(
      '[data-quick-note-editor-status]',
    )
    expect(dirtyStatus).toHaveAttribute('data-status', 'dirty')
    expect(dirtyStatus).toHaveAttribute('aria-live', 'off')
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

  it('keeps search, activity calendar, and tags in the left explorer column', async () => {
    const notes = [
      makeQuickNote({
        id: 'layout-note',
        content: 'Layout note body',
        tags: ['layout'],
        created_at: '2026-07-03T10:00:00.000Z',
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes

    render(createElement(QuickNotesView))

    const explorer = await screen.findByLabelText('小记探索')
    const grid = explorer.parentElement
    const mainColumn = explorer.nextElementSibling

    expect(grid).toHaveClass('grid')
    expect(grid).toHaveClass('lg:grid-cols-[18rem_minmax(0,1fr)]')
    expect(grid?.firstElementChild).toBe(explorer)
    expect(explorer).toContainElement(screen.getByLabelText('搜索小记'))
    expect(within(explorer).getByText('活动日历')).toBeInTheDocument()
    expect(within(explorer).getByText('标签')).toBeInTheDocument()
    expect(explorer).not.toContainElement(screen.getByLabelText('小记内容'))
    expect(mainColumn).toContainElement(screen.getByLabelText('小记内容'))
    expect(mainColumn).toContainElement(screen.getByRole('button', { name: /Layout note body/ }))
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

  it('renders tag exploration stats and dispatches tag filter changes', async () => {
    const notes = [
      makeQuickNote({
        id: 'work-frontend',
        content: 'Frontend memo',
        tags: ['work', 'frontend'],
      }),
      makeQuickNote({
        id: 'work-backend',
        content: 'Backend memo',
        tags: ['work', 'backend'],
      }),
      makeQuickNote({
        id: 'life',
        content: 'Life memo',
        tags: ['life'],
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes
    storeMocks.state.selectedTagFilters = ['work']

    render(createElement(QuickNotesView))

    const workTag = await screen.findByRole('button', {
      name: '筛选标签 #work，2 条小记',
    })
    expect(workTag).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(workTag)
    expect(storeMocks.toggleTagFilter).toHaveBeenCalledWith('work')

    fireEvent.click(screen.getByRole('button', { name: '切换为多选标签过滤' }))
    expect(storeMocks.setTagFilterMode).toHaveBeenCalledWith('multi')

    fireEvent.click(screen.getByRole('button', { name: '清除标签筛选' }))
    expect(storeMocks.clearTagFilters).toHaveBeenCalledTimes(1)
  })

  it('renames tags from the explorer inline editor', async () => {
    const notes = [
      makeQuickNote({
        id: 'rename-tag',
        content: 'Rename memo',
        tags: ['work'],
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: '重命名标签 #work' }))
    const renameInput = screen.getByLabelText('标签新名称 #work')
    fireEvent.change(renameInput, { target: { value: 'project' } })
    fireEvent.keyDown(renameInput, { key: 'Enter' })

    await waitFor(() => {
      expect(storeMocks.renameQuickNoteTag).toHaveBeenCalledWith('work', 'project')
    })
    expect(toastMock).toHaveBeenCalledWith('已将 #work 重命名为 #project')
  })

  it('shows tag cleanup feedback from the explorer', async () => {
    const notes = [
      makeQuickNote({
        id: 'cleanup-tag',
        content: 'Cleanup memo',
        tags: ['work'],
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes
    storeMocks.cleanupQuickNoteTags.mockResolvedValueOnce(2)

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: '清理标签' }))

    await waitFor(() => {
      expect(storeMocks.cleanupQuickNoteTags).toHaveBeenCalledTimes(1)
    })
    expect(toastMock).toHaveBeenCalledWith('已清理 2 条小记的标签')
  })

  it('shows tag cleanup when dirty active tags normalize to no visible stats', async () => {
    const notes = [
      makeQuickNote({
        id: 'dirty-empty-tags',
        content: 'Dirty empty tags',
        tags: ['', '#'],
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes
    storeMocks.cleanupQuickNoteTags.mockResolvedValueOnce(1)

    render(createElement(QuickNotesView))

    expect(await screen.findByText('还没有标签，写下 #灵感 试试。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清理标签' }))

    await waitFor(() => {
      expect(storeMocks.cleanupQuickNoteTags).toHaveBeenCalledTimes(1)
    })
    expect(toastMock).toHaveBeenCalledWith('已清理 1 条小记的标签')
  })

  it('switches between tag cloud and slash-separated tag tree', async () => {
    const notes = [
      makeQuickNote({
        id: 'tree-a',
        content: 'Tree memo',
        tags: ['work/frontend'],
      }),
      makeQuickNote({
        id: 'tree-b',
        content: 'Tree memo',
        tags: ['work/backend'],
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: '标签树视图' }))

    expect(
      screen.getByRole('button', { name: '筛选标签 #work/frontend，1 条小记' }),
    ).toHaveClass('text-[color:var(--qn-accent-readable)]')
    expect(screen.getByText('work')).toBeInTheDocument()
  })

  it('renders created_at activity calendar and dispatches date filters', async () => {
    const notes = [
      makeQuickNote({
        id: 'created-july-1',
        content: 'Created July one',
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-07T10:00:00.000Z',
      }),
      makeQuickNote({
        id: 'created-july-2',
        content: 'Created July two',
        created_at: '2026-07-02T10:00:00.000Z',
        updated_at: '2026-07-02T10:00:00.000Z',
      }),
    ]
    storeMocks.state.allQuickNotes = notes
    storeMocks.state.quickNotes = notes
    storeMocks.state.selectedDate = '2026-07-01'

    render(createElement(QuickNotesView))

    const createdDate = await screen.findByRole('button', {
      name: '筛选日期 2026-07-01，1 条小记',
    })
    expect(createdDate).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(createdDate)
    expect(storeMocks.toggleSelectedDate).toHaveBeenCalledWith('2026-07-01')

    fireEvent.click(screen.getByRole('button', { name: '清除日期筛选' }))
    expect(storeMocks.clearSelectedDate).toHaveBeenCalledTimes(1)
  })

  it('shows readable edit state and dispatches autosave update', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'edit-note',
        content: '编辑前标题\n编辑前内容',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))

    const savedStatus = screen.getByText('已保存').closest(
      '[data-quick-note-editor-status]',
    )
    expect(savedStatus).toHaveAttribute('data-status', 'saved')
    expect(savedStatus).toHaveAttribute('aria-live', 'polite')
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '自动保存标题\n自动保存内容' },
    })

    expect(screen.getByText('正在输入…')).toBeInTheDocument()
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(899)
    })
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByText('保存中…')).toBeInTheDocument()

    expect(storeMocks.updateQuickNote).toHaveBeenCalledWith('autosave-note', {
      content: '自动保存标题\n自动保存内容',
    })
    await act(async () => {
      resolveUpdate?.()
      await Promise.resolve()
    })
    expect(screen.getByText('已保存')).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'first save body' },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(screen.getByText('保存中…')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'second newer body' },
    })
    await act(async () => {
      resolveUpdate?.()
      await Promise.resolve()
    })

    expect(screen.getByText('正在输入…')).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: 'retry after' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    expect(screen.getByText('保存失败，可重试')).toBeInTheDocument()

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
    expect(screen.getByText('已保存')).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '失败后标题' },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })

    expect(screen.getByText('保存失败，可重试')).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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
    expect(screen.getByText('已保存')).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
    expect(screen.getByText('已保存')).toBeInTheDocument()

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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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
    expect(screen.getByText('远端有新版本')).toBeInTheDocument()
    expect(screen.getByLabelText('小记远端更新冲突')).toBeInTheDocument()
    expect(screen.getByText('这条小记在别处更新了')).toBeInTheDocument()
    expect(
      screen.getByText('你的本地草稿已保留，自动保存已暂停。保存前请选择处理方式。'),
    ).toBeInTheDocument()
    expect(screen.getByText('本地草稿')).toBeInTheDocument()
    expect(screen.getByText('远端版本')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '覆盖远端并保存' })).toBeInTheDocument()
    expect(toastMock).not.toHaveBeenCalledWith('有远端更新，已保留你的本地草稿')
  })

  it('pauses composer saves while a remote update conflict is unresolved', async () => {
    vi.useFakeTimers()
    const note = makeQuickNote({
      id: 'remote-conflict-pauses-save',
      content: '远端更新前',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

    expect(screen.getByLabelText('小记远端更新冲突')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存修改/ })).toBeDisabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })

    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '覆盖远端并保存' }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(storeMocks.updateQuickNote).toHaveBeenCalledWith(
      'remote-conflict-pauses-save',
      {
        content: '我正在写的本地草稿',
      },
    )
  })

  it('lets the editor adopt the remote version from the conflict panel', async () => {
    const note = makeQuickNote({
      id: 'remote-conflict-adopt',
      content: '远端更新前',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

    fireEvent.click(screen.getByRole('button', { name: '采用远端版本' }))

    expect(screen.getByLabelText('小记内容')).toHaveValue('远端已经改过')
    expect(screen.queryByLabelText('小记远端更新冲突')).not.toBeInTheDocument()
    expect(screen.getByText('已保存')).toBeInTheDocument()
  })

  it('lets the editor merge the remote version into the local draft', async () => {
    const note = makeQuickNote({
      id: 'remote-conflict-merge',
      content: '远端更新前',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '本地草稿内容' },
    })

    storeMocks.state.quickNotes = [
      {
        ...note,
        content: '远端新内容',
        updated_at: '2026-07-07T13:05:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '合并到草稿' }))

    expect(screen.getByLabelText('小记内容')).toHaveValue(
      '本地草稿内容\n\n--- 远端版本 ---\n远端新内容',
    )
    expect(screen.queryByLabelText('小记远端更新冲突')).not.toBeInTheDocument()
    expect(screen.getByText('草稿未保存')).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))

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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

    fireEvent.click(screen.getByRole('button', { name: '编辑小记' }))
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

  it('converts a quick note to a note from the card action', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'convert-card',
        content: '转为笔记的小记',
      }),
    ]

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: '转为笔记' }))

    await waitFor(() => {
      expect(storeMocks.migrateToNote).toHaveBeenCalledWith('convert-card')
      expect(toastMock).toHaveBeenCalledWith(
        '小记已转为笔记',
        expect.objectContaining({ description: '笔记 ID：note-converted' }),
      )
    })
  })

  it('shows a failure toast when quick note conversion fails', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'convert-fail',
        content: '转换失败小记',
      }),
    ]
    storeMocks.migrateToNote.mockRejectedValueOnce(new Error('convert blocked'))

    render(createElement(QuickNotesView))

    fireEvent.click(await screen.findByRole('button', { name: '转为笔记' }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记转为笔记失败',
        expect.objectContaining({ description: '请稍后重试' }),
      )
    })
  })

  it('enters focus-edit by expanding only the right column and pushing the timeline down', async () => {
    storeMocks.state.quickNotes = [
      makeQuickNote({
        id: 'focus-edit-note',
        content: '给专注模式一点背景',
      }),
    ]

    const { container, rerender } = render(createElement(QuickNotesView))
    const normalStage = container.querySelector('[data-focus-stage="normal"]')

    fireEvent.click(screen.getByRole('button', { name: '专注' }))
    expect(storeMocks.toggleFocusEdit).toHaveBeenCalled()

    storeMocks.state.focusMode = 'focus-edit'
    rerender(createElement(QuickNotesView))
    const focusStage = container.querySelector('[data-focus-stage="focus-edit"]')

    expect(focusStage).toBe(normalStage)
    expect(focusStage?.parentElement).toHaveClass('max-w-7xl')
    expect(screen.getByRole('button', { name: '退出专注' })).toHaveClass(
      'text-[color:var(--qn-accent-readable)]',
    )
    expect(screen.getByLabelText('小记内容')).toHaveAttribute('rows', '12')
    expect(screen.getByLabelText('小记内容')).toHaveClass(
      'h-[clamp(20rem,calc(100dvh-23rem),26rem)]',
    )
    expect(screen.getByLabelText('小记内容')).toHaveClass('max-h-[26rem]')
    expect(screen.getByLabelText('小记内容')).toHaveClass('overflow-y-auto')
    expect(screen.getByLabelText('小记内容')).not.toHaveClass(
      'min-h-[max(32rem,calc(100svh-12rem))]',
    )
    expect(screen.getByText(/专注写作中/)).toHaveClass(
      'text-[color:var(--qn-muted)]',
    )
    const explorer = screen.getByLabelText('小记探索')
    const focusGrid = explorer.parentElement
    const mainColumn = explorer.nextElementSibling
    const timeline = screen.getByLabelText('小记时间线')
    const timelineSink = timeline.parentElement

    expect(explorer).toBeInTheDocument()
    expect(focusGrid).toHaveClass('lg:grid-cols-[18rem_minmax(0,1fr)]')
    expect(focusGrid?.firstElementChild).toBe(explorer)
    expect(mainColumn).toContainElement(screen.getByLabelText('小记内容'))
    expect(mainColumn).toContainElement(timeline)
    expect(timelineSink).toHaveAttribute('data-focus-edit-timeline-sink', 'true')
    expect(timelineSink).toHaveClass('quick-note-focus-timeline-sink')
    expect(screen.getByRole('button', { name: /给专注模式一点背景/ })).toHaveAttribute(
      'tabIndex',
      '-1',
    )
    expect(screen.getByRole('button', { name: '编辑小记' })).toBeDisabled()
  })

  it('returns to normal after a successful focus-edit submit', async () => {
    storeMocks.state.focusMode = 'focus-edit'

    render(createElement(QuickNotesView))

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '专注写完的一段小记' },
    })
    fireEvent.click(screen.getByRole('button', { name: /记录/ }))

    await waitFor(() => {
      expect(storeMocks.createQuickNote).toHaveBeenCalledWith({
        content: '专注写完的一段小记',
      })
    })
    await waitFor(() => {
      expect(storeMocks.exitFocus).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps focus-edit open when submit fails', async () => {
    storeMocks.state.focusMode = 'focus-edit'
    storeMocks.createQuickNote.mockRejectedValueOnce(new Error('write blocked'))

    render(createElement(QuickNotesView))

    fireEvent.change(screen.getByLabelText('小记内容'), {
      target: { value: '这次保存会失败' },
    })
    fireEvent.click(screen.getByRole('button', { name: /记录/ }))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '小记创建失败',
        expect.objectContaining({ description: '请稍后重试' }),
      )
    })
    expect(storeMocks.exitFocus).not.toHaveBeenCalled()
  })

  it('shows a rendered quick preview inside the growing card without entering focus mode', async () => {
    const note = makeQuickNote({
      id: 'quick-preview-note',
      content: '快速预览标题\n\n这里是完整快速预览内容 #focus\n\n第三段用来确认原位展开',
      tags: ['focus'],
    })
    storeMocks.state.quickNotes = [note]

    const { rerender } = render(createElement(QuickNotesView))

    const collapsedTrigger = await screen.findByRole('button', { name: /快速预览标题/ })
    const collapsedCard = collapsedTrigger.closest('article')
    expect(collapsedCard).toHaveClass('max-h-[11.25rem]')
    expect(screen.getByText(/这里是完整快速预览内容/)).toHaveClass('line-clamp-2')

    fireEvent.click(collapsedTrigger)
    fireEvent.doubleClick(collapsedTrigger)
    expect(storeMocks.state.focusMode).toBe('normal')

    rerender(createElement(QuickNotesView))

    expect(screen.queryByText('Focus Read')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('小记轻详情')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('小记原位详情')).not.toBeInTheDocument()
    expect(screen.queryByText('创建')).not.toBeInTheDocument()
    expect(screen.queryByText('更新')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /快速预览标题/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    const expandedCard = screen.getByRole('button', { name: /快速预览标题/ }).closest('article')
    expect(expandedCard).toHaveClass('max-h-none')
    expect(screen.getByRole('button', { name: /快速预览标题/ })).not.toHaveAttribute(
      'aria-controls',
    )
    const quickPreview = screen.getByLabelText('小记快速预览')
    expect(quickPreview.closest('article')).toBe(expandedCard)
    expect(quickPreview).toHaveTextContent('第三段用来确认原位展开')
    expect(quickPreview).not.toHaveClass('line-clamp-2')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(storeMocks.exitFocus).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('小记快速预览')).not.toBeInTheDocument()
  })

  it('renders markdown semantics in quick preview while staying inside the card', async () => {
    const note = makeQuickNote({
      id: 'quick-preview-markdown-note',
      content: [
        '# Quick Preview Markdown',
        '',
        '- first item',
        '- second item',
        '',
        '> quoted insight',
        '',
        'Use `inline code` and [safe link](https://example.com).',
        '',
        '<img src=x onerror=alert(1)>',
      ].join('\n'),
    })
    storeMocks.state.quickNotes = [note]

    render(createElement(QuickNotesView))

    const collapsedTrigger = await screen.findByRole('button', {
      name: /# Quick Preview Markdown/,
    })
    fireEvent.doubleClick(collapsedTrigger)

    const expandedCard = screen
      .getByRole('button', { name: /# Quick Preview Markdown/ })
      .closest('article')
    const quickPreview = screen.getByLabelText('小记快速预览')

    expect(quickPreview.closest('article')).toBe(expandedCard)
    expect(screen.queryByLabelText('小记沉浸阅读')).not.toBeInTheDocument()
    expect(storeMocks.enterDetailRead).not.toHaveBeenCalled()
    expect(within(quickPreview).getByRole('heading', {
      level: 1,
      name: 'Quick Preview Markdown',
    })).toBeInTheDocument()
    expect(within(quickPreview).getAllByRole('listitem')).toHaveLength(2)
    expect(quickPreview.querySelector('blockquote')).toHaveTextContent('quoted insight')
    expect(quickPreview.querySelector('code')).toHaveTextContent('inline code')
    expect(quickPreview.querySelector('img')).toBeNull()
    expect(quickPreview).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(within(quickPreview).getByRole('link', { name: 'safe link' })).toHaveAttribute(
      'target',
      '_blank',
    )
    expect(within(quickPreview).getByRole('link', { name: 'safe link' })).toHaveAttribute(
      'rel',
      'noreferrer',
    )
  })

  it('renders the same markdown blocks in detail-read as quick preview', async () => {
    const markdownContent = [
      '# Shared Markdown',
      '',
      '- first shared item',
      '- second shared item',
      '',
      '> shared quote',
      '',
      '```ts',
      'const value = 42',
      '```',
    ].join('\n')
    const note = makeQuickNote({
      id: 'detail-markdown-note',
      content: markdownContent,
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id

    render(createElement(QuickNotesView))

    const detailRead = screen.getByLabelText('小记沉浸阅读')
    expect(within(detailRead).getByRole('heading', {
      level: 1,
      name: 'Shared Markdown',
    })).toBeInTheDocument()
    expect(within(detailRead).getAllByRole('listitem')).toHaveLength(2)
    expect(detailRead.querySelector('blockquote')).toHaveTextContent('shared quote')
    expect(detailRead.querySelector('pre code')).toHaveTextContent('const value = 42')
  })

  it('opens detail-read from the explicit read action', async () => {
    const note = makeQuickNote({
      id: 'detail-entry-note',
      content: '沉浸阅读入口\n正文',
    })
    storeMocks.state.quickNotes = [note]

    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.doubleClick(await screen.findByRole('button', { name: /沉浸阅读入口/ }))
    expect(screen.getByLabelText('小记快速预览')).toHaveTextContent('沉浸阅读入口')

    fireEvent.click(await screen.findByRole('button', { name: '阅读小记' }))

    expect(storeMocks.enterDetailRead).toHaveBeenCalledWith('detail-entry-note')

    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id
    rerender(createElement(QuickNotesView))
    expect(screen.queryByLabelText('小记快速预览')).not.toBeInTheDocument()

    storeMocks.state.focusMode = 'normal'
    storeMocks.state.selectedQuickNoteId = null
    rerender(createElement(QuickNotesView))
    expect(screen.getByRole('button', { name: /沉浸阅读入口/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByLabelText('小记快速预览')).not.toBeInTheDocument()
  })

  it('renders detail-read and saves inline edits without touching composer draft', async () => {
    vi.useFakeTimers()
    let resolveUpdate: (() => void) | null = null
    storeMocks.updateQuickNote.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve
        }),
    )
    const note = makeQuickNote({
      id: 'inline-edit-note',
      content: '沉浸标题\n\n原始正文 #deep',
      tags: ['deep'],
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id

    render(createElement(QuickNotesView))

    expect(screen.getByLabelText('小记沉浸阅读')).toBeInTheDocument()
    expect(screen.getByText('沉浸阅读')).toHaveClass(
      'text-[color:var(--qn-subtle)]',
    )
    expect(screen.queryByText('Detail Read')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('小记内容')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const inlineEditor = screen.getByLabelText('详情小记内容')
    fireEvent.change(inlineEditor, {
      target: { value: '沉浸标题\n\n局部编辑后的正文 #deep' },
    })
    expect(screen.queryByLabelText('小记内容')).not.toBeInTheDocument()
    expect(screen.getByText('正在输入…')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })

    expect(screen.getByText('草稿未保存')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByText('保存中…')).toBeInTheDocument()

    await act(async () => {
      resolveUpdate?.()
      await Promise.resolve()
    })

    expect(storeMocks.updateQuickNote).toHaveBeenCalledWith('inline-edit-note', {
      content: '沉浸标题\n\n局部编辑后的正文 #deep',
    })
  })

  it('keeps a dirty detail inline draft when the selected note refreshes remotely', async () => {
    const note = makeQuickNote({
      id: 'inline-remote-note',
      content: '远端前标题\n\n原始正文',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id

    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const inlineEditor = screen.getByLabelText('详情小记内容')
    fireEvent.change(inlineEditor, {
      target: { value: '远端前标题\n\n我正在写的本地详情草稿' },
    })

    storeMocks.state.quickNotes = [
      {
        ...note,
        content: '远端前标题\n\n远端更新后的正文',
        updated_at: '2026-07-07T13:10:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    await waitFor(() => {
      expect(screen.getByLabelText('详情小记内容')).toHaveValue(
        '远端前标题\n\n我正在写的本地详情草稿',
      )
    })
    const conflictStatus = screen.getByText('远端有新版本').closest(
      '[data-quick-note-editor-status]',
    )
    expect(conflictStatus).toHaveAttribute('data-status', 'conflict')
    expect(conflictStatus).toHaveAttribute('aria-live', 'assertive')
    expect(
      screen.getByText('远端也更新了，自动保存已暂停。请选择处理方式。'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('远端内容已更新，已保留你正在编辑的本地草稿。请先处理冲突再保存。'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.keyDown(screen.getByLabelText('详情小记内容'), {
      ctrlKey: true,
      key: 'Enter',
    })
    expect(storeMocks.updateQuickNote).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalledWith('远端内容已更新，请先处理冲突')
    expect(toastMock.error).not.toHaveBeenCalledWith('小记保存失败', expect.anything())
  })

  it('requires an explicit choice before saving a dirty detail draft over remote content', async () => {
    const note = makeQuickNote({
      id: 'inline-remote-keep-local-note',
      content: '远端前标题\n\n原始正文',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id

    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('详情小记内容'), {
      target: { value: '远端前标题\n\n我要明确覆盖远端的草稿' },
    })

    storeMocks.state.quickNotes = [
      {
        ...note,
        content: '远端前标题\n\n远端已经更新',
        updated_at: '2026-07-07T13:10:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保留本地并覆盖' }))
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(storeMocks.updateQuickNote).toHaveBeenCalledWith(
        'inline-remote-keep-local-note',
        {
          content: '远端前标题\n\n我要明确覆盖远端的草稿',
        },
      )
    })
  })

  it('updates the detail snapshot after saving while the selected note is hidden by search', async () => {
    const note = makeQuickNote({
      id: 'inline-hidden-by-search-note',
      content: '搜索前详情标题\n\n原始正文',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }
    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id

    const { rerender } = render(createElement(QuickNotesView))

    expect(screen.getByLabelText('小记沉浸阅读')).toBeInTheDocument()

    storeMocks.state.searchQuery = 'unmatched'
    storeMocks.state.quickNotes = []
    rerender(createElement(QuickNotesView))

    expect(screen.getByLabelText('小记沉浸阅读')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('详情小记内容'), {
      target: {
        value: [
          '搜索后保存标题',
          '',
          '## 过滤期间保存的正文',
          '',
          '- 保存后的 Markdown 项',
        ].join('\n'),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(storeMocks.updateQuickNote).toHaveBeenCalledWith(
        'inline-hidden-by-search-note',
        {
          content: '搜索后保存标题\n\n## 过滤期间保存的正文\n\n- 保存后的 Markdown 项',
        },
      )
    })
    const detailRead = screen.getByLabelText('小记沉浸阅读')
    expect(detailRead).toHaveTextContent('过滤期间保存的正文')
    expect(within(detailRead).getByRole('heading', {
      level: 2,
      name: '过滤期间保存的正文',
    })).toBeInTheDocument()
    expect(within(detailRead).getByText('保存后的 Markdown 项').closest('li')).not.toBeNull()
  })

  it('adopts or merges remote content before detail inline saving', async () => {
    const note = makeQuickNote({
      id: 'inline-remote-merge-note',
      content: '合并标题\n\n原始正文',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id

    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('详情小记内容'), {
      target: { value: '合并标题\n\n本地草稿' },
    })

    storeMocks.state.quickNotes = [
      {
        ...note,
        content: '合并标题\n\n远端正文',
        updated_at: '2026-07-07T13:10:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '采用远端' }))
    expect(screen.getByLabelText('详情小记内容')).toHaveValue('合并标题\n\n远端正文')

    fireEvent.change(screen.getByLabelText('详情小记内容'), {
      target: { value: '合并标题\n\n再次本地草稿' },
    })
    storeMocks.state.quickNotes = [
      {
        ...note,
        content: '合并标题\n\n再次远端正文',
        updated_at: '2026-07-07T13:20:00.000Z',
      },
    ]
    rerender(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '合并到草稿' }))
    expect(screen.getByLabelText('详情小记内容')).toHaveValue(
      '合并标题\n\n再次本地草稿\n\n--- 远端版本 ---\n合并标题\n\n再次远端正文',
    )
  })

  it('hides an open quick preview when search filtering removes the card without focus-mode exit', async () => {
    const note = makeQuickNote({
      id: 'selected-filtered-active',
      content: '被搜索过滤的小记\n正文',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.lifecycleStateById = { [note.id]: 'active' }

    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.doubleClick(await screen.findByRole('button', { name: /被搜索过滤的小记/ }))
    expect(screen.queryByLabelText('小记轻详情')).not.toBeInTheDocument()
    expect(screen.getByLabelText('小记快速预览')).toHaveTextContent('被搜索过滤的小记')

    storeMocks.state.searchQuery = 'unmatched'
    storeMocks.state.quickNotes = []
    rerender(createElement(QuickNotesView))

    expect(screen.queryByLabelText('小记轻详情')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('小记快速预览')).not.toBeInTheDocument()
    expect(screen.getByText('没有匹配的小记')).toBeInTheDocument()
    expect(screen.queryByLabelText('小记原位阅读')).not.toBeInTheDocument()
    expect(storeMocks.exitFocus).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalledWith('当前小记已在同步中移除/移入回收站')

    storeMocks.state.searchQuery = ''
    storeMocks.state.quickNotes = [note]
    rerender(createElement(QuickNotesView))

    expect(screen.getByRole('button', { name: /被搜索过滤的小记/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByLabelText('小记快速预览')).not.toBeInTheDocument()
  })

  it('hides an open quick preview when the note lifecycle moves out of active', async () => {
    const note = makeQuickNote({
      id: 'selected-quick-preview-trashed',
      content: '快速预览生命周期\n正文',
    })
    storeMocks.state.quickNotes = [note]

    const { rerender } = render(createElement(QuickNotesView))

    fireEvent.doubleClick(await screen.findByRole('button', { name: /快速预览生命周期/ }))
    expect(screen.queryByLabelText('小记轻详情')).not.toBeInTheDocument()
    expect(screen.getByLabelText('小记快速预览')).toHaveTextContent('快速预览生命周期')

    storeMocks.state.quickNotes = []
    storeMocks.state.lifecycleStateById = { [note.id]: 'trashed' }
    rerender(createElement(QuickNotesView))

    expect(screen.queryByLabelText('小记快速预览')).not.toBeInTheDocument()
    expect(storeMocks.exitFocus).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalledWith('当前小记已移入回收站')
  })

  it.each([
    ['detail-read', '小记沉浸阅读', /移到回收站/, 'delete'],
    ['detail-read', '小记沉浸阅读', /转为笔记/, 'migrate'],
  ] as const)(
    'exits %s after successful %s panel action',
    async (focusMode, label, actionName, action) => {
      const note = makeQuickNote({
        id: `${focusMode}-${action}-exit`,
        content: '详情动作退出\n正文',
      })
      storeMocks.state.quickNotes = [note]
      storeMocks.state.focusMode = focusMode
      storeMocks.state.selectedQuickNoteId = note.id

      render(createElement(QuickNotesView))

      const activePanel = screen.getByLabelText(label)
      expect(activePanel).toBeInTheDocument()
      fireEvent.click(within(activePanel).getAllByRole('button', { name: actionName })[0])

      await waitFor(() => {
        if (action === 'delete') {
          expect(storeMocks.deleteQuickNote).toHaveBeenCalledWith(note.id)
        } else {
          expect(storeMocks.migrateToNote).toHaveBeenCalledWith(note.id)
        }
        expect(storeMocks.exitFocus).toHaveBeenCalled()
      })
    },
  )

  it.each([
    ['converted', '当前小记已迁移为笔记'],
    ['trashed', '当前小记已移入回收站'],
    ['sync-deleted', '当前小记已在同步中移除/移入回收站'],
  ] as const)(
    'exits detail-read when the selected note becomes %s',
    async (lifecycleState, message) => {
      const note = makeQuickNote({
        id: `selected-${lifecycleState}`,
        content: '即将离开的详情态\n正文',
      })
      storeMocks.state.quickNotes = [note]
      storeMocks.state.focusMode = 'detail-read'
      storeMocks.state.selectedQuickNoteId = note.id

      const { rerender } = render(createElement(QuickNotesView))

      expect(screen.getByLabelText('小记沉浸阅读')).toBeInTheDocument()

      storeMocks.state.quickNotes = []
      storeMocks.state.lifecycleStateById = { [note.id]: lifecycleState }
      rerender(createElement(QuickNotesView))

      await waitFor(() => {
        expect(storeMocks.exitFocus).toHaveBeenCalled()
      })
      expect(toastMock).toHaveBeenCalledWith(message)
    },
  )

  it('cancels detail inline editing with Escape without closing detail-read', async () => {
    const note = makeQuickNote({
      id: 'inline-escape-note',
      content: '沉浸 Esc 标题\n\n原始正文',
    })
    storeMocks.state.quickNotes = [note]
    storeMocks.state.focusMode = 'detail-read'
    storeMocks.state.selectedQuickNoteId = note.id

    render(createElement(QuickNotesView))

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const inlineEditor = screen.getByLabelText('详情小记内容')
    fireEvent.change(inlineEditor, {
      target: { value: '沉浸 Esc 标题\n\n未保存草稿' },
    })
    fireEvent.keyDown(inlineEditor, { key: 'Escape' })

    expect(screen.queryByLabelText('详情小记内容')).not.toBeInTheDocument()
    expect(screen.getByLabelText('小记沉浸阅读')).toBeInTheDocument()
    expect(storeMocks.exitFocus).not.toHaveBeenCalled()
  })
})
