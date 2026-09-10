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

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
// 副作用导入：触发各命令组的注册。工具栏与快捷键都从注册表里取。
import '@/lib/editor/commands-core'
import '@/lib/editor/commands-tables'
import { tryDeleteTableSelection } from '@/lib/editor/commands-tables'
import {
  commandsWithIcon,
  getAllCommands,
  getCommandGroups,
  getKeyedCommands,
  runCommand,
} from '@/lib/editor/commands'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { countWords, parseOutline, type OutlineItem } from '@/lib/notes/note-outline'
import { findTableAt } from '@/lib/notes/note-tables'
// 表格 Live Preview：光标离开表格时渲染成 <table>，进入时露出源码。
// ★ 必须排在 markdown({ base: markdownLanguage }) 之后 —— 没有 GFM 语法树
//   就没有 Table 节点，也就没有可渲染的表格块。
import { editingCellField, tablePreview } from '@/lib/editor/table-preview'
import { imagePreview } from '@/lib/editor/image-preview'
import { pasteImageUpload } from '@/lib/editor/paste-image'
import { setActiveView } from '@/lib/editor/active-view'
import {
  applyWikiLinkInsertion,
  matchNoteTitles,
} from '@/lib/notes/note-links'

/** 编辑器内的选区（字符偏移，含头不含尾）。 */
export interface EditorSelectionRange {
  from: number
  to: number
}

export interface NoteEditorProps {
  value: string
  onChange: (value: string) => void
  /** Cmd/Ctrl+S 立即保存（跳过防抖）。不传则该快捷键无动作。 */
  onSave?: () => void
  /**
   * 选区变化。无选区（光标）时传 null。
   * 「拆分」这类针对选中内容的操作需要它 —— 选区偏移交给调用方，
   * 编辑器本身不理解任何笔记业务。
   */
  onSelectionChange?: (range: EditorSelectionRange | null) => void
  /**
   * 编辑器滚动位置（0..1）。用于让预览跟随滚动。
   * 只在开启预览同步时才需要传。
   */
  onScrollPercent?: (percent: number) => void
  placeholder?: string
  ariaLabel?: string
  /**
   * 用于 `[[` 自动补全的候选笔记标题。不传则不启用链接补全
   * （速记等其它使用方不受影响）。
   */
  noteTitles?: readonly string[]
}

/**
 * `[[` 之后的笔记标题补全。
 *
 * 匹配与插入文案都由 `lib/notes/note-links` 的纯函数完成，这里只做
 * CodeMirror 的适配 —— 这样补全逻辑可以脱离编辑器被测试。
 */
function makeWikiLinkCompletion(titles: readonly string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^[\]\n]*/)
    if (!match) return null

    const prefix = match.text.slice(2)
    const options = matchNoteTitles(prefix, titles)
    if (options.length === 0) return null

    return {
      from: match.from + 2,
      options: options.map((title) => ({
        label: title,
        type: 'text',
        apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
          const after = view.state.sliceDoc(to, to + 2)
          const insert = applyWikiLinkInsertion(title, after)
          // 光标落到 `]]` 之后（若后面原本就有 `]]` 则停在它之前，不跳过）
          const caret = from + title.length + (after.startsWith(']]') ? 0 : 2)
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: caret },
          })
        },
      })),
    }
  }
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

/**
 * 快捷键。用 Prec.highest 确保覆盖 CodeMirror 自身的绑定 ——
 * 尤其是 Mod-s，浏览器默认会弹出「保存网页」。
 *
 * ★ 格式化快捷键不再写死在这里，而是从命令注册表里取：
 *   带 key 的命令会自动绑上 —— 以后加命令即加快捷键，不用改这个文件。
 *   Mod-s 是例外：它调的是组件的 onSave，不属于「文本命令」的范畴。
 */
function buildKeymap(
  onSave: (() => void) | undefined,
  runById: (id: string, view: EditorView) => boolean,
) {
  return Prec.highest(
    keymap.of([
      /**
       * ★★ "选中 + Delete" 删除表格行/列（在 Mod-s 之后、其它键位之前）。
       *
       *   判定：选区在表格内且**严格覆盖**整行/整列 → 拦截 Delete/Backspace
       *   调对应删除；否则返回 false，让 CodeMirror 默认的字符删除继续。
       *
       *   流程（参照 advanced-tables）：
       *   1. 点进表格 → 露出源码 → 光标在表格内
       *   2. 选中整行（Shift+Home/End 或鼠标拖）或从表头拖到最后一行（整列）
       *   3. 按 Delete/Backspace → 行/列消失
       */
      {
        key: 'Delete',
        preventDefault: true,
        run: (view) => tryDeleteTableSelection(view),
      },
      {
        key: 'Backspace',
        preventDefault: true,
        run: (view) => tryDeleteTableSelection(view),
      },
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSave?.()
          return true
        },
      },
      ...getKeyedCommands().map((command) => ({
        key: command.key as string,
        preventDefault: true,
        run: (view: EditorView) => runById(command.id, view),
      })),
    ]),
  )
}

export default function NoteEditor({
  value,
  onChange,
  onSave,
  onScrollPercent,
  onSelectionChange,
  placeholder = '用 Markdown 写点什么…',
  ariaLabel = '笔记正文',
  noteTitles,
}: NoteEditorProps) {
  const viewRef = useRef<EditorView | null>(null)
  // 滚动监听器只挂一次，用 ref 拿最新回调，避免闭包捕获旧值
  const scrollCbRef = useRef<((p: number) => void) | undefined>(onScrollPercent)
  scrollCbRef.current = onScrollPercent
  // 同理：选区回调也走 ref，避免把旧闭包挂进 CodeMirror 的扩展里
  const selectionCbRef = useRef<((r: EditorSelectionRange | null) => void) | undefined>(
    onSelectionChange,
  )
  selectionCbRef.current = onSelectionChange

  // 卸载时移除监听器（CodeMirror 的 DOM 由库自己销毁，这里只解绑事件）
  const detachRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      detachRef.current?.()
      // ★ 必须注销：否则切走笔记页后，命令面板还会拿着已卸载的 view 执行命令
      setActiveView(null)
    },
    [],
  )
  const [showOutline, setShowOutline] = useState(false)
  /**
   * 光标是否在表格内。只是驱动重渲染的信号位 —— 真值在渲染时用 viewRef.current 现算，
   * 这样命令的 when 不必绑死在「表格」这一个概念上。
   */
  const [cursorInTable, setCursorInTable] = useState(false)
  /**
   * 编辑器是否已挂载。
   * ★ 必须等 CodeMirror 建好 view 之后，命令的 when 才算得准 ——
   *   viewRef.current 在建好之前是 null，那时算出来的可用性是不作数的。
   */
  const [editorReady, setEditorReady] = useState(false)

  // ★ 大纲与统计不能跟着每次按键同步重算。
  //   两者都是对整篇正文的全量扫描（parseOutline 遍历所有行、
  //   countWords 做一串正则替换），万字级笔记下每次输入都会卡顿。
  //   useDeferredValue 让这两项在浏览器空闲时更新 —— 输入保持即时响应，
  //   大纲与字数稍一拍跟上。比手写 setTimeout 防抖更贴合 React 的调度语义。
  const deferredValue = useDeferredValue(value)
  const outline = useMemo(() => parseOutline(deferredValue), [deferredValue])
  const stats = useMemo(() => countWords(deferredValue), [deferredValue])

  /**
   * ★ 工具栏按钮按下时**不要夺走焦点**（阻止 mousedown 的默认行为）。
   *
   * 否则会出现死循环：表格命令要求光标位于表格内，但用户必须点工具栏
   * 才能用这些命令 —— 一点焦点就离开编辑器，命令立刻变灰，永远用不上。
   *
   * 保住焦点还附带一个好处：命令执行后光标仍在原处，可以接着操作。
   * 键盘用户不受影响（Tab 聚焦不走 mousedown）。
   */
  const keepFocus = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  /** 用当前 EditorView 构造命令上下文。 */
  const ctxFor = useCallback((view: EditorView) => {
    const { from, to } = view.state.selection.main
    return { view, selection: from === to ? null : { from, to } }
  }, [])

  /**
   * 按 id 执行一条注册过的命令。
   *
   * ★ 返回 false 的两种情况都要让 CodeMirror 继续走默认行为：
   *   1. 命令不存在
   *   2. 命令的 `when` 不满足（如 Tab 跳格只在表格内生效，
   *      表格外必须保留原来的缩进功能）
   */
  const runById = useCallback((id: string, view: EditorView): boolean => {
    const command = getAllCommands().find((c) => c.id === id)
    if (!command) return false
    const { from, to } = view.state.selection.main
    const ctx = { view, selection: from === to ? null : { from, to } }
    if (command.when && !command.when(ctx)) return false
    runCommand(command, ctx)
    return true
  }, [])

  /** 跳到指定行：把光标放上去并滚动到可见区域。 */
  const jumpToLine = useCallback((line: number) => {
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc
    if (line >= doc.lines) return
    const pos = doc.line(line + 1).from // parseOutline 的 line 是 0 基
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    })
    view.focus()
  }, [])

  // cursorInTable / editorReady 是驱动重渲染的**信号位**（见 updateListener 与
  // onCreateEditor 的注释）：进出表格、编辑器就绪时它们翻转 → 触发重渲染 →
  // 下面的工具栏才会重新求值 when。渲染本身不使用其值，这里显式消费以免被清成未使用。
  void cursorInTable
  void editorReady

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
        {/* ★ 命令组 → 工具栏。
            表格组收进下拉：五个编辑操作若常驻工具栏，光标不在表格里时
            就是一排灰按钮（实测反馈），噪音太大；收进菜单后，
            「菜单里禁用」反而自然 —— 菜单本来就承载「当前能用什么」。 */}
        {getCommandGroups().map((group) => {
          const items = commandsWithIcon(group.commands).map((command) => ({
              command,
              enabled: viewRef.current
                ? (command.when?.(ctxFor(viewRef.current)) ?? true)
                : true,
            }))

          if (group.id === 'tables') {
            // ★ 分段按钮（split button）：
            //   主区域 = 直接执行组的第一条命令（「点 ▦ 就插入表格」的一键手感）；
            //   箭头   = 展开整组，用于增删行列这类编辑操作。
            //   之前做成「点 ▦ 先展开菜单再选插入」，把一步变成了两步 —— 是退步。
            const primary = items[0]
            // 组里一条带图标的命令都没有时不渲染 —— 少了这道防线，
            // 空组会让 primary.command 抛错，进而让 Fast Refresh 整体失败。
            if (!primary) return null

            return (
              <div key={group.id} className="flex items-center">
                <button
                  type="button"
                  title={primary.command.title}
                  aria-label={primary.command.title}
                  data-command-id={primary.command.id}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    if (viewRef.current) runById(primary.command.id, viewRef.current)
                  }}
                  className="focus-ring transition-ui min-w-[1.75rem] rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {primary.command.icon}
                </button>

                <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      title="更多表格操作"
                      aria-label="更多表格操作"
                      onMouseDown={keepFocus}
                      // ★ 别把箭头做小：之前 -ml-0.5 + px-0.5 只有约 13×20px，
                      //   还和主按钮重叠，点交界处会误触主按钮（表现为"又插了个表格"）。
                      //   现在与主按钮同高、独立圆角、左侧加分隔线，一眼能看出是两个区域。
                      className="focus-ring transition-ui min-w-[1.25rem] rounded-r border-l border-border/60 py-1 pl-1 pr-1 text-[0.7rem] leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      ▾
                    </button>
                  }
                />
                <DropdownMenuContent align="start" className="min-w-56">
                  {items.map(({ command, enabled }) => (
                    <DropdownMenuItem
                      key={command.id}
                      data-command-id={command.id}
                      disabled={!enabled}
                      onClick={() => {
                        if (viewRef.current) runById(command.id, viewRef.current)
                      }}
                    >
                      {/* whitespace-nowrap：菜单过窄时文字会一字一行竖排（实测） */}
                      <span className="mr-2 whitespace-nowrap">{command.icon}</span>
                      <span className="whitespace-nowrap">{command.title}</span>
                      {command.key && (
                        <span className="ml-auto whitespace-nowrap pl-4 text-xs text-muted-foreground">
                          {command.key}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                  {items.some(({ enabled }) => !enabled) && (
                    <div className="border-t px-2 pt-1.5 text-xs text-muted-foreground">
                      灰色命令需要光标位于表格内（分隔行每格须为 --- ）
                    </div>
                  )}
                </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          }

          return items.map(({ command, enabled }) => (
            <button
              key={command.id}
              type="button"
              title={command.title}
              aria-label={command.title}
              data-command-id={command.id}
              disabled={!enabled}
              onMouseDown={keepFocus}
              onClick={() => {
                if (viewRef.current) runById(command.id, viewRef.current)
              }}
              className="focus-ring transition-ui min-w-[1.75rem] rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {command.icon}
            </button>
          ))
        })}

        <button
          type="button"
          title="大纲"
          aria-label="大纲"
          onClick={() => setShowOutline((v) => !v)}
          className={
            showOutline
              ? 'ml-auto rounded bg-muted px-1.5 py-1 text-xs text-foreground'
              : 'focus-ring transition-ui ml-auto rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground'
          }
        >
          大纲
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
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
              // 登记为活动编辑器 —— 全局命令面板要靠它执行编辑器命令
              setActiveView(view)
              // view 就绪后要重算一次命令可用性（此前 viewRef 是 null）
              setEditorReady(true)

              const scroller = view.scrollDOM
              const handleScroll = () => {
                const max = scroller.scrollHeight - scroller.clientHeight
                scrollCbRef.current?.(max > 0 ? scroller.scrollTop / max : 0)
              }
              scroller.addEventListener('scroll', handleScroll, { passive: true })
              detachRef.current = () => {
                scroller.removeEventListener('scroll', handleScroll)
              }
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
              buildKeymap(onSave, runById),
              // 未接 @codemirror/language-data：它包含全部语言、体积很大，
              // 而代码块内高亮对笔记写作是次要需求。
              markdown({ base: markdownLanguage }),
              // ★ editingCellField 必须先注册：tablePreview 的 build 会读它
              editingCellField,
              tablePreview,
              // 图片预览：光标离开那一行就渲染成 <img>
              imagePreview,
              // 粘贴即上传：Ctrl+V 图片直接进 assets
              pasteImageUpload,
              EditorView.lineWrapping,
              // 选区变化上报。只在 selectionSet 时回调 —— 正文变化不算选区变化，
              // 否则打一个字就会通知一次，调用方无从区分。
              EditorView.updateListener.of((update) => {
                if (update.selectionSet) {
                  const { from, to } = update.state.selection.main
                  selectionCbRef.current?.(from === to ? null : { from, to })
                }

                // ★ 命令可用性（如表格命令只在表格内可用）要跟着光标与正文更新。
                //   但 viewRef 变化不会触发 React 重渲染，所以在这里用 state 打信号；
                //   且只在状态**真的变了**时才 setState —— 否则每次按键都会重渲染工具栏。
                if (update.selectionSet || update.docChanged) {
                  const inside =
                    findTableAt(
                      update.state.doc.toString(),
                      update.state.selection.main.head,
                    ) !== null
                  setCursorInTable((prev) => (prev === inside ? prev : inside))
                }
              }),
              // `[[` 触发的笔记标题补全。没传候选就不挂这个扩展。
              ...(noteTitles && noteTitles.length > 0
                ? [
                    autocompletion({
                      // 用 override 而非追加：CodeMirror 的 autocompletion 只提供
                      // override（替换）语义。Markdown 下原本没有其它补全源，
                      // 替换的代价可以忽略。
                      override: [makeWikiLinkCompletion(noteTitles)],
                    }),
                  ]
                : []),
            ]}
          />
        </div>

        {showOutline && <OutlinePanel items={outline} onJump={jumpToLine} />}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1 text-xs text-muted-foreground">
        <span>{stats.words} 词</span>
        <span>{stats.characters} 字</span>
        <span>约 {stats.readingMinutes} 分钟</span>
      </div>
    </div>
  )
}

/** 大纲面板：按层级缩进，点击跳转。 */
function OutlinePanel({
  items,
  onJump,
}: {
  items: OutlineItem[]
  onJump: (line: number) => void
}) {
  if (items.length === 0) {
    return (
      <aside className="w-48 shrink-0 overflow-y-auto border-l px-3 py-3">
        <p className="text-xs text-muted-foreground">还没有标题</p>
      </aside>
    )
  }

  return (
    <aside className="w-48 shrink-0 overflow-y-auto border-l px-3 py-3">
      <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">大纲</div>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={`${item.line}-${index}`}>
            <button
              type="button"
              onClick={() => onJump(item.line)}
              className="focus-ring transition-ui block w-full truncate rounded text-left text-xs text-muted-foreground hover:text-foreground"
              style={{ paddingLeft: `${(item.level - 1) * 12}px` }}
              title={item.text}
            >
              {item.text || '(无标题)'}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
