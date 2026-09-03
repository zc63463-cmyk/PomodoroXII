'use client'

/**
 * Note editor —— 基于 CodeMirror 6 的 Markdown 源码编辑器。
 *
 * ★ 为什么必须是独立组件 + 由调用方 dynamic(ssr:false) 加载
 *   CodeMirror 在构造 EditorView 时就要访问 DOM，Next.js 的 SSR /
 *   静态预渲染阶段没有 document，直接渲染会报错。
 *
 * ★ 为什么是源码编辑器而不是所见即所得
 *   方案 A 的前提是「正文就是纯 .md 文件，能被 Obsidian 直接打开编辑」。
 *   WYSIWYG 会引入「编辑器内部文档模型 ↔ Markdown」的往返转换，
 *   必然有格式损耗，且与这个前提冲突。
 *
 * 语法高亮来自 @codemirror/lang-markdown（Lezer 真解析器），
 * 不是正则匹配 —— 长文与嵌套结构下不会错。
 */

import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'

export interface NoteEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
}

/**
 * 轻量主题：只覆盖与项目背景/文字色对齐的部分，
 * 其余沿用 CodeMirror 默认，避免引入一整套第二设计语言。
 */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    fontFamily: 'inherit',
    padding: '12px 0',
    caretColor: 'currentColor',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.7',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-line': {
    padding: '0 2px',
  },
})

export default function NoteEditor({
  value,
  onChange,
  placeholder = '用 Markdown 写点什么…',
  ariaLabel = '笔记正文',
}: NoteEditorProps) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={editorTheme}
      height="100%"
      placeholder={placeholder}
      aria-label={ariaLabel}
      basicSetup={{
        // 行号对长文写作意义不大，反而占宽度
        lineNumbers: false,
        foldGutter: true,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        // 长文写作要用的能力
        searchKeymap: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
      }}
      extensions={[
        // 注意：没有接 @codemirror/language-data —— 它包含全部语言、
        // 体积很大，而代码块内高亮对笔记写作是次要需求。
        // Markdown 自身的标题/强调/列表/引用/链接等由 Lezer 正确解析。
        markdown({ base: markdownLanguage }),
        EditorView.lineWrapping,
      ]}
    />
  )
}
