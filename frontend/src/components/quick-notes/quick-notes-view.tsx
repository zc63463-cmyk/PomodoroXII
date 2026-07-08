'use client'

import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import { SearchIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { QuickNoteComposer } from '@/components/quick-notes/quick-note-composer'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { QuickNoteTimeline } from '@/components/quick-notes/quick-note-timeline'
import { TrashPanel } from '@/components/quick-notes/trash-panel'
import { useQuickNoteEditor } from '@/components/quick-notes/use-quick-note-editor'
import { useQuickNoteItemActions } from '@/components/quick-notes/use-quick-note-item-actions'
import { getQuickNoteRepositoryUserMessage } from '@/lib/quick-notes/quick-note-repository'
import { groupQuickNotesByDate } from '@/lib/quick-notes/quick-note-selectors'
import { ensureQuickNotePreviewSpace } from '@/lib/quick-notes/quick-note-preview'
import { useQuickNoteStore } from '@/stores/quick-note-store'

export function QuickNotesView() {
  const {
    quickNotes,
    trashedQuickNotes,
    syncStatusById,
    lifecycleStateById,
    isLoading,
    error,
    searchQuery,
    loadQuickNotes,
    createQuickNote,
    updateQuickNote,
    deleteQuickNote,
    restoreQuickNote,
    purgeQuickNote,
    togglePin,
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

  const groups = useMemo(() => groupQuickNotesByDate(quickNotes), [quickNotes])
  const isSearching = searchQuery.trim().length > 0
  const describeQuickNoteError = useCallback(
    (error: unknown, fallback: string) => getQuickNoteRepositoryUserMessage(error, fallback),
    [],
  )
  const {
    cancelEdit,
    draft,
    editingId,
    editingNote,
    saveState,
    setDraft,
    startEdit,
    submitDraft,
  } = useQuickNoteEditor({
    quickNotes,
    trashedQuickNotes,
    createQuickNote,
    updateQuickNote,
    describeQuickNoteError,
    lifecycleStateById,
  })
  const {
    moveToTrashWithUndo,
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
    describeQuickNoteError,
  })

  function clearSearch() {
    void loadQuickNotes({ query: '' })
  }

  return createElement(
    'main',
    { className: quickNoteStyles.page },
    createElement(
      'div',
      { className: `${quickNoteStyles.shell} ${quickNoteStyles.surface}` },
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
      createElement(QuickNoteComposer, {
        draft,
        editingNote,
        onDraftChange: setDraft,
        onCancelEdit: cancelEdit,
        onSubmit: submitDraft,
        saveState,
      }),
      createElement(
        'div',
        { className: quickNoteStyles.searchWrap },
        createElement(SearchIcon, { className: quickNoteStyles.searchIcon }),
        createElement(Input, {
          value: searchQuery,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            void loadQuickNotes({ query: event.target.value }),
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
                onClick: clearSearch,
                'aria-label': '清空搜索',
                className: quickNoteStyles.ghostButton,
              },
              createElement(XIcon),
            )
          : null,
      ),
      previewError
        ? createElement(
            'div',
            {
              className: quickNoteStyles.error,
            },
            `预览初始化失败：${previewError}`,
          )
        : null,
      error
        ? createElement(
            'div',
            {
              className: quickNoteStyles.error,
            },
            error,
          )
        : null,
      showTrash
        ? createElement(TrashPanel, {
            notes: trashedQuickNotes,
            onRestore: restoreFromTrash,
            onPurge: purgeFromTrash,
            pendingById: trashPendingById,
          })
        : null,
      createElement(QuickNoteTimeline, {
        groups,
        isLoading,
        isSearching,
        hasNotes: quickNotes.length > 0,
        onEdit: startEdit,
        onTogglePin: (id: string) => void togglePinWithPending(id),
        onDelete: (id: string) => void moveToTrashWithUndo(id),
        onTagClick: (tag: string) => void loadQuickNotes({ query: `#${tag}` }),
        pendingById: timelinePendingById,
        syncStatusById,
        searchQuery,
      }),
    ),
  )
}
