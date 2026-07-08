import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TrashView } from '@/components/trash/trash-view'
import type { Folder, Note, QuickNote } from '@/types'

vi.mock('lucide-react', () => ({
  ArchiveRestoreIcon: () => createElement('span', { 'data-testid': 'restore-icon' }),
  FileTextIcon: () => createElement('span', { 'data-testid': 'quick-note-icon' }),
  FolderIcon: () => createElement('span', { 'data-testid': 'folder-icon' }),
  NotebookTextIcon: () => createElement('span', { 'data-testid': 'note-icon' }),
  RefreshCwIcon: () => createElement('span', { 'data-testid': 'refresh-icon' }),
  Trash2Icon: () => createElement('span', { 'data-testid': 'trash-icon' }),
}))

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn((_message: string) => undefined), {
    error: vi.fn((_message: string, _options?: { description?: string }) => undefined),
  }),
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

vi.mock('@/components/ui/card', () => ({
  Card: ({
    children,
    size: _size,
    ...props
  }: {
    children?: ReactNode
    size?: string
    [key: string]: unknown
  }) => createElement('div', props, children),
  CardAction: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => createElement('div', props, children),
  CardContent: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => createElement('div', props, children),
  CardDescription: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => createElement('div', props, children),
  CardHeader: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => createElement('div', props, children),
  CardTitle: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => createElement('div', props, children),
}))

const storeMocks = vi.hoisted(() => ({
  state: {
    trashedNotes: [] as Note[],
    trashedQuickNotes: [] as QuickNote[],
    trashedFolders: [] as Folder[],
    isLoading: false,
    error: null as string | null,
    loadTrashed: vi.fn().mockResolvedValue(undefined),
    restoreNote: vi.fn().mockResolvedValue(undefined),
    restoreQuickNote: vi.fn().mockResolvedValue(undefined),
    restoreFolder: vi.fn().mockResolvedValue(undefined),
    purgeNote: vi.fn().mockResolvedValue(undefined),
    purgeQuickNote: vi.fn().mockResolvedValue(undefined),
    purgeFolder: vi.fn().mockResolvedValue(undefined),
    emptyTrash: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/stores/trash-store', () => ({
  useTrashStore: () => storeMocks.state,
}))

describe('TrashView', () => {
  beforeEach(() => {
    storeMocks.state.trashedNotes = []
    storeMocks.state.trashedQuickNotes = []
    storeMocks.state.trashedFolders = []
    storeMocks.state.isLoading = false
    storeMocks.state.error = null
    storeMocks.state.loadTrashed.mockClear()
    storeMocks.state.restoreNote.mockClear()
    storeMocks.state.restoreQuickNote.mockClear()
    storeMocks.state.restoreFolder.mockClear()
    storeMocks.state.purgeNote.mockClear()
    storeMocks.state.purgeQuickNote.mockClear()
    storeMocks.state.purgeFolder.mockClear()
    storeMocks.state.emptyTrash.mockClear()
    toastMock.mockClear()
    toastMock.error.mockClear()
  })

  it('loads trash and renders the unified empty state', async () => {
    render(createElement(TrashView))

    expect(await screen.findByRole('heading', { name: '回收站' })).toBeInTheDocument()
    expect(screen.getByText('回收站是空的')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /清空回收站/ })).toBeDisabled()
    expect(storeMocks.state.loadTrashed).toHaveBeenCalledTimes(1)
  })

  it('renders notes, quick notes, and folders with restore and purge actions', async () => {
    storeMocks.state.trashedNotes = [
      makeNote({
        id: 'note-1',
        title: '待恢复笔记',
        summary: '笔记摘要',
        trashed_at: '2026-07-07T13:30:00.000Z',
      }),
    ]
    storeMocks.state.trashedQuickNotes = [
      makeQuickNote({
        id: 'quick-1',
        content: '待恢复小记\n第二行',
        trashed_at: '2026-07-07T13:31:00.000Z',
      }),
    ]
    storeMocks.state.trashedFolders = [
      makeFolder({
        id: 'folder-1',
        name: '待恢复文件夹',
        trashed_at: '2026-07-07T13:32:00.000Z',
      }),
    ]

    render(createElement(TrashView))

    expect(await screen.findByText('待恢复笔记')).toBeInTheDocument()
    expect(screen.getByText('待恢复小记')).toBeInTheDocument()
    expect(screen.getByText('待恢复文件夹')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '恢复笔记 待恢复笔记' }))
    await waitFor(() => {
      expect(storeMocks.state.restoreNote).toHaveBeenCalledWith('note-1')
      expect(toastMock).toHaveBeenCalledWith('笔记已恢复')
    })

    fireEvent.click(screen.getByRole('button', { name: '彻删小记 待恢复小记' }))
    await waitFor(() => {
      expect(storeMocks.state.purgeQuickNote).toHaveBeenCalledWith('quick-1')
      expect(toastMock).toHaveBeenCalledWith('小记已彻底删除')
    })
  })

  it('shows store errors and runs empty trash from the page header', async () => {
    storeMocks.state.error = 'Trash load failed'
    storeMocks.state.trashedFolders = [
      makeFolder({
        id: 'folder-1',
        name: '待清空文件夹',
        trashed_at: '2026-07-07T13:32:00.000Z',
      }),
    ]

    render(createElement(TrashView))

    expect(await screen.findByText('Trash load failed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /清空回收站/ }))

    await waitFor(() => {
      expect(storeMocks.state.emptyTrash).toHaveBeenCalledTimes(1)
      expect(toastMock).toHaveBeenCalledWith('回收站已清空')
    })
  })
})

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = '2026-07-07T12:00:00.000Z'
  return {
    id: 'note-id',
    title: 'Note title',
    content: 'Note content',
    summary: 'Note summary',
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

function makeQuickNote(overrides: Partial<QuickNote> = {}): QuickNote {
  const now = '2026-07-07T12:00:00.000Z'
  return {
    id: 'quick-note-id',
    content: 'Quick note',
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

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  const now = '2026-07-07T12:00:00.000Z'
  return {
    id: 'folder-id',
    name: 'Folder name',
    parent_id: null,
    icon: null,
    color: null,
    sort_order: 0,
    is_system: false,
    trashed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}
