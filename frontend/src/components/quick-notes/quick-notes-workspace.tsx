'use client'

import { createElement, FormEvent, ReactNode, useEffect, useMemo, useState } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { QuickNoteComposer, type QuickNoteSaveState } from '@/components/quick-notes/quick-note-composer'
import { QuickNoteConflictPanel, type QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import { QuickNoteDetailPanel } from '@/components/quick-notes/quick-note-detail-panel'
import { QuickNoteReadView } from '@/components/quick-notes/quick-note-read-view'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { QuickNoteTimeline } from '@/components/quick-notes/quick-note-timeline'
import { TrashPanel } from '@/components/quick-notes/trash-panel'
import {
  getSelectedQuickNote,
  isDetailRead,
  isFocusEdit,
  isFocusRead,
} from '@/lib/quick-notes/quick-note-focus'
import { groupQuickNotesByDate } from '@/lib/quick-notes/quick-note-selectors'
import type {
  QuickNoteLifecycleState,
  QuickNoteSyncStatus,
} from '@/lib/quick-notes/quick-note-repository'
import type { QuickNoteFocusMode } from '@/stores/quick-note-store'
import type { QuickNote } from '@/types'

interface QuickNotesWorkspaceProps {
  quickNotes: QuickNote[]
  trashedQuickNotes: QuickNote[]
  syncStatusById: Record<string, QuickNoteSyncStatus>
  lifecycleStateById: Record<string, QuickNoteLifecycleState>
  isLoading: boolean
  error: string | null
  previewError: string | null
  searchQuery: string
  focusMode: QuickNoteFocusMode
  selectedQuickNoteId: string | null
  draft: string
  draftConflict: QuickNoteDraftConflict | null
  editingNote: QuickNote | null
  isTyping: boolean
  saveState: QuickNoteSaveState
  showTrash: boolean
  trashPendingById: Record<string, 'restore' | 'purge'>
  timelinePendingById: Record<string, 'delete' | 'pin' | 'migrate'>
  onDraftChange: (value: string) => void
  onCancelEdit: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => boolean | Promise<boolean>
  onKeepLocalDraft: () => void
  onUseRemoteDraft: () => void
  onMergeRemoteDraft: () => void
  onSearchChange: (query: string) => void
  onClearSearch: () => void
  onTagClick: (tag: string) => void
  onEdit: (note: QuickNote) => void
  onRestore: (id: string) => boolean | void | Promise<boolean | void>
  onPurge: (id: string) => boolean | void | Promise<boolean | void>
  onTogglePin: (id: string) => boolean | void | Promise<boolean | void>
  onDelete: (id: string) => boolean | Promise<boolean>
  onMigrate: (id: string) => boolean | Promise<boolean>
  onOpenPreview: (id: string) => void
  onOpenDetail: (id: string) => void
  onToggleFocusEdit: () => void
  onExitFocus: () => void
  onUpdateQuickNote: (id: string, data: { content: string }) => Promise<void>
}

export function QuickNotesWorkspace({
  quickNotes,
  trashedQuickNotes,
  syncStatusById,
  lifecycleStateById,
  isLoading,
  error,
  previewError,
  searchQuery,
  focusMode,
  selectedQuickNoteId,
  draft,
  draftConflict,
  editingNote,
  isTyping,
  saveState,
  showTrash,
  trashPendingById,
  timelinePendingById,
  onDraftChange,
  onCancelEdit,
  onSubmit,
  onKeepLocalDraft,
  onUseRemoteDraft,
  onMergeRemoteDraft,
  onSearchChange,
  onClearSearch,
  onTagClick,
  onEdit,
  onRestore,
  onPurge,
  onTogglePin,
  onDelete,
  onMigrate,
  onOpenPreview,
  onOpenDetail,
  onToggleFocusEdit,
  onExitFocus,
  onUpdateQuickNote,
}: QuickNotesWorkspaceProps) {
  const groups = useMemo(() => groupQuickNotesByDate(quickNotes), [quickNotes])
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
  const focusReadNote = isFocusRead(focusMode) ? selectedNote : null

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
    if (!selectedQuickNoteId) return
    if (!isFocusRead(focusMode) && !isDetailRead(focusMode)) return
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
    onOpenPreview,
    onClosePreview: onExitFocus,
    onOpenDetail,
    onTogglePin: (id: string) => void onTogglePin(id),
    onDelete: (id: string) => void onDelete(id),
    onMigrate: (id: string) => void onMigrate(id),
    onTagClick,
    pendingById: timelinePendingById,
    selectedQuickNoteId: isFocusRead(focusMode) ? selectedQuickNoteId : null,
    syncStatusById,
    searchQuery,
    disabledInteractions: isFocusEdit(focusMode),
  })

  return createElement(
    WorkspaceMotion,
    { keyName: focusMode, className: quickNoteStyles.workspaceStage },
    createElement(
      'div',
      {
        className: isFocusEdit(focusMode)
          ? quickNoteStyles.focusEditGrid
          : focusReadNote
            ? `${quickNoteStyles.workspaceGrid} lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]`
          : quickNoteStyles.workspaceGrid,
      },
      createElement(
        'div',
        { className: quickNoteStyles.workspaceMain },
        createElement(QuickNoteComposer, {
          draft,
          editingNote,
          hasConflict: draftConflict !== null,
          isTyping,
          onDraftChange,
          onCancelEdit,
          onSubmit: handleComposerSubmit,
          saveState,
          variant: isFocusEdit(focusMode) ? 'focus' : 'compact',
          isFocusMode: isFocusEdit(focusMode),
          onToggleFocus: onToggleFocusEdit,
        }),
        createElement(QuickNoteConflictPanel, {
          conflict: draftConflict,
          onKeepLocal: onKeepLocalDraft,
          onUseRemote: onUseRemoteDraft,
          onMerge: onMergeRemoteDraft,
        }),
        isFocusEdit(focusMode)
          ? createElement(
              'div',
              { className: quickNoteStyles.focusEditHint },
              '专注写作中：Ctrl/Cmd + Enter 保存，Esc 返回工作台。',
            )
          : createElement(SearchBox, {
              searchQuery,
              onSearchChange,
              onClearSearch,
            }),
        createElement(FeedbackBlocks, { previewError, error }),
        showTrash
          ? createElement(TrashPanel, {
              notes: trashedQuickNotes,
              onRestore,
              onPurge,
              pendingById: trashPendingById,
            })
          : null,
        isFocusEdit(focusMode)
          ? createElement(
              'div',
              {
                className: quickNoteStyles.timelineDimmed,
                'aria-hidden': true,
                inert: true,
              },
              timeline,
          )
        : timeline,
      ),
      focusReadNote
        ? createElement(QuickNoteDetailPanel, {
            note: focusReadNote,
            syncStatus: selectedSyncStatus,
            pendingAction: selectedPendingAction,
            onClose: onExitFocus,
            onOpenDetail,
            onTogglePin,
            onDelete: async (id: string) => {
              const ok = await onDelete(id)
              if (ok) onExitFocus()
            },
            onMigrate: async (id: string) => {
              const ok = await onMigrate(id)
              if (ok) onExitFocus()
            },
          })
        : null,
    ),
  )
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
      key: keyName,
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
