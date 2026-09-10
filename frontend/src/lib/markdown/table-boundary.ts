/**
 * Markdown 表格边界修正。
 *
 * ★ 为什么需要它
 *   remark-gfm 的表格行是**贪婪匹配**的：表格后面如果没有空行，
 *   紧随其后的那一行会被当成表格的数据行吞掉。
 *
 *   实测（表格后紧跟「下文」）：
 *   ```html
 *   <table>…<td>内容</td>…
 *     <tr><td>下文</td><td></td><td></td></tr>   ← 被吞进表格
 *   </table>
 *   ```
 *   而外层本该有的 `<p>下文</p>` 也消失了。
 *
 *   这是用户最常撞到的表格问题：写完表格直接换行接着写，
 *   结果后面整段都进了表格。
 *
 * ★ 只在渲染时修正，不改存储
 *   正文就是 .md 文件（方案 A 的前提），不能为了渲染器去改用户的内容。
 *   这个函数在渲染前跑一遍，输出只喂给渲染器。
 */

// 表格语法判定统一取自共享模块 —— 与表格编辑命令必须是同一套规则，
// 否则会出现"命令认为光标在表格里、渲染器却不当它是表格"的不一致。
import { isCodeFence, isTableDelimiter, isTableRow } from './table-syntax'

/**
 * 在每个表格块后面补一个空行（若原本就有空行或已到文末则不动）。
 *
 * 代码围栏内的内容一律跳过 —— 围栏里出现 `|` 很常见（ASCII 表格、正则、
 * 命令行输出），误判会凭空插入空行。
 */
export function ensureBlankLineAfterTables(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inFence = false
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 围栏状态优先：进出围栏都要先记账，且围栏内原样输出
    if (isCodeFence(line)) {
      inFence = !inFence
      out.push(line)
      i += 1
      continue
    }
    if (inFence) {
      out.push(line)
      i += 1
      continue
    }

    // 表格块的起点：表头行 + 紧跟分隔行
    const isTableStart =
      isTableRow(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1])

    if (!isTableStart) {
      out.push(line)
      i += 1
      continue
    }

    // 吞掉整个表格块（表头 + 分隔行 + 后续所有内容行）
    out.push(line)
    out.push(lines[i + 1])
    let j = i + 2
    while (j < lines.length && isTableRow(lines[j])) {
      out.push(lines[j])
      j += 1
    }

    // ★ 表格结束了：下一行若还有内容且不是空行，插一个空行把它挡在外面
    if (j < lines.length && lines[j].trim() !== '') out.push('')

    i = j
  }

  return out.join('\n')
}
