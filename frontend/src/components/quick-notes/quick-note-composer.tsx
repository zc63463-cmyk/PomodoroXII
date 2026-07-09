'use client'

import { createElement, FormEvent, KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QuickNoteEditorStatusLine } from '@/components/quick-notes/quick-note-editor-status-line'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import {
  applyQuickNoteTagAutocomplete,
  getQuickNoteTagAutocompleteState,
} from '@/lib/quick-notes/quick-note-tag-autocomplete'
import {
  extractQuickNoteTags,
  normalizeQuickNoteTag,
} from '@/lib/quick-notes/quick-note-tags'
import { cn } from '@/lib/utils'
import type { QuickNoteEditorStatus } from '@/lib/quick-notes/quick-note-editor-status'
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
  popularTags = [],
  onInsertTag,
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
  popularTags?: string[]
  onInsertTag?: (tag: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const autocompleteId = useId()
  const [caretIndex, setCaretIndex] = useState(draft.length)
  const [autocompleteOpen, setAutocompleteOpen] = useState(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [pendingCaretIndex, setPendingCaretIndex] = useState<number | null>(null)
  const previewTags = extractQuickNoteTags(draft)
  const draftTags = new Set(previewTags)
  const autocompleteState = useMemo(
    () =>
      autocompleteOpen
        ? getQuickNoteTagAutocompleteState(draft, caretIndex, popularTags)
        : null,
    [autocompleteOpen, caretIndex, draft, popularTags],
  )
  const autocompleteSuggestions = autocompleteState?.suggestions ?? []
  const isAutocompleteVisible = autocompleteSuggestions.length > 0
  const listboxId = `${autocompleteId}-quick-note-tag-autocomplete-listbox`
  const activeOptionId = isAutocompleteVisible
    ? `${listboxId}-option-${activeSuggestionIndex}`
    : undefined
  const editorStatus = getComposerStatus({
    draft,
    editingNote,
    hasConflict,
    isTyping,
    saveState,
  })

  useEffect(() => {
    if (pendingCaretIndex === null) return
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.setSelectionRange(pendingCaretIndex, pendingCaretIndex)
    setCaretIndex(pendingCaretIndex)
    setPendingCaretIndex(null)
  }, [draft, pendingCaretIndex])

  useEffect(() => {
    if (!isAutocompleteVisible) {
      setActiveSuggestionIndex(0)
      return
    }
    setActiveSuggestionIndex((index) =>
      Math.min(index, autocompleteSuggestions.length - 1),
    )
  }, [autocompleteSuggestions.length, isAutocompleteVisible])

  function handleDraftChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const nextDraft = event.target.value
    const nextCaretIndex = event.target.selectionStart ?? nextDraft.length
    setCaretIndex(nextCaretIndex)
    setAutocompleteOpen(
      getQuickNoteTagAutocompleteState(nextDraft, nextCaretIndex, popularTags) !== null,
    )
    onDraftChange(nextDraft)
  }

  function syncCaretFromTextarea(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    const currentValue = event.currentTarget.value
    const nextCaretIndex = event.currentTarget.selectionStart ?? draft.length
    setCaretIndex(nextCaretIndex)
    setAutocompleteOpen(
      getQuickNoteTagAutocompleteState(currentValue, nextCaretIndex, popularTags) !== null,
    )
  }

  function handleKeyUp(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      return
    }
    syncCaretFromTextarea(event)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
      return
    }

    if (isAutocompleteVisible) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setActiveSuggestionIndex((index) =>
          (index + 1) % autocompleteSuggestions.length,
        )
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActiveSuggestionIndex((index) =>
          (index - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length,
        )
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        insertAutocompleteSuggestion(autocompleteSuggestions[activeSuggestionIndex])
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setAutocompleteOpen(false)
        return
      }
    }

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
  }

  function insertAutocompleteSuggestion(tag: string | undefined) {
    if (!tag || !autocompleteState) return

    const nextDraft = applyQuickNoteTagAutocomplete(
      draft,
      autocompleteState.range,
      tag,
    )
    setAutocompleteOpen(false)
    setPendingCaretIndex(nextDraft.caretIndex)
    onDraftChange(nextDraft.value)
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
      createElement(
        'div',
        { className: quickNoteStyles.tagAutocompleteAnchor },
        createElement('textarea', {
          ref: textareaRef,
          value: draft,
          onChange: handleDraftChange,
          onClick: syncCaretFromTextarea,
          onKeyUp: handleKeyUp,
          onKeyDown: handleKeyDown,
          placeholder: isFocusMode ? '专注写作，把这一段想法完整落下来...' : '随手写下正在想的事...',
          rows: variant === 'focus' ? 12 : editingNote ? 5 : 4,
          className:
            variant === 'focus'
              ? quickNoteStyles.textareaFocus
              : quickNoteStyles.textarea,
          'aria-label': '小记内容',
          'aria-autocomplete': 'list',
          'aria-controls': isAutocompleteVisible ? listboxId : undefined,
          'aria-expanded': isAutocompleteVisible,
          'aria-activedescendant': activeOptionId,
        }),
        isAutocompleteVisible
          ? createElement(
              'div',
              {
                id: listboxId,
                role: 'listbox',
                'aria-label': '标签补全',
                className: quickNoteStyles.tagAutocompleteList,
              },
              ...autocompleteSuggestions.map((tag, index) =>
                createElement(
                  'button',
                  {
                    key: tag,
                    id: `${listboxId}-option-${index}`,
                    type: 'button',
                    role: 'option',
                    'aria-selected': activeSuggestionIndex === index,
                    onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) =>
                      event.preventDefault(),
                    onClick: () => insertAutocompleteSuggestion(tag),
                    className: cn(
                      quickNoteStyles.tagAutocompleteOption,
                      activeSuggestionIndex === index
                        ? quickNoteStyles.tagAutocompleteOptionActive
                        : null,
                    ),
                  },
                  `#${tag}`,
                ),
              ),
            )
          : null,
      ),
      createElement(
        'div',
        { className: 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' },
        createElement(
          'div',
          { className: 'flex min-w-0 flex-col gap-2' },
          createElement(
            'div',
            { className: 'flex min-h-7 items-center' },
            createElement(QuickNoteEditorStatusLine, editorStatus),
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
          popularTags.length > 0
            ? createElement(
                'div',
                { className: quickNoteStyles.tagShortcutWrap },
                createElement('span', { className: quickNoteStyles.metaText }, '常用标签'),
                ...popularTags.map((tag) => {
                  const normalizedTag = normalizeQuickNoteTag(tag)
                  const selected = draftTags.has(normalizedTag) || draftIncludesTagText(draft, normalizedTag)
                  return createElement(
                    'button',
                    {
                      key: tag,
                      type: 'button',
                      onClick: () => {
                        if (!selected) onInsertTag?.(tag)
                      },
                      'aria-pressed': selected,
                      'aria-label': `插入常用标签 #${tag}`,
                      className: cn(
                        quickNoteStyles.tagShortcut,
                        selected ? quickNoteStyles.tagShortcutSelected : null,
                      ),
                    },
                    `#${tag}`,
                  )
                }),
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

function draftIncludesTagText(draft: string, tag: string): boolean {
  if (!tag) return false
  return draft.toLowerCase().split(/\s+/).includes(`#${tag}`)
}

function getComposerStatus({
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
}): {
  status: QuickNoteEditorStatus | null
  fallbackText?: string
} {
  if (hasConflict) return { status: 'conflict' }
  if (saveState === 'saving') return { status: 'saving' }
  if (saveState === 'failed') return { status: 'failed' }
  if (isTyping && draft.trim()) return { status: 'typing' }
  if (!editingNote) {
    return draft.trim()
      ? { status: 'dirty' }
      : {
          status: null,
          fallbackText: '新建小记：点击记录保存，Ctrl/Cmd + Enter 快速记录',
        }
  }

  if (saveState === 'unsaved' || draft.trim() !== editingNote.content.trim()) {
    return { status: 'dirty' }
  }

  return { status: 'saved' }
}
