'use client'

import { createElement } from 'react'
import { GitMergeIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { getQuickNoteTitle } from '@/lib/quick-notes/quick-note-selectors'
import type { QuickNote } from '@/types'

export interface QuickNoteDraftConflict {
  note: QuickNote
  localDraft: string
  remoteContent: string
}

export function QuickNoteConflictPanel({
  conflict,
  onKeepLocal,
  onUseRemote,
  onMerge,
}: {
  conflict: QuickNoteDraftConflict | null
  onKeepLocal: () => void
  onUseRemote: () => void
  onMerge: () => void
}) {
  if (!conflict) return null

  return createElement(
    'section',
    {
      className:
        'rounded-2xl border border-[color:var(--qn-border-strong)] bg-[color:var(--qn-panel)] p-4 shadow-[var(--qn-shadow-soft)] ring-1 ring-[color:var(--qn-accent-soft)]',
      'aria-label': '小记远端更新冲突',
    },
    createElement(
      'div',
      { className: 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between' },
      createElement(
        'div',
        { className: 'min-w-0' },
        createElement(
          'h2',
          { className: quickNoteStyles.panelTitle },
          '有远端更新',
        ),
        createElement(
          'p',
          { className: `${quickNoteStyles.metaText} mt-1` },
          `正在编辑：${getQuickNoteTitle(conflict.note)}。本地草稿已保留，请选择处理方式。`,
        ),
      ),
      createElement(GitMergeIcon, {
        className: 'size-5 shrink-0 text-[color:var(--qn-accent-readable)]',
      }),
    ),
    createElement(
      'div',
      { className: 'mt-3 grid gap-3 sm:grid-cols-2' },
      createElement(ConflictPreview, {
        label: '本地草稿',
        content: conflict.localDraft,
      }),
      createElement(ConflictPreview, {
        label: '远端版本',
        content: conflict.remoteContent,
      }),
    ),
    createElement(
      'div',
      { className: 'mt-3 flex flex-wrap gap-2' },
      createElement(
        Button,
        {
          type: 'button',
          variant: 'outline',
          onClick: onKeepLocal,
          className: quickNoteStyles.outlineButton,
        },
        '保留本地草稿',
      ),
      createElement(
        Button,
        {
          type: 'button',
          variant: 'outline',
          onClick: onUseRemote,
          className: quickNoteStyles.outlineButton,
        },
        '采用远端版本',
      ),
      createElement(
        Button,
        {
          type: 'button',
          onClick: onMerge,
          className: quickNoteStyles.primaryButton,
        },
        '合并到草稿',
      ),
    ),
  )
}

function ConflictPreview({
  label,
  content,
}: {
  label: string
  content: string
}) {
  return createElement(
    'div',
    { className: 'rounded-xl bg-[color:var(--qn-panel-muted)] p-3' },
    createElement('p', { className: quickNoteStyles.metaText }, label),
    createElement(
      'p',
      {
        className:
          'mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-sm leading-6 text-[color:var(--qn-text-strong)]',
      },
      content || '空内容',
    ),
  )
}
