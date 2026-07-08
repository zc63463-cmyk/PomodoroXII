'use client'

import { createElement } from 'react'
import { FileTextIcon, PinIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { getQuickNoteTitle } from '@/lib/quick-notes/quick-note-selectors'
import { cn } from '@/lib/utils'
import type { QuickNoteSyncStatus } from '@/lib/quick-notes/quick-note-repository'
import type { QuickNote } from '@/types'

export function QuickNoteDetailPanel({
  note,
  syncStatus,
  pendingAction,
  onClose,
  onOpenDetail,
  onTogglePin,
  onDelete,
  onMigrate,
}: {
  note: QuickNote
  syncStatus?: QuickNoteSyncStatus
  pendingAction?: 'delete' | 'pin' | 'migrate'
  onClose: () => void
  onOpenDetail: (id: string) => void
  onTogglePin: (id: string) => boolean | void | Promise<boolean | void>
  onDelete: (id: string) => void | Promise<void>
  onMigrate: (id: string) => void | Promise<void>
}) {
  const isPending = pendingAction !== undefined

  return createElement(
    'aside',
    {
      id: 'quick-note-focus-read-panel',
      className: cn(quickNoteStyles.detailPanel, quickNoteStyles.focusPanelMotion),
      'data-motion': 'detail',
      'aria-label': '小记轻详情',
    },
    createElement(
      'div',
      { className: quickNoteStyles.detailHeader },
      createElement(
        'div',
        { className: 'min-w-0' },
        createElement('p', { className: quickNoteStyles.eyebrow }, 'Focus Read'),
        createElement('h2', { className: quickNoteStyles.detailTitle }, getQuickNoteTitle(note)),
      ),
      createElement(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-sm',
          onClick: onClose,
          'aria-label': '关闭轻详情',
          className: quickNoteStyles.ghostButton,
        },
        createElement(XIcon),
      ),
    ),
    createElement(
      'div',
      { className: quickNoteStyles.detailBody },
      note.content,
    ),
    createElement(QuickNoteMetaStrip, { note, syncStatus }),
    createElement(
      'div',
      { className: quickNoteStyles.detailActions },
      createElement(
        Button,
        {
          type: 'button',
          variant: note.pinned ? 'secondary' : 'ghost',
          onClick: () => void onTogglePin(note.id),
          disabled: isPending,
          className: cn(
            quickNoteStyles.ghostButton,
            note.pinned ? quickNoteStyles.pinnedAction : null,
          ),
        },
        createElement(PinIcon),
        note.pinned ? '取消置顶' : '置顶',
      ),
      createElement(
        Button,
        {
          type: 'button',
          variant: 'outline',
          onClick: () => onOpenDetail(note.id),
          disabled: isPending,
          className: quickNoteStyles.outlineButton,
        },
        '沉浸阅读',
      ),
      createElement(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          onClick: () => void onMigrate(note.id),
          disabled: isPending,
          className: quickNoteStyles.ghostButton,
        },
        createElement(FileTextIcon),
        '转笔记',
      ),
      createElement(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          onClick: () => void onDelete(note.id),
          disabled: isPending,
          className: quickNoteStyles.cardDangerAction,
        },
        createElement(Trash2Icon),
        '移到回收站',
      ),
    ),
  )
}

export function QuickNoteMetaStrip({
  note,
  syncStatus,
}: {
  note: QuickNote
  syncStatus?: QuickNoteSyncStatus
}) {
  return createElement(
    'div',
    { className: quickNoteStyles.metaGrid },
    createElement(MetaItem, { label: '创建', value: formatFullTime(note.created_at) }),
    createElement(MetaItem, { label: '更新', value: formatFullTime(note.updated_at) }),
    createElement(MetaItem, { label: '状态', value: note.pinned ? '已置顶' : '普通' }),
    syncStatus
      ? createElement(MetaItem, {
          label: '同步',
          value: syncStatus === 'failed' ? '同步失败' : '待同步',
          danger: syncStatus === 'failed',
        })
      : createElement(MetaItem, { label: '同步', value: '已入库' }),
    note.tags.length > 0
      ? createElement(
          'div',
          { className: quickNoteStyles.metaWide },
          createElement('span', { className: quickNoteStyles.metaLabel }, '标签'),
          createElement(
            'div',
            { className: 'mt-2 flex flex-wrap gap-2' },
            ...note.tags.map((tag) =>
              createElement('span', { key: tag, className: quickNoteStyles.tag }, `#${tag}`),
            ),
          ),
        )
      : null,
  )
}

function MetaItem({
  label,
  value,
  danger = false,
}: {
  label: string
  value: string
  danger?: boolean
}) {
  return createElement(
    'div',
    { className: quickNoteStyles.metaItem },
    createElement('span', { className: quickNoteStyles.metaLabel }, label),
    createElement(
      'span',
      { className: danger ? quickNoteStyles.metaValueDanger : quickNoteStyles.metaValue },
      value,
    ),
  )
}

function formatFullTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
