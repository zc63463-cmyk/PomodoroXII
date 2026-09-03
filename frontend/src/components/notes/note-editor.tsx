'use client'

/**
 * Note editor —— CodeMirror 6 Markdown 源码编辑器 + 工具栏。
 *
 * ★ 为什么必须是独立组件 + 由调用方 dynamic(ssr:false) 加载
 *   CodeMirror 构造 EditorView 时就要访问 DOM，Next.js 的 SSR /
 *   静态预渲染阶段没有 document，直接渲染会报错。
 *
 * ★ 为什么是源码编辑器而不是所见即所得
 *   方案 A 的前提是「正文就是纯 .md 文件，能被 Obsidian 直接打开编辑」。
 *   WYSIWYG 会引入「编辑器内部文档模型 ↔ Markdown」的往返转换，
 *   必然有格式损耗，且与这个前提冲突。
 *
 * 工具栏覆盖速记（quick-note-editor-toolbar）的全部 11 项，
 * 并额外提供速记没有的表格与图片。
 */

import { useCallback, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export interface NoteEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { fontFamily: 'inherit', padding: '12px 0', caretColor: 'currentColor' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-line': { padding: '0 2px' },
})

// --------------------------------------------------------------------------- //
// 选区操作：Markdown 的格式无非两类 —— 包裹选区、给行加前缀
// --------------------------------------------------------------------------- //

/** 用 before/after 包裹当前选区（无选区时用 placeholder 占位并选中它）。 */
function wrapSelection(view: EditorView, before: string, after: string, placeholder: string) {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const text = selected || placeholder
  const inserted = `${before}${text}${after}`

  view.dispatch({
    changes: { from, to, insert: inserted },
    selection: selected
      ? EditorSelection.range(from + inserted.length, from + inserted.length)
      : EditorSelection.range(from + before.length, from + before.length + text.length),
  })
  view.focus()
}

/**
 * 给选中的每一行切换前缀。
 * 已全部带前缀则移除（toggle 语义，与常见编辑器一致），否则添加。
 */
function toggleLinePrefix(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const startLine = doc.lineAt(from).number
  const endLine = doc.lineAt(to).number

  const changes: ChangeSpec[] = []
  let allPrefixed = true

  for (let n = startLine; n <= endLine; n++) {
    const line = doc.line(n)
    if (!line.text.startsWith(prefix)) allPrefixed = false
  }

  for (let n = startLine; n <= endLine; n++) {
    const line = doc.line(n)
    if (allPrefixed) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' })
    } else {
      // 已有其它同类前缀（如列表换成任务列表）时先去掉，避免叠加
      const stripped = line.text.replace(/^(\s*)([-*+] \[[ x]\] |[-*+] |>\s?|\d+\.\s|#{1,6}\s)?/, '$1')
      changes.push({ from: line.from, to: line.to, insert: prefix + stripped })
    }
  }

  view.dispatch({ changes })
  view.focus()
}

/** 在当前光标处插入一段文本（用于表格这类块级模板）。 */
function insertBlock(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const line = doc.lineAt(from)
  const needsNewline = line.text.trim().length > 0
  const insert = `${needsNewline ? '\n' : ''}${text}\n`

  view.dispatch({
    changes: { from: line.to, to: line.to, insert },
    selection: EditorSelection.range(line.to + insert.length, line.to + insert.length),
  })
  view.focus()
}

// --------------------------------------------------------------------------- //
// 工具栏定义
// --------------------------------------------------------------------------- //

interface ToolbarItem {
  key: string
  title: string
  label: string
  action: (view: EditorView) => void
}

const TABLE_TEMPLATE = [
  '| 列 1 | 列 2 | 列 3 |',
  '| --- | --- | --- |',
  '| 内容 | 内容 | 内容 |',
].join('\n')

/**
 * 覆盖速记的 11 项（标签/标题/粗体/斜体/删除线/无序/有序/任务列表/引用/代码块/链接），
 * 外加速记没有的表格与图片。
 */
const TOOLBAR: ToolbarItem[] = [
  { key: 'tag', title: '标签', label: '#', action: (v) => wrapSelection(v, '#', '', '标签') },
  { key: 'heading', title: '标题', label: 'H', action: (v) => toggleLinePrefix(v, '## ') },
  { key: 'bold', title: '粗体', label: 'B', action: (v) => wrapSelection(v, '**', '**', '粗体') },
  { key: 'italic', title: '斜体', label: 'I', action: (v) => wrapSelection(v, '*', '*', '斜体') },
  { key: 'strike', title: '删除线', label: 'S', action: (v) => wrapSelection(v, '~~', '~~', '删除线') },
  { key: 'ul', title: '无序列表', label: '•', action: (v) => toggleLinePrefix(v, '- ') },
  { key: 'ol', title: '有序列表', label: '1.', action: (v) => toggleLinePrefix(v, '1. ') },
  { key: 'task', title: '任务列表', label: '☑', action: (v) => toggleLinePrefix(v, '- [ ] ') },
  { key: 'quote', title: '引用', label: '❝', action: (v) => toggleLinePrefix(v, '> ') },
  { key: 'code', title: '代码块', label: '{}', action: (v) => wrapSelection(v, '\n```\n', '\n```\n', '代码') },
  { key: 'link', title: '链接', label: '🔗', action: (v) => wrapSelection(v, '[', '](https://)', '链接文字') },
  // ↓ 速记没有的
  { key: 'table', title: '表格', label: '▦', action: (v) => insertBlock(v, TABLE_TEMPLATE) },
  { key: 'image', title: '图片', label: '🖼', action: (v) => insertBlock(v, '![描述](图片地址)') },
]

// --------------------------------------------------------------------------- //

export default function NoteEditor({
  value,
  onChange,
  placeholder = '用 Markdown 写点什么…',
  ariaLabel = '笔记正文',
}: NoteEditorProps) {
  const viewRef = useRef<EditorView | null>(null)

  const run = useCallback((action: (view: EditorView) => void) => {
    if (viewRef.current) action(viewRef.current)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
        {TOOLBAR.map((item) => (
          <button
            key={item.key}
            type="button"
            title={item.title}
            aria-label={item.title}
            onClick={() => run(item.action)}
            className="min-w-[1.75rem] rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
        <CodeMirror
          value={value}
          onChange={onChange}
          theme={editorTheme}
          height="100%"
          placeholder={placeholder}
          aria-label={ariaLabel}
          onCreateEditor={(view) => {
            viewRef.current = view
          }}
          basicSetup={{
            lineNumbers: false,
            foldGutter: true,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            searchKeymap: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
          }}
          extensions={[
            // 未接 @codemirror/language-data：它包含全部语言、体积很大，
            // 而代码块内高亮对笔记写作是次要需求。
            markdown({ base: markdownLanguage }),
            EditorView.lineWrapping,
          ]}
        />
      </div>
    </div>
  )
}
