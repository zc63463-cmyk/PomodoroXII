'use client'

import { createElement, useEffect, useRef, useState } from 'react'
import { FileTextIcon, PinIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { renderHighlightedText } from '@/components/quick-notes/quick-note-highlight'
import { QuickNoteMarkdown } from '@/components/quick-notes/quick-note-markdown'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import {
  getQuickNoteSearchNeedle,
  getQuickNoteSearchSnippet,
  getQuickNoteTitle,
} from '@/lib/quick-notes/quick-note-selectors'
import { cn } from '@/lib/utils'
import type { QuickNote } from '@/types'
import type { QuickNoteSyncStatus } from '@/lib/quick-notes/quick-note-repository'

export function QuickNoteCard({
  note,
  onEdit,
  onOpenPreview,
  onClosePreview,
  onOpenDetail,
  onTogglePin,
  onDelete,
  onMigrate,
  onTagClick,
  pendingAction,
  isExpanded = false,
  syncStatus,
  searchQuery,
  disabledInteractions = false,
}: {
  note: QuickNote
  onEdit: (note: QuickNote) => void
  onOpenPreview: (id: string) => void
  onClosePreview: () => void
  onOpenDetail: (id: string) => void
  onTogglePin: (id: string) => void
  onDelete: (id: string) => void
  onMigrate: (id: string) => void
  onTagClick: (tag: string) => void
  pendingAction?: 'delete' | 'pin' | 'migrate'
  isExpanded?: boolean
  syncStatus?: QuickNoteSyncStatus
  searchQuery: string
  disabledInteractions?: boolean
}) {
  const searchNeedle = getQuickNoteSearchNeedle(searchQuery).toLowerCase()
  const isTagSearch = searchQuery.trim().startsWith('#')
  const isPending = pendingAction !== undefined
  const interactionsDisabled = isPending || disabledInteractions
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    items()[0]?.focus()
    function onKeyDown(event: KeyboardEvent) {
      const menuItems = items()
      const index = menuItems.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); triggerRef.current?.focus(); return }
      if (event.key === 'Home') { event.preventDefault(); menuItems[0]?.focus(); return }
      if (event.key === 'End') { event.preventDefault(); menuItems.at(-1)?.focus(); return }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && index >= 0) { event.preventDefault(); menuItems[(index + (event.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length]?.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  function togglePreview() {
    if (interactionsDisabled) return
    if (isExpanded) return
    onOpenPreview(note.id)
  }

  return createElement(
    'article',
    {
      className: cn(
        quickNoteStyles.card,
        isExpanded ? quickNoteStyles.cardExpanded : quickNoteStyles.cardCollapsed,
        note.pinned ? quickNoteStyles.cardPinned : quickNoteStyles.cardDefault,
      ),
    },
    createElement(
      'div',
      { className: 'flex items-start justify-between gap-3' },
      createElement(
        'div',
        {
          role: 'button',
          tabIndex: interactionsDisabled ? -1 : 0,
          onClick: togglePreview,
          onDoubleClick: togglePreview,
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            togglePreview()
          },
          'aria-expanded': isExpanded,
          className:
            'min-w-0 flex-1 cursor-default text-left transition group-hover/card:translate-x-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--qn-border-strong)]',
        },
        createElement(
          'h2',
          { className: quickNoteStyles.cardTitle },
          renderHighlightedText(getQuickNoteTitle(note), searchQuery),
        ),
        isExpanded
          ? null
          : createElement(
              'p',
              {
                className: quickNoteStyles.cardBody,
              },
              renderHighlightedText(getQuickNoteSearchSnippet(note, searchQuery), searchQuery),
            ),
      ),
      createElement(
        'div',
        { className: 'flex shrink-0 items-center gap-1' },
        isExpanded
          ? createElement(
              Button,
              {
                type: 'button',
                variant: 'ghost',
                size: 'icon-sm',
                onClick: onClosePreview,
                'aria-label': '收起小记',
                className: quickNoteStyles.cardAction,
              },
              createElement(XIcon),
            )
          : null,
        createElement(
          Button,
          {
            type: 'button',
            variant: note.pinned ? 'secondary' : 'ghost',
            size: 'icon-sm',
            onClick: () => onTogglePin(note.id),
            disabled: interactionsDisabled,
            'aria-label': note.pinned ? '取消置顶' : '置顶',
            className: cn(
              quickNoteStyles.cardAction,
              note.pinned ? quickNoteStyles.pinnedAction : null,
            ),
          },
          createElement(PinIcon),
        ),
        createElement('div', { className: 'relative' },
          createElement(Button, { ref: triggerRef, type: 'button', variant: 'ghost', size: 'icon-sm', onClick: () => setMenuOpen((value) => !value), disabled: interactionsDisabled, 'aria-label': '更多小记操作', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, className: quickNoteStyles.cardAction }, '...'),
          menuOpen ? createElement('div', { ref: menuRef, role: 'menu', 'aria-label': '小记操作', className: quickNoteStyles.cardOverflowMenu },
            createElement('button', { type: 'button', role: 'menuitem', disabled: interactionsDisabled, onClick: () => { setMenuOpen(false); onEdit(note) }, className: quickNoteStyles.cardOverflowItem }, '编辑小记'),
            createElement('button', { type: 'button', role: 'menuitem', disabled: interactionsDisabled, onClick: () => { setMenuOpen(false); onOpenDetail(note.id) }, className: quickNoteStyles.cardOverflowItem }, '阅读小记'),
            createElement('button', { type: 'button', role: 'menuitem', disabled: interactionsDisabled, onClick: () => { setMenuOpen(false); onMigrate(note.id) }, className: quickNoteStyles.cardOverflowItem }, createElement(FileTextIcon), '转为笔记'),
            createElement('button', { type: 'button', role: 'menuitem', disabled: interactionsDisabled, onClick: () => { setMenuOpen(false); onDelete(note.id) }, className: quickNoteStyles.cardOverflowItem }, createElement(Trash2Icon), '移到回收站'),
          ) : null,
        ),
      ),
    ),
    isExpanded
      ? createElement(
          'div',
          {
            className: quickNoteStyles.cardBodyExpanded,
            'aria-label': '小记快速预览',
          },
          createElement(QuickNoteMarkdown, {
            content: note.content,
            variant: 'preview',
          }),
        )
      : null,
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
            disabled: interactionsDisabled,
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
