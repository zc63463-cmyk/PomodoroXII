/**
 * Note summary —— 顶部的「一句话摘要」。
 *
 * ★ 为什么摘要写在正文里、而不是只存 `note.summary` 字段
 *   方案 A 的前提是「正文就是 .md 文件，用 Obsidian 打开也不丢」。
 *   摘要若只存数据库字段，用户在 Obsidian 里看到的正文就没有它 ——
 *   而摘要恰恰是给「未来的自己 / 别人快速扫一眼」用的，藏在字段里就失去了意义。
 *
 *   所以：**正文顶部的引用块是真相源**，`note.summary` 字段只是它的派生投影
 *   （供列表显示用，见 `note-selectors.getNoteSummary`）。
 *
 * ★ 为什么用 blockquote 而不是 YAML frontmatter
 *   - frontmatter 在 Obsidian 里默认折叠、阅读视图中也常被隐藏，不够显眼
 *   - `> 摘要：xxx` 是 Markdown 原生语法，不引入自定义约定，任何渲染器都认
 */

/** 摘要块前缀。中英文冒号都接受，用户输入时不该被标点卡住。 */
const SUMMARY_LINE = /^\s*>\s*摘要\s*[：:]\s*(.*)$/

/** 只在正文开头若干行内寻找摘要 —— 正文中间的引用不该被误判成摘要。 */
const SUMMARY_SCAN_LINES = 5

/**
 * 从正文顶部解析摘要。没有则返回 null。
 *
 * 只取第一行匹配到的：摘要是一句话，不该跨多行。
 */
export function detectSummary(content: string): string | null {
  const lines = content.split('\n').slice(0, SUMMARY_SCAN_LINES)
  for (const line of lines) {
    const match = SUMMARY_LINE.exec(line)
    if (match) {
      const text = match[1].trim()
      return text.length > 0 ? text : null
    }
  }
  return null
}

/** 是否已填写摘要（有摘要块且内容非空）。 */
export function hasSummary(content: string): boolean {
  return detectSummary(content) != null
}

/**
 * 是否该提示用户补摘要。
 *
 * ★ 为什么是「轻提示」而不是强制校验
 *   规范要能被执行才有效。强制校验会让用户为了通过校验而写废话，
 *   那比没有摘要更糟（它看起来像摘要，实际没有信息量）。
 *
 * @param thresholdChars 正文超过这么多字符仍未填摘要才提示 ——
 *   刚开的新笔记不该一上来就催。
 */
export function shouldPromptSummary(content: string, thresholdChars = 200): boolean {
  if (hasSummary(content)) return false
  return content.replace(/\s/g, '').length >= thresholdChars
}

/** 新建笔记的正文模板：只带一个待填的摘要块，不塞更多东西。 */
export function buildNoteTemplate(): string {
  return '> 摘要：\n\n'
}

/**
 * 写入（或替换）摘要块。
 *
 * 已有摘要块 → 就地替换，不动正文其余部分；
 * 没有 → 插到正文开头，并与后面的内容隔开一个空行。
 */
export function withSummary(content: string, summary: string): string {
  const line = `> 摘要：${summary.trim()}`
  const lines = content.split('\n')

  const index = lines
    .slice(0, SUMMARY_SCAN_LINES)
    .findIndex((l) => SUMMARY_LINE.test(l))

  if (index >= 0) {
    const next = [...lines]
    next[index] = line
    return next.join('\n')
  }

  const body = content.replace(/^\s+/, '')
  return body.length > 0 ? `${line}\n\n${body}` : `${line}\n`
}
