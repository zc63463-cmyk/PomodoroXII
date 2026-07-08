'use client'

import { createElement } from 'react'
import { FileTextIcon, PinIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { renderHighlightedText } from '@/components/quick-notes/quick-note-highlight'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import {
  getQuickNoteSearchNeedle,
  getQuickNoteSummary,
  getQuickNoteTitle,
} from '@/lib/quick-notes/quick-note-selectors'
import { cn } from '@/lib/utils'
import type { QuickNote } from '@/types'
import type { QuickNoteSyncStatus } from '@/lib/quick-notes/quick-note-repository'

export function QuickNoteCard({
  note,
  onEdit,
  onTogglePin,
  onDelete,
  onMigrate,
  onTagClick,
  pendingAction,
  syncStatus,
  searchQuery,
}: {
  note: QuickNote
  onEdit: (note: QuickNote) => void
  onTogglePin: (id: string) => void
  onDelete: (id: string) => void
  onMigrate: (id: string) => void
  onTagClick: (tag: string) => void
  pendingAction?: 'delete' | 'pin' | 'migrate'
  syncStatus?: QuickNoteSyncStatus
  searchQuery: string
}) {
  const searchNeedle = getQuickNoteSearchNeedle(searchQuery).toLowerCase()
  const isTagSearch = searchQuery.trim().startsWith('#')
  const isPending = pendingAction !== undefined

  return createElement(
    'article',
    {
      className: cn(
        quickNoteStyles.card,
        note.pinned ? quickNoteStyles.cardPinned : quickNoteStyles.cardDefault,
      ),
    },
    createElement(
      'div',
      { className: 'flex items-start justify-between gap-3' },
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => onEdit(note),
          disabled: isPending,
          className: 'min-w-0 flex-1 text-left',
        },
        createElement(
          'h2',
          { className: quickNoteStyles.cardTitle },
          renderHighlightedText(getQuickNoteTitle(note), searchQuery),
        ),
        createElement(
          'p',
          { className: quickNoteStyles.cardBody },
          renderHighlightedText(getQuickNoteSummary(note), searchQuery),
        ),
      ),
      createElement(
        'div',
        { className: 'flex shrink-0 items-center gap-1' },
        createElement(
          Button,
          {
            type: 'button',
            variant: note.pinned ? 'secondary' : 'ghost',
            size: 'icon-sm',
            onClick: () => onTogglePin(note.id),
            disabled: isPending,
            'aria-label': note.pinned ? '取消置顶' : '置顶',
            className: cn(
              quickNoteStyles.cardAction,
              note.pinned ? quickNoteStyles.pinnedAction : null,
            ),
          },
          createElement(PinIcon),
        ),
        createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'icon-sm',
            onClick: () => onMigrate(note.id),
            disabled: isPending,
            'aria-label': '转为笔记',
            className: quickNoteStyles.cardAction,
          },
          createElement(FileTextIcon),
        ),
        createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'icon-sm',
            onClick: () => onDelete(note.id),
            disabled: isPending,
            'aria-label': '移到回收站',
            className: quickNoteStyles.cardDangerAction,
          },
          createElement(Trash2Icon),
        ),
      ),
    ),
    createElement(
      'footer',
      { className: quickNoteStyles.cardFooter },
      createElement('span', null, formatTime(note.updated_at)),
      syncStatus
        ? createElement(
            'span',
            {
              className:
                syncStatus === 'failed'
                  ? quickNoteStyles.syncFailed
                  : quickNoteStyles.syncPending,
            },
            syncStatus === 'failed' ? '同步失败，可稍后重试' : '待同步',
          )
        : null,
      ...note.tags.map((tag) =>
        createElement(
          'button',
          {
            key: tag,
            type: 'button',
            onClick: () => onTagClick(tag),
            className: cn(
              quickNoteStyles.tag,
              quickNoteStyles.tagButton,
              searchNeedle &&
                (isTagSearch
                  ? tag.toLowerCase() === searchNeedle
                  : tag.toLowerCase().includes(searchNeedle))
                ? quickNoteStyles.tagActive
                : null,
            ),
          },
          `#${tag}`,
        ),
      ),
    ),
  )
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
