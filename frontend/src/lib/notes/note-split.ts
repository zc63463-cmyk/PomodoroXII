/**
 * Note split —— 把选中的一段正文拆成独立笔记（Obsidian 的 Note Refactor 思路）。
 *
 * ★ 为什么需要它：原子化的判定标准是「能不能用一句话概括这篇笔记」。
 *   一篇笔记一旦讲了两件事，它就没法被一句话概括，也就没法被可靠地链接。
 *   拆分是**把长笔记变原子**的关键工具 —— 没有它，用户只能在
 *   「新建笔记 + 手动剪切 + 手动打链接」之间来回折腾，实际不会去做。
 *
 * ★ 拆分后原文**必须自动留下链接**，否则原笔记就少了一段，
 *   而读者看不出它去哪了。链接是这次拆分的唯一痕迹。
 *
 * 纯函数：不碰 Dexie、不碰 CodeMirror。选区偏移由调用方给，
 * 这样拆分逻辑可以脱离编辑器被完整测试。
 */

/** 拆分方案：新笔记的标题/正文，以及原笔记拆分后的正文。 */
export interface NoteSplitPlan {
  /** 新笔记标题（由选中内容首行推导） */
  title: string
  /** 新笔记正文（选中的原文，原样保留） */
  newContent: string
  /** 原笔记拆分后的正文（选中部分已被替换为 `[[标题]]`） */
  sourceContent: string
}

/** 标题里会破坏 wiki 链接语法的字符，一律剔除。 */
const ILLEGAL_TITLE_CHARS = /[[\]|#]/g

/** 标题最大长度。超长标题在列表里显示不全，也失去了「像 API 方法名」的意义。 */
const MAX_TITLE_LENGTH = 50

/**
 * 剔除会破坏 `[[...]]` 语法的字符。
 *
 * `[` `]` 会让链接提前闭合，`|` 后面会变成显示文字，`#` 后面会变成章节定位 ——
 * 三个都会让链接指向一个错误的、不存在的目标。宁可改标题也不能让链接坏掉。
 */
export function sanitizeLinkTitle(title: string): string {
  return title.replace(ILLEGAL_TITLE_CHARS, '').trim()
}

/**
 * 从选中内容推导新笔记标题。
 *
 * 取**第一个非空行**（而不是死板的第一行）：选中时经常带上前导空行，
 * 取第一行会得到空标题。
 */
export function deriveSplitTitle(selection: string): string {
  const firstLine =
    selection
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''

  if (!firstLine) return '未命名'

  // 标题行常见形态：`## 小节`、`**粗体**`、`` `行内代码` ``
  const stripped = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+(\[[ x]\]\s*)?/, '')
    .replace(/^>\s*/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()

  const title = sanitizeLinkTitle(stripped || firstLine)
  if (!title) return '未命名'
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title
}

/** 连续 3 个以上换行压成 2 个 —— 拆分后段落之间不该留下大片空白。 */
function squeezeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

/**
 * 生成拆分方案。无法拆分时返回 null（由调用方决定提示文案）。
 *
 * @param content 原笔记正文
 * @param from 选区起始偏移（含）
 * @param to 选区结束偏移（不含）
 */
export function planNoteSplit(
  content: string,
  from: number,
  to: number,
): NoteSplitPlan | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < from || to > content.length) return null
  if (from === to) return null

  const selected = content.slice(from, to)
  if (selected.trim().length === 0) return null

  // 首尾空白不参与搬运 —— 否则新笔记正文前后会挂一串空行，
  // 而原文里的链接位置也会跟着错位。
  const lead = selected.length - selected.trimStart().length
  const tail = selected.length - selected.trimEnd().length
  const body = content.slice(from + lead, to - tail)

  const title = deriveSplitTitle(body)
  const sourceContent = squeezeBlankLines(
    content.slice(0, from) + `[[${title}]]` + content.slice(to),
  )

  return { title, newContent: body, sourceContent }
}

/**
 * 是否为「值得拆分」的选区。
 *
 * 整篇选中没有意义（拆完原笔记只剩一个链接，等于重命名），
 * 这种情况前端应直接禁用按钮，而不是拆完再报错。
 */
export function isSplittableRange(content: string, from: number, to: number): boolean {
  if (from >= to || to > content.length) return false
  const selected = content.slice(from, to)
  if (selected.trim().length === 0) return false
  // 选区就是整篇（忽略首尾空白）→ 拆完原笔记只剩一个链接，等于重命名，没有意义
  return selected.trim() !== content.trim()
}
