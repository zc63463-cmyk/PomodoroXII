/**
 * 笔记标签 —— 从正文的 #hashtag 提取，与结构化 tags 字段同步。
 *
 * 刻意与 quick-notes 的标签规则保持一致（同款正则、同款规范化），
 * 让用户在速记与笔记里的手感一致。实现上不直接 import
 * quick-note-tags，避免 notes 域依赖 quick-notes 域 ——
 * 标签提取是通用 Markdown 逻辑，不属于任何一个域。
 * 若日后抽到共用位置，两边的规则已对齐，合并无成本。
 *
 * 为什么选「正文行内 #tag」而不是独立标签输入框
 *   方案 A 的核心价值是「.md 能被 Obsidian 直接打开编辑」。
 *   标签写在正文里，用户用任何工具编辑都能带上标签；
 *   若存在独立的 tags 字段而正文没有，用 Obsidian 编辑就会丢标签。
 */

/** 与 quick-notes 一致：支持 Unicode、数字、下划线、连字符与 / 层级。 */
const TAG_PATTERN = /#[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*/gu

/** 去 # 前缀、转小写、去空白。 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').toLowerCase()
}

/** 规范化并去重，保持原有顺序。 */
export function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const tag of tags) {
    const value = normalizeTag(tag)
    if (!value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }

  return normalized
}

/** 从正文提取 #hashtag（返回已规范化、去重）。 */
export function extractTags(content: string): string[] {
  return normalizeTags(content.match(TAG_PATTERN) ?? [])
}

/**
 * 合并正文标签与已存储的标签。
 *
 * 取并集而非直接用正文替换 —— 已存的 tags 可能来自服务端或其它端，
 * 若正文里暂时删掉了某个 #tag 就直接抹掉，会造成意外的标签丢失。
 * （要真正删除标签，应通过明确的交互，而不是从正文里删字。）
 */
export function mergeTags(
  storedTags: readonly string[] | undefined,
  content: string,
): string[] {
  return normalizeTags([...(storedTags ?? []), ...extractTags(content)])
}

/** 两个标签数组是否相同（顺序无关，因为存储时已规范化排序无关）。 */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = normalizeTags(a)
  const right = normalizeTags(b)
  return left.every((tag, index) => tag === right[index])
}
