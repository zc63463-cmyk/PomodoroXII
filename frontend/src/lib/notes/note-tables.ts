/**
 * Note tables —— Markdown 表格的纯函数操作（对标 advanced-tables-obsidian）。
 *
 * ★ 为什么全部是纯函数
 *   命令层（`custom` action）要能薄到只是把结果 dispatch 出去，
 *   表格逻辑才测得动。这里是字符串进、字符串出，不碰 EditorView。
 *
 * ★ 支持的表格形态
 *   | a | b |        ← 标准（首尾带竖线）
 *   a | b            ← 也认（GFM 允许省略首尾竖线，但本项目写入时一律补齐）
 *   分隔行支持对齐语法：| :--- | :---: | ---: |
 *
 * ★ 已知简化
 *   不处理转义竖线 `\|`（单元格内竖线）与代码块内的伪表格。
 *   个人笔记量级下极少遇到，真撞上了再上 remark AST 实现。
 */

// 表格语法判定用共享定义 —— 与渲染前的表格边界修正必须是同一套规则
import { isTableDelimiter, isTableRow } from '@/lib/markdown/table-syntax'

/** 一次编辑的结果。命令层只需把 text 写回、把光标放到 caret。 */
export interface TableEdit {
  text: string
  caret: number
}

/** 光标所在的表格。 */
export interface TableBlock {
  /** 表格首字符偏移 */
  from: number
  /** 表格末尾（不含） */
  to: number
  /** 表格各行原文 */
  lines: string[]
  /** 光标所在行（0 基；0 = 表头，1 = 分隔行） */
  rowIndex: number
  /** 光标所在列（0 基） */
  columnIndex: number
}

/**
 * 拆出一行的单元格文本（去首尾竖线、trim）。
 * 用于计算列数与列宽。
 */
export function parseTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((cell) => cell.trim())
}

/**
 * 光标落在第几列：数光标前的竖线个数。
 * `| a | b |` 中，光标在 `a` 处时前面有 1 个竖线 → 第 0 列。
 */
function columnIndexAt(line: string, offsetInLine: number): number {
  let count = 0
  for (let i = 0; i < offsetInLine && i < line.length; i += 1) {
    if (line[i] === '|') count += 1
  }
  return Math.max(0, count - 1)
}

/**
 * 找到光标所在的表格。不在表格内则返回 null。
 *
 * 表格 = 连续的表格行块，且**第二行必须是分隔行** ——
 * 否则只是几个碰巧以 `|` 开头的普通段落。
 */
export function findTableAt(markdown: string, offset: number): TableBlock | null {
  if (offset < 0 || offset > markdown.length) return null

  // 光标所在行
  const lineStart = markdown.lastIndexOf('\n', Math.max(offset - 1, 0)) + 1
  let lineEnd = markdown.indexOf('\n', offset)
  if (lineEnd === -1) lineEnd = markdown.length

  if (!isTableRow(markdown.slice(lineStart, lineEnd))) return null

  // 向上扩展到块首
  let from = lineStart
  let probe = lineStart
  for (;;) {
    const prevEnd = probe - 1
    if (prevEnd < 0) break
    const prevStart = markdown.lastIndexOf('\n', Math.max(prevEnd - 1, 0)) + 1
    if (!isTableRow(markdown.slice(prevStart, prevEnd))) break
    from = prevStart
    probe = prevStart
  }

  // 向下扩展到块尾
  let to = lineEnd
  probe = lineEnd
  for (;;) {
    if (probe + 1 >= markdown.length) break
    let nextEnd = markdown.indexOf('\n', probe + 1)
    if (nextEnd === -1) nextEnd = markdown.length
    if (!isTableRow(markdown.slice(probe + 1, nextEnd))) break
    to = nextEnd
    probe = nextEnd
  }

  const lines = markdown.slice(from, to).split('\n')
  // 至少要有表头 + 分隔行
  if (lines.length < 2 || !isTableDelimiter(lines[1])) return null

  // 光标行在块内是第几行
  let rowIndex = 0
  let cursor = from
  for (let i = 0; i < lines.length; i += 1) {
    if (lineStart === cursor) {
      rowIndex = i
      break
    }
    cursor += lines[i].length + 1
  }

  const columnIndex = columnIndexAt(lines[rowIndex], offset - lineStart)

  return { from, to, lines, rowIndex, columnIndex }
}

/** 表格的列数（以表头行为准）。 */
function columnCount(lines: string[]): number {
  return parseTableRow(lines[0]).length
}

/** 把单元格数组渲染成一行（首尾补竖线）。 */
function renderRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

/** 生成一张空表格。用于"在光标处建表"。 */
export function createTable(rows: number, columns: number): string {
  const header = renderRow(
    Array.from({ length: columns }, (_, i) => `列 ${i + 1}`),
  )
  const delimiter = renderRow(Array.from({ length: columns }, () => '---'))
  const body = Array.from({ length: rows }, () =>
    renderRow(Array.from({ length: columns }, () => '  ')),
  )
  return [header, delimiter, ...body].join('\n')
}

// --------------------------------------------------------------------------- //
// 结构化解析（供编辑器内的表格预览渲染使用）
// --------------------------------------------------------------------------- //

/** 列的对齐方式。null = 未在分隔行标注。 */
export type ColumnAlignment = 'left' | 'center' | 'right' | null

export interface TableData {
  header: string[]
  rows: string[][]
  alignments: ColumnAlignment[]
}

/**
 * 把表格的若干行原文解析成结构化数据。
 * 第 2 行必须是合法分隔行，否则返回 null（那就不算一张表）。
 *
 * 单元格里的行内 Markdown（**粗体**、`代码`、`[[链接]]`）**保持原样**，
 * 由渲染层决定要不要再解析 —— 这里只负责把表格拆成格子。
 */
export function parseTable(lines: string[]): TableData | null {
  if (lines.length < 2) return null
  if (!isTableDelimiter(lines[1])) return null

  const header = parseTableRow(lines[0])
  const alignments = parseTableRow(lines[1]).map(
    (cell): ColumnAlignment => {
      const left = cell.startsWith(':')
      const right = cell.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      if (left) return 'left'
      return null
    },
  )
  const rows = lines.slice(2).map((line) => parseTableRow(line))
  return { header, rows, alignments }
}

// --------------------------------------------------------------------------- //
// 行操作
// --------------------------------------------------------------------------- //

/** 在光标所在行下方插入一行。光标在分隔行上时插到它后面（分隔行必须在第 2 行）。 */
export function insertTableRow(markdown: string, offset: number): TableEdit | null {
  const table = findTableAt(markdown, offset)
  if (!table) return null

  const columns = columnCount(table.lines)
  const blank = renderRow(Array.from({ length: columns }, () => ''))
  const insertAt = Math.max(table.rowIndex, 1) + 1

  const lines = [...table.lines]
  lines.splice(insertAt, 0, blank)

  const text =
    markdown.slice(0, table.from) + lines.join('\n') + markdown.slice(table.to)
  const caret =
    table.from +
    lines.slice(0, insertAt).reduce((sum, l) => sum + l.length + 1, 0) +
    2
  return { text, caret: Math.min(caret, text.length) }
}

/**
 * 删除光标所在行。
 * 表头与分隔行不许删 —— 删了表格就不成立了；此时原样返回，由调用方决定是否提示。
 */
export function deleteTableRow(markdown: string, offset: number): TableEdit | null {
  const table = findTableAt(markdown, offset)
  if (!table) return null
  if (table.rowIndex <= 1) return { text: markdown, caret: offset }

  const lines = [...table.lines]
  const removedStart =
    table.from +
    lines.slice(0, table.rowIndex).reduce((sum, l) => sum + l.length + 1, 0)

  lines.splice(table.rowIndex, 1)

  const text =
    markdown.slice(0, table.from) + lines.join('\n') + markdown.slice(table.to)
  return { text, caret: Math.min(removedStart, text.length) }
}

// --------------------------------------------------------------------------- //
// 列操作
// --------------------------------------------------------------------------- //

/** 第 index 个单元格起始处相对行首的偏移（跳过 "| " 前缀）。 */
function offsetInRow(row: string, index: number): number {
  const cells = parseTableRow(row)
  let pos = 2
  for (let i = 0; i < index && i < cells.length; i += 1) {
    pos += cells[i].length + 3
  }
  return Math.min(pos, row.length)
}

/** 在光标所在列右侧插入一列。 */
export function insertTableColumn(markdown: string, offset: number): TableEdit | null {
  const table = findTableAt(markdown, offset)
  if (!table) return null

  const at = table.columnIndex + 1
  const lines = table.lines.map((line) => {
    const cells = parseTableRow(line)
    cells.splice(at, 0, isTableDelimiter(line) ? '---' : '')
    return renderRow(cells)
  })

  const text =
    markdown.slice(0, table.from) + lines.join('\n') + markdown.slice(table.to)
  const caret =
    table.from +
    lines.slice(0, table.rowIndex).reduce((sum, l) => sum + l.length + 1, 0) +
    offsetInRow(lines[table.rowIndex], at)
  return { text, caret: Math.min(caret, text.length) }
}

/** 删除光标所在列。只剩一列时不删（删完就没有表格了）。 */
export function deleteTableColumn(markdown: string, offset: number): TableEdit | null {
  const table = findTableAt(markdown, offset)
  if (!table) return null
  if (columnCount(table.lines) <= 1) return { text: markdown, caret: offset }

  const at = table.columnIndex
  const lines = table.lines.map((line) => {
    const cells = parseTableRow(line)
    cells.splice(at, 1)
    return renderRow(cells)
  })

  const text =
    markdown.slice(0, table.from) + lines.join('\n') + markdown.slice(table.to)
  const caret =
    table.from +
    lines.slice(0, table.rowIndex).reduce((sum, l) => sum + l.length + 1, 0) +
    offsetInRow(lines[table.rowIndex], Math.max(0, at))
  return { text, caret: Math.min(caret, text.length) }
}

// --------------------------------------------------------------------------- //
// 对齐格式化 / 单元格跳转
// --------------------------------------------------------------------------- //

/**
 * 对齐格式化：每列按最宽单元格补齐空格，分隔行同步补齐宽度并保留对齐冒号。
 * 这是 advanced-tables 里最常用的一个动作 —— 手写的表格几乎总是不齐的。
 */
export function formatTable(markdown: string, offset: number): TableEdit | null {
  const table = findTableAt(markdown, offset)
  if (!table) return null

  const parsed = table.lines.map((line) => parseTableRow(line))
  const columns = columnCount(table.lines)
  const widths = Array.from({ length: columns }, (_, col) =>
    Math.max(3, ...parsed.map((cells) => (cells[col] ?? '').length)),
  )

  const lines = table.lines.map((line, rowIndex) => {
    const cells = parsed[rowIndex]
    if (isTableDelimiter(line)) {
      return renderRow(
        Array.from({ length: columns }, (_, col) => {
          const raw = cells[col] ?? '---'
          const hasLeft = raw.startsWith(':')
          const hasRight = raw.endsWith(':')
          const body = '-'.repeat(widths[col])
          return (hasLeft ? ':' : '') + body + (hasRight ? ':' : '')
        }),
      )
    }
    return renderRow(
      Array.from({ length: columns }, (_, col) =>
        (cells[col] ?? '').padEnd(widths[col], ' '),
      ),
    )
  })

  const text =
    markdown.slice(0, table.from) + lines.join('\n') + markdown.slice(table.to)
  return { text, caret: Math.min(offset, text.length) }
}

/**
 * 就地编辑：把某个单元格的内容改成 value，其余原样保留。
 *
 * ★ 这是「点单元格 → 原地打字 → 不降级为源码」的写回入口。
 *   只改这一格的文本，**不动行列数、不动其它格、不动对齐** ——
 *   和 formatTable（会重排整张表）刻意区分开，避免用户编辑时表格被"推来推去"。
 *
 * 行/列号沿用源码行号（0 = 表头，1 = 分隔行，2+ = 数据行）。
 * 分隔行（1）不该被当作普通单元格编辑 —— 调用方负责拦住。
 *
 * 值里含 `|` 会破坏表格，这里按成熟项目的做法**转义为 `\|`**
 * （Obsidian / GFM 都这么做，parseTableRow 能原样读回）。
 */
export function setTableCell(
  markdown: string,
  offset: number,
  rowIndex: number,
  colIndex: number,
  value: string,
): TableEdit | null {
  const table = findTableAt(markdown, offset)
  if (!table) return null
  if (rowIndex < 0 || rowIndex >= table.lines.length) return null
  if (rowIndex === 1) return null // 分隔行不可编辑

  const lines = [...table.lines]
  const cells = parseTableRow(lines[rowIndex])
  if (colIndex < 0 || colIndex >= cells.length) return null

  cells[colIndex] = value.replace(/\|/g, '\\|')
  lines[rowIndex] = renderRow(cells)

  const text =
    markdown.slice(0, table.from) + lines.join('\n') + markdown.slice(table.to)

  // 光标落在刚编辑的这一格内，方便接着按 Tab 跳格
  let caret = table.from
  for (let i = 0; i < rowIndex; i += 1) caret += lines[i].length + 1
  caret += offsetInRow(lines[rowIndex], colIndex)
  return { text, caret: Math.min(caret, text.length) }
}

/**
 * Tab 跳到下一个单元格；行末则换行到下一行首格；表尾则追加一行。
 * 不在表格内返回 null —— 调用方应让 Tab 保持原来的缩进行为。
 */
export function nextTableCell(markdown: string, offset: number): TableEdit | null {
  const table = findTableAt(markdown, offset)
  if (!table) return null

  const columns = columnCount(table.lines)
  const isLastColumn = table.columnIndex >= columns - 1
  const isLastRow = table.rowIndex >= table.lines.length - 1

  if (isLastColumn && isLastRow) {
    // 表尾：追加一行并跳到它的第一格
    const appended = insertTableRow(markdown, offset)
    if (!appended) return null
    const next = findTableAt(appended.text, appended.caret)
    if (!next) return null
    const caret =
      next.from +
      next.lines.slice(0, 2).reduce((sum, l) => sum + l.length + 1, 0) +
      2
    return { text: appended.text, caret: Math.min(caret, appended.text.length) }
  }

  const rowStart = (rowIndex: number, lines: string[]) =>
    lines.slice(0, rowIndex).reduce((sum, l) => sum + l.length + 1, 0)

  if (isLastColumn) {
    // 换行到下一行第一格
    const caret = table.from + rowStart(table.rowIndex + 1, table.lines) + 2
    return { text: markdown, caret: Math.min(caret, markdown.length) }
  }

  // 同一行的下一列
  const caret =
    table.from +
    rowStart(table.rowIndex, table.lines) +
    offsetInRow(table.lines[table.rowIndex], table.columnIndex + 1)
  return { text: markdown, caret: Math.min(caret, markdown.length) }
}

/**
 * 选区 [selFrom, selTo] 是否**完全**覆盖某一行（且该行是数据行，从第 2 行起）。
 *
 * 判定很严格：起点必须落在该行首字符位置，终点必须落在该行末位置。
 * 表头行（0）和分隔行（1）不会被覆盖删除 —— 删了表就坏了。
 *
 * 选区返回 1（已选了一段）→ 行号；空选区 / 半选区 / 选区超出表格 → null。
 *
 * ★★ 这是为"选中 + Delete 删除行"做准备的。设计选择：
 *   - **不**返回 true 当光标只在某行但没选区（光标独立不算"选中"）；
 *     用户得用 Shift+Home/End 或鼠标拖选中整行。
 *   - 选区边界必须**严格等于**行首末 —— 这样普通删除单元格内容的行为不受影响。
 */
export function coversTableRow(
  text: string,
  selFrom: number,
  selTo: number,
): number | null {
  if (selFrom >= selTo) return null
  const table = findTableAt(text, selFrom)
  if (!table) return null
  if (selTo > table.to) return null

  for (let r = 2; r < table.lines.length; r += 1) {
    let lineStartInTable = 0
    for (let i = 0; i < r; i += 1) lineStartInTable += table.lines[i].length + 1
    const lineEndInTable = lineStartInTable + table.lines[r].length
    const relFrom = selFrom - table.from
    const relTo = selTo - table.from
    // 接受两种 selTo：行末字符位置（lineEndInTable-1）或紧跟其后的 \n（lineEndInTable）。
    // 鼠标拖选通常停在行末字符上；键盘 Shift+End 则会包含 \n。
    if (
      relFrom === lineStartInTable &&
      (relTo === lineEndInTable || relTo === lineEndInTable - 1)
    ) {
      return r
    }
  }
  return null
}

/**
 * 选区 [selFrom, selTo] 是否**完全**覆盖某一列。
 *
 * 判定：起点落在该列**表头格**的开始位置，终点落在该列**最后一行**该格末尾位置。
 * 列至少要 2 列（唯一列不可删）。
 *
 * 这是为"选中 + Delete 删除列"做准备的。表头那一格是任何列选择都必须经过的"门槛"，
 * 用户从表头按 Shift+End/↓ 拖到底很自然。
 */
/**
 * ★ 工具：把表内偏移转成 (行, 列)。
 *   用累加法（不过 split），并把 \n 当作"上一行末尾"（行末 \n 归上一行）。
 */
function inTableRowCol(lines: string[], offsetInTable: number): { row: number; col: number } {
  let cursor = 0
  for (let row = 0; row < lines.length; row += 1) {
    const lineLen = lines[row].length
    const nextCursor = cursor + lineLen + 1 // +1 含 \n
    if (offsetInTable < nextCursor) {
      // ★ 把 \n（offsetInTable == nextCursor - 1）归到本行的最后一个格
      const colAt = Math.min(offsetInTable - cursor, lineLen)
      return { row, col: columnIndexAt(lines[row], Math.max(0, colAt)) }
    }
    cursor = nextCursor
  }
  // 越界（offset > 整个表长）—— 兜底到最后一格
  return { row: lines.length - 1, col: 0 }
}

export function coversTableColumn(
  text: string,
  selFrom: number,
  selTo: number,
): number | null {
  if (selFrom >= selTo) return null

  const fromTable = findTableAt(text, selFrom)
  if (!fromTable) return null
  // ★ 终点允许超出 fromTable.to（如在行末 \n 上）—— 选区终点更晚是合法的
  //   只要不超出整个表范围（用 fromTable 长度兜底）
  if (selTo > fromTable.from + fromTable.lines.reduce((s, l) => s + l.length + 1, 0)) return null

  const cols = parseTableRow(fromTable.lines[0]).length
  if (cols < 2) return null

  /**
   * ★ 用「行内偏移 → (row, col)」判定：
   *   起点 = 表头行 (0)、终点 = 最后一行 (lines.length - 1)、两列号必须相同
   *   即"从表头某列拖到最后一行的同一列" = 选中整列。
   *   早期版本要求精确偏移，导致键盘 End+Shift+↓ 选不出整列（起点不在格首）。
   */
  const fromPos = inTableRowCol(fromTable.lines, selFrom - fromTable.from)
  const toPos = inTableRowCol(fromTable.lines, selTo - fromTable.from)
  if (fromPos.row !== 0) return null
  if (toPos.row !== fromTable.lines.length - 1) return null
  if (fromPos.col !== toPos.col) return null

  return fromPos.col
}
