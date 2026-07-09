'use client'

import { createElement } from 'react'
import { QuickNoteCard } from '@/components/quick-notes/quick-note-card'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import type { QuickNote } from '@/types'
import type { QuickNoteSyncStatus } from '@/lib/quick-notes/quick-note-repository'

type QuickNoteDateGroup = {
  date: string
  label: string
  notes: QuickNote[]
}

export function QuickNoteTimeline({
  groups,
  isLoading,
  isSearching,
  hasNotes,
  onEdit,
  onOpenPreview,
  onClosePreview,
  onOpenDetail,
  onTogglePin,
  onDelete,
  onMigrate,
  onTagClick,
  pendingById,
  expandedQuickNoteId,
  syncStatusById,
  searchQuery,
  disabledInteractions = false,
}: {
  groups: QuickNoteDateGroup[]
  isLoading: boolean
  isSearching: boolean
  hasNotes: boolean
  onEdit: (note: QuickNote) => void
  onOpenPreview: (id: string) => void
  onClosePreview: () => void
  onOpenDetail: (id: string) => void
  onTogglePin: (id: string) => void
  onDelete: (id: string) => void
  onMigrate: (id: string) => void
  onTagClick: (tag: string) => void
  pendingById?: Record<string, 'delete' | 'pin' | 'migrate'>
  expandedQuickNoteId?: string | null
  syncStatusById?: Record<string, QuickNoteSyncStatus>
  searchQuery: string
  disabledInteractions?: boolean
}) {
  return createElement(
    'section',
    { className: quickNoteStyles.timeline, 'aria-label': '小记时间线' },
    isLoading && !hasNotes
      ? createElement(EmptyState, {
          title: '正在载入小记...',
          description: '本地空间连接中。',
        })
      : null,
    !isLoading && !hasNotes
      ? createElement(EmptyState, {
          title: isSearching ? '没有匹配的小记' : '还没有小记',
          description: isSearching
            ? '换个关键词试试，或清空搜索。'
            : '先写一条，给今天留个轻轻的锚点。',
        })
      : null,
    ...groups.map((group) =>
      createElement(
        'div',
        { key: group.date, className: 'grid gap-3' },
        createElement(
          'div',
          {
            className: quickNoteStyles.groupLabel,
          },
          group.label,
        ),
        ...group.notes.map((note) =>
          createElement(QuickNoteCard, {
            key: note.id,
            note,
            onEdit,
            onOpenPreview,
            onClosePreview,
            onOpenDetail,
            onTogglePin,
            onDelete,
            onMigrate,
            onTagClick,
            pendingAction: pendingById?.[note.id],
            isExpanded: expandedQuickNoteId === note.id,
            syncStatus: syncStatusById?.[note.id],
            searchQuery,
            disabledInteractions,
          }),
        ),
      ),
    ),
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return createElement(
    'div',
    {
      className: quickNoteStyles.empty,
    },
    createElement('h2', { className: quickNoteStyles.emptyTitle }, title),
    createElement('p', { className: quickNoteStyles.emptyDescription }, description),
  )
}
