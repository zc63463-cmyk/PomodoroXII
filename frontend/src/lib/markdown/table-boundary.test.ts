import { describe, expect, it } from 'vitest'
import { ensureBlankLineAfterTables } from './table-boundary'

const T = ['| 列 1 | 列 2 |', '| --- | --- |', '| a | b |'].join('\n')

describe('ensureBlankLineAfterTables', () => {
  it('★ 表格后面紧跟正文时补空行（remark-gfm 会把正文吞进表格）', () => {
    expect(ensureBlankLineAfterTables(`上文\n\n${T}\n下文`)).toBe(
      `上文\n\n${T}\n\n下文`,
    )
  })

  it('★ 多个表格依次出现都能补上', () => {
    const input = `${T}\n第一段后文\n\n${T}\n第二段后文`
    const out = ensureBlankLineAfterTables(input)
    expect(out).toBe(`${T}\n\n第一段后文\n\n${T}\n\n第二段后文`)
  })

  it('原本就有空行时不重复插入', () => {
    const input = `${T}\n\n下文`
    expect(ensureBlankLineAfterTables(input)).toBe(input)
  })

  it('表格就是最后一行时不追加空行', () => {
    const input = `上文\n\n${T}`
    expect(ensureBlankLineAfterTables(input)).toBe(input)
  })

  it('表格后面还是表格行时不插（属于同一张表）', () => {
    const input = ['| A |', '| --- |', '| 1 |', '| 2 |'].join('\n')
    expect(ensureBlankLineAfterTables(input)).toBe(input)
  })

  it('★ 代码围栏内的表格不被处理', () => {
    const input = ['```', T, '下一行代码', '```'].join('\n')
    expect(ensureBlankLineAfterTables(input)).toBe(input)
  })

  it('★ 围栏外的表格仍能正常处理（围栏状态会正确复原）', () => {
    const input = ['```', '| 代码里的一行 |', '```', '', T, '后文'].join('\n')
    const out = ensureBlankLineAfterTables(input)
    expect(out).toBe(['```', '| 代码里的一行 |', '```', '', T, '', '后文'].join('\n'))
  })

  it('非表格内容原样返回', () => {
    const input = '普通段落\n\n另一段'
    expect(ensureBlankLineAfterTables(input)).toBe(input)
  })

  it('孤立的分隔行（前面没有表头）不算表格', () => {
    const input = '| --- |\n后文'
    expect(ensureBlankLineAfterTables(input)).toBe(input)
  })

  it('分隔行带对齐冒号的表格', () => {
    const t = ['| 左 | 右 |', '| :--- | ---: |', '| a | b |'].join('\n')
    expect(ensureBlankLineAfterTables(`${t}\n后文`)).toBe(`${t}\n\n后文`)
  })

  it('分隔行不带首尾竖线的表格', () => {
    const t = ['列 1 | 列 2', '--- | ---', 'a | b'].join('\n')
    // 首行不以 | 开头，按 GFM 不是表格 —— 不应插入空行
    expect(ensureBlankLineAfterTables(`${t}\n后文`)).toBe(`${t}\n后文`)
  })

  it('幂等：处理两次结果不变', () => {
    const once = ensureBlankLineAfterTables(`${T}\n后文`)
    expect(ensureBlankLineAfterTables(once)).toBe(once)
  })
})
