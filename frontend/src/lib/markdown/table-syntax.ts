/**
 * Markdown 表格语法的**唯一**定义。
 *
 * ★ 为什么单独抽出来
 *   表格的语法判定被两处使用，而且必须是同一套规则：
 *   - `table-boundary.ts`：渲染前给表格补空行（修正 remark-gfm 的贪婪吞行）
 *   - `lib/notes/note-tables.ts`：表格编辑命令（增删行列、对齐、Tab 跳格）
 *
 *   两边各写一份的话，改了一处忘另一处就会出现
 *   "命令认为光标在表格里、渲染器却不当它是表格"这类不一致。
 */

/** GFM 分隔行，如 `| --- | :---: | ---: |`（也允许不带首尾竖线）。 */
export const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** 表格行：以竖线开头（允许前导空格）。 */
export const TABLE_ROW = /^\s*\|/

/** 代码围栏。围栏内的 `|` 是代码，不是表格。 */
export const TABLE_FENCE = /^\s*(```|~~~)/

export function isTableDelimiter(line: string): boolean {
  return TABLE_DELIMITER.test(line)
}

export function isTableRow(line: string): boolean {
  return TABLE_ROW.test(line)
}

export function isCodeFence(line: string): boolean {
  return TABLE_FENCE.test(line)
}
