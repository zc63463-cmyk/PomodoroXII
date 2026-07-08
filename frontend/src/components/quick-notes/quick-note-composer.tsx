'use client'

import { createElement, FormEvent, KeyboardEvent } from 'react'
import { PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { getQuickNoteTitle } from '@/lib/quick-notes/quick-note-selectors'
import { extractQuickNoteTags } from '@/lib/quick-notes/quick-note-tags'
import type { QuickNote } from '@/types'

export type QuickNoteSaveState = 'saved' | 'unsaved' | 'saving' | 'failed'

export function QuickNoteComposer({
  draft,
  editingNote,
  onDraftChange,
  onCancelEdit,
  onSubmit,
  saveState,
}: {
  draft: string
  editingNote: QuickNote | null
  onDraftChange: (value: string) => void
  onCancelEdit: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  saveState: QuickNoteSaveState
}) {
  const previewTags = extractQuickNoteTags(draft)

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && editingNote) {
      event.preventDefault()
      onCancelEdit()
      return
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  return createElement(
    'section',
    { className: quickNoteStyles.panel },
    createElement(
      'form',
      { onSubmit, className: 'flex flex-col gap-3' },
      createElement('textarea', {
        value: draft,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onDraftChange(event.target.value),
        onKeyDown: handleKeyDown,
        placeholder: '随手写下正在想的事...',
        rows: editingNote ? 5 : 4,
        className: quickNoteStyles.textarea,
        'aria-label': '小记内容',
      }),
      createElement(
        'div',
        { className: 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' },
        createElement(
          'div',
          { className: 'flex min-w-0 flex-col gap-2' },
          createElement(
            'div',
            { className: quickNoteStyles.metaText },
            getComposerStatusText(editingNote, saveState),
          ),
          previewTags.length > 0
            ? createElement(
                'div',
                { className: quickNoteStyles.tagPreview },
                createElement('span', { className: quickNoteStyles.metaText }, '将写入标签'),
                ...previewTags.map((tag) =>
                  createElement(
                    'span',
                    { key: tag, className: quickNoteStyles.tag },
                    `#${tag}`,
                  ),
                ),
              )
            : null,
        ),
        createElement(
          'div',
          { className: 'flex items-center gap-2' },
          editingNote
            ? createElement(
                Button,
                {
                  type: 'button',
                  variant: 'ghost',
                  onClick: onCancelEdit,
                  className: quickNoteStyles.ghostButton,
                },
                createElement(XIcon),
                '取消',
              )
            : null,
          createElement(
            Button,
            {
              type: 'submit',
              disabled: editingNote
                ? saveState === 'saving'
                : !draft.trim() || saveState === 'saving',
              className: quickNoteStyles.primaryButton,
            },
            createElement(PlusIcon),
            editingNote ? '保存修改' : '记录',
          ),
        ),
      ),
    ),
  )
}

function getComposerStatusText(
  editingNote: QuickNote | null,
  saveState: QuickNoteSaveState,
): string {
  if (!editingNote) return '新建小记：点击记录保存，Ctrl/Cmd + Enter 快速记录'

  const title = getQuickNoteTitle(editingNote)
  if (saveState === 'saving') return `保存中：${title}`
  if (saveState === 'failed') return `保存失败：${title}，请重试`
  if (saveState === 'unsaved') return `未保存：${title}，Esc 取消，Ctrl/Cmd + Enter 保存`
  return `已保存：${title}，Esc 取消，Ctrl/Cmd + Enter 保存`
}
