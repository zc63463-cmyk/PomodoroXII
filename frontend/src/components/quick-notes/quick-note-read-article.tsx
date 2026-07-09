'use client'

import { createElement, useEffect, useRef, useState } from 'react'
import { FileTextIcon, PinIcon, Trash2Icon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { QuickNoteEditorStatusLine } from '@/components/quick-notes/quick-note-editor-status-line'
import { QuickNoteMarkdown } from '@/components/quick-notes/quick-note-markdown'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { QUICK_NOTE_TYPING_IDLE_MS } from '@/lib/quick-notes/quick-note-editor-status'
import { getQuickNoteTitle } from '@/lib/quick-notes/quick-note-selectors'
import { cn } from '@/lib/utils'
import type { QuickNoteSyncStatus } from '@/lib/quick-notes/quick-note-repository'
import type { QuickNoteEditorStatus } from '@/lib/quick-notes/quick-note-editor-status'
import type { QuickNote } from '@/types'

export function QuickNoteReadArticle({
  note,
  syncStatus,
  pendingAction,
  onClose,
  onTogglePin,
  onDelete,
  onMigrate,
  onUpdateQuickNote,
}: {
  note: QuickNote
  syncStatus?: QuickNoteSyncStatus
  pendingAction?: 'delete' | 'pin' | 'migrate'
  onClose: () => void
  onTogglePin: (id: string) => boolean | void | Promise<boolean | void>
  onDelete: (id: string) => void | Promise<void>
  onMigrate: (id: string) => void | Promise<void>
  onUpdateQuickNote: (id: string, data: { content: string }) => Promise<void>
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(note.content)
  const [baseContent, setBaseContent] = useState(note.content)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'failed'>('idle')
  const [hasRemoteUpdate, setHasRemoteUpdate] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const previousNoteIdRef = useRef(note.id)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = draft.trim() !== baseContent.trim()
  const isPending = pendingAction !== undefined || saveState === 'saving'

  useEffect(() => {
    if (previousNoteIdRef.current !== note.id) {
      previousNoteIdRef.current = note.id
      setIsEditing(false)
      setDraft(note.content)
      setBaseContent(note.content)
      setSaveState('idle')
      setHasRemoteUpdate(false)
      setIsTyping(false)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      return
    }

    if (!isEditing || !dirty) {
      setDraft(note.content)
      setBaseContent(note.content)
      setHasRemoteUpdate(false)
      setSaveState('idle')
      setIsTyping(false)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      return
    }

    if (note.content !== baseContent) {
      setBaseContent(note.content)
      setHasRemoteUpdate(true)
      setIsTyping(false)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      setSaveState('dirty')
    }
  }, [baseContent, dirty, isEditing, note.content, note.id])

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    }
  }, [])

  async function saveInlineEdit() {
    const content = draft.trim()
    if (!content) {
      setIsTyping(false)
      toast.error('小记内容不能为空')
      setSaveState('dirty')
      return
    }
    if (hasRemoteUpdate) {
      setIsTyping(false)
      setSaveState('dirty')
      return
    }

    try {
      setIsTyping(false)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      setSaveState('saving')
      await onUpdateQuickNote(note.id, { content })
      setBaseContent(content)
      setDraft(content)
      setHasRemoteUpdate(false)
      setIsEditing(false)
      setSaveState('idle')
      toast('小记已更新')
    } catch (error) {
      setSaveState('failed')
      toast.error('小记保存失败', {
        description: error instanceof Error ? error.message : '请稍后重试',
      })
    }
  }

  function startEditing() {
    setDraft(note.content)
    setBaseContent(note.content)
    setHasRemoteUpdate(false)
    setIsTyping(false)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setSaveState('idle')
    setIsEditing(true)
  }

  function cancelEditing() {
    setDraft(note.content)
    setBaseContent(note.content)
    setHasRemoteUpdate(false)
    setIsTyping(false)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setSaveState('idle')
    setIsEditing(false)
  }

  function keepLocalDraftAfterRemoteUpdate() {
    setHasRemoteUpdate(false)
    setIsTyping(false)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setSaveState('dirty')
  }

  function useRemoteContent() {
    setDraft(baseContent)
    setHasRemoteUpdate(false)
    setIsTyping(false)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setSaveState('idle')
  }

  function mergeRemoteContent() {
    const merged = [
      draft.trimEnd(),
      '',
      '--- 远端版本 ---',
      baseContent.trim(),
    ].join('\n')
    setDraft(merged)
    setHasRemoteUpdate(false)
    setIsTyping(false)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setSaveState('dirty')
  }

  function updateDraft(value: string) {
    setDraft(value)
    setSaveState('dirty')
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    const hasDraft = value.trim().length > 0
    setIsTyping(hasDraft)
    if (hasDraft) {
      typingTimerRef.current = setTimeout(() => {
        setIsTyping(false)
      }, QUICK_NOTE_TYPING_IDLE_MS)
    }
  }

  return createElement(
    'article',
    {
      className: cn(quickNoteStyles.readArticle, quickNoteStyles.motionPanel),
      'data-motion': 'article',
    },
    createElement(
      'header',
      { className: quickNoteStyles.readHeader },
      createElement(
        'div',
        { className: 'min-w-0' },
        createElement('p', { className: quickNoteStyles.eyebrow }, '沉浸阅读'),
        createElement('h1', { className: quickNoteStyles.readTitle }, getQuickNoteTitle(note)),
        createElement(
          'p',
          { className: quickNoteStyles.metaText },
          `${formatReadableDate(note.created_at)} · ${syncStatus === 'failed' ? '同步失败' : syncStatus === 'pending' ? '待同步' : '本地已保存'}`,
        ),
      ),
      createElement(
        'div',
        { className: 'flex shrink-0 flex-wrap items-center justify-end gap-1.5' },
        createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            onClick: startEditing,
            disabled: isPending,
            className: quickNoteStyles.ghostButton,
          },
          '编辑',
        ),
        createElement(
          Button,
          {
            type: 'button',
            variant: note.pinned ? 'secondary' : 'ghost',
            size: 'icon-sm',
            onClick: () => void onTogglePin(note.id),
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
            onClick: () => void onMigrate(note.id),
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
            onClick: () => void onDelete(note.id),
            disabled: isPending,
            'aria-label': '移到回收站',
            className: quickNoteStyles.cardDangerAction,
          },
          createElement(Trash2Icon),
        ),
        createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            size: 'icon-sm',
            onClick: onClose,
            'aria-label': '返回工作台',
            className: quickNoteStyles.ghostButton,
          },
          createElement(XIcon),
        ),
      ),
    ),
    isEditing
      ? createElement(
          'div',
          { className: quickNoteStyles.inlineEditorWrap },
          hasRemoteUpdate
            ? createElement(
                'div',
                { className: quickNoteStyles.notice },
                createElement(
                  'p',
                  null,
                  '远端也更新了，自动保存已暂停。请选择处理方式。',
                ),
                createElement(
                  'div',
                  { className: 'mt-2 flex flex-wrap items-center gap-2' },
                  createElement(
                    Button,
                    {
                      type: 'button',
                      variant: 'outline',
                      size: 'sm',
                      onClick: keepLocalDraftAfterRemoteUpdate,
                      className: quickNoteStyles.outlineButton,
                    },
                    '保留本地并覆盖',
                  ),
                  createElement(
                    Button,
                    {
                      type: 'button',
                      variant: 'ghost',
                      size: 'sm',
                      onClick: useRemoteContent,
                      className: quickNoteStyles.ghostButton,
                    },
                    '采用远端',
                  ),
                  createElement(
                    Button,
                    {
                      type: 'button',
                      variant: 'ghost',
                      size: 'sm',
                      onClick: mergeRemoteContent,
                      className: quickNoteStyles.ghostButton,
                    },
                    '合并到草稿',
                  ),
                ),
              )
            : null,
          createElement('textarea', {
            value: draft,
            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
              updateDraft(event.target.value)
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                cancelEditing()
              }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void saveInlineEdit()
              }
            },
            className: quickNoteStyles.inlineTextarea,
            'aria-label': '详情小记内容',
          }),
          createElement(
            'div',
            { className: 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' },
            createElement(
              QuickNoteEditorStatusLine,
              getInlineEditStatus(saveState, dirty, hasRemoteUpdate, isTyping),
            ),
            createElement(
              'div',
              { className: 'flex items-center gap-2' },
              createElement(
                Button,
                {
                  type: 'button',
                  variant: 'ghost',
                  onClick: cancelEditing,
                  disabled: saveState === 'saving',
                  className: quickNoteStyles.ghostButton,
                },
                '取消',
              ),
              createElement(
                Button,
                {
                  type: 'button',
                  onClick: () => void saveInlineEdit(),
                  disabled: saveState === 'saving' || !draft.trim() || hasRemoteUpdate,
                  className: quickNoteStyles.primaryButton,
                },
                saveState === 'saving' ? '保存中' : '保存',
              ),
            ),
          ),
        )
      : createElement(
          'div',
          { className: quickNoteStyles.readBody },
          createElement(QuickNoteMarkdown, {
            content: note.content,
            variant: 'read',
          }),
        ),
  )
}

function getInlineEditStatus(
  saveState: 'idle' | 'dirty' | 'saving' | 'failed',
  dirty: boolean,
  hasRemoteUpdate: boolean,
  isTyping: boolean,
): {
  status: QuickNoteEditorStatus | null
  fallbackText?: string
} {
  if (hasRemoteUpdate) return { status: 'conflict' }
  if (saveState === 'saving') return { status: 'saving' }
  if (saveState === 'failed') return { status: 'failed' }
  if (isTyping && dirty) return { status: 'typing' }
  if (dirty || saveState === 'dirty') return { status: 'dirty' }
  return {
    status: null,
    fallbackText: '局部编辑，不会影响顶部 composer 草稿。',
  }
}

function formatReadableDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
