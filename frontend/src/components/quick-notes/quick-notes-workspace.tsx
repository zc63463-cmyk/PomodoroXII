'use client'

import { createElement, FormEvent, ReactNode, useEffect, useMemo, useState } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  QuickNoteComposer,
  type QuickNoteDraftSaveState,
  type QuickNoteSaveState,
} from '@/components/quick-notes/quick-note-composer'
import { QuickNoteConflictPanel, type QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import { QuickNoteExplorer } from '@/components/quick-notes/quick-note-explorer'
import { QuickNoteReadView } from '@/components/quick-notes/quick-note-read-view'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { QuickNoteTimeline } from '@/components/quick-notes/quick-note-timeline'
import { TrashPanel } from '@/components/quick-notes/trash-panel'
import {
  getSelectedQuickNote,
  isDetailRead,
  isFocusEdit,
} from '@/lib/quick-notes/quick-note-focus'
import {
  getQuickNoteTagStats,
  groupQuickNotesByDate,
} from '@/lib/quick-notes/quick-note-selectors'
import {
  extractQuickNoteTags,
  normalizeQuickNoteTag,
} from '@/lib/quick-notes/quick-note-tags'
import type {
  QuickNoteLifecycleState,
  QuickNoteSyncStatus,
} from '@/lib/quick-notes/quick-note-repository'
import type { QuickNoteFocusMode } from '@/stores/quick-note-store'
import type { QuickNoteTagFilterMode } from '@/stores/quick-note-store'
import type { QuickNote } from '@/types'

interface QuickNotesWorkspaceProps {
  allQuickNotes: QuickNote[]
  quickNotes: QuickNote[]
  trashedQuickNotes: QuickNote[]
  syncStatusById: Record<string, QuickNoteSyncStatus>
  lifecycleStateById: Record<string, QuickNoteLifecycleState>
  isLoading: boolean
  error: string | null
  previewError: string | null
  searchQuery: string
  selectedTagFilters: string[]
  tagFilterMode: QuickNoteTagFilterMode
  selectedDate: string | null
  focusMode: QuickNoteFocusMode
  selectedQuickNoteId: string | null
  draft: string
  draftConflict: QuickNoteDraftConflict | null
  draftSaveState: QuickNoteDraftSaveState
  editingNote: QuickNote | null
  isTyping: boolean
  saveState: QuickNoteSaveState
  showTrash: boolean
  trashPendingById: Record<string, 'restore' | 'purge'>
  timelinePendingById: Record<string, 'delete' | 'pin' | 'migrate'>
  onDraftChange: (value: string) => void
  onDiscardDraft: () => void | Promise<void>
  onCancelEdit: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => boolean | Promise<boolean>
  onKeepLocalDraft: () => void
  onUseRemoteDraft: () => void
  onMergeRemoteDraft: () => void
  onSearchChange: (query: string) => void
  onClearSearch: () => void
  onTagClick: (tag: string) => void
  onToggleTagFilter: (tag: string) => void
  onClearTagFilters: () => void
  onSetTagFilterMode: (mode: QuickNoteTagFilterMode) => void
  onRenameTag: (from: string, to: string) => Promise<void>
  onCleanupTags: () => Promise<number>
  onToggleSelectedDate: (date: string) => void
  onClearSelectedDate: () => void
  onEdit: (note: QuickNote) => void
  onRestore: (id: string) => boolean | void | Promise<boolean | void>
  onPurge: (id: string) => boolean | void | Promise<boolean | void>
  onTogglePin: (id: string) => boolean | void | Promise<boolean | void>
  onDelete: (id: string) => boolean | Promise<boolean>
  onMigrate: (id: string) => boolean | Promise<boolean>
  onOpenDetail: (id: string) => void
  onToggleFocusEdit: () => void
  onExitFocus: () => void
  onUpdateQuickNote: (id: string, data: { content: string }) => Promise<void>
}

export function QuickNotesWorkspace({
  allQuickNotes,
  quickNotes,
  trashedQuickNotes,
  syncStatusById,
  lifecycleStateById,
  isLoading,
  error,
  previewError,
  searchQuery,
  selectedTagFilters,
  tagFilterMode,
  selectedDate,
  focusMode,
  selectedQuickNoteId,
  draft,
  draftConflict,
  draftSaveState,
  editingNote,
  isTyping,
  saveState,
  showTrash,
  trashPendingById,
  timelinePendingById,
  onDraftChange,
  onDiscardDraft,
  onCancelEdit,
  onSubmit,
  onKeepLocalDraft,
  onUseRemoteDraft,
  onMergeRemoteDraft,
  onSearchChange,
  onClearSearch,
  onTagClick,
  onToggleTagFilter,
  onClearTagFilters,
  onSetTagFilterMode,
  onRenameTag,
  onCleanupTags,
  onToggleSelectedDate,
  onClearSelectedDate,
  onEdit,
  onRestore,
  onPurge,
  onTogglePin,
  onDelete,
  onMigrate,
  onOpenDetail,
  onToggleFocusEdit,
  onExitFocus,
  onUpdateQuickNote,
}: QuickNotesWorkspaceProps) {
  const groups = useMemo(() => groupQuickNotesByDate(quickNotes), [quickNotes])
  const popularTags = useMemo(
    () => getQuickNoteTagStats(allQuickNotes).slice(0, 8).map((stat) => stat.tag),
    [allQuickNotes],
  )
  const [quickPreviewNoteId, setQuickPreviewNoteId] = useState<string | null>(null)
  const selectedLifecycleState = selectedQuickNoteId
    ? lifecycleStateById[selectedQuickNoteId]
    : undefined
  const selectedNoteFromList = getSelectedQuickNote(quickNotes, selectedQuickNoteId)
  const [selectedNoteSnapshotState, setSelectedNoteSnapshot] = useState<QuickNote | null>(null)
  const selectedNoteSnapshot =
    selectedQuickNoteId &&
    selectedLifecycleState === 'active' &&
    selectedNoteSnapshotState?.id === selectedQuickNoteId
      ? selectedNoteSnapshotState
      : null
  const selectedNote = selectedNoteFromList ?? selectedNoteSnapshot
  const isSearching = searchQuery.trim().length > 0
  const hasNotes = quickNotes.length > 0
  const selectedSyncStatus = selectedQuickNoteId
    ? syncStatusById[selectedQuickNoteId]
    : undefined
  const selectedPendingAction = selectedQuickNoteId
    ? timelinePendingById[selectedQuickNoteId]
    : undefined
  const isFocusEditing = isFocusEdit(focusMode)

  useEffect(() => {
    if (!selectedQuickNoteId || focusMode === 'normal') {
      setSelectedNoteSnapshot(null)
      return
    }
    if (selectedNoteFromList) {
      setSelectedNoteSnapshot(selectedNoteFromList)
    }
  }, [focusMode, selectedNoteFromList, selectedQuickNoteId])

  useEffect(() => {
    if (focusMode === 'normal') return

    setQuickPreviewNoteId(null)

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (isFocusEdit(focusMode) && editingNote) {
        onCancelEdit()
      }
      onExitFocus()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editingNote, focusMode, onCancelEdit, onExitFocus])

  useEffect(() => {
    if (!quickPreviewNoteId) return
    if (quickNotes.some((note) => note.id === quickPreviewNoteId)) return
    setQuickPreviewNoteId(null)
  }, [quickNotes, quickPreviewNoteId])

  useEffect(() => {
    if (!quickPreviewNoteId) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.key !== 'Escape') return
      event.preventDefault()
      setQuickPreviewNoteId(null)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [quickPreviewNoteId])

  useEffect(() => {
    if (!selectedQuickNoteId) return
    if (!isDetailRead(focusMode)) return
    if (selectedNote) return
    if (isLoading) return

    const lifecycleState = lifecycleStateById[selectedQuickNoteId]
    if (lifecycleState === 'active') return
    onExitFocus()
    if (lifecycleState === 'converted') {
      toast('当前小记已迁移为笔记')
      return
    }
    if (lifecycleState === 'archived') {
      toast('当前小记已归档')
      return
    }
    if (lifecycleState === 'trashed') {
      toast('当前小记已移入回收站')
      return
    }
    toast('当前小记已在同步中移除/移入回收站')
  }, [
    focusMode,
    isLoading,
    lifecycleStateById,
    onExitFocus,
    selectedNote,
    selectedQuickNoteId,
  ])

  async function handleComposerSubmit(event: FormEvent<HTMLFormElement>) {
    const saved = await onSubmit(event)
    if (saved && isFocusEdit(focusMode)) onExitFocus()
  }

  async function updateSelectedQuickNote(id: string, data: { content: string }) {
    await onUpdateQuickNote(id, data)
    setSelectedNoteSnapshot((current) => {
      const source =
        current?.id === id
          ? current
          : selectedNote?.id === id
            ? selectedNote
            : null
      if (!source) return current
      return {
        ...source,
        ...data,
        updated_at: new Date().toISOString(),
      }
    })
  }

  async function handleRenameTag(from: string, to: string) {
    const fromTag = normalizeQuickNoteTag(from)
    const toTag = normalizeQuickNoteTag(to)
    if (!fromTag || !toTag || fromTag === toTag) return

    try {
      await onRenameTag(fromTag, toTag)
      toast(`已将 #${fromTag} 重命名为 #${toTag}`)
    } catch (error) {
      toast.error('标签重命名失败')
      void error
    }
  }

  async function handleCleanupTags() {
    try {
      const changedCount = await onCleanupTags()
      toast(changedCount > 0 ? `已清理 ${changedCount} 条小记的标签` : '标签已是干净状态')
    } catch (error) {
      toast.error('标签清理失败')
      void error
    }
  }

  function handleInsertPopularTag(tag: string) {
    const normalizedTag = normalizeQuickNoteTag(tag)
    if (!normalizedTag || draftIncludesTag(draft, normalizedTag)) return

    const trimmedDraft = draft.trimEnd()
    onDraftChange(trimmedDraft ? `${trimmedDraft} #${normalizedTag}` : `#${normalizedTag} `)
  }

  if (isDetailRead(focusMode) && selectedNote) {
    return createElement(
      WorkspaceMotion,
      { keyName: 'detail-read', className: quickNoteStyles.workspaceStage },
      createElement(QuickNoteReadView, {
        note: selectedNote,
        syncStatus: selectedSyncStatus,
        pendingAction: selectedPendingAction,
        onClose: onExitFocus,
        onTogglePin,
        onDelete: async (id: string) => {
          const ok = await onDelete(id)
          if (ok) onExitFocus()
        },
        onMigrate: async (id: string) => {
          const ok = await onMigrate(id)
          if (ok) onExitFocus()
        },
        onUpdateQuickNote: updateSelectedQuickNote,
      }),
    )
  }

  const timeline = createElement(QuickNoteTimeline, {
    groups,
    isLoading,
    isSearching,
    hasNotes,
    onEdit,
    onOpenPreview: setQuickPreviewNoteId,
    onClosePreview: () => setQuickPreviewNoteId(null),
    onOpenDetail: (id: string) => {
      setQuickPreviewNoteId(null)
      onOpenDetail(id)
    },
    onTogglePin: (id: string) => void onTogglePin(id),
    onDelete: (id: string) => void onDelete(id),
    onMigrate: (id: string) => void onMigrate(id),
    onTagClick,
    pendingById: timelinePendingById,
    expandedQuickNoteId: quickPreviewNoteId,
    syncStatusById,
    searchQuery,
    disabledInteractions: isFocusEditing,
  })
  const explorer = createElement(QuickNoteExplorer, {
    notes: allQuickNotes,
    selectedTagFilters,
    tagFilterMode,
    selectedDate,
    topSlot: createElement(SearchBox, {
      searchQuery,
      onSearchChange,
      onClearSearch,
    }),
    onToggleTag: onToggleTagFilter,
    onClearTags: onClearTagFilters,
    onSetTagFilterMode,
    onRenameTag: handleRenameTag,
    onCleanupTags: handleCleanupTags,
    onToggleDate: onToggleSelectedDate,
    onClearDate: onClearSelectedDate,
  })
  const timelineSlot = isFocusEditing
    ? createElement(
        'div',
        {
          className: quickNoteStyles.focusEditTimelineSink,
          'data-focus-edit-timeline-sink': 'true',
          'aria-disabled': true,
        },
        timeline,
      )
    : timeline
  const mainColumn = createElement(
    'div',
    { className: quickNoteStyles.workspaceMain },
    createElement(QuickNoteComposer, {
      draft,
      editingNote,
      hasConflict: draftConflict !== null,
      isTyping,
      onDraftChange,
      onDiscardDraft,
      onCancelEdit,
      onSubmit: handleComposerSubmit,
      saveState,
      draftSaveState,
      variant: isFocusEditing ? 'focus' : 'compact',
      isFocusMode: isFocusEditing,
      onToggleFocus: onToggleFocusEdit,
      popularTags,
      onInsertTag: handleInsertPopularTag,
    }),
    createElement(QuickNoteConflictPanel, {
      conflict: draftConflict,
      onKeepLocal: onKeepLocalDraft,
      onUseRemote: onUseRemoteDraft,
      onMerge: onMergeRemoteDraft,
    }),
    isFocusEditing
      ? createElement(
          'div',
          { className: quickNoteStyles.focusEditHint },
          '专注写作中：Ctrl/Cmd + Enter 保存，Esc 返回工作台。',
        )
      : null,
    createElement(FeedbackBlocks, { previewError, error }),
    !isFocusEditing && showTrash
      ? createElement(TrashPanel, {
          notes: trashedQuickNotes,
          onRestore,
          onPurge,
          pendingById: trashPendingById,
        })
      : null,
    timelineSlot,
  )

  return createElement(
    WorkspaceMotion,
    { keyName: focusMode, className: quickNoteStyles.workspaceStage },
    createElement(
      'div',
      {
        className: isFocusEditing
          ? quickNoteStyles.focusEditGrid
          : quickNoteStyles.workspaceGrid,
      },
      explorer,
      mainColumn,
    ),
  )
}

function draftIncludesTag(draft: string, tag: string): boolean {
  const normalizedTag = normalizeQuickNoteTag(tag)
  if (!normalizedTag) return false

  if (extractQuickNoteTags(draft).includes(normalizedTag)) return true
  return draft.toLowerCase().split(/\s+/).includes(`#${normalizedTag}`)
}

function WorkspaceMotion({
  children,
  className,
  keyName,
}: {
  children?: ReactNode
  className: string
  keyName: string
}) {
  return createElement(
    'div',
    {
      className,
      'data-focus-stage': keyName,
    },
    children,
  )
}

function SearchBox({
  searchQuery,
  onSearchChange,
  onClearSearch,
}: {
  searchQuery: string
  onSearchChange: (query: string) => void
  onClearSearch: () => void
}) {
  return createElement(
    'div',
    { className: quickNoteStyles.searchWrap },
    createElement(SearchIcon, { className: quickNoteStyles.searchIcon }),
    createElement(Input, {
      value: searchQuery,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onSearchChange(event.target.value),
      placeholder: '搜索内容或 #标签',
      className: quickNoteStyles.searchInput,
      'aria-label': '搜索小记',
    }),
    searchQuery
      ? createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'icon-sm',
            onClick: onClearSearch,
            'aria-label': '清空搜索',
            className: quickNoteStyles.ghostButton,
          },
          createElement(XIcon),
        )
      : null,
  )
}

function FeedbackBlocks({
  previewError,
  error,
}: {
  previewError: string | null
  error: string | null
}) {
  return createElement(
    'div',
    { className: 'grid gap-2' },
    previewError
      ? createElement(
          'div',
          { className: quickNoteStyles.error },
          `预览初始化失败：${previewError}`,
        )
      : null,
    error
      ? createElement(
          'div',
          { className: quickNoteStyles.error },
          error,
        )
      : null,
  )
}
