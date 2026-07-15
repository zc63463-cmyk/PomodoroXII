'use client'

import { createElement, useCallback, useEffect, useState } from 'react'
import { Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { QuickNotesWorkspace } from '@/components/quick-notes/quick-notes-workspace'
import { useQuickNoteEditor } from '@/components/quick-notes/use-quick-note-editor'
import { useQuickNoteItemActions } from '@/components/quick-notes/use-quick-note-item-actions'
import { getQuickNoteRepositoryUserMessage } from '@/lib/quick-notes/quick-note-repository'
import { ensureQuickNotePreviewSpace } from '@/lib/quick-notes/quick-note-preview'
import { useQuickNoteStore } from '@/stores/quick-note-store'

export function QuickNotesView() {
  const {
    allQuickNotes,
    quickNotes,
    trashedQuickNotes,
    syncStatusById,
    lifecycleStateById,
    isLoading,
    error,
    searchQuery,
    selectedTagFilters,
    tagFilterMode,
    selectedDate,
    focusMode,
    selectedQuickNoteId,
    loadQuickNotes,
    projectCommittedQuickNote,
    updateQuickNote,
    deleteQuickNote,
    restoreQuickNote,
    purgeQuickNote,
    togglePin,
    migrateToNote,
    renameQuickNoteTag,
    cleanupQuickNoteTags,
    toggleTagFilter,
    clearTagFilters,
    setTagFilterMode,
    toggleSelectedDate,
    clearSelectedDate,
    toggleFocusEdit,
    enterDetailRead,
    exitFocus,
  } = useQuickNoteStore()
  const [showTrash, setShowTrash] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        await ensureQuickNotePreviewSpace()
        if (!cancelled) await loadQuickNotes()
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : 'QuickNote 预览初始化失败'
          setPreviewError(message)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [loadQuickNotes])

  const describeQuickNoteError = useCallback(
    (error: unknown, fallback: string) => getQuickNoteRepositoryUserMessage(error, fallback),
    [],
  )
  const {
    cancelEdit,
    discardNewDraft,
    draft,
    draftConflict,
    draftSaveState,
    editingId,
    editingNote,
    isTyping,
    keepLocalDraft,
    mergeRemoteDraft,
    saveState,
    setDraft,
    startEdit,
    submitDraft,
    useRemoteDraft,
  } = useQuickNoteEditor({
    quickNotes,
    trashedQuickNotes,
    projectCommittedQuickNote,
    describeQuickNoteError,
    lifecycleStateById,
  })
  const {
    moveToTrashWithUndo,
    migrateToNoteWithPending,
    purgeFromTrash,
    restoreFromTrash,
    timelinePendingById,
    togglePinWithPending,
    trashPendingById,
  } = useQuickNoteItemActions({
    quickNotes,
    editingId,
    cancelEdit,
    deleteQuickNote,
    restoreQuickNote,
    purgeQuickNote,
    togglePin,
    migrateToNote,
    describeQuickNoteError,
  })

  function clearSearch() {
    void loadQuickNotes({ query: '' })
  }

  return createElement(
    'main',
    {
      className: quickNoteStyles.page,
      'data-quicknote-visual-style': 'apple-notes',
    },
    createElement(
      'div',
      {
        className: `${focusMode === 'detail-read' ? quickNoteStyles.shell : quickNoteStyles.shellWide} ${quickNoteStyles.surface}`,
      },
      createElement(
        'header',
        { className: quickNoteStyles.header },
        createElement(
          'div',
          null,
          createElement(
            'p',
            {
              className: quickNoteStyles.eyebrow,
            },
            'Quick Notes',
          ),
          createElement(
            'h1',
            { className: quickNoteStyles.title },
            '速记',
          ),
          createElement(
            'p',
            { className: quickNoteStyles.subtitle },
            '像 Memos 一样快速写下想法，先本地保存，再慢慢沉淀成笔记。',
          ),
        ),
        createElement(
          'div',
          { className: quickNoteStyles.headerActions },
          createElement(
            Button,
            {
              type: 'button',
              variant: 'outline',
              onClick: () => setShowTrash((value) => !value),
              'aria-pressed': showTrash,
              className: quickNoteStyles.outlineButton,
            },
            createElement(Trash2Icon),
            `回收站${trashedQuickNotes.length > 0 ? ` ${trashedQuickNotes.length}` : ''}`,
          ),
        ),
      ),
      createElement(QuickNotesWorkspace, {
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
        onDraftChange: setDraft,
        onDiscardDraft: discardNewDraft,
        onCancelEdit: cancelEdit,
        onSubmit: submitDraft,
        onKeepLocalDraft: keepLocalDraft,
        onUseRemoteDraft: useRemoteDraft,
        onMergeRemoteDraft: mergeRemoteDraft,
        saveState,
        showTrash,
        trashPendingById,
        timelinePendingById,
        onSearchChange: (query: string) => void loadQuickNotes({ query }),
        onClearSearch: clearSearch,
        onTagClick: (tag: string) => void loadQuickNotes({ query: `#${tag}` }),
        onToggleTagFilter: toggleTagFilter,
        onClearTagFilters: clearTagFilters,
        onSetTagFilterMode: setTagFilterMode,
        onRenameTag: renameQuickNoteTag,
        onCleanupTags: cleanupQuickNoteTags,
        onToggleSelectedDate: toggleSelectedDate,
        onClearSelectedDate: clearSelectedDate,
        onEdit: startEdit,
        onRestore: restoreFromTrash,
        onPurge: purgeFromTrash,
        onTogglePin: togglePinWithPending,
        onDelete: moveToTrashWithUndo,
        onMigrate: migrateToNoteWithPending,
        onOpenDetail: enterDetailRead,
        onToggleFocusEdit: toggleFocusEdit,
        onExitFocus: exitFocus,
        onUpdateQuickNote: updateQuickNote,
      }),
    ),
  )
}
