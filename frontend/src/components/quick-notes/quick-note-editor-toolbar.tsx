'use client'

import { createElement, ElementType } from 'react'
import {
  Bold as BoldIcon,
  Code as CodeIcon,
  Eye as EyeIcon,
  Hash as HashIcon,
  Heading1 as Heading1Icon,
  Italic as ItalicIcon,
  Link as LinkIcon,
  List as ListIcon,
  ListOrdered as ListOrderedIcon,
  ListTodo as ListTodoIcon,
  PencilLine as PencilLineIcon,
  Strikethrough as StrikethroughIcon,
  TextQuote as TextQuoteIcon,
} from 'lucide-react'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { cn } from '@/lib/utils'

export interface QuickNoteToolbarInsert {
  /** Text inserted before the selection (wrap mode) or at the line start (line mode). */
  before: string
  /** Text inserted after the selection (wrap mode only). */
  after?: string
  /** Placeholder used when there is no selection. */
  placeholder: string
  mode: 'wrap' | 'line'
}

interface ToolbarButton {
  key: string
  title: string
  icon: ElementType
  insert: QuickNoteToolbarInsert
}

const BUTTONS: ToolbarButton[] = [
  { key: 'tag', title: '标签', icon: HashIcon, insert: { before: '#', placeholder: '', mode: 'wrap' } },
  { key: 'heading', title: '标题', icon: Heading1Icon, insert: { before: '# ', placeholder: '标题', mode: 'line' } },
  { key: 'bold', title: '粗体', icon: BoldIcon, insert: { before: '**', after: '**', placeholder: '粗体', mode: 'wrap' } },
  { key: 'italic', title: '斜体', icon: ItalicIcon, insert: { before: '*', after: '*', placeholder: '斜体', mode: 'wrap' } },
  { key: 'strike', title: '删除线', icon: StrikethroughIcon, insert: { before: '~~', after: '~~', placeholder: '删除线', mode: 'wrap' } },
  { key: 'ul', title: '无序列表', icon: ListIcon, insert: { before: '- ', placeholder: '列表项', mode: 'line' } },
  { key: 'ol', title: '有序列表', icon: ListOrderedIcon, insert: { before: '1. ', placeholder: '列表项', mode: 'line' } },
  { key: 'task', title: '任务列表', icon: ListTodoIcon, insert: { before: '- [ ] ', placeholder: '任务', mode: 'line' } },
  { key: 'quote', title: '引用', icon: TextQuoteIcon, insert: { before: '> ', placeholder: '引用', mode: 'line' } },
  { key: 'code', title: '代码块', icon: CodeIcon, insert: { before: '```\n', after: '\n```', placeholder: '代码', mode: 'wrap' } },
  { key: 'link', title: '链接', icon: LinkIcon, insert: { before: '[', after: '](url)', placeholder: '链接文字', mode: 'wrap' } },
]

export function QuickNoteEditorToolbar({
  onInsert,
  label = '快捷编辑',
  showPreviewToggle = false,
  previewActive = false,
  onTogglePreview,
  insertsDisabled = false,
}: {
  onInsert: (insert: QuickNoteToolbarInsert) => void
  label?: string
  /** 渲染预览切换键（专注模式专用）。 */
  showPreviewToggle?: boolean
  /** 预览态激活中：切换键高亮，插入键全部禁用（预览时无光标概念，插入有歧义）。 */
  previewActive?: boolean
  onTogglePreview?: () => void
  insertsDisabled?: boolean
}) {
  const insertButtons = BUTTONS.map((button) =>
    createElement(
      'button',
      {
        key: button.key,
        type: 'button',
        'data-toolbar-key': button.key,
        title: button.title,
        'aria-label': button.title,
        disabled: insertsDisabled,
        className: cn(quickNoteStyles.ghostButton, quickNoteStyles.toolbarButton),
        onClick: () => onInsert(button.insert),
      },
      createElement(button.icon, { className: quickNoteStyles.toolbarIcon }),
    ),
  )

  const previewToggle =
    showPreviewToggle && onTogglePreview
      ? createElement(
          'button',
          {
            key: 'preview-toggle',
            type: 'button',
            'data-toolbar-key': 'preview',
            title: previewActive ? '返回编辑' : '预览',
            'aria-label': previewActive ? '返回编辑' : '预览',
            'aria-pressed': previewActive,
            className: cn(
              quickNoteStyles.ghostButton,
              quickNoteStyles.toolbarButton,
              previewActive ? quickNoteStyles.toolbarButtonActive : null,
            ),
            onClick: onTogglePreview,
          },
          createElement(
            previewActive ? PencilLineIcon : EyeIcon,
            { className: quickNoteStyles.toolbarIcon },
          ),
        )
      : null

  return createElement(
    'div',
    { className: quickNoteStyles.toolbar, role: 'toolbar', 'aria-label': label },
    previewToggle,
    insertButtons,
  )
}
