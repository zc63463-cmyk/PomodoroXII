/**
 * Editor commands —— 笔记编辑器（CodeMirror）的命令层。
 *
 * ★ 为什么只要一个注册表
 *   目标是"以后遇到好的 Obsidian 插件能平滑搬进来"。
 *   在那之前，加一个功能要同时改 `TOOLBAR` 数组和 `buildKeymap` 两处，
 *   编辑器核心文件里塞满了具体功能 —— 装第一个插件时这里就会失控。
 *
 *   现在：一切能力 = 一条命令，工具栏 / 快捷键 / 命令面板都只是消费者，
 *   编辑器本身**不认识任何具体功能**。
 *
 * ★ 适用范围：CodeMirror 编辑器（笔记域）
 *   速记域用的是原生 <textarea>，插入语义也不同（笔记的 line 模式是
 *   toggle + 剥离其它前缀，速记是简单加前缀）。强行统一要么改坏行为，
 *   要么得抽象跨内核接口 —— 收益远小于成本，所以速记保持原样。
 *
 * ★ 关键约束：命令逻辑尽量是纯函数
 *   `custom` 类型的 run 直接操作 EditorView，测不了；
 *   所以复杂命令（如表格操作）必须把文本变换抽成纯函数，
 *   custom 只做薄适配。见 lib/notes/ 下的既有做法。
 */

import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** 命令运行时上下文。只给命令它需要的东西，不暴露整个编辑器组件。 */
export interface EditorCommandContext {
  view: EditorView
  /** 当前选区；无选区（光标）时为 null */
  selection: { from: number; to: number } | null
}

/**
 * 命令动作。
 *
 * 前三种是**声明式**的：只用数据描述，由统一执行器处理。
 * 日常格式化类命令都能落在这三类里，也因此是可枚举、可序列化、可测试的。
 */
export type EditorCommandAction =
  /** 包裹选区（无选区时用 placeholder 占位并选中它） */
  | { kind: 'wrap'; before: string; after: string; placeholder: string }
  /** 给选中行切换前缀（已全部带则移除，与常见编辑器一致） */
  | { kind: 'line'; prefix: string }
  /** 在光标处插入块级模板（表格、图片等） */
  | { kind: 'block'; text: string }
  /** 复杂命令。逻辑请抽成纯函数，这里只做薄适配。 */
  | { kind: 'custom'; run: (ctx: EditorCommandContext) => void }

export interface EditorCommand {
  /** 全局唯一，建议 `分组.动作`，如 `table.insertRow` */
  id: string
  /** 提示与命令面板里显示的名字 */
  title: string
  /** 工具栏上的文字图标。不提供则只出现在命令面板，不占工具栏位 */
  icon?: string
  /** CodeMirror 键位，如 `Mod-b`。不提供则只能从工具栏触发 */
  key?: string
  /** 当前上下文是否可用。不提供视为总是可用 */
  when?: (ctx: EditorCommandContext) => boolean
  action: EditorCommandAction
}

/** 一组相关命令 = 一个「插件」。工具栏里同一组会加分隔线。 */
export interface EditorCommandGroup {
  id: string
  name: string
  commands: EditorCommand[]
}

// --------------------------------------------------------------------------- //
// 执行器
// --------------------------------------------------------------------------- //

/** 用 before/after 包裹选区（无选区时用 placeholder 占位并选中它）。 */
export function wrapSelection(
  view: EditorView,
  before: string,
  after: string,
  placeholder: string,
): void {
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
export function toggleLinePrefix(view: EditorView, prefix: string): void {
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
      const stripped = line.text.replace(
        /^(\s*)([-*+] \[[ x]\] |[-*+] |>\s?|\d+\.\s|#{1,6}\s)?/,
        '$1',
      )
      changes.push({ from: line.from, to: line.to, insert: prefix + stripped })
    }
  }

  view.dispatch({ changes })
  view.focus()
}

/** 在当前光标处插入一段文本（表格、图片这类块级模板）。 */
export function insertBlock(view: EditorView, text: string): void {
  const { from } = view.state.selection.main
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

/** 执行一条命令。 */
export function runCommand(
  command: EditorCommand,
  ctx: EditorCommandContext,
): void {
  switch (command.action.kind) {
    case 'wrap':
      wrapSelection(
        ctx.view,
        command.action.before,
        command.action.after,
        command.action.placeholder,
      )
      return
    case 'line':
      toggleLinePrefix(ctx.view, command.action.prefix)
      return
    case 'block':
      insertBlock(ctx.view, command.action.text)
      return
    case 'custom':
      command.action.run(ctx)
      return
  }
}

// --------------------------------------------------------------------------- //
// 注册表
// --------------------------------------------------------------------------- //

const groups: EditorCommandGroup[] = []

/**
 * 把一组命令并进列表；同 id 已存在则原样返回。
 *
 * ★ 抽成纯函数是为了可测：注册表是模块级单例，
 *   直接在测试里往里塞探针命令会污染同进程的其它测试
 *   （工具栏会多出按钮，进而让"顺序基准"之类的断言全红）。
 */
export function mergeGroups(
  list: readonly EditorCommandGroup[],
  group: EditorCommandGroup,
): readonly EditorCommandGroup[] {
  if (list.some((g) => g.id === group.id)) return list
  return [...list, group]
}

/**
 * 注册一组命令。重复注册同一 id 会被忽略 ——
 * 模块热更新时这段代码可能跑多次，静默去重比炸掉更好。
 *
 * 去重逻辑复用纯函数 mergeGroups，避免两处各写一份。
 */
export function registerCommandGroup(group: EditorCommandGroup): void {
  if (mergeGroups(groups, group) === groups) return
  groups.push(group)
}

export function getCommandGroups(): readonly EditorCommandGroup[] {
  return groups
}

/** 全部命令（展平）。 */
export function getAllCommands(): EditorCommand[] {
  return groups.flatMap((g) => g.commands)
}

/** 有图标的命令才显示在工具栏（不提供 icon 的只出现在命令面板/快捷键）。 */
export function commandsWithIcon(
  commands: readonly EditorCommand[],
): EditorCommand[] {
  return commands.filter((c) => c.icon)
}

/** 有图标的才进工具栏。 */
export function getToolbarCommands(): EditorCommand[] {
  return commandsWithIcon(getAllCommands())
}

/** 有键位的才绑快捷键。 */
export function getKeyedCommands(): EditorCommand[] {
  return getAllCommands().filter((c) => c.key)
}
