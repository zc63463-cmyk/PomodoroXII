'use client'

import { createElement, FormEvent, KeyboardEvent } from 'react'
import { PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { getQuickNoteEditorStatusText } from '@/lib/quick-notes/quick-note-editor-status'
import { extractQuickNoteTags } from '@/lib/quick-notes/quick-note-tags'
import type { QuickNote } from '@/types'

export type QuickNoteSaveState = 'saved' | 'unsaved' | 'saving' | 'failed'

export function QuickNoteComposer({
  draft,
  editingNote,
  hasConflict = false,
  isTyping = false,
  onDraftChange,
  onCancelEdit,
  onSubmit,
  saveState,
  variant = 'compact',
  isFocusMode = false,
  onToggleFocus,
}: {
  draft: string
  editingNote: QuickNote | null
  hasConflict?: boolean
  isTyping?: boolean
  onDraftChange: (value: string) => void
  onCancelEdit: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  saveState: QuickNoteSaveState
  variant?: 'compact' | 'focus'
  isFocusMode?: boolean
  onToggleFocus?: () => void
}) {
  const previewTags = extractQuickNoteTags(draft)

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && isFocusMode) {
      event.preventDefault()
      event.stopPropagation()
      if (editingNote) onCancelEdit()
      onToggleFocus?.()
      return
    }

    if (event.key === 'Escape' && editingNote) {
      event.preventDefault()
      event.stopPropagation()
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
    {
      className:
        variant === 'focus'
          ? quickNoteStyles.composerFocusPanel
          : quickNoteStyles.panel,
    },
    createElement(
      'form',
      { onSubmit, className: 'flex flex-col gap-3' },
      createElement('textarea', {
        value: draft,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onDraftChange(event.target.value),
        onKeyDown: handleKeyDown,
        placeholder: isFocusMode ? '专注写作，把这一段想法完整落下来...' : '随手写下正在想的事...',
        rows: variant === 'focus' ? 12 : editingNote ? 5 : 4,
        className:
          variant === 'focus'
            ? quickNoteStyles.textareaFocus
            : quickNoteStyles.textarea,
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
            getComposerStatusText({
              draft,
              editingNote,
              hasConflict,
              isTyping,
              saveState,
            }),
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
          onToggleFocus
            ? createElement(
                Button,
                {
                  type: 'button',
                  variant: isFocusMode ? 'secondary' : 'ghost',
                  onClick: onToggleFocus,
                  className: isFocusMode
                    ? quickNoteStyles.pinnedAction
                    : quickNoteStyles.ghostButton,
                },
                isFocusMode ? '退出专注' : '专注',
              )
            : null,
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
                ? saveState === 'saving' || hasConflict
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

function getComposerStatusText({
  draft,
  editingNote,
  hasConflict,
  isTyping,
  saveState,
}: {
  draft: string
  editingNote: QuickNote | null
  hasConflict: boolean
  isTyping: boolean
  saveState: QuickNoteSaveState
}): string {
  if (hasConflict) return getQuickNoteEditorStatusText('conflict')
  if (saveState === 'saving') return getQuickNoteEditorStatusText('saving')
  if (saveState === 'failed') return getQuickNoteEditorStatusText('failed')
  if (isTyping && draft.trim()) return getQuickNoteEditorStatusText('typing')
  if (!editingNote) {
    return draft.trim()
      ? getQuickNoteEditorStatusText('dirty')
      : '新建小记：点击记录保存，Ctrl/Cmd + Enter 快速记录'
  }

  if (saveState === 'unsaved' || draft.trim() !== editingNote.content.trim()) {
    return getQuickNoteEditorStatusText('dirty')
  }

  return getQuickNoteEditorStatusText('saved')
}
