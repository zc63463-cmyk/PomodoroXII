/**
 * Note links —— 笔记之间的 wiki 链接（`[[标题]]`）解析与索引。
 *
 * ★ 设计前提：链接**不落库、不参与同步**，是从正文派生的。
 *   理由：
 *   1. 正文 `content` 本身就是同步的（方案 A：正文 = .md 文件），
 *      再存一份链接表是冗余，且要改 `response-schema` 的 strictObject，成本高。
 *   2. 与 Obsidian 的做法一致——从 .md 文件运行时扫描，链接不是独立数据。
 *   3. 没有新增 Dexie 表，因此**不需要升 Dexie 版本**（本项目升版被 v18 原生
 *      DDL 切换绑定，风险高，能避则避）。
 *
 * ★ 语法（与 Obsidian 对齐，已成事实标准）
 *   [[标题]]              → 链接到该标题的笔记
 *   [[标题|显示文字]]      → 自定义显示文字
 *   [[标题#章节]]         → 链接到笔记内某个章节
 *
 * ★ 已知局限：当前是全文本正则替换，代码块 / 行内代码里的 `[[...]]` 也会被转换。
 *   要精确处理需换成 remark 插件（在 AST 层只处理 text 节点）。
 *   在个人笔记量级下影响很小，先记录在此，等真正被抱怨时再换实现。
 */

import type { Note } from '@/types'

/** 可链接的实体类型。笔记默认类型，任务与日程需显式前缀。 */
export type WikiLinkType = 'note' | 'task' | 'schedule'

/** 链接里的类型前缀，如 `[[task:修复登录]]`。 */
const TYPE_PREFIX: Record<Exclude<WikiLinkType, 'note'>, string> = {
  task: 'task:',
  schedule: 'schedule:',
}

/**
 * 把「类型 + 标题」还原成链接里的 target 写法。
 * 笔记类型不带前缀，保持 `[[标题]]` 的简洁形态。
 */
export function linkTargetOf(type: WikiLinkType, title: string): string {
  return type === 'note' ? title : `${TYPE_PREFIX[type]}${title}`
}

/** 解析出的一条 wiki 链接。 */
export interface WikiLink {
  /** 链接目标的类型 */
  type: WikiLinkType
  /** 链接目标（标题），不含类型前缀与 # 部分，已 trim */
  target: string
  /** 显示文字（| 后的部分；缺省为带前缀的原始 target，便于用户看出链的是什么） */
  label: string
  /** # 后的章节（无则为空串） */
  section: string
  /** 原始文本，如 `[[task:修复登录|登录问题]]` */
  raw: string
}

/**
 * 匹配 wiki 链接。三段依次为：标题 / 章节 / 别名，后两段可选。
 * 标题与别名里都不允许出现 `[` `]` `|` `#`，避免贪婪匹配把两条链接连成一条。
 */
const WIKI_LINK_PATTERN = /\[\[([^[\]|#]+)(?:#([^[\]|]*))?(?:\|([^[\]]*))?\]\]/g

/** 生成给渲染器用的伪协议 href。用自定义 scheme，便于 MarkdownLink 识别。 */
export const WIKI_HREF_PREFIX = 'note:'
export const MISSING_HREF_PREFIX = 'note-missing:'

/** 一个可被 `[[ ]]` 引用的实体。 */
export interface LinkableEntity {
  type: WikiLinkType
  id: string
  title: string
}

/** 索引键：类型 + 折叠后的标题，保证笔记/任务/日程之间不会互相撞名。 */
export function entityKey(type: WikiLinkType, title: string): string {
  return `${type}:${titleKey(title)}`
}

export function parseWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = []
  for (const match of content.matchAll(WIKI_LINK_PATTERN)) {
    const [raw, rawTarget, rawSection, rawLabel] = match
    const targetWithType = (rawTarget ?? '').trim()
    if (targetWithType === '') continue // [[]] 或 [[ ]] 不是有效链接

    // 解析类型前缀。只有 task: / schedule: 会被识别，其余一律按笔记处理 ——
    // 这样"标题里恰好含冒号"的笔记不会被误判成别的东西。
    let type: WikiLinkType = 'note'
    let target = targetWithType
    for (const [candidate, prefix] of Object.entries(TYPE_PREFIX)) {
      if (targetWithType.startsWith(prefix)) {
        type = candidate as WikiLinkType
        target = targetWithType.slice(prefix.length).trim()
        break
      }
    }
    if (target === '') continue

    // 默认显示文字保留类型前缀，让用户一眼看出链的是笔记还是任务/日程
    const label = (rawLabel ?? '').trim() || targetWithType
    links.push({
      type,
      target,
      label,
      section: (rawSection ?? '').trim(),
      raw,
    })
  }
  return links
}

/** 把标题折叠成比较用的键：忽略大小写与首尾空白，让 `[[Foo]]` 与 `[[foo]]` 等价。 */
export function titleKey(title: string): string {
  return title.trim().toLowerCase()
}

/**
 * 由一组笔记构建「标题 → 笔记 id」的索引。
 *
 * 标题冲突时以**先出现者为准**（不静默丢后者，但也不制造歧义链接）。
 * 空标题不参与索引 —— 否则 `[[无标题小记]]` 会误链到所有空标题笔记。
 */
export function buildTitleIndex(notes: readonly Note[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const note of notes) {
    if (note.trashed_at !== null) continue
    const key = titleKey(note.title)
    if (key === '' || index.has(key)) continue
    index.set(key, note.id)
  }
  return index
}

/**
 * 把正文里的 `[[标题]]` 渲染成标准 Markdown 链接，交给现有渲染器处理。
 *
 * 只渲染**笔记**链接 —— 这是本函数既有且被依赖的行为，保持不变。
 * 任务与日程请用 `renderEntityLinks`：它们需要把类型带进 href，渲染器才知道该往哪跳。
 *
 * - 目标存在 → `[label](note:<id>)`，点击后跳转
 * - 目标不存在 → `[label](note-missing:<target>)`，渲染为"未创建"样式；
 *   Obsidian 的行为是"点击即创建"，我们保留这个可能，但当前只做视觉区分。
 */
export function renderWikiLinks(
  content: string,
  resolve: (target: string) => string | null,
): string {
  return content.replace(WIKI_LINK_PATTERN, (raw, rawTarget: string, rawSection: string | undefined, rawLabel: string | undefined) => {
    const target = (rawTarget ?? '').trim()
    if (target === '') return raw

    const label = (rawLabel ?? '').trim() || target
    const noteId = resolve(target)
    if (noteId === null) {
      return `[${label}](${MISSING_HREF_PREFIX}${encodeURIComponent(target)})`
    }
    const section = (rawSection ?? '').trim()
    const anchor = section === '' ? '' : `#${encodeURIComponent(section)}`
    return `[${label}](${WIKI_HREF_PREFIX}${noteId}${anchor})`
  })
}

/** 各类型在渲染结果里的 href 前缀。渲染器据此决定跳转目标。 */
export const HREF_PREFIX: Record<WikiLinkType, string> = {
  note: WIKI_HREF_PREFIX,
  task: 'task:',
  schedule: 'schedule:',
}

/** 各类型"目标不存在"时的 href 前缀。 */
export const MISSING_PREFIX: Record<WikiLinkType, string> = {
  note: MISSING_HREF_PREFIX,
  task: 'task-missing:',
  schedule: 'schedule-missing:',
}

export type EntityResolver = (type: WikiLinkType, target: string) => string | null

/**
 * 渲染**含任务与日程**的链接：把类型编进 href，渲染器才能决定跳去哪。
 *
 * ★ 为什么类型必须进 href：正文里 `[[task:修复登录]]` 与 `[[修复登录]]` 可能同时存在，
 *   只靠 id 无法区分该跳 /notes 还是 /tasks。
 *
 * 目标不存在时按类型给不同的 missing 前缀 —— 笔记"点击即创建"有意义，
 * 但任务/日程不该由一段正文顺手造出来，所以只做视觉区分。
 */
export function renderEntityLinks(content: string, resolve: EntityResolver): string {
  return content.replace(
    WIKI_LINK_PATTERN,
    (raw, rawTarget: string, rawSection: string | undefined, rawLabel: string | undefined) => {
      const parsed = parseWikiLinks(raw)[0]
      if (!parsed) return raw

      const label = (rawLabel ?? '').trim() || parsed.label
      const id = resolve(parsed.type, parsed.target)
      if (id === null) {
        const target = linkTargetOf(parsed.type, parsed.target)
        return `[${label}](${MISSING_PREFIX[parsed.type]}${encodeURIComponent(target)})`
      }
      const section = (rawSection ?? '').trim()
      const anchor = section === '' ? '' : `#${encodeURIComponent(section)}`
      return `[${label}](${HREF_PREFIX[parsed.type]}${id}${anchor})`
    },
  )
}

/**
 * 为编辑器补全挑选候选标题。
 *
 * 排序刻意分两级：**前缀匹配优先于包含匹配**。
 * 输入 "深度" 时，"深度工作" 应排在 "关于深度的思考" 前面——
 * 用户敲 `[[` 时心里想的是标题开头。
 *
 * 同组内再按长度升序（短的更可能是目标），最后按字典序保证结果稳定。
 */
export function matchNoteTitles(
  prefix: string,
  titles: readonly string[],
  limit = 20,
): string[] {
  // 先统一清理：丢弃空标题、按折叠键去重（保留最先出现的写法）。
  // 放在入口而不是各分支里，避免"空前缀"这条路径漏掉同样的规则。
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const title of titles) {
    const key = titleKey(title)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    cleaned.push(title)
  }

  const needle = titleKey(prefix)
  if (needle === '') {
    return [...cleaned].sort(byLengthThenAlpha).slice(0, limit)
  }

  const starts: string[] = []
  const contains: string[] = []

  for (const title of cleaned) {
    const key = titleKey(title)
    if (key.startsWith(needle)) starts.push(title)
    else if (key.includes(needle)) contains.push(title)
  }

  starts.sort(byLengthThenAlpha)
  contains.sort(byLengthThenAlpha)
  return [...starts, ...contains].slice(0, limit)
}

function byLengthThenAlpha(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b)
}

/**
 * 补全插入的内容：标题本身，外加闭合的 `]]`。
 *
 * ★ 关键细节：若光标后面**已经**有 `]]`（很多人习惯先打完整对括号再回头填），
 *   就只补标题，不重复补 `]]`。这个细节不处理的话，补全后会得到
 *   `[[标题]]]]` 这种明显的破窗，用户会立刻对补全失去信任。
 */
export function applyWikiLinkInsertion(title: string, followingText: string): string {
  return followingText.startsWith(']]') ? title : `${title}]]`
}

/** 反向链接条目：谁引用了它、以及引用处的上下文。 */
export interface BacklinkEntry {
  /** 引用方（来源笔记） */
  sourceId: string
  sourceTitle: string
  /** 引用所在的原始文本，如 `[[目标|别名]]` */
  raw: string
  /** 引用所在的那一整行（去掉链接原文后用于展示上下文） */
  context: string
}

/**
 * 构建反向链接索引：目标笔记 id → 谁引用了它。
 *
 * ★ 匹配用「标题」而不是 id —— 这是刻意的：
 *   链接写在正文里，人写的是标题。用标题匹配，用户改标题时的行为才是可预期的
 *   （改标题 = 改链接的语义目标），而 id 对用户是不可见的。
 */
export function buildBacklinkIndex(
  notes: readonly Note[],
): Map<string, BacklinkEntry[]> {
  const titleIndex = buildTitleIndex(notes)
  const backlinks = new Map<string, BacklinkEntry[]>()

  for (const note of notes) {
    if (note.trashed_at !== null) continue
    for (const link of parseWikiLinks(note.content)) {
      const targetId = titleIndex.get(titleKey(link.target))
      if (targetId === undefined) continue // 目标不存在，不构成有效链接
      const entry: BacklinkEntry = {
        sourceId: note.id,
        sourceTitle: note.title,
        raw: link.raw,
        context: contextLineOf(note.content, link.raw),
      }
      const existing = backlinks.get(targetId)
      if (existing) existing.push(entry)
      else backlinks.set(targetId, [entry])
    }
  }

  return backlinks
}

/** 取链接所在的那一整行，作为反向链接面板里的上下文。 */
function contextLineOf(content: string, raw: string): string {
  const index = content.indexOf(raw)
  if (index === -1) return ''
  const start = content.lastIndexOf('\n', index) + 1
  const endOfLine = content.indexOf('\n', index)
  const end = endOfLine === -1 ? content.length : endOfLine
  return content.slice(start, end).trim()
}

/**
 * 重命名笔记时，返回「正文中引用了旧标题、需要改写」的笔记 id 列表。
 *
 * ★ 这是链接系统的隐藏前提：重命名必须带动引用一起改，否则链接会烂，
 *   用户会失去链接的信心（Obsidian 的自动更新引用是它的核心承诺之一）。
 */
export function findNotesReferencing(
  notes: readonly Note[],
  oldTitle: string,
  excludeId?: string,
): Note[] {
  const oldKey = titleKey(oldTitle)
  if (oldKey === '') return []
  return notes.filter(
    (note) =>
      note.id !== excludeId &&
      note.trashed_at === null &&
      parseWikiLinks(note.content).some((link) => titleKey(link.target) === oldKey),
  )
}

/**
 * 把某条笔记正文里对 `oldTitle` 的引用改写成 `newTitle`，返回新正文。
 *
 * 只改链接的**目标部分**，保留 `|别名` 与 `#章节` 不动 —— 用户改的是"指向哪篇"，
 * 不是"显示成什么"。
 */
export function rewriteLinksInContent(
  content: string,
  oldTitle: string,
  newTitle: string,
): string {
  const oldKey = titleKey(oldTitle)
  if (oldKey === '') return content

  return content.replace(WIKI_LINK_PATTERN, (raw, rawTarget: string, rawSection: string | undefined, rawLabel: string | undefined) => {
    const target = (rawTarget ?? '').trim()
    if (titleKey(target) !== oldKey) return raw
    const section = rawSection === undefined ? '' : `#${rawSection}`
    const label = rawLabel === undefined ? '' : `|${rawLabel}`
    return `[[${newTitle}${section}${label}]]`
  })
}
