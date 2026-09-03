/**
 * 笔记大纲（TOC）与统计 —— 纯函数，不碰 Dexie、不异步。
 *
 * 刻意与渲染分离：标题解析有一堆边界（代码块内的 # 不算标题、
 * 强调包裹的 #、缩进层级等），纯函数能被单测覆盖；
 * 组件只负责渲染与滚动。
 */

export interface OutlineItem {
  /** 标题层级 1..6 */
  level: number
  /** 去掉 # 标记与首尾空白后的标题文字 */
  text: string
  /** 在文档中的行号（0 基），用于跳转 */
  line: number
}

/** 解析 Markdown 标题，跳过代码块内的伪标题。 */
export function parseOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let inFence = false

  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ``` 或 ~~~ 围栏：围栏内的 # 是代码内容，不是标题
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // ATX 标题：1-6 个 # 后跟空格（#foo 不是标题）。
    // 允许最多 3 个前导空格的缩进 —— Markdown 规范允许，实际写作常见。
    const match = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (!match) continue

    const text = match[2].trim()
    // 只有 # 没有内容的不算标题
    if (text.length === 0) continue

    items.push({ level: match[1].length, text, line: i })
  }

  return items
}

/** 去掉 Markdown 标记，得到用于统计的纯文本。 */
function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整体不计入
    .replace(/`[^`]*`/g, ' ') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题标记
    .replace(/^\s{0,3}>\s?/gm, '') // 引用标记
    .replace(/^\s*[-*+]\s+\[[ x]\]\s*/gm, '') // 任务列表标记
    .replace(/^\s*[-*+]\s+/gm, '') // 无序列表
    .replace(/^\s*\d+\.\s+/gm, '') // 有序列表
    .replace(/[*_~]/g, '') // 强调/删除线
    .replace(/^\s*\|.*\|\s*$/gm, (m) => m.replace(/|/g, ' ')) // 表格竖线
}

/**
 * 统计字数与阅读时长。
 *
 * 中英文混排的处理：中文按字计，英文按词计 —— 直接按字符数算会
 * 严重高估英文内容的阅读时长。
 */
export function countWords(markdown: string): {
  characters: number
  words: number
  /** 预计阅读分钟数，向上取整，最少 1 分钟（有内容时） */
  readingMinutes: number
} {
  const plain = toPlainText(markdown)
  const characters = plain.replace(/\s/g, '').length

  const cjk = plain.match(/[一-龥぀-ヿ]/g)?.length ?? 0
  const latin = plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  const words = cjk + latin

  // 中文约 300 字/分钟，英文约 200 词/分钟，这里取折中 250
  const readingMinutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 250))

  return { characters, words, readingMinutes }
}
