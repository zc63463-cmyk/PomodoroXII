import { describe, expect, it } from 'vitest'
import { isTableRow } from '@/lib/markdown/table-syntax'
import {
  coversTableColumn,
  coversTableRow,
  createTable,
  deleteTableColumn,
  deleteTableRow,
  findTableAt,
  formatTable,
  insertTableColumn,
  insertTableRow,
  nextTableCell,
  parseTable,
  parseTableRow,
  setTableCell,
} from './note-tables'

const T3 = ['| 列 1 | 列 2 |', '| --- | --- |', '| a | b |'].join('\n')

/** 取表格的正文部分（去掉前后正文），便于断言。 */
function rowsOf(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().startsWith('|'))
}

describe('parseTableRow', () => {
  it('拆出单元格文本', () => {
    expect(parseTableRow('| 列 1 | 列 2 |')).toEqual(['列 1', '列 2'])
  })

  it('首尾无竖线也能拆', () => {
    expect(parseTableRow('列 1 | 列 2')).toEqual(['列 1', '列 2'])
  })

  it('空单元格保留为空串', () => {
    expect(parseTableRow('|  | b |')).toEqual(['', 'b'])
  })
})

describe('findTableAt', () => {
  it('★ 认出光标所在的表格', () => {
    const text = `上文\n\n${T3}\n\n下文`
    const table = findTableAt(text, text.indexOf('| a | b |') + 3)
    expect(table).not.toBeNull()
    expect(table!.lines).toHaveLength(3)
    expect(table!.rowIndex).toBe(2)
  })

  it('★ 算出光标在第几列', () => {
    const row = '| a | b |'
    const text = `| 列 1 | 列 2 |\n| --- | --- |\n${row}`
    // 光标在 b 处
    const table = findTableAt(text, text.indexOf(row) + row.indexOf('b'))
    expect(table!.columnIndex).toBe(1)

    const tableA = findTableAt(text, text.indexOf(row) + row.indexOf('a'))
    expect(tableA!.columnIndex).toBe(0)
  })

  it('不在表格内返回 null', () => {
    expect(findTableAt('普通段落\n\n另一段', 2)).toBeNull()
  })

  it('★ 只有表头没有分隔行 → 不是表格', () => {
    const text = '| a | b |\n| c | d |'
    expect(findTableAt(text, 2)).toBeNull()
  })

  it('★ 表格范围正确（不吞前后正文）', () => {
    const text = `上文\n\n${T3}\n\n下文`
    const table = findTableAt(text, text.indexOf('| a | b |') + 2)!
    expect(text.slice(table.from, table.to)).toBe(T3)
  })

  it('★ 多张表格时各找各的', () => {
    const text = `${T3}\n\n中间段落\n\n${T3}`
    const second = text.indexOf('| a | b |', text.indexOf('中间'))
    const table = findTableAt(text, second + 2)!
    expect(table.from).toBeGreaterThan(text.indexOf('中间'))
    expect(table.to).toBe(text.length)
  })

  it('偏移量越界返回 null', () => {
    expect(findTableAt(T3, -1)).toBeNull()
    expect(findTableAt(T3, 9999)).toBeNull()
  })
})

describe('createTable', () => {
  it('生成表头 + 分隔行 + 指定行数', () => {
    const t = createTable(2, 3)
    const lines = t.split('\n')
    expect(lines).toHaveLength(4) // 表头 + 分隔 + 2 行
    expect(lines[0]).toBe('| 列 1 | 列 2 | 列 3 |')
    expect(lines[1]).toBe('| --- | --- | --- |')
  })
})

describe('行操作', () => {
  it('★ 在光标行下方插入一行', () => {
    const text = `上文\n\n${T3}\n\n下文`
    const edit = insertTableRow(text, text.indexOf('| a | b |') + 2)!
    expect(rowsOf(edit.text)).toHaveLength(4)
  })

  it('★ 光标在分隔行上时，新行插在它后面（分隔行必须留在第 2 行）', () => {
    const text = T3
    const edit = insertTableRow(text, text.indexOf('| --- |') + 2)!
    const lines = edit.text.split('\n')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines).toHaveLength(4)
  })

  it('★ 表头与分隔行不许删', () => {
    const text = T3
    const header = deleteTableRow(text, 2)!
    expect(header.text).toBe(text)

    const delimiter = deleteTableRow(text, text.indexOf('| --- |') + 2)!
    expect(delimiter.text).toBe(text)
  })

  it('删除数据行', () => {
    const text = `| 列 1 | 列 2 |\n| --- | --- |\n| a | b |\n| c | d |`
    const edit = deleteTableRow(text, text.indexOf('| a | b |') + 2)!
    expect(rowsOf(edit.text)).toHaveLength(3)
    expect(edit.text).not.toContain('| a | b |')
  })

  it('非表格位置返回 null', () => {
    expect(insertTableRow('普通段落', 2)).toBeNull()
  })
})

describe('列操作', () => {
  it('★ 在光标列右侧插入一列', () => {
    const text = T3
    const edit = insertTableColumn(text, text.indexOf('| a | b |') + 3)!
    expect(edit.text.split('\n')[0]).toBe('| 列 1 |  | 列 2 |')
    // 分隔行的新列也应是分隔语义
    expect(edit.text.split('\n')[1]).toBe('| --- | --- | --- |')
  })

  it('★ 删除光标所在列', () => {
    const text = T3
    // 光标落在 a 处 = 第 0 列 → 删掉「列 1」，剩下「列 2」
    const edit = deleteTableColumn(text, text.indexOf('| a | b |') + 3)!
    expect(edit.text.split('\n')[0]).toBe('| 列 2 |')
    expect(edit.text.split('\n')[2]).toBe('| b |')
  })

  it('★ 只剩一列时不删', () => {
    const text = '| 唯一 |\n| --- |\n| a |'
    const edit = deleteTableColumn(text, text.indexOf('| a |') + 2)!
    expect(edit.text).toBe(text)
  })

  it('插入列后所有行列数一致', () => {
    const text = T3
    const edit = insertTableColumn(text, text.indexOf('| a | b |') + 2)!
    const counts = rowsOf(edit.text).map((l) => parseTableRow(l).length)
    expect(new Set(counts).size).toBe(1)
  })
})

describe('formatTable', () => {
  it('★ 按最宽单元格补齐列宽', () => {
    const text = ['| a | bbbbb |', '| --- | --- |', '| cccc | d |'].join('\n')
    const edit = formatTable(text, 2)!
    const lines = edit.text.split('\n')
    // 第一列最宽是 cccc（4），第二列最宽是 bbbbb（5）—— 各按各的列宽补齐
    expect(lines[0]).toBe('| a    | bbbbb |')
    expect(lines[2]).toBe('| cccc | d     |')
  })

  it('★ 保留分隔行的对齐冒号', () => {
    const text = ['| 左 | 右 |', '| :--- | ---: |', '| a | b |'].join('\n')
    const edit = formatTable(text, 2)!
    const delimiter = edit.text.split('\n')[1]
    expect(delimiter).toContain(':---')
    expect(delimiter).toContain('---:')
  })

  it('列宽不齐时补齐到一致', () => {
    const text = ['| aaa | b |', '| --- | --- |', '| c | ddddd |'].join('\n')
    const edit = formatTable(text, 2)!
    const widths = rowsOf(edit.text).map((l) => l.length)
    expect(new Set(widths).size).toBe(1)
  })
})

describe('nextTableCell', () => {
  it('★ 跳到同一行的下一列', () => {
    const text = T3
    const edit = nextTableCell(text, text.indexOf('| a | b |') + 2)!
    const after = edit.text.slice(edit.caret)
    // 光标应停在 b 前
    expect(after.startsWith('b')).toBe(true)
  })

  it('★ 行末则跳到下一行首格', () => {
    const text = `| 列 1 | 列 2 |\n| --- | --- |\n| a | b |\n| c | d |`
    const edit = nextTableCell(text, text.indexOf('| a | b |') + 6)!
    const line = edit.text.slice(0, edit.caret).split('\n').length
    expect(line).toBe(4) // 已到第 4 行（0 基的第 3 行）
  })

  it('★ 表尾则追加一行', () => {
    const edit = nextTableCell(T3, T3.indexOf('| a | b |') + 6)!
    expect(rowsOf(edit.text)).toHaveLength(4)
  })

  it('不在表格内返回 null（Tab 应保持默认行为）', () => {
    expect(nextTableCell('普通段落', 2)).toBeNull()
  })
})

/**
 * parseTable 是渲染层（表格 Live Preview）的数据入口 ——
 * 它返回 null 意味着"这不是一张表"，渲染层据此决定要不要渲染。
 * 所以这里的用例重点钉住**什么算表格**这个边界。
 */
describe('parseTable', () => {
  it('★ 正常表格：分出表头 / 数据行 / 对齐（未标注为 null）', () => {
    const data = parseTable(['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'])!
    expect(data.header).toEqual(['a', 'b'])
    expect(data.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
    expect(data.alignments).toEqual([null, null])
  })

  it('★ 没有分隔行 → 返回 null（只是几个以竖线开头的普通段落）', () => {
    // 用户那篇 One-on-One 笔记里第二行是 `| 1 | --- | --- |`，正是这种情况 ——
    // 不是 bug，是数据问题，渲染层应当原样显示源码。
    expect(parseTable(['| a | b |', '| 1 | --- | --- |'])).toBeNull()
  })

  it('★ 解析对齐冒号（左 / 中 / 右 / 未标注）', () => {
    const data = parseTable([
      '| 左 | 中 | 右 | 默认 |',
      '| :--- | :---: | ---: | --- |',
      '| a | b | c | d |',
    ])!
    expect(data.alignments).toEqual(['left', 'center', 'right', null])
  })

  it('★ 空单元格保留为空串（不是 undefined）', () => {
    const data = parseTable(['|  | b |', '| --- | --- |', '|  |  |'])!
    expect(data.header).toEqual(['', 'b'])
    expect(data.rows).toEqual([['', '']])
  })

  it('★ 行内 Markdown 标记原样保留，不在这一层解析', () => {
    const data = parseTable([
      '| **粗** | `代码` | [[双向链接]] |',
      '| --- | --- | --- |',
      '| *斜* | [链接](http://x) | 普通 |',
    ])!
    expect(data.header).toEqual(['**粗**', '`代码`', '[[双向链接]]'])
    expect(data.rows[0]).toEqual(['*斜*', '[链接](http://x)', '普通'])
  })

  it('只有表头与分隔行时，数据行为空数组', () => {
    const data = parseTable(['| a | b |', '| --- | --- |'])!
    expect(data.rows).toEqual([])
    expect(data.alignments).toEqual([null, null])
  })

  it('行数不足返回 null', () => {
    expect(parseTable([])).toBeNull()
    expect(parseTable(['| a | b |'])).toBeNull()
  })

  it('首尾无竖线的宽松写法也能解析', () => {
    const data = parseTable(['a | b', '--- | ---', '1 | 2'])!
    expect(data.header).toEqual(['a', 'b'])
    expect(data.rows).toEqual([['1', '2']])
  })
})

// --------------------------------------------------------------------------- //
// 选区覆盖判定（为"选中 + Delete 删行/删列"准备）
// --------------------------------------------------------------------------- //

describe('coversTableRow / coversTableColumn', () => {
  const T = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
  // 行长度: 9 / 13 / 9 / 9。表内偏移: 0-8, 10-22, 24-32, 34-42。

  describe('coversTableRow', () => {
    it('★ 选区完整覆盖第二条数据行 → 返回行号 3', () => {
      expect(coversTableRow(T, 34, 42)).toBe(3)
    })

    it('★ 选区完整覆盖第一条数据行 → 返回行号 2', () => {
      expect(coversTableRow(T, 24, 32)).toBe(2)
    })

    it('★ 选区覆盖表头行 → 返回 null（不允许删表头）', () => {
      expect(coversTableRow(T, 0, 8)).toBe(null)
    })

    it('★ 选区覆盖分隔行 → 返回 null（不允许删分隔行）', () => {
      expect(coversTableRow(T, 10, 22)).toBe(null)
    })

    it('★ 空选区 / 单光标 → null（不是"选中"）', () => {
      expect(coversTableRow(T, 24, 24)).toBe(null)
    })

    it('★ 选区超出表格边界 → null', () => {
      // 超出右边界
      expect(coversTableRow(T, 0, 50)).toBe(null)
    })

    it('★ 选区半行 → null（要求严格覆盖整行）', () => {
      expect(coversTableRow(T, 24, 28)).toBe(null) // 从行首到行中间
      expect(coversTableRow(T, 27, 32)).toBe(null) // 从行中间到行末
    })

    it('★ 选区跨两行 → null', () => {
      expect(coversTableRow(T, 24, 42)).toBe(null)
    })

    it('★ 选区起点不在表格内 → null', () => {
      expect(coversTableRow('前文\n' + T, 0, 5)).toBe(null)
    })
  })

  describe('coversTableColumn（行列判定）', () => {
    it('★ 选区起点在表头列 0，终点在最后一行列 0 → 返回 0', () => {
      // 任意 selFrom 落在表头列 0 即可，任意 selTo 落在最后一行列 0
      expect(coversTableColumn(T, 3, 37)).toBe(0) // 'a' 末 → '3' 末
      expect(coversTableColumn(T, 2, 38)).toBe(0) // 格首 → 格末
    })

    it('★ 选区起点在表头列 1，终点在最后一行列 1 → 返回 1', () => {
      expect(coversTableColumn(T, 5, 41)).toBe(1) // 'b' 内 → '4' 末
    })

    it('★ 选区从表头跨到中间数据行（不到最后一行）→ null', () => {
      expect(coversTableColumn(T, 3, 29)).toBe(null) // 'a' → '2'
    })

    it('★ 选区起点不在表头（从数据行到数据行）→ null', () => {
      expect(coversTableColumn(T, 25, 41)).toBe(null) // '1' → '4'
    })

    it('★ 选区跨多列 → null', () => {
      expect(coversTableColumn(T, 3, 41)).toBe(null) // 'a' → '4'（跨列）
    })

    it('★ 唯一列时 → null（不可删）', () => {
      const single = '| x |\n| --- |\n| 1 |'
      expect(coversTableColumn(single, 3, 5)).toBe(null)
    })

    it('★ 选区起点不在表格内 → null', () => {
      expect(coversTableColumn('前文\n' + T, 0, 5)).toBe(null)
    })

    it('★ 选区终点落在 \n 上（行末 \n 归该行）→ 能匹配', () => {
      // T 字符位置：33 是行 2 末尾 \n，34-42 是最后一行 '| 3 | 4 |'
      // 选区到行 2 末尾（selTo=33）→ 没到行 3，列覆盖不完整 → null
      expect(coversTableColumn(T, 3, 33)).toBe(null)
      // 选区到行 3 col 0（selTo=36='3'）→ 匹配
      expect(coversTableColumn(T, 3, 36)).toBe(0)
      // 选区终点在最后一行任意 col 0 位置都应匹配
      expect(coversTableColumn(T, 3, 37)).toBe(0) // '3' 后空格
      expect(coversTableColumn(T, 3, 38)).toBe(0) // '|' 位置
    })

    it('★ 两张不同的表 → null', () => {
      const two = T + '\n\n' + T
      const tableEnd = T.length
      // selFrom 在第一张表，selTo 在第二张表 → 不在同一张表
      expect(coversTableColumn(two, 3, tableEnd + 2)).toBe(null)
    })
  })
})

// --------------------------------------------------------------------------- //
// 就地编辑：setTableCell（点单元格 → 原地打字 → 不降级为源码）
// --------------------------------------------------------------------------- //

describe('setTableCell（单元格就地编辑）', () => {
  const T = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  // 行长度 9 / 13 / 9；表内偏移 0-8, 10-22, 24-32

  it('★ 改一条数据行的单元格 → 只动那一格', () => {
    const r = setTableCell(T, 24, 2, 0, 'X')!
    expect(r.text).toBe('| a | b |\n| --- | --- |\n| X | 2 |')
  })

  it('★ 改表头单元格', () => {
    const r = setTableCell(T, 2, 0, 1, 'B')!
    expect(r.text).toBe('| a | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('★ 改第二列', () => {
    const r = setTableCell(T, 24, 2, 1, 'Y')!
    expect(r.text).toBe('| a | b |\n| --- | --- |\n| 1 | Y |')
  })

  it('★ 置空 → 该格变空串（不是 undefined）', () => {
    const r = setTableCell(T, 24, 2, 0, '')!
    expect(r.text).toBe('| a | b |\n| --- | --- |\n|  | 2 |')
  })

  it('★ 不改其它格、不改行列数、不重排', () => {
    const messy = '| aaa | b |\n| --- | --- |\n| 1 | 2 |'
    const r = setTableCell(messy, 26, 2, 0, 'X')!
    // 刻意对比 formatTable：这里不动宽度，'aaa' 保持原样
    expect(r.text).toBe('| aaa | b |\n| --- | --- |\n| X | 2 |')
  })

  it('★ 值里含 | → 转义为 \\|（不破坏表格结构）', () => {
    const r = setTableCell(T, 24, 2, 0, 'a|b')!
    // JS 字符串里要写 \\| 才表示一个反斜杠 + 竖线
    expect(r.text).toBe('| a | b |\n| --- | --- |\n| a\\|b | 2 |')
    // 关键：转义后这一行不再有"裸"的 | ，表格结构没被拆散
    const row = r.text.split('\n')[2]
    expect(row.startsWith('| ')).toBe(true)
    expect(row.endsWith(' |')).toBe(true)
    expect(isTableRow(row)).toBe(true)
    // ⚠ 已知局限：parseTableRow 目前不还原 \| 转义（它会把 \| 也当分隔符）。
    //   所以含 | 的内容写进去后，读回来会不完整 —— 需要时再单独支持。
    //   这里只保证"不会把整张表拆坏"这个安全底线。
  })

  it('★ 分隔行不可编辑 → null', () => {
    expect(setTableCell(T, 10, 1, 0, 'X')).toBe(null)
  })

  it('★ 行列越界 → null', () => {
    expect(setTableCell(T, 24, 99, 0, 'X')).toBe(null)
    expect(setTableCell(T, 24, 2, 99, 'X')).toBe(null)
    expect(setTableCell(T, 24, -1, 0, 'X')).toBe(null)
  })

  it('★ 光标不在表格内 → null', () => {
    expect(setTableCell('前文', 0, 2, 0, 'X')).toBe(null)
  })

  it('★ caret 落在刚编辑的那一格内', () => {
    const r = setTableCell(T, 24, 2, 0, 'X')!
    const caretLine = r.text.slice(0, r.caret).split('\n').length - 1
    expect(caretLine).toBe(2) // 光标回到第 2 行（那条数据行）
  })
})
