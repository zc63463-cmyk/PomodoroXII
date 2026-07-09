'use client'

import { createElement } from 'react'
import { FileTextIcon, PinIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { cn } from '@/lib/utils'
import type { QuickNoteSyncStatus } from '@/lib/quick-notes/quick-note-repository'
import type { QuickNote } from '@/types'

export function QuickNoteReadAside({
  note,
  syncStatus,
  pendingAction,
  onTogglePin,
  onDelete,
  onMigrate,
}: {
  note: QuickNote
  syncStatus?: QuickNoteSyncStatus
  pendingAction?: 'delete' | 'pin' | 'migrate'
  onTogglePin: (id: string) => boolean | void | Promise<boolean | void>
  onDelete: (id: string) => void | Promise<void>
  onMigrate: (id: string) => void | Promise<void>
}) {
  const isPending = pendingAction !== undefined

  return createElement(
    'aside',
    {
      className: cn(quickNoteStyles.readAside, quickNoteStyles.motionPanel),
      'data-motion': 'aside',
    },
    createElement(
      'section',
      { className: quickNoteStyles.asideBlock },
      createElement('h2', { className: quickNoteStyles.asideTitle }, '属性'),
      createElement(AsideRow, { label: '创建', value: formatFullTime(note.created_at) }),
      createElement(AsideRow, { label: '更新', value: formatFullTime(note.updated_at) }),
      createElement(AsideRow, { label: '置顶', value: note.pinned ? '是' : '否' }),
      createElement(AsideRow, {
        label: '同步',
        value: syncStatus === 'failed' ? '失败' : syncStatus === 'pending' ? '待同步' : '已保存',
        danger: syncStatus === 'failed',
      }),
    ),
    note.tags.length > 0
      ? createElement(
          'section',
          { className: quickNoteStyles.asideBlock },
          createElement('h2', { className: quickNoteStyles.asideTitle }, '标签'),
          createElement(
            'div',
            { className: 'flex flex-wrap gap-2' },
            ...note.tags.map((tag) =>
              createElement('span', { key: tag, className: quickNoteStyles.tag }, `#${tag}`),
            ),
          ),
        )
      : null,
    createElement(
      'section',
      { className: quickNoteStyles.asideBlock },
      createElement('h2', { className: quickNoteStyles.asideTitle }, '操作'),
      createElement(
        'div',
        { className: 'grid gap-2' },
        createElement(
          Button,
          {
            type: 'button',
            variant: note.pinned ? 'secondary' : 'outline',
            onClick: () => void onTogglePin(note.id),
            disabled: isPending,
            className: note.pinned
              ? quickNoteStyles.pinnedAction
              : quickNoteStyles.outlineButton,
          },
          createElement(PinIcon),
          note.pinned ? '取消置顶' : '置顶',
        ),
        createElement(
          Button,
          {
            type: 'button',
            variant: 'outline',
            onClick: () => void onMigrate(note.id),
            disabled: isPending,
            className: quickNoteStyles.outlineButton,
          },
          createElement(FileTextIcon),
          '转为笔记',
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
    ),
  )
}

function AsideRow({
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
    { className: quickNoteStyles.asideRow },
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
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
