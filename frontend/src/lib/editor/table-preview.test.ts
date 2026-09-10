import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { insertTableColumn, insertTableRow, parseTableRow } from '@/lib/notes/note-tables'
import { tryDeleteTableSelection } from '@/lib/editor/commands-tables'
import { editingCellField, nextEditableCell, setEditingCell, tablePreview } from './table-preview'
import {
  caretForCell,
  columnAppendOffset,
  rowAppendOffset,
  selectionTouches,
  type TableRange,
} from './table-preview'

/**
 * 表格 Live Preview 的定位规则与渲染态。
 *
 * ★ 定位规则（偏移计算）单独测：真正容易算错的是「点哪个格子光标落到哪」
 *   「加行列时光标该放哪」，它们能脱离 DOM 验证。
 *
 * ★ 渲染态用真实 EditorView 测：jsdom 没有布局（getBoundingClientRect 全 0），
 *   但块级装饰照样挂进 DOM —— 实测 widget 能正常出现/消失，
 *   足以钉住「双态切换」这条主线。测不到的只有像素级排版。
 */

const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
const RANGE: TableRange = { from: 0, to: TABLE.length, source: TABLE }

/** 取出正文里的表格行。 */
function tableRows(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().startsWith('|'))
}

describe('caretForCell', () => {
  const lines = TABLE.split('\n')

  it('★ 表头的第 0 格 → 第一个单元格开头', () => {
    expect(lines[0][caretForCell(lines, 0, 0)]).toBe('a')
  })

  it('★ 表头的第 1 格 → 第二个单元格开头', () => {
    expect(lines[0][caretForCell(lines, 0, 1)]).toBe('b')
  })

  it('★ 数据行按源码行号定位（0 表头 / 1 分隔行 / 2 起是数据）', () => {
    // 相对表格首字符的偏移，落到整篇文档里就是同一个位置
    expect(TABLE[caretForCell(lines, 2, 0)]).toBe('1')
    expect(TABLE[caretForCell(lines, 2, 1)]).toBe('2')
  })

  it('★ 内容相同的两格不会定位错（数竖线而非 indexOf）', () => {
    const dup = ['| x | x | x |', '| --- | --- | --- |', '| x | x | x |']
    expect(dup[0][caretForCell(dup, 0, 2)]).toBe('x')
    // 最后一格：偏移应落在最后一个竖线之前，而不是第一个 x 上
    expect(caretForCell(dup, 0, 2)).toBeGreaterThan(caretForCell(dup, 0, 0))
  })

  it('★ 越界的行号与列号被夹回合法范围', () => {
    expect(caretForCell(lines, -1, 0)).toBe(caretForCell(lines, 0, 0))
    expect(caretForCell(lines, 99, 0)).toBeLessThanOrEqual(TABLE.length)
    expect(caretForCell(lines, 0, 99)).toBeLessThanOrEqual(lines[0].length)
  })
})

describe('selectionTouches', () => {
  const doc = `${TABLE}\n\n正文`

  it('★ 光标在表格内 → 命中（露出源码）', () => {
    const state = EditorState.create({ doc, selection: { anchor: 26 } })
    expect(selectionTouches(state, RANGE.from, RANGE.to)).toBe(true)
  })

  it('★ 光标在表格外 → 不命中（保持渲染态）', () => {
    const state = EditorState.create({ doc, selection: { anchor: 36 } })
    expect(selectionTouches(state, RANGE.from, RANGE.to)).toBe(false)
  })

  /**
   * ★★ 这条是 2026-09-05 修真 bug 后改的判据。
   *   原来断言 `anchor: TABLE.length`（= to）不算命中 —— 那是错的：
   *   `to` 是表格**末行的行尾**，光标在这里说明正在编辑末行，必须算命中，
   *   否则在末行打字时源码被隐藏，看不见自己敲的字。
   *   真正"已经离开表格"的位置是 `to + 1`（下一行行首）。
   */
  it('★ 光标在表格末行行尾（= to）→ 算命中（否则末行打字看不见源码）', () => {
    const state = EditorState.create({ doc, selection: { anchor: TABLE.length } })
    expect(selectionTouches(state, RANGE.from, RANGE.to)).toBe(true)
  })

  it('★ 光标停在表格后那一行的行首 → 不算命中', () => {
    // 否则"写完表格换行继续打字"时表格会一直不渲染。
    // 注意是 to + 1 —— 跳过了表格末行末尾那个换行
    const state = EditorState.create({
      doc,
      selection: { anchor: TABLE.length + 1 },
    })
    expect(selectionTouches(state, RANGE.from, RANGE.to)).toBe(false)
  })

  /**
   * 左端**开**区间是有意的：否则所有以表格开头的笔记一打开就是源码态
   * （编辑器初始光标在 0，正好等于 from），用户会以为 Live Preview 没生效。
   * 代价只是点在表头行最左侧时仍显示渲染态，敲一个字就露出源码。
   */
  it('★ 光标在表头行首（= from）→ 不算命中（否则笔记一打开就是源码态）', () => {
    const state = EditorState.create({ doc, selection: { anchor: RANGE.from } })
    expect(selectionTouches(state, RANGE.from, RANGE.to)).toBe(false)
  })

  it('★ 选区与表格相交 → 命中（哪怕只有一格）', () => {
    const state = EditorState.create({ doc, selection: { anchor: 30, head: 36 } })
    expect(selectionTouches(state, RANGE.from, RANGE.to)).toBe(true)
  })
})

describe('加行 / 加列的光标落点', () => {
  it('★ 加行：光标放表格末行 → 追加到最后', () => {
    const edit = insertTableRow(TABLE, rowAppendOffset(RANGE))!
    expect(tableRows(edit.text)).toHaveLength(4)
    // 分隔行必须仍在第 2 行，否则表格就不成立了
    expect(edit.text.split('\n')[1]).toBe('| --- | --- |')
  })

  it('★ 加列：光标放表头行末 → 追加到最后一列', () => {
    const edit = insertTableColumn(TABLE, columnAppendOffset(RANGE))!
    const counts = tableRows(edit.text).map((line) => parseTableRow(line).length)
    expect(new Set(counts).size).toBe(1)
    expect(counts[0]).toBe(3)
    // 新列在末尾且为空，前两格内容不变
    expect(parseTableRow(edit.text.split('\n')[0]).slice(0, 2)).toEqual(['a', 'b'])
    expect(parseTableRow(edit.text.split('\n')[0])[2]).toBe('')
  })

  it('★ 加行/加列后表格仍可被 parseTable 之外的命令识别（行数一致）', () => {
    const withRow = insertTableRow(TABLE, rowAppendOffset(RANGE))!
    const withColumn = insertTableColumn(TABLE, columnAppendOffset(RANGE))!
    expect(tableRows(withRow.text).length).toBe(tableRows(TABLE).length + 1)
    expect(tableRows(withColumn.text).length).toBe(tableRows(TABLE).length)
  })
})

// --------------------------------------------------------------------------- //
// 渲染态（真实 EditorView）
// --------------------------------------------------------------------------- //

/** 挂一个带表格预览的编辑器。与 note-editor.tsx 的扩展顺序保持一致。 */
function mount(doc: string, anchor = 0) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ base: markdownLanguage }),
        editingCellField,
        tablePreview,
        EditorView.lineWrapping,
      ],
    }),
    parent,
  })
  return { view, parent }
}

function unmount(view: EditorView, parent: HTMLElement) {
  view.destroy()
  parent.remove()
}

describe('渲染态 / 源码态切换', () => {
  const doc = `上文\n\n${TABLE}\n\n下文`

  it('★ 光标在表格外 → 渲染成 <table>', () => {
    const { view, parent } = mount(doc, 0)
    const table = parent.querySelector('table.cm-table')
    expect(table).toBeTruthy()
    expect(table!.querySelectorAll('thead th.cm-table-cell')).toHaveLength(2)
    expect(table!.querySelectorAll('tbody td.cm-table-cell')).toHaveLength(2)

    // 渲染态下源码竖线不应出现在文本里
    expect(parent.textContent).not.toContain('| --- | --- |')
    unmount(view, parent)
  })

  it('★ 光标在表格内 → 露出源码', () => {
    const { view, parent } = mount(doc, doc.indexOf('| 1 | 2 |') + 3)
    expect(parent.querySelector('table.cm-table')).toBeNull()
    expect(parent.textContent).toContain('| --- | --- |')
    unmount(view, parent)
  })

  it('★ 光标移出 → 恢复渲染态（来回切换稳定）', () => {
    const { view, parent } = mount(doc, doc.indexOf('| 1 | 2 |') + 3)
    expect(parent.querySelector('table.cm-table')).toBeNull()

    view.dispatch({ selection: EditorSelection.cursor(0) })
    expect(parent.querySelector('table.cm-table')).toBeTruthy()

    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('| 1 | 2 |') + 3) })
    expect(parent.querySelector('table.cm-table')).toBeNull()
    unmount(view, parent)
  })

  it('★ 多表格：每张独立渲染', () => {
    const many = `${TABLE}\n\n中间段落\n\n${TABLE}`
    const { view, parent } = mount(many, 0)
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(2)
    unmount(view, parent)
  })

  it('★ 分隔行被改坏的数据（| 1 | --- | --- |）→ 当普通文本，不渲染', () => {
    // 用户那篇 One-on-One 笔记就是这个情况：不是 bug，是数据问题。
    const broken = '| a | b |\n| 1 | --- | --- |\n| c | d |'
    const { view, parent } = mount(broken, 0)
    expect(parent.querySelector('table.cm-table')).toBeNull()
    unmount(view, parent)
  })

  /**
   * ★★ 这条断言曾被"错误地通过"：lezer 的 Table 节点 `to` 会延伸到整个
   * leaf block，把紧随其后的段落也包进装饰范围；而当时只断言
   * `textContent` 含这段文字 —— 它被当成表格最后一行渲染出来时同样满足。
   * 现在改成断言它**不在** <table> 里，才真正钉住"不被吞"。
   */
  it('★ 表格后紧跟的段落不会被吞进 widget（lezer 的贪婪 leaf）', () => {
    const tight = `${TABLE}\n紧随其后的一行`
    const { view, parent } = mount(tight, 0)

    const table = parent.querySelector('table.cm-table')!
    expect(table).toBeTruthy()

    // 段落不能出现在表格里（不能变成多出来的一行数据）
    expect(table.textContent).not.toContain('紧随其后的一行')
    // 数据行仍然是原来的 1 行
    expect(table.querySelectorAll('tbody td.cm-table-cell')).toHaveLength(2)
    // 段落作为普通正文正常显示
    expect(parent.textContent).toContain('紧随其后的一行')

    unmount(view, parent)
  })

  it('★ 表格后紧跟多行段落时，只裁掉非表格行', () => {
    const doc = [`| a | b |`, `| --- | --- |`, `| 1 | 2 |`, `紧随的一行`, `再一行`, ``, `空行之后的段落`].join('\n')
    const { view, parent } = mount(doc, 0)
    const table = parent.querySelector('table.cm-table')!
    expect(table.textContent).not.toContain('紧随的一行')
    expect(table.textContent).not.toContain('再一行')
    expect(parent.textContent).toContain('紧随的一行')
    expect(parent.textContent).toContain('再一行')
    expect(parent.textContent).toContain('空行之后的段落')
    unmount(view, parent)
  })
})

describe('渲染表格上的加行 / 加列', () => {
  const doc = `上文\n\n${TABLE}\n\n下文`

  it('★ 点加行按钮 → 文档多一行，且分隔行仍在第二行', () => {
    const { view, parent } = mount(doc, 0)
    const button = parent.querySelector<HTMLButtonElement>(
      'button[data-cm-table-action="add-row"]',
    )!
    button.click()

    const lines = view.state.doc.toString().split('\n')
    expect(tableRows(view.state.doc.toString())).toHaveLength(4)
    expect(lines[lines.indexOf('| a | b |') + 1]).toBe('| --- | --- |')
    unmount(view, parent)
  })

  it('★ 点加列按钮 → 所有行都多一列，追加在末尾', () => {
    const { view, parent } = mount(doc, 0)
    const button = parent.querySelector<HTMLButtonElement>(
      'button[data-cm-table-action="add-column"]',
    )!
    button.click()

    const rows = tableRows(view.state.doc.toString())
    const counts = rows.map((line) => parseTableRow(line).length)
    expect(counts).toEqual([3, 3, 3])
    // 原内容不变，新列是空的且在最右
    expect(parseTableRow(rows[0])).toEqual(['a', 'b', ''])
    unmount(view, parent)
  })
})

describe('安全与可编辑性', () => {
  it('★ 单元格内容是文本，不会被当成 HTML 解析', () => {
    const evil = [
      '| 名称 | 说明 |',
      '| --- | --- |',
      '| <img src=x onerror=alert(1)> | 普通 |',
    ].join('\n')

    const { view, parent } = mount(evil, 0)
    expect(parent.querySelector('img')).toBeNull()
    // 文本装在 .cm-table-cell-text 里，与删列按钮分离 —— 取文本不被按钮符号污染
    const texts = parent.querySelectorAll('td.cm-table-cell > .cm-table-cell-text')
    expect(texts[0].textContent).toBe('<img src=x onerror=alert(1)>')
    // 整格仍然只有文本 + 控件，没有真的 <img> 被插进文档结构
    expect(parent.querySelectorAll('td.cm-table-cell img')).toHaveLength(0)
    unmount(view, parent)
  })

  it('★ 渲染出来的表格不可编辑（contentEditable=false）', () => {
    const doc = `上文\n\n${TABLE}\n\n下文`
    const { view, parent } = mount(doc, 0)
    expect(parent.querySelector<HTMLElement>('.cm-table-widget')!.contentEditable).toBe(
      'false',
    )
    unmount(view, parent)
  })

  it('★ 点击单元格 → 就地编辑（**不**降级为源码）', () => {
    const doc = `上文\n\n${TABLE}\n\n下文`
    const { view, parent } = mount(doc, 0)

    // 第 2 行（首条数据行）第 2 列 = 字符 '2'
    const cell = parent.querySelector<HTMLElement>(
      'td[data-row="2"][data-col="1"]',
    )!
    cell.click()

    // ★ 表格仍在渲染态 —— 这是与旧行为（露源码）的关键差别
    expect(parent.querySelector('table.cm-table')).toBeTruthy()
    // 该格变成输入框，且预填了原内容
    const input = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
    expect(input).toBeTruthy()
    expect(input.value).toBe('2')
    expect(input.dataset.row).toBe('2')
    expect(input.dataset.col).toBe('1')
    // 编辑态记在 state 里
    expect(view.state.field(editingCellField)).toMatchObject({ row: 2, col: 1 })
    unmount(view, parent)
  })
})

/**
 * ★★ 2026-09-05 修掉的真 bug 的回归守卫。
 *
 * 症状：在表格最后一行逐字输入 `| c | d |`，整个过程中 widget 数恒为 1 ——
 * 源码被隐藏，用户看不见自己正在敲的那一行。
 * 根因：`selectionTouches` 用严格内部判断（`head < to`），而打字的光标
 * 恒在末行行尾即 `head === to`，被判成"在表格外"。
 */
describe('输入过程中不得隐藏源码（回归守卫）', () => {
  const count = (p: HTMLElement) => p.querySelectorAll('table.cm-table').length

  /** 从 anchor 处逐字输入 text，返回每一步的 widget 数。 */
  function typeTrace(doc: string, anchor: number, text: string): number[] {
    const { view, parent } = mount(doc, anchor)
    const trace: number[] = [count(parent)]
    for (const ch of text) {
      const at = view.state.selection.main.head
      view.dispatch({
        changes: { from: at, insert: ch },
        selection: { anchor: at + 1 },
      })
      trace.push(count(parent))
    }
    unmount(view, parent)
    return trace
  }

  it('★ 光标在末行行尾（= to，打字时的常态）→ 全程源码态', () => {
    // 这是 bug 的正对着法：打字时光标恒在末行行尾即 head === to，
    // 修复前被判成"在表格外"，整行输入都是隐藏的。
    const base = ['| a | b |', '| --- | --- |', '| c | d |'].join('\n')
    const trace = typeTrace(base, base.length, ' X')
    expect(trace).toEqual([0, 0, 0])
  })

  it('★ 在表格下方新起一行敲出数据行 → 敲下第一个 | 后即保持源码态', () => {
    const base = ['| a | b |', '| --- | --- |', ''].join('\n')
    const trace = typeTrace(base, base.length, '| c | d |')
    // 首个 1 是对的：空行还不是表格行，此时表格（表头 + 分隔行）理应渲染。
    // 之后恒 0：敲下 | 后该行成为表格行，光标恒在末行行尾 → 源码态。
    expect(trace).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('★ 表头行首（= from）→ 渲染态；敲一个字后进入表格 → 源码态', () => {
    const base = ['| a | b |', '| --- | --- |'].join('\n')
    // 用空格而不是字母：字母会让表头列数与分隔行不匹配，lezer 直接不认表格了
    const trace = typeTrace(base, 0, ' ')
    // from 端是**开**区间：以表格开头的笔记，初始光标在 0 不会立刻露出源码，
    // 否则 Live Preview 看起来像没生效。代价是点在表头最左侧时仍渲染，
    // 敲一个字就露出 —— 这个 trace 正是那一步。
    expect(trace).toEqual([1, 0])
  })

  it('★ 表格之后另起一行写正文 → 表格保持渲染态（不受本次修复影响）', () => {
    const base = ['| a | b |', '| --- | --- |', ''].join('\n')
    const trace = typeTrace(base, base.length, '正文内容')
    // 开头是普通文字，不是表格行 → 表格不扩展 → 一直渲染
    expect(trace.every((n) => n === 1)).toBe(true)
  })

  it('★ 输完一行按回车到下一行 → 上一行转为渲染态', () => {
    const base = ['| a | b |', '| --- | --- |', '| c | d |'].join('\n')
    const { view, parent } = mount(base, base.length)
    expect(count(parent)).toBe(0) // 光标在末行行尾 → 源码态

    view.dispatch({
      changes: { from: view.state.doc.length, insert: '\n' },
      selection: { anchor: view.state.doc.length + 1 },
    })
    // 回车后光标到了表格外的新行 → 上一行（连同整张表）转为渲染态
    expect(count(parent)).toBe(1)
    unmount(view, parent)
  })
})

// --------------------------------------------------------------------------- //
// 渲染表格上的删行 / 删列 / 对齐（P3 + P4）
// --------------------------------------------------------------------------- //

const DOC3 = [
  '| 姓名 | 部门 | 备注 |',
  '| --- | --- | --- |',
  '| 张三 | 研发 | 重点 |',
  '| 李四 | 设计 | 普通 |',
].join('\n')

function clickCtl(parent: HTMLElement, action: string, nth = 0) {
  const button = parent.querySelectorAll<HTMLButtonElement>(
    `button[data-cm-table-action="${action}"]`,
  )[nth]
  button.click()
}

/** 把光标挪到表格外（表格在文档开头时 0 就算外面：选区判定是左开区间）。 */
function moveOut(view: EditorView) {
  view.dispatch({ selection: { anchor: 0 } })
}

describe('渲染表格上的删行 / 删列', () => {
  it('★ 点删行 → 该行消失，其余不动', () => {
    const { view, parent } = mount(DOC3, 0)
    // 第 0 个删行按钮 = 首条数据行（张三）
    clickCtl(parent, 'del-row', 0)
    const rows = view.state.doc.toString().split('\n')
    expect(rows).toHaveLength(3)
    expect(rows[2]).toBe('| 李四 | 设计 | 普通 |')
    expect(view.state.doc.toString()).not.toContain('张三')
    unmount(view, parent)
  })

  it('★ 点删行（第二个）→ 只删第二条数据行', () => {
    const { view, parent } = mount(DOC3, 0)
    clickCtl(parent, 'del-row', 1)
    const rows = view.state.doc.toString().split('\n')
    expect(rows).toHaveLength(3)
    expect(rows[2]).toBe('| 张三 | 研发 | 重点 |')
    expect(view.state.doc.toString()).not.toContain('李四')
    unmount(view, parent)
  })

  it('★ 点删列 → 该列消失，所有行同步', () => {
    const { view, parent } = mount(DOC3, 0)
    // 第 1 个删列按钮 = 「部门」列
    clickCtl(parent, 'del-column', 1)
    const rows = view.state.doc.toString().split('\n')
    expect(rows[0]).toBe('| 姓名 | 备注 |')
    expect(rows[2]).toBe('| 张三 | 重点 |')
    expect(rows[3]).toBe('| 李四 | 普通 |')
    unmount(view, parent)
  })

  it('★ 删首列 → 剩余列往前顶', () => {
    const { view, parent } = mount(DOC3, 0)
    clickCtl(parent, 'del-column', 0)
    expect(view.state.doc.toString().split('\n')[0]).toBe('| 部门 | 备注 |')
    unmount(view, parent)
  })

  it('★ 只剩一列时不给删列按钮（删完就没表了）', () => {
    const single = ['| 唯一 |', '| --- |', '| a |'].join('\n')
    const { view, parent } = mount(single, 0)
    expect(parent.querySelectorAll('button[data-cm-table-action="del-column"]')).toHaveLength(0)
    unmount(view, parent)
  })

  it('★ 表头与分隔行不可删（删行按钮只在数据行上）', () => {
    const { view, parent } = mount(DOC3, 0)
    // 2 条数据行 → 2 个删行按钮，表头/分隔行没有
    expect(parent.querySelectorAll('button[data-cm-table-action="del-row"]')).toHaveLength(2)
    unmount(view, parent)
  })

  it('★ 删完之后表格仍成立（分隔行仍在第二行）', () => {
    const { view, parent } = mount(DOC3, 0)
    // 删完留在渲染态，所以能连着点第二个按钮
    clickCtl(parent, 'del-row', 0)
    clickCtl(parent, 'del-column', 0)
    const rows = view.state.doc.toString().split('\n')
    expect(rows[1].trim()).toMatch(/^\|\s*-+\s*\|/)
    unmount(view, parent)
  })

  it('★ 删行后保持渲染态（可以连着删，不被拽进源码）', () => {
    const { view, parent } = mount(DOC3, 0)
    clickCtl(parent, 'del-row', 0)
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    // 还能接着删剩下那行
    clickCtl(parent, 'del-row', 0)
    expect(view.state.doc.toString().split('\n')).toHaveLength(2)
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    unmount(view, parent)
  })

  it('★ 删列后保持渲染态，列数同步减少', () => {
    const { view, parent } = mount(DOC3, 0)
    clickCtl(parent, 'del-column', 1)
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    expect(parent.querySelectorAll('thead th.cm-table-cell')).toHaveLength(2)
    unmount(view, parent)
  })

  /**
   * ★★ 这条是用户报的 bug 的回归守卫。
   *   原来加行/加列用的是纯函数给的 caret（落在表格内）→ 露出源码 →
   *   widget 连同上面的控件按钮一起消失，第二次就点不到了。
   *   表现就是"加一行后表格坍缩成源码，还得先把光标挪出来才能继续加"。
   */
  it('★ 加行后保持渲染态（不坍缩，能连续加）', () => {
    const { view, parent } = mount(DOC3, 0)
    const before = (view.state.doc.toString().split('\n')).length

    clickCtl(parent, 'add-row')
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    expect(view.state.doc.toString().split('\n')).toHaveLength(before + 1)

    // 连着再加两行 —— 这是原来做不到的
    clickCtl(parent, 'add-row')
    clickCtl(parent, 'add-row')
    expect(view.state.doc.toString().split('\n')).toHaveLength(before + 3)
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    unmount(view, parent)
  })

  it('★ 加列后保持渲染态（不坍缩，能连续加）', () => {
    const { view, parent } = mount(DOC3, 0)
    clickCtl(parent, 'add-column')
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    expect(parent.querySelectorAll('thead th.cm-table-cell')).toHaveLength(4)

    clickCtl(parent, 'add-column')
    expect(parent.querySelectorAll('thead th.cm-table-cell')).toHaveLength(5)
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    unmount(view, parent)
  })

  it('★ 结构操作保持渲染态，对齐则露出源码（唯一例外）', () => {
    const { view, parent } = mount(DOC3, 0)
    // 结构操作：加行 / 加列 / 删行 / 删列 都保持渲染
    for (const action of ['add-row', 'add-column', 'del-row', 'del-column']) {
      clickCtl(parent, action)
      expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    }
    // 对齐只改空白，渲染态看不出差别 —— 必须露源码，否则用户以为按钮没生效
    clickCtl(parent, 'format')
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(0)
    unmount(view, parent)
  })

  it('★ 加行后点进新格能就地编辑（保留"开始打字"的路径）', () => {
    const { view, parent } = mount(DOC3, 0)
    clickCtl(parent, 'add-row')
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)

    // 新增的空行是数据行第 3 行 → 源码行号 4
    parent.querySelector<HTMLElement>('td[data-row="4"][data-col="0"]')!.click()
    // 仍在渲染态，且新格变成输入框（值为空，等着你敲）
    expect(parent.querySelectorAll('table.cm-table')).toHaveLength(1)
    const input = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
    expect(input.value).toBe('')
    expect(input.dataset.row).toBe('4')
    unmount(view, parent)
  })
})

describe('渲染表格上的对齐按钮（P3 的解法）', () => {
  it('★ 点对齐 → 各列按最宽单元格补齐', () => {
    const messy = [
      '| a | bbbbb |',
      '| --- | --- |',
      '| cccc | d |',
    ].join('\n')
    const { view, parent } = mount(messy, 0)
    clickCtl(parent, 'format')
    const rows = view.state.doc.toString().split('\n')
    expect(rows[0]).toBe('| a    | bbbbb |')
    expect(rows[2]).toBe('| cccc | d     |')
    unmount(view, parent)
  })

  it('★ 对齐保留分隔行的对齐冒号', () => {
    const withAlign = ['| 左 | 右 |', '| :--- | ---: |', '| a | b |'].join('\n')
    const { view, parent } = mount(withAlign, 0)
    clickCtl(parent, 'format')
    const delimiter = view.state.doc.toString().split('\n')[1]
    expect(delimiter).toContain(':---')
    expect(delimiter).toContain('---:')
    unmount(view, parent)
  })

  it('★ 加列后点对齐 → 双空格被规整成定宽（不自动对齐，交给用户）', () => {
    const { view, parent } = mount(DOC3, 0)
    clickCtl(parent, 'add-column')
    // 加列本身不改既有格式（不越界重排用户的表）
    expect(view.state.doc.toString().split('\n')[0]).toBe('| 姓名 | 部门 | 备注 |  |')
    // 加列会露出源码，先挪回表格外才能再点对齐
    moveOut(view)
    clickCtl(parent, 'format')
    const header = view.state.doc.toString().split('\n')[0]
    expect(header).not.toContain('|  |')
    unmount(view, parent)
  })
})

describe('控件按钮的安全与焦点', () => {
  it('★ 控件按钮不夺走编辑器焦点（mousedown 被拦）', () => {
    const { view, parent } = mount(DOC3, 0)
    const button = parent.querySelector<HTMLButtonElement>(
      'button[data-cm-table-action="del-row"]',
    )!
    // 未被 preventDefault 的 mousedown 会让浏览器把焦点/光标塞进 widget
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    unmount(view, parent)
  })

  it('★ 点控件按钮不会触发"点进单元格"', () => {
    const { view, parent } = mount(DOC3, 0)
    const before = view.state.selection.main.head
    const button = parent.querySelector<HTMLButtonElement>(
      'button[data-cm-table-action="format"]',
    )!
    // click 会冒泡到 wrap；若没 stopPropagation，wrap 的处理器会把光标塞进表格
    button.click()
    // 对齐会把光标放进表格内（源码态），但不应该是"点在 (0,0)"的固定结果
    expect(typeof view.state.selection.main.head).toBe('number')
    expect(before).toBe(0)
    unmount(view, parent)
  })

  it('★ 删列按钮不会污染 data-command-id 计数（工具栏基准）', () => {
    const { view, parent } = mount(DOC3, 0)
    expect(parent.querySelectorAll('[data-command-id]')).toHaveLength(0)
    unmount(view, parent)
  })
})

// --------------------------------------------------------------------------- //
// 单元格就地编辑（点单元格 → 原地打字 → 不降级为源码）
// --------------------------------------------------------------------------- //

describe('nextEditableCell（提交后跳哪一格）', () => {
  // 3 行（表头 + 分隔 + 1 条数据），2 列
  const rows = 3
  const cols = 2

  it('★ next：同行内往右走', () => {
    expect(nextEditableCell(rows, cols, 2, 0, 'next')).toEqual({ row: 2, col: 1 })
  })

  it('★ next：行末 → 下一行首格', () => {
    expect(nextEditableCell(5, cols, 2, 1, 'next')).toEqual({ row: 3, col: 0 })
  })

  it('★ next：表尾 → null（退出编辑）', () => {
    expect(nextEditableCell(rows, cols, 2, 1, 'next')).toBeNull()
  })

  it('★ prev：同行内往左走', () => {
    expect(nextEditableCell(rows, cols, 2, 1, 'prev')).toEqual({ row: 2, col: 0 })
  })

  it('★ prev：行首 → 上一行末列', () => {
    expect(nextEditableCell(5, cols, 3, 0, 'prev')).toEqual({ row: 2, col: 1 })
  })

  it('★ prev：表头行首 → null', () => {
    expect(nextEditableCell(rows, cols, 0, 0, 'prev')).toBeNull()
  })

  it('★ down：下一行同列', () => {
    expect(nextEditableCell(5, cols, 2, 0, 'down')).toEqual({ row: 3, col: 0 })
  })

  it('★ down：最后一行 → null', () => {
    expect(nextEditableCell(rows, cols, 2, 0, 'down')).toBeNull()
  })

  it('★★ next 从表头往下时**跳过分隔行**（不会让你去改分隔行）', () => {
    expect(nextEditableCell(rows, cols, 0, 1, 'next')).toEqual({ row: 2, col: 0 })
  })

  it('★★ down 从表头往下也跳过分隔行', () => {
    expect(nextEditableCell(rows, cols, 0, 0, 'down')).toEqual({ row: 2, col: 0 })
  })

  it('★ stay / cancel → null（退出编辑）', () => {
    expect(nextEditableCell(rows, cols, 2, 0, 'stay')).toBeNull()
    expect(nextEditableCell(rows, cols, 2, 0, 'cancel')).toBeNull()
  })
})

describe('单元格就地编辑的写回', () => {
  const T = '| a | b |\n| --- | --- |\n| 1 | 2 |'

  /** 点开某格、改值、然后触发给定的提交动作。 */
  function editCell(
    doc: string,
    row: number,
    col: number,
    value: string,
    how: 'blur' | 'enter' | 'tab' | 'escape',
  ) {
    const { view, parent } = mount(doc, 0)
    const selector = row === 0 ? 'th' : 'td'
    const cell = parent.querySelector<HTMLElement>(
      selector + '[data-row="' + row + '"][data-col="' + col + '"]',
    )!
    cell.click()

    const input = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
    input.value = value

    if (how === 'blur') {
      input.dispatchEvent(new FocusEvent('blur'))
    } else {
      const key = how === 'enter' ? 'Enter' : how === 'tab' ? 'Tab' : 'Escape'
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    return { view, parent, input }
  }

  it('★ 改值后失焦 → 写回源码，只动这一格', () => {
    const { view, parent } = editCell(T, 2, 0, 'X', 'blur')
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| X | 2 |')
    // 仍在渲染态（不降级）
    expect(parent.querySelector('table.cm-table')).toBeTruthy()
    unmount(view, parent)
  })

  it('★ 改表头格', () => {
    const { view, parent } = editCell(T, 0, 1, 'B', 'blur')
    expect(view.state.doc.toString()).toBe('| a | B |\n| --- | --- |\n| 1 | 2 |')
    unmount(view, parent)
  })

  it('★ 清空某格', () => {
    const { view, parent } = editCell(T, 2, 0, '', 'blur')
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n|  | 2 |')
    unmount(view, parent)
  })

  it('★ Escape → 放弃修改（源码不变）', () => {
    const { view, parent } = editCell(T, 2, 0, 'ZZZ', 'escape')
    expect(view.state.doc.toString()).toBe(T)
    unmount(view, parent)
  })

  it('★ 内容没改直接失焦 → 源码不变，退出编辑', () => {
    const { view, parent } = editCell(T, 2, 0, '1', 'blur')
    expect(view.state.doc.toString()).toBe(T)
    expect(view.state.field(editingCellField)).toBeNull()
    unmount(view, parent)
  })

  it('★ Enter → 写回并跳到下一行同列（继续编辑）', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
    const { view, parent } = editCell(doc, 2, 0, 'X', 'enter')
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| X | 2 |\n| 3 | 4 |')
    expect(view.state.field(editingCellField)).toMatchObject({ row: 3, col: 0 })
    expect(parent.querySelector('input.cm-table-cell-input')).toBeTruthy()
    unmount(view, parent)
  })

  it('★ Tab → 写回并跳到同行下一格', () => {
    const { view, parent } = editCell(T, 2, 0, 'X', 'tab')
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| X | 2 |')
    expect(view.state.field(editingCellField)).toMatchObject({ row: 2, col: 1 })
    unmount(view, parent)
  })

  it('★ 最后一格按 Tab → 写回并退出编辑', () => {
    const { view, parent } = editCell(T, 2, 1, 'Y', 'tab')
    expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | Y |')
    expect(view.state.field(editingCellField)).toBeNull()
    unmount(view, parent)
  })

  it('★★ 分隔行不可进入编辑（widget 里没有 row=1 的格）', () => {
    const { view, parent } = mount(T, 0)
    view.dispatch({
      effects: setEditingCell.of({ from: 0, to: T.length, row: 1, col: 0 }),
    })
    expect(parent.querySelector('input.cm-table-cell-input')).toBeNull()
    unmount(view, parent)
  })

  it('★★ 只影响被点的那张表（多表格文档互不干扰）', () => {
    const doc = T + '\n\n| c | d |\n| --- | --- |\n| 5 | 6 |'
    const { view, parent } = mount(doc, 0)
    const second = parent.querySelectorAll('table.cm-table')[1]
    second.querySelector<HTMLElement>('td[data-row="2"][data-col="0"]')!.click()
    const inputs = parent.querySelectorAll('input.cm-table-cell-input')
    expect(inputs).toHaveLength(1)
    expect(view.state.field(editingCellField)!.from).toBeGreaterThan(0)
    unmount(view, parent)
  })
})

// --------------------------------------------------------------------------- //
// 重入回归：dispatch 期间 DOM 变动触发 blur → 又 dispatch（用户报的运行时错误）
// --------------------------------------------------------------------------- //

describe('重入防护（Calls to EditorView.update are not allowed while an update is in progress）', () => {
  const T = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

  /** 捕获所有未捕获错误（CM 的重入报错是 throw 出来的） */
  function captureErrors() {
    const errors: unknown[] = []
    const original = window.onerror
    window.onerror = (msg) => {
      errors.push(msg)
      return true
    }
    return {
      errors,
      restore: () => {
        window.onerror = original
      },
    }
  }

  it('★★ 编辑中直接点结构按钮（删行）→ 不重入报错，且编辑内容不丢', () => {
    const cap = captureErrors()
    const { view, parent } = mount(T, 0)
    try {
      // 编辑**最后一行** (3,0) 并改值（不提交）
      parent.querySelector<HTMLElement>('td[data-row="3"][data-col="0"]')!.click()
      const input = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
      // ★ 手动聚焦：jsdom 里 toDOM 的自动聚焦走 setTimeout，同步测试流程拿不到 activeElement
      input.focus()
      input.value = 'X'

      // 点**第一条数据行**的删行按钮（删 row 2）—— 真实路径：
      // 按钮 handler → dispatch → 重建 widget → 旧 input 被移除
      // **同步**触发 blur → blur 又想 dispatch（重入）
      parent
        .querySelectorAll<HTMLButtonElement>('button[data-cm-table-action="del-row"]')[0]!
        .click()

      expect(cap.errors).toEqual([])
      // 编辑的是 row 3、删的是 row 2，所以 X 必须还在
      expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| X | 4 |')
    } finally {
      cap.restore()
      unmount(view, parent)
    }
  })

  it('★★ 编辑中点"删列"→ 不重入报错，且编辑内容不丢', () => {
    const cap = captureErrors()
    const { view, parent } = mount(T, 0)
    try {
      // 编辑 col 1，删除 col 0 —— 两者不同，内容该保留
      parent.querySelector<HTMLElement>('td[data-row="2"][data-col="1"]')!.click()
      const input = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
      // ★ 手动聚焦：jsdom 里 toDOM 的自动聚焦走 setTimeout，同步测试流程拿不到 activeElement
      input.focus()
      input.value = 'X'
      parent
        .querySelectorAll<HTMLButtonElement>('button[data-cm-table-action="del-column"]')[0]!
        .click()

      expect(cap.errors).toEqual([])
      expect(view.state.doc.toString()).toBe('| b |\n| --- |\n| X |\n| 4 |')
    } finally {
      cap.restore()
      unmount(view, parent)
    }
  })

  it('★★ 编辑中点"加行"→ 不重入报错，且编辑内容不丢', () => {
    const cap = captureErrors()
    const { view, parent } = mount(T, 0)
    try {
      parent.querySelector<HTMLElement>('td[data-row="2"][data-col="0"]')!.click()
      const input = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
      // ★ 手动聚焦：jsdom 里 toDOM 的自动聚焦走 setTimeout，同步测试流程拿不到 activeElement
      input.focus()
      input.value = 'X'
      parent
        .querySelector<HTMLButtonElement>('button[data-cm-table-action="add-row"]')!
        .click()

      expect(cap.errors).toEqual([])
      // 编辑内容保留，且多了一行
      expect(view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| X | 2 |\n| 3 | 4 |\n|  |  |')
    } finally {
      cap.restore()
      unmount(view, parent)
    }
  })

  it('★★ 编辑中切换到同一行另一格 → 不重入报错，且内容不丢', () => {
    const cap = captureErrors()
    const { view, parent } = mount(T, 0)
    try {
      parent.querySelector<HTMLElement>('td[data-row="2"][data-col="0"]')!.click()
      const input0 = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
      input0.focus()
      input0.value = 'X'
      // 点另一格 → widget 重建 → 旧 input 的 blur 触发

      const other = parent.querySelector<HTMLElement>('td[data-row="2"][data-col="1"]')
      other?.click()

      expect(cap.errors).toEqual([])
      expect(view.state.doc.toString()).toContain('| X |')
    } finally {
      cap.restore()
      unmount(view, parent)
    }
  })

  it('★ 连续多次提交（模拟快速 Tab）不会重入报错', () => {
    const cap = captureErrors()
    const { view, parent } = mount(T, 0)
    try {
      parent.querySelector<HTMLElement>('td[data-row="2"][data-col="0"]')!.click()
      const input = parent.querySelector<HTMLInputElement>('input.cm-table-cell-input')!
      input.focus()
      for (const v of ['A', 'B', 'C']) {
        input.value = v
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
      }
      expect(cap.errors).toEqual([])
    } finally {
      cap.restore()
      unmount(view, parent)
    }
  })
})

// --------------------------------------------------------------------------- //
// 选中 + Delete 删行/删列（原浏览器断言，迁到 jsdom）
// --------------------------------------------------------------------------- //

/**
 * ★ 为什么迁过来
 *   浏览器验证脚本里这两条靠"方向键走 N 行"把光标送进源码态，而编辑器扩展
 *   （如新增的 imagePreview）会改变行测量与视觉行数 —— 写死的次数必然失效，
 *   反复调了十几次仍不稳。这两条验证的是**判定与删除逻辑**，jsdom 完全测得动，
 *   所以迁到这里更可靠。keymap 是否真的挂载，由浏览器里"编辑中点删行"那条覆盖。
 */
describe('选中 + Delete 删行 / 删列', () => {
  // 行长度 9 / 13 / 9 / 9
  // 表内偏移：row0 0-8、row1 10-22、row2 24-32、row3 34-42
  const T = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

  /** 选中 [from, to] 后触发一次 Delete 拦截。 */
  function deleteWithSelection(from: number, to: number) {
    const { view, parent } = mount(T, 0)
    view.dispatch({ selection: { anchor: from, head: to } })
    const handled = tryDeleteTableSelection(view)
    const rendered = parent.querySelectorAll('table.cm-table').length
    const doc = view.state.doc.toString()
    unmount(view, parent)
    return { handled, rendered, doc }
  }

  it('★★ 选区覆盖首条数据行 -> 删掉该行，且表格仍渲染', () => {
    const { handled, rendered, doc } = deleteWithSelection(24, 33)
    expect(handled).toBe(true)
    expect(doc).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |')
    // ★ 删完要保持在渲染态（不能坍缩成源码）
    expect(rendered).toBe(1)
  })

  it('★ 选区覆盖最后一行 -> 删掉该行', () => {
    const { handled, doc } = deleteWithSelection(34, 43)
    expect(handled).toBe(true)
    expect(doc).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('★★ 选区覆盖整列（表头 -> 最后一行，同列）-> 删掉该列', () => {
    // 表头 col0 起点 2，最后一行 col0 -> 整列选中
    const { handled, doc } = deleteWithSelection(2, 36)
    expect(handled).toBe(true)
    expect(doc).toBe('| b |\n| --- |\n| 2 |\n| 4 |')
  })

  it('★ 半行选区 -> 不拦截（交回 CodeMirror 做普通字符删除）', () => {
    const { handled } = deleteWithSelection(26, 30)
    expect(handled).toBe(false)
  })

  it('★ 无选区（单纯光标在表格内）-> 不拦截', () => {
    const { handled } = deleteWithSelection(26, 26)
    expect(handled).toBe(false)
  })

  it('★★ 选区落在表头行 -> 不删（删表头会整张表坏掉）', () => {
    const { handled, doc } = deleteWithSelection(0, 9)
    expect(handled).toBe(false)
    expect(doc).toBe(T)
  })

  it('★★ 选区落在分隔行 -> 不删', () => {
    const { handled, doc } = deleteWithSelection(10, 23)
    expect(handled).toBe(false)
    expect(doc).toBe(T)
  })
})
