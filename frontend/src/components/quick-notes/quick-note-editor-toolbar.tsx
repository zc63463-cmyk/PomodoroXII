'use client'

import { createElement, ElementType } from 'react'
import {
  Bold as BoldIcon,
  Code as CodeIcon,
  Hash as HashIcon,
  Heading1 as Heading1Icon,
  Italic as ItalicIcon,
  Link as LinkIcon,
  List as ListIcon,
  ListOrdered as ListOrderedIcon,
  ListTodo as ListTodoIcon,
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
}: {
  onInsert: (insert: QuickNoteToolbarInsert) => void
  label?: string
}) {
  return createElement(
    'div',
    { className: quickNoteStyles.toolbar, role: 'toolbar', 'aria-label': label },
    BUTTONS.map((button) =>
      createElement(
        'button',
        {
          key: button.key,
          type: 'button',
          'data-toolbar-key': button.key,
          title: button.title,
          'aria-label': button.title,
          className: cn(quickNoteStyles.ghostButton, quickNoteStyles.toolbarButton),
          onClick: () => onInsert(button.insert),
        },
        createElement(button.icon, { className: quickNoteStyles.toolbarIcon }),
      ),
    ),
  )
}
