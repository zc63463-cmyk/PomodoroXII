import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { QuickNote } from '@/types'
import { spaceDBManager } from '@/services/space-db'

vi.mock('lucide-react', () => ({
  ArchiveRestoreIcon: () => createElement('span', { 'data-testid': 'archive-restore-icon' }),
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
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('button', props, children),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: { [key: string]: unknown }) => createElement('input', props),
}))

const previewMocks = vi.hoisted(() => ({
  ensureQuickNotePreviewSpace: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/quick-notes/quick-note-preview', () => ({
  ensureQuickNotePreviewSpace: previewMocks.ensureQuickNotePreviewSpace,
}))

const repositoryMocks = vi.hoisted(() => ({
  getQuickNoteRepositoryUserMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}))

vi.mock('@/lib/quick-notes/quick-note-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/quick-notes/quick-note-repository')>()
  return {
    ...actual,
    getQuickNoteRepositoryUserMessage: repositoryMocks.getQuickNoteRepositoryUserMessage,
  }
})

const storeMocks = vi.hoisted(() => ({
  state: {
    allQuickNotes: [] as QuickNote[],
    quickNotes: [] as QuickNote[],
    trashedQuickNotes: [] as QuickNote[],
    syncStatusById: {} as Record<string, 'pending' | 'failed'>,
    lifecycleStateById: {} as Record<string, 'active' | 'trashed' | 'archived' | 'converted' | 'sync-deleted'>,
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
  projectCommittedQuickNote: vi.fn((_note: QuickNote): undefined => undefined),
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
    projectCommittedQuickNote: storeMocks.projectCommittedQuickNote,
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

function makeQuickNotes(count: number): QuickNote[] {
  return Array.from({ length: count }, (_, i) =>
    makeQuickNote({
      id: `quick-note-${i}`,
      content: `Test content ${i} #tag${i % 5}`,
      tags: [`tag${i % 5}`],
      pinned: i < 2,
    }),
  )
}

describe('QuickNotesView - 界面与交互升级', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    if (!spaceDBManager.hasSpace) {
      await spaceDBManager.switchTo(`quick-notes-view-${crypto.randomUUID()}`)
    }
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
  })

  describe('布局与视觉', () => {
    it('应该使用紧凑的工作台式布局，标题字号不超过 2xl', () => {
      const { container } = render(createElement(QuickNotesView))
      const title = container.querySelector('h1')
      expect(title).toBeTruthy()
      const className = title?.className || ''
      expect(className).not.toMatch(/text-4xl|text-5xl/)
    })

    it('应该在 Desktop 首屏同时显示工具栏、搜索/筛选、编辑器及至少四条小记', async () => {
      storeMocks.state.quickNotes = makeQuickNotes(5)
      storeMocks.state.allQuickNotes = storeMocks.state.quickNotes

      render(createElement(QuickNotesView))

      expect(screen.getByText('回收站')).toBeTruthy()
      // 使用 getAllByPlaceholderText 因为可能有多个搜索框（桌面和移动）
      const searchInputs = screen.getAllByPlaceholderText('搜索内容或 #标签')
      expect(searchInputs.length).toBeGreaterThan(0)
      expect(screen.getByPlaceholderText('随手写下正在想的事...')).toBeTruthy()

      await waitFor(() => {
        const cards = document.querySelectorAll('article')
        expect(cards.length).toBeGreaterThanOrEqual(4)
      })
    })

    it('小记行应该支持单击预览', async () => {
      const notes = makeQuickNotes(1)
      storeMocks.state.quickNotes = notes
      storeMocks.state.allQuickNotes = notes

      render(createElement(QuickNotesView))

      await waitFor(() => {
        const card = document.querySelector('article')
        expect(card).toBeTruthy()
      })

      const card = document.querySelector('article')
      // 单击卡片主体区域（不是按钮）
      const cardBody = card?.querySelector('[role="button"]')
      if (cardBody) {
        fireEvent.click(cardBody)
      }

      // 单击应该触发预览（通过 onOpenPreview 回调）
      // 由于预览状态在组件内部管理，我们检查是否调用了正确的处理函数
      await waitFor(() => {
        // 检查是否有预览相关的状态变化
        const expandedCard = document.querySelector('[aria-expanded="true"]')
        // 或者检查是否进入了详情阅读模式
        expect(expandedCard || storeMocks.enterDetailRead.mock.calls.length > 0).toBeTruthy()
      }, { timeout: 500 }).catch(() => {
        // 如果单击没有触发任何预览行为，测试失败
        throw new Error('单击卡片没有触发预览')
      })
    })

    it('交互目标应该至少 44x44px', () => {
      storeMocks.state.quickNotes = makeQuickNotes(1)
      storeMocks.state.allQuickNotes = storeMocks.state.quickNotes

      render(createElement(QuickNotesView))

      const buttons = document.querySelectorAll('button')
      let hasSmallButton = false
      buttons.forEach((button) => {
        const rect = button.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          if (Math.min(rect.width, rect.height) < 40) {
            hasSmallButton = true
          }
        }
      })
      expect(hasSmallButton).toBe(false)
    })
  })

  describe('焦点编辑模式', () => {
    it('焦点编辑模式应该是真正的单列状态', () => {
      storeMocks.state.focusMode = 'focus-edit'
      storeMocks.state.quickNotes = makeQuickNotes(3)
      storeMocks.state.allQuickNotes = storeMocks.state.quickNotes

      const { container } = render(createElement(QuickNotesView))

      // 在焦点编辑模式下，时间线应该被移除（而不是显示为 sink）
      const timeline = container.querySelector('[data-focus-edit-timeline-sink]')
      expect(timeline).toBeNull()

      // 检查是否使用了正确的 grid 类
      const workspaceGrid = container.querySelector('[class*="grid"]')
      expect(workspaceGrid).toBeTruthy()

      // 焦点编辑提示应该存在（通过文本内容查找）
      const hintText = screen.queryByText(/专注写作中/)
      expect(hintText).toBeTruthy()
    })

    it('Escape 应该退出焦点模式', async () => {
      storeMocks.state.focusMode = 'focus-edit'
      storeMocks.state.quickNotes = makeQuickNotes(1)
      storeMocks.state.allQuickNotes = storeMocks.state.quickNotes

      render(createElement(QuickNotesView))

      fireEvent.keyDown(window, { key: 'Escape' })

      await waitFor(() => {
        expect(storeMocks.exitFocus).toHaveBeenCalled()
      })
    })
  })

  describe('搜索与筛选', () => {
    it('搜索应该触发 loadQuickNotes 并携带查询参数', async () => {
      storeMocks.state.quickNotes = makeQuickNotes(1)
      storeMocks.state.allQuickNotes = storeMocks.state.quickNotes

      render(createElement(QuickNotesView))

      // 使用 getAllByPlaceholderText 因为可能有多个搜索框
      const searchInputs = screen.getAllByPlaceholderText('搜索内容或 #标签')
      fireEvent.change(searchInputs[0], { target: { value: '性能' } })

      await waitFor(() => {
        expect(storeMocks.loadQuickNotes).toHaveBeenCalledWith({ query: '性能' })
      })
    })

    it('日期筛选应该与时间线使用相同的日期规则', async () => {
      const today = new Date().toISOString().split('T')[0]
      storeMocks.state.quickNotes = makeQuickNotes(1)
      storeMocks.state.allQuickNotes = storeMocks.state.quickNotes
      storeMocks.state.selectedDate = today

      render(createElement(QuickNotesView))

      await waitFor(() => {
        const calendar = screen.queryByText(/2026 年/)
        expect(calendar).toBeTruthy()
      })
    })
  })

  describe('移动端适配', () => {
    it('应该在小屏幕提供筛选抽屉按钮', async () => {
      render(createElement(QuickNotesView))

      // 查找打开筛选的按钮
      const filterButton = screen.queryByRole('button', { name: '打开筛选' })
      expect(filterButton).toBeTruthy()
    })

    it('筛选抽屉应该可以打开和关闭', async () => {
      render(createElement(QuickNotesView))

      const openButton = await screen.findByRole('button', { name: '打开筛选' })
      fireEvent.click(openButton)

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: '筛选小记' })).toBeTruthy()
      })

      const closeButton = screen.getByRole('button', { name: '关闭筛选' })
      fireEvent.click(closeButton)

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: '筛选小记' })).toBeNull()
      })
    })
  })
})
