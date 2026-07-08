'use client'

import { createElement } from 'react'
import { QuickNoteReadArticle } from '@/components/quick-notes/quick-note-read-article'
import { QuickNoteReadAside } from '@/components/quick-notes/quick-note-read-aside'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import type { QuickNoteSyncStatus } from '@/lib/quick-notes/quick-note-repository'
import type { QuickNote } from '@/types'

export function QuickNoteReadView({
  note,
  syncStatus,
  pendingAction,
  onClose,
  onTogglePin,
  onDelete,
  onMigrate,
  onUpdateQuickNote,
}: {
  note: QuickNote
  syncStatus?: QuickNoteSyncStatus
  pendingAction?: 'delete' | 'pin' | 'migrate'
  onClose: () => void
  onTogglePin: (id: string) => boolean | void | Promise<boolean | void>
  onDelete: (id: string) => void | Promise<void>
  onMigrate: (id: string) => void | Promise<void>
  onUpdateQuickNote: (id: string, data: { content: string }) => Promise<void>
}) {
  return createElement(
    'section',
    {
      className: quickNoteStyles.readView,
      'aria-label': '小记沉浸阅读',
    },
    createElement(QuickNoteReadArticle, {
      note,
      syncStatus,
      pendingAction,
      onClose,
      onTogglePin,
      onDelete,
      onMigrate,
      onUpdateQuickNote,
    }),
    createElement(QuickNoteReadAside, {
      note,
      syncStatus,
      pendingAction,
      onTogglePin,
      onDelete,
      onMigrate,
    }),
  )
}
