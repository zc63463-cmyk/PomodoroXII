'use client'

import { createElement, FormEvent, KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QuickNoteEditorStatusLine } from '@/components/quick-notes/quick-note-editor-status-line'
import {
  QuickNoteEditorToolbar,
  type QuickNoteToolbarInsert,
} from '@/components/quick-notes/quick-note-editor-toolbar'
import { QuickNoteMarkdown } from '@/components/quick-notes/quick-note-markdown'
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
import type {
  QuickNoteDraftSaveState,
  QuickNoteEditorStatus,
} from '@/lib/quick-notes/quick-note-editor-status'
import type { QuickNote } from '@/types'

export type QuickNoteSaveState = 'saved' | 'unsaved' | 'saving' | 'failed'
export type { QuickNoteDraftSaveState } from '@/lib/quick-notes/quick-note-editor-status'

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
  draftSaveState = 'idle',
  onDiscardDraft,
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
  draftSaveState?: QuickNoteDraftSaveState
  onDiscardDraft?: () => void | Promise<void>
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const autocompleteId = useId()
  const [caretIndex, setCaretIndex] = useState(draft.length)
  const [autocompleteOpen, setAutocompleteOpen] = useState(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [pendingCaretIndex, setPendingCaretIndex] = useState<number | null>(null)
  const [discardArmed, setDiscardArmed] = useState(false)
  const [isPreview, setIsPreview] = useState(false)
  const [isPeeking, setIsPeeking] = useState(false)
  const [peekKey] = useState<QuickNotePeekKey>(readPeekKey)
  const discardArmedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    draftSaveState,
  })
  // 预览可见性 = 手动切换态 ∪ 长按 peek 态（两者正交，Esc 只关当前层）。
  const previewVisible = isFocusMode && (isPreview || isPeeking)

  useEffect(() => {
    if (pendingCaretIndex === null) return
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.setSelectionRange(pendingCaretIndex, pendingCaretIndex)
    setCaretIndex(pendingCaretIndex)
    setPendingCaretIndex(null)
  }, [draft, pendingCaretIndex])

  useEffect(() => {
    if (!isFocusMode) return
    textareaRef.current?.focus()
  }, [isFocusMode])

  // 预览是专注态的瞬时视角：退出专注即复位为编辑态（对齐原版 isPreview watch）。
  useEffect(() => {
    if (!isFocusMode) {
      setIsPreview(false)
      setIsPeeking(false)
    }
  }, [isFocusMode])

  // 长按 peek：松开后 textarea 重新挂载，自动收回焦点，打字零中断。
  useEffect(() => {
    if (previewVisible) return
    if (!isFocusMode) return
    textareaRef.current?.focus()
  }, [previewVisible, isFocusMode])

  // peek 打开期间监听 window keyup（textarea 已卸载，keyup 只会到 window）。
  useEffect(() => {
    if (!isPeeking) return
    function onKeyUp(event: KeyboardEvent) {
      if (!matchesPeekKey(event, peekKey)) return
      event.preventDefault()
      setIsPeeking(false)
    }
    window.addEventListener('keyup', onKeyUp)
    return () => window.removeEventListener('keyup', onKeyUp)
  }, [isPeeking, peekKey])

  // 生长式 textarea（移植自原版 MemoEditorTextarea）：compact 态随内容
  // 自动生长（CSS max-h-72 封顶后转内滚）；进入专注态清空内联高度，交给
  // flex 链条一次性撑到底（把下方笔记挤出视口 = 隐藏）。
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (isFocusMode) {
      textarea.style.height = ''
      return
    }
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [draft, isFocusMode])

  useEffect(() => {
    if (!draft.trim() || editingNote) setDiscardArmed(false)
  }, [draft, editingNote])

  useEffect(() => {
    if (!discardArmed) {
      if (discardArmedTimerRef.current) clearTimeout(discardArmedTimerRef.current)
      return
    }
    discardArmedTimerRef.current = setTimeout(() => {
      setDiscardArmed(false)
    }, 4000)
    return () => {
      if (discardArmedTimerRef.current) clearTimeout(discardArmedTimerRef.current)
    }
  }, [discardArmed])

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
    if (discardArmed) setDiscardArmed(false)
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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
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

  // 快捷编辑工具栏（对齐原版 MemoEditorToolbar 的 insert 机制）：
  // wrap 模式包裹选中文本（无选中时用占位符），line 模式在光标所在行首插入前缀。
  function handleToolbarInsert(insert: QuickNoteToolbarInsert) {
    const textarea = textareaRef.current
    if (!textarea) return
    const selectionStart = textarea.selectionStart ?? draft.length
    const selectionEnd = textarea.selectionEnd ?? selectionStart
    const selected = draft.slice(selectionStart, selectionEnd)

    if (insert.mode === 'wrap') {
      const body = selected || insert.placeholder
      const next =
        draft.slice(0, selectionStart) +
        insert.before +
        body +
        (insert.after ?? '') +
        draft.slice(selectionEnd)
      const bodyEnd = selectionStart + insert.before.length + body.length
      setPendingCaretIndex(bodyEnd)
      onDraftChange(next)
      textarea.focus()
      return
    }

    const lineStart = draft.lastIndexOf('\n', Math.max(selectionStart - 1, 0)) + 1
    const next = draft.slice(0, lineStart) + insert.before + draft.slice(lineStart)
    setPendingCaretIndex(selectionEnd + insert.before.length)
    onDraftChange(next)
    textarea.focus()
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
      {
        onSubmit,
        onKeyDown: (event: KeyboardEvent<HTMLFormElement>) => {
          // 长按 peek：按下 peek 键立即进入预览（preventDefault 防止 Alt
          // 松开触发浏览器菜单；e.repeat 忽略长按重复；IME 组合中忽略）。
          if (
            !isPeeking &&
            !isPreview &&
            matchesPeekKey(event, peekKey) &&
            !event.repeat &&
            !event.isComposing
          ) {
            event.preventDefault()
            setIsPeeking(true)
            return
          }
          // Esc 渐进退出：peek 优先关闭，其次退出手动预览，最后才轮到
          // workspace 的全局 Esc 退出专注（preventDefault 阻断）。
          if (event.key === 'Escape' && previewVisible) {
            event.preventDefault()
            event.stopPropagation()
            if (isPeeking) setIsPeeking(false)
            else setIsPreview(false)
          }
        },
        onKeyUp: (event: KeyboardEvent<HTMLFormElement>) => {
          // 兜底：textarea 仍在 DOM 时（偶发未卸载）keyup 也会冒泡到这里。
          if (isPeeking && matchesPeekKey(event, peekKey)) {
            setIsPeeking(false)
          }
        },
        className: isFocusMode
          ? quickNoteStyles.composerFocusForm
          : 'flex flex-col gap-3',
      },
      createElement(
        'div',
        {
          className: isFocusMode
            ? quickNoteStyles.composerFocusAnchor
            : quickNoteStyles.tagAutocompleteAnchor,
        },
        isFocusMode && previewVisible
          ? createElement(
              'div',
              {
                'data-testid': 'quick-note-composer-preview',
                className: quickNoteStyles.previewPane,
                'aria-label': '小记预览',
              },
              createElement(QuickNoteMarkdown, {
                content: draft,
                variant: 'preview',
              }),
              isPeeking && !isPreview
                ? createElement(
                    'div',
                    { className: quickNoteStyles.metaText },
                    '松开返回编辑',
                  )
                : null,
            )
          : createElement('textarea', {
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
      createElement(QuickNoteEditorToolbar, {
        onInsert: handleToolbarInsert,
        showPreviewToggle: isFocusMode,
        previewActive: previewVisible,
        onTogglePreview: () => setIsPreview((value) => !value),
        insertsDisabled: previewVisible,
      }),
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
            : draft.trim() && onDiscardDraft
              ? createElement(
                  Button,
                  {
                    type: 'button',
                    variant: 'ghost',
                    onClick: () => {
                      if (!discardArmed) {
                        setDiscardArmed(true)
                        return
                      }
                      setDiscardArmed(false)
                      void onDiscardDraft()
                    },
                    'aria-label': discardArmed ? '确认丢弃草稿' : '丢弃草稿',
                    className: discardArmed
                      ? 'text-[color:var(--qn-danger)]'
                      : quickNoteStyles.ghostButton,
                  },
                  createElement(XIcon),
                  discardArmed ? '再次点击确认丢弃' : '丢弃草稿',
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

// ---- 长按 peek 快捷键（默认 Alt，localStorage 可配置）----
// 设置页 UI 待 P1 接入；当前可通过控制台切换：
//   localStorage.setItem('pxii_quick_note_peek_key', 'backslash' | 'alt')
const PEEK_KEY_STORAGE_KEY = 'pxii_quick_note_peek_key'
export const QUICK_NOTE_PEEK_KEY_STORAGE = PEEK_KEY_STORAGE_KEY

export type QuickNotePeekKey = 'alt' | 'backslash'

function readPeekKey(): QuickNotePeekKey {
  try {
    const value = localStorage.getItem(PEEK_KEY_STORAGE_KEY)
    if (value === 'alt' || value === 'backslash') return value
  } catch {
    // storage 不可用（隐私模式等）时用默认值
  }
  return 'alt'
}

function matchesPeekKey(
  event: { key: string },
  peekKey: QuickNotePeekKey,
): boolean {
  return peekKey === 'alt' ? event.key === 'Alt' : event.key === '\\'
}

function getComposerStatus({
  draft,
  editingNote,
  hasConflict,
  isTyping,
  saveState,
  draftSaveState,
}: {
  draft: string
  editingNote: QuickNote | null
  hasConflict: boolean
  isTyping: boolean
  saveState: QuickNoteSaveState
  draftSaveState: QuickNoteDraftSaveState
}): {
  status: QuickNoteEditorStatus | null
  fallbackText?: string
} {
  if (hasConflict) return { status: 'conflict' }
  if (saveState === 'saving') return { status: 'saving' }
  if (saveState === 'failed') return { status: 'failed' }
  if (isTyping && draft.trim()) return { status: 'typing' }
  if (!editingNote) {
    if (draftSaveState === 'restored') return { status: 'draft-restored' }
    if (draftSaveState === 'failed') return { status: 'draft-failed' }
    if (draftSaveState === 'saving') return { status: 'draft-saving' }
    if (draftSaveState === 'saved') return { status: 'draft-saved' }
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
