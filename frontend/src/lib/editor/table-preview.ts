/**
 * 表格 Live Preview —— 光标离开表格时把它渲染成真正的 <table>，进入时露出源码。
 *
 * ★ 为什么是「双态」而不是一直渲染
 *   Markdown 表格的源码本身就是可读的对齐文本，但**写着难受**：改一个单元格
 *   要手动补空格，否则整列错位。Obsidian 的做法是：光标在表格里就显示源码
 *   （可精确编辑），光标离开就渲染成表格（可读）。这里照做。
 *
 * ★ 为什么不直接改 DOM 里的文本
 *   decoration 只是**视图**：文档内容始终是源码，widget 是它的替身。
 *   这样撤销/重做、同步、保存全都走原有链路，不必为预览单独维护一份状态。
 *
 * ★ 数据来源
 *   表格块的位置来自 lezer 的 GFM 语法树（`markdownLanguage` 已含 Table 节点），
 *   单元格内容来自 `lib/notes/note-tables` 的 `parseTable`（纯函数、有测试）。
 *   语法树只负责「这一段是不是表格块」，`parseTable` 负责判定「它是不是一张
 *   合法的表格」—— 两者都通过才渲染。
 */

import { syntaxTree } from '@codemirror/language'
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view'
// 表格行的判定必须取自共享定义 —— 与表格命令（findTableAt）同一套规则
import { isTableRow } from '@/lib/markdown/table-syntax'
import {
  deleteTableColumn,
  deleteTableRow,
  formatTable,
  insertTableColumn,
  insertTableRow,
  parseTable,
  parseTableRow,
  setTableCell,
  type ColumnAlignment,
  type TableData,
  type TableEdit,
} from '@/lib/notes/note-tables'

/** 文档里的一块表格（范围已对齐到整行）。 */
/** 正在就地编辑的单元格。`from/to` 用来确认它属于哪张表（多表格文档要区分）。 */
export interface EditingCell {
  from: number
  to: number
  row: number
  col: number
}

/** 进入 / 退出某格的就地编辑。null = 退出。 */
export const setEditingCell = StateEffect.define<EditingCell | null>()

/**
 * 当前正在编辑的单元格。
 *
 * ★ 为什么要单独一个 StateField
 *   "哪一格正在被编辑"是**视图状态**，不是文档内容 —— 不该写进源码，
 *   也不该塞进 DecorationSet（那会让每次光标移动都重建 widget）。
 */
export const editingCellField = StateField.define<EditingCell | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditingCell)) return effect.value
    }
    // 光标一旦被挪到这张表之外就退出编辑（点了别处、或走了撤销）
    if (value && tr.selection) {
      const head = tr.selection.main.head
      if (head < value.from || head > value.to) return null
    }
    return value
  },
})

export interface TableRange {
  from: number
  to: number
  /** 表格各行原文，含换行 */
  source: string
}

/**
 * 加行时光标该放在哪：表格末行。
 *
 * `insertTableRow` 是「在光标行下方插入」，所以放在**最后一行**等于追加。
 * 取 `to`（末行行尾）而不是 `to - 1`：findTableAt 会把行尾也算作该行内，
 * 效果一样，但不用处理「末行是空行」时 `to - 1` 落到上一行的边界情况。
 */
export function rowAppendOffset(table: TableRange): number {
  return table.to
}

/**
 * 加列时光标该放在哪：表头行末。
 *
 * `insertTableColumn` 是「在光标列右侧插入」，列号由光标前的竖线个数决定。
 * 放在表头行**末尾**，竖线个数就等于总列数 —— 算出的列号即便越界，
 * `Array.splice` 也会把新列追加到最后，两边都稳。
 */
export function columnAppendOffset(table: TableRange): number {
  return table.from + table.source.split('\n')[0].length
}

/**
 * 从语法树里取出所有表格块。
 *
 * ★★ 为什么不能直接用 `node.from / node.to`（两个坑，都实测过）
 *
 *   坑 1 —— `node.to` 会**吞掉表格后面的段落**。
 *     lezer 的 Table 节点范围是 `leaf.start + leaf.content.length`，也就是
 *     **整个 leaf block**，而不是"实际被识别成表格的那些行"。所以
 *     `| a | b |\n| --- | --- |\n紧随其后的一行` 的 Table 节点是 `[0, 25]`，
 *     把最后那行正文也包了进来 —— 与 `table-boundary.ts` 里记录的 remark-gfm
 *     贪婪吞行是同一个病，只是换了引擎。
 *     → 必须按表格行规则把尾部多余的行裁掉。
 *
 *   坑 2 —— `node.to` 可能落在块末换行之后（= 下一行行首），而
 *     `Decoration.replace({ block: true })` 的范围必须落在整行边界上，
 *     多带一个换行同样会把下一行一起替换掉。
 *     → 取范围前先 `lineAt` 对齐到整行。
 */
function collectTables(state: EditorState): TableRange[] {
  const ranges: TableRange[] = []

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return

      let end = node.to
      if (end > node.from && state.sliceDoc(end - 1, end) === '\n') end -= 1

      const from = state.doc.lineAt(node.from).from
      const lineEnd = state.doc.lineAt(end).to
      if (lineEnd <= from) return

      // 裁掉尾部不属于表格的行（坑 1）。判定用共享的 table-syntax，
      // 与表格命令（findTableAt）保持同一套规则，避免"渲染层认为是表格、
      // 命令层认为不是"这类不一致。
      const lines = state.sliceDoc(from, lineEnd).split('\n')
      let kept = lines.length
      // 至少保留表头 + 分隔行两行
      while (kept > 2 && !isTableRow(lines[kept - 1])) kept -= 1

      const to =
        kept === lines.length
          ? lineEnd
          : from + lines.slice(0, kept).reduce((sum, l) => sum + l.length + 1, 0) - 1
      if (to <= from) return

      ranges.push({ from, to, source: state.sliceDoc(from, to) })
    },
  })

  return ranges
}

/**
 * 选区是否落在表格范围内。
 *
 * ★★ 两端不对称是**有意为之**，别"顺手统一"成全闭区间（试过，会坏）
 *
 *   右端闭（`head <= to`）：修的是真 bug。打字的光标恒在末行行尾即
 *   `head === to`，若判成"在表格外"，**在表格最后一行输入时源码一直是隐藏的**
 *   —— 逐字实测 `| c | d |` 整个过程 widget 数恒为 1，一个字都看不见。
 *
 *   左端开（`head > from`）：`from` 是表头行的行首。若也取闭，那么
 *   **所有以表格开头的笔记一打开就是源码态**（编辑器初始光标在 0，
 *   正好等于 from）—— 用户会觉得"Live Preview 没生效"。
 *   代价只是"点在表头行最左侧"时仍显示渲染态，敲一个字就露出源码，可忽略。
 *
 *   至于当初收紧比较的初衷（别把"表格后那一行行首"算成命中）：
 *   那个位置是 `to + 1`，右端闭区间仍然排除它，没有冲突。
 */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head > from && range.head <= to
      : range.from <= to && range.to > from,
  )
}

/**
 * 单元格在表格源码里的光标偏移（**相对表格首字符**）。
 *
 * ★ 为什么是「数竖线」而不是 `indexOf(单元格文本)`
 *   两个单元格内容相同时 indexOf 会停在第一格；数竖线按结构定位，与内容无关。
 *
 * 行的编号沿用源码行号：0 = 表头，1 = 分隔行，2+ = 数据行。
 * 分隔行不含可编辑内容，点它落在哪都无所谓，这里一视同仁。
 */
export function caretForCell(
  lines: string[],
  rowIndex: number,
  colIndex: number,
): number {
  const row = Math.min(Math.max(rowIndex, 0), lines.length - 1)

  let offset = 0
  for (let i = 0; i < row; i += 1) offset += lines[i].length + 1

  const line = lines[row]
  // 走到第 colIndex + 1 个竖线之后，再跳过紧随的一个空格
  let pos = 0
  let pipes = 0
  while (pos < line.length && pipes <= colIndex) {
    if (line[pos] === '|') pipes += 1
    pos += 1
  }
  if (line[pos] === ' ') pos += 1

  return offset + Math.min(pos, line.length)
}

/**
 * 把纯函数算出的编辑结果写回整篇文档。
 *
 * ★ `keepRendered` 决定操作后是留在渲染态还是露出源码，不是随手加的开关：
 *   - **加行 / 加列 / 对齐** → 露源码。加完要立刻打字；对齐的结果只在源码里
 *     看得见（渲染态前后一模一样，留在渲染态会让人以为按钮没生效）。
 *   - **删行 / 删列** → 留在渲染态。删除最常连续操作，被拽进源码很打断；
 *     而且行/列少了一格本身就是最直观的反馈，不需要再看源码确认。
 *     做法是把光标放到表格首字符 —— 而选区判定是左开区间（`head > from`），
 *     所以 `anchor === from` 正好算"在表格外"，表格继续渲染。
 */
/**
 * ★★ 模块级重入锁：是否正在 dispatch。
 *
 * 为什么必须是**模块级**而不是 widget 内的局部变量：
 * dispatch 会重建 widget，旧 input 被移除时**同步**触发 blur，
 * blur 处理器闭包捕获的是旧 `toDOM` 作用域里的锁（永远是 false），
 * 于是又 dispatch → `Calls to EditorView.update are not allowed while an
 * update is in progress`。只有模块级的标志才跨得住这次重入。
 */
let dispatching = false

/** 所有对编辑器的写入都走这里，重入时直接忽略。 */
function safeDispatch(view: EditorView, spec: TransactionSpec): void {
  if (dispatching) return
  dispatching = true
  try {
    view.dispatch(spec)
  } finally {
    dispatching = false
  }
}

/**
 * ★★ 当前正在编辑、但还没提交的单元格。
 *
 * 结构类操作（加行 / 加列 / 删行 / 删列）会重建 widget，
 * 若此时输入框里有未提交的内容，重建后内容就**静默丢失**了
 * （更糟的是 blur 被重入锁挡掉，连写回的机会都没有）。
 * 所以这类操作前必须先把待提交的内容 flush 掉。
 */
/**
 * 把正在编辑、但还没提交的单元格写回。
 *
 * ★ 用 `document.activeElement` 而不是闭包里记的 input：
 *   widget 的 DOM 会在每次 dispatch 时重建，闭包捕获的 input 可能已经不是页面上那个
 *   （实测因此读到旧值，导致"内容没变"而跳过写回，编辑内容静默丢失）。
 *   `activeElement` 永远是当前用户真正在敲的那个框，最可靠。
 *   让它 blur 即可 —— 提交逻辑就挂在 blur 上，不用另写一条路径。
 */
function flushPendingEdit(): void {
  const active = document.activeElement as HTMLInputElement | null
  if (!active || !active.classList.contains('cm-table-cell-input')) return
  active.blur()
}

function applyTableEdit(
  view: EditorView,
  edit: TableEdit | null,
  keepRenderedAt: number | null = null,
): void {
  if (!edit) return
  const anchor =
    keepRenderedAt === null
      ? Math.min(edit.caret, edit.text.length)
      : Math.min(keepRenderedAt, edit.text.length)
  safeDispatch(view, {
    changes: { from: 0, to: view.state.doc.length, insert: edit.text },
    selection: { anchor },
  })
  view.focus()
}

/** 渲染表格上的控件按钮。 */
export type TableAction = 'add-row' | 'add-column' | 'del-row' | 'del-column' | 'format'

/**
 * 渲染表格上的控件按钮。
 *
 * ★ mousedown 上 `preventDefault` 是**必需**的，不是优化
 *   note-editor 工具栏的 `keepFocus` 修的是同一个死循环：按钮抢走编辑器焦点 →
 *   表格命令的 `when`（要求光标在表格内）立刻不成立 → 命令不可用。
 *   widget 不在 React 树里，拿不到 keepFocus，必须自己拦一次。
 */
function buildControlButton(
  glyph: string,
  title: string,
  action: TableAction,
  extraClass: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `cm-table-ctl ${extraClass}`
  button.title = title
  button.setAttribute('aria-label', title)
  // ★ 不用 data-command-id：那是命令注册表菜单项的定位标记，
  //   notes-view.test.tsx 的「工具栏顺序」基准按它计数（13 项），
  //   往 widget 上也贴会污染那条断言。
  button.dataset.cmTableAction = action
  button.textContent = glyph

  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onClick()
  })

  return button
}

function applyAlignment(cell: HTMLElement, alignment: ColumnAlignment): void {
  if (alignment) cell.dataset.align = alignment
}

/**
 * 单元格文本单独装一个 span —— 删列按钮要和它做兄弟节点，
 * 且测试与后续逻辑都要能只取文本（不被按钮的 `－` 污染 textContent）。
 */
function textSpan(text: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'cm-table-cell-text'
  span.textContent = text
  return span
}

/**
 * 就地编辑用的输入框。
 *
 * ★ 为什么是"覆盖一个 input"而不是让整个 widget contentEditable
 *   后者要把光标管理、选区、Tab/Enter、IME、粘贴全部自己接管，
 *   而且 CodeMirror 的块级装饰重建时会把 DOM 连带光标一起换掉 —— 全是雷。
 *   覆盖 input 的做法（Notion / Excel / 多数表格组件都这么干）把光标交给
 *   浏览器自己管，我们只需要"什么时候写回"。
 *
 * 键盘约定（对齐 Obsidian advanced-tables / Excel）：
 *   Tab / Shift+Tab → 提交并跳到下一格 / 上一格，继续编辑
 *   Enter           → 提交并跳到下一行同列
 *   Escape          → 放弃修改
 *   失焦            → 提交并退出
 */
export function cellEditor(
  value: string,
  row: number,
  col: number,
  onCommit: (
    row: number,
    col: number,
    value: string,
    move: 'next' | 'prev' | 'down' | 'stay' | 'cancel',
  ) => void,
): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'cm-table-cell-input'
  input.value = value
  input.dataset.row = String(row)
  input.dataset.col = String(col)
  // 无障碍：说明这是哪一格的编辑框
  input.setAttribute('aria-label', `编辑第 ${row} 行第 ${col + 1} 列的单元格`)

  // ★ 全部 stopPropagation：widget 外层有 mousedown/click 处理器，
  //   不拦的话点一下输入框就会被当成"点进单元格"而重新触发一次进入编辑。
  input.addEventListener('mousedown', (event) => event.stopPropagation())
  input.addEventListener('click', (event) => event.stopPropagation())
  input.addEventListener('input', (event) => event.stopPropagation())

  // ★ 键盘必须 stopPropagation，否则 Tab 会被 CodeMirror 的
  //   `table.nextCell` 命令接走（那个是源码态跳格，会破坏这里的编辑流）
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Tab') {
      event.preventDefault()
      onCommit(row, col, input.value, event.shiftKey ? 'prev' : 'next')
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onCommit(row, col, input.value, 'down')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCommit(row, col, input.value, 'cancel')
    }
  })

  input.addEventListener('blur', () => {
    onCommit(row, col, input.value, 'stay')
  })

  return input
}

/**
 * 就地编辑提交后，下一个要编辑的格子。返回 null = 退出编辑。
 *
 * ★ 分隔行（源码行 1）不是可编辑内容，一律跳过 —— 否则 Tab 会把
 *   `| --- | --- |` 当成一个单元格让你去改，改完表格就不合法了。
 *
 * 行/列号沿用源码行号：0 = 表头，1 = 分隔行，2+ = 数据行。
 */
export function nextEditableCell(
  rowCount: number,
  colCount: number,
  row: number,
  col: number,
  move: 'next' | 'prev' | 'down' | 'stay' | 'cancel',
): { row: number; col: number } | null {
  if (move === 'stay' || move === 'cancel') return null

  /** 从 r 出发按 dir 走，跳过分隔行。越界返回 null。 */
  const skipDelimiter = (r: number, dir: 1 | -1): number | null => {
    let cursor = r
    while (cursor >= 0 && cursor < rowCount) {
      if (cursor !== 1) return cursor
      cursor += dir
    }
    return null
  }

  if (move === 'next') {
    if (col + 1 < colCount) return { row, col: col + 1 }
    const r = skipDelimiter(row + 1, 1)
    return r === null ? null : { row: r, col: 0 }
  }
  if (move === 'prev') {
    if (col - 1 >= 0) return { row, col: col - 1 }
    const r = skipDelimiter(row - 1, -1)
    return r === null ? null : { row: r, col: colCount - 1 }
  }
  // down：下一行同一列
  const r = skipDelimiter(row + 1, 1)
  return r === null ? null : { row: r, col }
}

/** 用 createElement 搭出 <table> —— 单元格内容是用户输入，禁止 innerHTML。 */
function buildTableElement(
  data: TableData,
  controls: {
    addColumn: HTMLButtonElement
    addRow: HTMLButtonElement
    format: HTMLButtonElement
    onDeleteRow: (rowIndex: number) => void
    onDeleteColumn: (colIndex: number) => void
  },
  /** 就地编辑中的那一格；null 表示没有在编辑 */
  editing: { row: number; col: number } | null,
  onCellCommit: (
    row: number,
    col: number,
    value: string,
    move: 'next' | 'prev' | 'down' | 'stay' | 'cancel',
  ) => void,
): { table: HTMLTableElement; input: HTMLInputElement | null } {
  const table = document.createElement('table')
  table.className = 'cm-table'
  let input: HTMLInputElement | null = null

  /** 这一格是在编辑，还是照常显示文本。 */
  const fill = (cell: HTMLElement, text: string, row: number, col: number) => {
    if (editing && editing.row === row && editing.col === col) {
      input = cellEditor(text, row, col, onCellCommit)
      cell.appendChild(input)
    } else {
      cell.appendChild(textSpan(text))
    }
  }

  const deletableColumns = data.header.length > 1

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  data.header.forEach((text, col) => {
    const th = document.createElement('th')
    th.className = 'cm-table-cell'
    th.dataset.row = '0'
    th.dataset.col = String(col)
    applyAlignment(th, data.alignments[col])
    fill(th, text, 0, col)
    // 删列：长在表头格里，随该列 hover 浮现。只剩一列时不给 —— 删完就没表了。
    // 编辑中不给，免得点按钮把输入框顶掉。
    if (deletableColumns && !(editing && editing.row === 0 && editing.col === col)) {
      th.appendChild(
        buildControlButton(
          '－',
          `删除「${text || '空表头'}」这一列`,
          'del-column',
          'cm-table-del',
          () => controls.onDeleteColumn(col),
        ),
      )
    }
    headRow.appendChild(th)
  })
  // 列末：加列按钮占一格（无边框，看起来是浮在表头右侧的）
  const headAdd = document.createElement('th')
  headAdd.className = 'cm-table-adjunct'
  headAdd.appendChild(controls.addColumn)
  headRow.appendChild(headAdd)
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  data.rows.forEach((cells, index) => {
    // 数据行在源码里从第 2 行开始（0 表头、1 分隔行）
    const rowIndex = index + 2
    const tr = document.createElement('tr')
    cells.forEach((text, col) => {
      const td = document.createElement('td')
      td.className = 'cm-table-cell'
      td.dataset.row = String(rowIndex)
      td.dataset.col = String(col)
      applyAlignment(td, data.alignments[col])
      fill(td, text, rowIndex, col)
      tr.appendChild(td)
    })
    // 删行：随整行 hover 浮现（表头与分隔行不许删，所以只有数据行有）
    const filler = document.createElement('td')
    filler.className = 'cm-table-adjunct'
    filler.appendChild(
      buildControlButton('－', '删除这一行', 'del-row', 'cm-table-del', () =>
        controls.onDeleteRow(rowIndex),
      ),
    )
    tr.appendChild(filler)
    tbody.appendChild(tr)
  })

  // 行末：加行 + 对齐，独占一行
  const addRow = document.createElement('tr')
  addRow.className = 'cm-table-adjunct-row'
  const addRowCell = document.createElement('td')
  addRowCell.className = 'cm-table-adjunct'
  addRowCell.colSpan = data.header.length + 1
  addRowCell.appendChild(controls.addRow)
  addRowCell.appendChild(controls.format)
  addRow.appendChild(addRowCell)
  tbody.appendChild(addRow)
  table.appendChild(tbody)

  return { table, input }
}

/**
 * 渲染态的表格 widget。
 *
 * ★ `eq` 比较的是源码字符串：正文一变就重建，没变就复用
 *   —— 否则每次按键都会重建 DOM，大文档下会明显掉帧。
 */
class TableWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly from: number,
    /** 这一格正在被就地编辑（渲染成 input 而不是纯文本）。null = 没有 */
    private readonly editing: { row: number; col: number } | null = null,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    // ★ editing 必须参与比较：进入/退出编辑要触发重建，否则 input 不会出现
    const sameEditing =
      (this.editing === null && other.editing === null) ||
      (this.editing !== null &&
        other.editing !== null &&
        this.editing.row === other.editing.row &&
        this.editing.col === other.editing.col)
    return (
      other.source === this.source && other.from === this.from && sameEditing
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const lines = this.source.split('\n')
    const data = parseTable(lines)

    const wrap = document.createElement('div')
    wrap.className = 'cm-table-widget'
    // ★ 渲染出来的是**视图**，不是可编辑内容。不设 false 的话浏览器允许在
    //   <table> 里打字，改的是 DOM 而不是文档 —— 一刷新就"丢内容"。
    wrap.contentEditable = 'false'

    if (!data) return wrap

    // 表格范围由源码长度反推 —— 不必把它塞进 widget 的相等性比较里
    const table: TableRange = {
      from: this.from,
      to: this.from + this.source.length,
      source: this.source,
    }

    /** 把光标放到指定单元格，再交给纯函数算出编辑结果。 */
    const editAt = (
      run: (text: string, offset: number) => TableEdit | null,
      rowIndex: number,
      colIndex: number,
      keepRenderedAt: number | null = null,
    ) => {
      /**
       * ★★ flush 必须在**计算 edit 之前**：`edit` 是整篇替换（from 0 到全文），
       *   用的是计算那一刻的原文。若先算 edit 再 flush，写回的内容会被
       *   这份"旧 edit.text"整篇覆盖掉 —— 实测编辑内容就是这样没的。
       */
      flushPendingEdit()
      applyTableEdit(
        view,
        run(view.state.doc.toString(), this.from + caretForCell(lines, rowIndex, colIndex)),
        keepRenderedAt,
      )
    }

    /**
     * ★ 结构类操作（加行 / 加列 / 删行 / 删列）一律**保持渲染态**，
     *   做法是把光标放到表格首字符 `from` —— 选区判定是左开区间
     *   （`head > from`），所以 `anchor === from` 正好算"在表格外"。
     *
     *   为什么不用纯函数给的 `edit.caret`（落在表格内 → 露源码）：
     *   结构操作最常**连续**进行（加 3 行、连删 2 列），掉回源码态之后
     *   控件按钮跟着 widget 一起消失，第二次就点不到了 —— 必须先把光标
     *   挪出表格才能继续，手感上是"表格坍缩了"。
     *   而且"少了一行 / 多了一列"本身就是最直观的反馈，不需要看源码确认。
     *
     *   代价：加完不能立刻打字。但点进单元格即可露出源码并定位到该格，
     *   比"每次加行都要先把光标挪出来"划算得多。
     */
    const keepRendered = this.from

    const controls = {
      // 加行：光标放在表格末行 → insertTableRow 插到它后面
      addRow: buildControlButton('＋', '在末尾添加一行', 'add-row', 'cm-table-add', () => {
        flushPendingEdit() // 同上：先写回正在编辑的内容，再算 edit
        applyTableEdit(
          view,
          insertTableRow(view.state.doc.toString(), rowAppendOffset(table)),
          keepRendered,
        )
      }),
      // 加列：光标放在表头行末 → insertTableColumn 判定为最后一列 → 追加到列末
      addColumn: buildControlButton(
        '＋',
        '在末尾添加一列',
        'add-column',
        'cm-table-add',
        () => {
          flushPendingEdit()
          applyTableEdit(
            view,
            insertTableColumn(view.state.doc.toString(), columnAppendOffset(table)),
            keepRendered,
          )
        },
      ),
      /**
       * 对齐。★ 这里是唯一**故意**露出源码的结构操作
       *   对齐只改空白、不改结构，渲染态前后长得一模一样 ——
       *   留在渲染态用户会以为按钮没生效。所以要看结果就得露源码。
       *
       * ★★ 另：为什么不做成"加列后自动对齐"
       *   自动 formatTable 会把整张表按最宽单元格重排 ——
       *   `| 姓名 | 部门 |` 会被撑成 `| 姓名   | 部门    |`，侵入性远大于收益。
       *   交给用户按需点一下，才是既不越界又能解决"源码看着不齐"的做法。
       */
      format: buildControlButton('≡', '对齐表格', 'format', 'cm-table-add', () =>
        editAt(formatTable, 0, 0),
      ),
      // 删行：光标放到该行的第一格（表头与分隔行没有这个按钮）
      onDeleteRow: (rowIndex: number) => editAt(deleteTableRow, rowIndex, 0, keepRendered),
      // 删列：光标放到表头的该列（只剩一列时按钮不会渲染）
      onDeleteColumn: (colIndex: number) =>
        editAt(deleteTableColumn, 0, colIndex, keepRendered),
    }

    /**
     * 就地编辑的提交：把输入框的值写回源码，然后按 move 决定去哪。
     *
     * ★ 为什么不在每次按键时就写回
     *   一 dispatch 就会重建 widget，input 被换掉 → 光标和 IME 组合输入全丢。
     *   所以输入期间什么都不做，等 Tab / Enter / 失焦 / Escape 再一次性写回。
     *
     * ★ 内容没变时也要走一遍 dispatch：这样"退出编辑"和"内容已写回"
     *   是同一条路径，不会出现"改了但没生效"的分支。
     */
    /**
     * ★★ 防重入：dispatch 会重建 widget，旧 input 被移除时**同步**触发
     *   blur → blur 又调 commit → 在 update 进行中再 dispatch，
     *   浏览器控制台刷 `Calls to EditorView.update are not allowed while an
     *   update is in progress`（实测一次提交能触发三次）。用一把锁挡掉。
     */
    let committing = false
    const commit: (
      row: number,
      col: number,
      value: string,
      move: 'next' | 'prev' | 'down' | 'stay' | 'cancel',
    ) => void = (row, col, value, move) => {
      if (committing) return
      committing = true
      try {
        applyCommit(row, col, value, move)
      } finally {
        committing = false
      }
    }

    const applyCommit = (
      row: number,
      col: number,
      value: string,
      move: 'next' | 'prev' | 'down' | 'stay' | 'cancel',
    ) => {
      if (move === 'cancel') {
        safeDispatch(view, { effects: setEditingCell.of(null) })
        view.focus()
        return
      }

      const text = view.state.doc.toString()
      const current = parseTableRow(lines[row])?.[col] ?? ''
      const offset = this.from + caretForCell(lines, row, col)
      const edit =
        value === current
          ? { text, caret: offset }
          : setTableCell(text, offset, row, col, value)

      if (!edit) {
        safeDispatch(view, { effects: setEditingCell.of(null) })
        view.focus()
        return
      }

      const next = nextEditableCell(
        lines.length,
        data.header.length,
        row,
        col,
        move,
      )

      safeDispatch(view, {
        changes: { from: 0, to: text.length, insert: edit.text },
        /**
         * ★★ 光标必须留在表格外（keepRendered = `from`），**不能**用
         *   `edit.caret`（它落在表格内）—— 否则 `selectionTouches` 判定
         *   "光标在表格里" → 立刻露出源码，就地编辑就白做了：改完一格
         *   表格就降级，下一格的 input 也跟着消失（实测两个用例都因此失败）。
         */
        selection: { anchor: Math.min(keepRendered, edit.text.length) },
        effects: setEditingCell.of(
          next ? { from: this.from, to: this.from + edit.text.length, ...next } : null,
        ),
      })
      // 退出编辑后把焦点还给编辑器（继续编辑时焦点由下面的 input 自己拿）
      if (!next) view.focus()
    }

    const built = buildTableElement(data, controls, this.editing, commit)
    wrap.appendChild(built.table)

    // ★ 进入编辑后自动聚焦并全选（Excel 式：直接敲就覆盖原内容）。
    //   用 setTimeout 而不是 requestAnimationFrame —— jsdom 里后者不一定触发，
    //   那样单测就拿不到聚焦后的 input。
    if (built.input) {
      const input = built.input
      // ★ 进入编辑后自动聚焦并全选（Excel 式：直接敲就覆盖原内容）。
      //   用 setTimeout 而不是 requestAnimationFrame —— jsdom 里后者不一定触发，
      //   那样单测就拿不到聚焦后的 input。
      setTimeout(() => {
        input.focus()
        input.select()
      }, 0)
    }

    /**
     * ★ mousedown 全部 preventDefault：不让浏览器把焦点/光标塞进 widget
     *   （widget 是 contentEditable=false，浏览器会找最近的可编辑位置，
     *   结果常常是表格外的某个莫名其妙的地方）。位置由下面自己算。
     */
    wrap.addEventListener('mousedown', (event) => {
      if ((event.target as HTMLElement | null)?.closest('button')) return
      event.preventDefault()
    })

    /**
     * ★ 点击单元格 → **原地进入编辑**（渲染态不降级为源码）。
     *
     *   早期这里是"把光标放到源码对应位置 → 露出源码"，用户的反馈是
     *   "点进去就降级成源码了"。改成覆盖一个 input 后，表格始终在渲染态，
     *   改完失焦/Enter 就写回 —— 这是 Notion / Excel / Obsidian 表格的做法。
     *
     *   分隔行（源码行 1）不是内容，点了当作没点。
     */
    wrap.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('button')) return

      const cell = target?.closest<HTMLElement>('[data-row]')
      const row = cell ? Number(cell.dataset.row) : lines.length - 1
      const col = cell ? Number(cell.dataset.col) : 0
      if (row === 1) return // 分隔行不可编辑

      event.stopPropagation()
      // ★ 从一格切到另一格时，先把原来那格提交掉，别丢内容
      flushPendingEdit()
      safeDispatch(view, {
        effects: setEditingCell.of({
          from: this.from,
          to: this.from + this.source.length,
          row,
          col,
        }),
      })
    })

    return wrap
  }

  /** widget 内的一切事件都不交给 CodeMirror 处理（点击已由上面的监听器接管）。 */
  ignoreEvent(): boolean {
    return true
  }

  /**
   * widget 被销毁时清掉待提交引用 —— 否则它会指向一个已经脱离文档的 input，
   * 下次结构操作会拿旧值去写回（脏数据覆盖）。
   */
  destroy(): void {
    // 输入框会随 DOM 一起消失，不需要额外清理（提交走 blur，见 flushPendingEdit）
  }
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  // 读取"哪一格正在被就地编辑"（可能没注册，用 false 兜底）
  const editing = state.field(editingCellField, false) ?? null

  for (const table of collectTables(state)) {
    // 语法树说是表格块、但分隔行不合法（数据问题，如 `| 1 | --- | --- |`）
    // → 不当表格，原样显示源码。判定权交给 parseTable，与命令层同一套规则。
    if (!parseTable(table.source.split('\n'))) continue
    if (selectionTouches(state, table.from, table.to)) continue

    builder.add(
      table.from,
      table.to,
      Decoration.replace({
        widget: new TableWidget(
          table.source,
          table.from,
          // ★ 只把属于**这张表**的编辑态传进去，多表格文档互不干扰
          editing && editing.from === table.from
            ? { row: editing.row, col: editing.col }
            : null,
        ),
        block: true,
      }),
    )
  }

  return builder.finish()
}

/**
 * 表格 Live Preview 扩展。
 *
 * ★ 为什么是 StateField 而不是 ViewPlugin
 *   CodeMirror 6 **不允许** ViewPlugin 提供块级装饰
 *   （运行时会抛 `RangeError: Block decorations may not be specified via plugins`）——
 *   块级装饰会改变纵向块结构，必须在编辑器做整体测量之前就确定下来，
 *   而 ViewPlugin 的更新时机太晚。这是本模块踩到的第一个硬约束。
 *
 * 用法：加进 `note-editor.tsx` 的 `extensions` 数组
 * （必须排在 `markdown({ base: markdownLanguage })` 之后 —— 没有 GFM
 * 语法树就没有 Table 节点）。
 */
export const tablePreview = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state),

  update(deco: DecorationSet, tr: Transaction) {
    /**
     * ★ 只有这三类变化才重建：正文改了、光标/选区动了、语法树变了。
     *   其余（如纯样式 transaction）原样返回同一个对象 ——
     *   返回相同引用时 CodeMirror 会跳过整个重绘。
     *
     *   语法树比较是必要的：输入一半的表格（刚敲完表头与分隔行）
     *   不会触发 docChanged 之外的事件，但语法树已经不同了。
     */
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state)
    // ★ 进入/退出就地编辑也要重建：它既不改文档也不动选区，
    //   只发一个 StateEffect，没有这一条 input 根本不会出现。
    const editingChanged = tr.effects.some((effect) => effect.is(setEditingCell))
    if (!tr.docChanged && !tr.selection && !treeChanged && !editingChanged) {
      return deco
    }
    return buildTableDecorations(tr.state)
  },

  provide: (field) => EditorView.decorations.from(field),
})
