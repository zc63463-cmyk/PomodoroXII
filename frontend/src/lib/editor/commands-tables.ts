/**
 * 表格命令组 —— 对标 advanced-tables-obsidian 的核心能力。
 *
 * ★ 全部逻辑在 lib/notes/note-tables.ts（纯函数、27 例测试），
 *   这里只做三件薄活：取正文与光标、调用纯函数、把结果写回去。
 *
 * ★ `when` 决定命令是否可用：光标不在表格内时全部禁用。
 *   工具栏会把这些命令渲染成**禁用态而不是隐藏**（隐藏会让工具栏宽度跳）。
 */

import type { EditorView } from '@codemirror/view'
import {
  coversTableColumn,
  coversTableRow,
  deleteTableColumn,
  deleteTableRow,
  formatTable,
  insertTableColumn,
  insertTableRow,
  nextTableCell,
  createTable,
  findTableAt,
  type TableEdit,
} from '@/lib/notes/note-tables'
import { registerCommandGroup, type EditorCommand, type EditorCommandContext } from './commands'

/** 光标是否在表格内。所有表格命令的可用性判断都走它。 */
function inTable(ctx: EditorCommandContext): boolean {
  return (
    findTableAt(ctx.view.state.doc.toString(), ctx.view.state.selection.main.head) !==
    null
  )
}

/** 纯函数 → 编辑器写入的薄适配。 */
function applyTableEdit(
  ctx: EditorCommandContext,
  edit: (text: string, offset: number) => TableEdit | null,
): void {
  const text = ctx.view.state.doc.toString()
  const offset = ctx.view.state.selection.main.head
  const result = edit(text, offset)
  if (!result) return

  ctx.view.dispatch({
    changes: { from: 0, to: text.length, insert: result.text },
    selection: { anchor: Math.min(result.caret, result.text.length) },
  })
  ctx.view.focus()
}

function tableCommand(
  id: string,
  title: string,
  icon: string,
  edit: (text: string, offset: number) => TableEdit | null,
  key?: string,
): EditorCommand {
  return {
    id,
    title,
    icon,
    key,
    when: inTable,
    action: {
      kind: 'custom',
      run: (ctx) => applyTableEdit(ctx, edit),
    },
  }
}

const TABLE_COMMANDS: EditorCommand[] = [
  {
    // 从 core 组挪进来的：表格的"插入"与"编辑"应该聚在同一个入口里。
    // 模板直接由纯函数 createTable 生成 —— 不在这里再抄一份字面量。
    id: 'table.create',
    title: '插入表格',
    icon: '▦',
    action: { kind: 'block', text: createTable(3, 3) },
  },
  tableCommand('table.insertRow', '插入表格行', '⊕', insertTableRow, 'Mod-Shift-Enter'),
  tableCommand('table.deleteRow', '删除表格行', '⊖', deleteTableRow, 'Mod-Shift-Backspace'),
  tableCommand('table.insertColumn', '插入表格列', '⊞', insertTableColumn, 'Mod-Shift-\\'),
  tableCommand('table.deleteColumn', '删除表格列', '⊟', deleteTableColumn),
  tableCommand('table.format', '对齐表格', '≡', formatTable, 'Mod-Shift-t'),
  {
    // Tab 跳格不占工具栏位（没有图标），只在表格内拦截 Tab。
    // 表格外 runById 返回 false，CodeMirror 会走默认的缩进行为。
    id: 'table.nextCell',
    title: '跳到下一个单元格',
    key: 'Tab',
    when: inTable,
    action: {
      kind: 'custom',
      run: (ctx) => applyTableEdit(ctx, nextTableCell),
    },
  },
]

registerCommandGroup({
  id: 'tables',
  name: '表格',
  commands: TABLE_COMMANDS,
})

/**
 * "选中 + Delete" 删除行/列的统一入口。
 *
 * 选区在表格内且**严格覆盖**整行/整列时，调对应纯函数；否则返回 false
 * （让调用方继续走默认的字符删除）。
 *
 * ★★ 这是「选中+Delete 比专门 − 按钮更自然」的需求落地。
 *   流程：
 *   1. 用 `coversTableRow` / `coversTableColumn` 判定选区
 *   2. 命中 → 调 `deleteTableRow` / `deleteTableColumn`，光标落到 from（保持渲染态）
 *   3. 不命中 → return false，由 keymap 让 CM 默认 deleteCharForward 处理
 *
 * 这里写成可重用的函数而不是散在 keymap 里，方便单测和复用。
 */
/**
 * 删完把光标放到表格首字符 `from` —— 选区判定是左开区间（`head > from`），
 * 所以 `anchor === from` 正好算"在表格外"，表格**继续渲染**。
 * （与 widget 上 − 按钮的行为保持一致：结构操作不坍缩。）
 */
function dispatchTableDelete(view: EditorView, text: string, result: TableEdit, tableFrom: number) {
  view.dispatch({
    changes: { from: 0, to: text.length, insert: result.text },
    selection: { anchor: Math.min(tableFrom, result.text.length) },
  })
  view.focus()
}

export function tryDeleteTableSelection(view: EditorView): boolean {
  const text = view.state.doc.toString()
  const sel = view.state.selection.main

  if (coversTableRow(text, sel.from, sel.to) !== null) {
    const table = findTableAt(text, sel.from)
    const result = deleteTableRow(text, sel.from)
    if (!result || !table) return false
    dispatchTableDelete(view, text, result, table.from)
    return true
  }

  if (coversTableColumn(text, sel.from, sel.to) !== null) {
    const table = findTableAt(text, sel.from)
    const result = deleteTableColumn(text, sel.from)
    if (!result || !table) return false
    dispatchTableDelete(view, text, result, table.from)
    return true
  }

  return false
}
