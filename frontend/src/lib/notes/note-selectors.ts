/**
 * Note selectors —— 笔记列表的纯函数筛选/排序/摘要。
 *
 * 刻意保持纯函数（不碰 Dexie、不异步）：列表渲染、搜索结果预览、
 * 文件夹树分组都靠它，单测成本极低。
 *
 * 职责边界：**本地可见字段**的匹配。正文全文检索走 `note-api.searchNotes`
 * （服务端 FTS5），这里只做标题 / 摘要 / 标签 / 正文前缀的即时过滤。
 */

import type { Note } from '@/types'

export interface NoteFilters {
  /** 关键字：匹配标题、摘要、标签。 */
  query?: string
  folderId?: string | null
  category?: string | null
  status?: Note['status']
}

export interface NoteGroup {
  folderId: string | null
  notes: Note[]
}

export function isTrashedNote(note: Note): boolean {
  return note.trashed_at != null
}

export function isActiveNote(note: Note): boolean {
  return note.trashed_at == null && note.status === 'active'
}

/** 空标题的显示兜底：取正文首行，避免列表里出现一片空白项。 */
export function getNoteTitle(note: Note): string {
  const title = note.title.trim()
  if (title) return title

  const firstLine = note.content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return firstLine ? firstLine.slice(0, 80) : '(无标题)'
}

/** 摘要兜底：没有 summary 时截取正文开头。 */
export function getNoteSummary(note: Note, maxLength = 120): string {
  const summary = note.summary.trim()
  if (summary) return summary.slice(0, maxLength)

  const plain = note.content.replace(/\s+/g, ' ').trim()
  if (!plain) return ''
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain
}

/** 本地关键字匹配。大小写不敏感，纯前端即时过滤用。 */
export function noteMatchesQuery(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  if (getNoteTitle(note).toLowerCase().includes(q)) return true
  if (note.summary.toLowerCase().includes(q)) return true
  return note.tags.some((tag) => tag.toLowerCase().includes(q))
}

/**
 * 命中位置周边的正文片段。
 * 与服务端 `excerpt` 对齐的本地版本——离线时服务端搜不了，仍要给出可读预览。
 */
export function getNoteSearchSnippet(
  note: Note,
  query: string,
  radius = 40,
): string {
  const q = query.trim()
  if (!q) return getNoteSummary(note)

  const index = note.content.toLowerCase().indexOf(q.toLowerCase())
  if (index < 0) return getNoteSummary(note)

  const start = Math.max(0, index - radius)
  const end = Math.min(note.content.length, index + q.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < note.content.length ? '…' : ''
  return `${prefix}${note.content.slice(start, end).replace(/\s+/g, ' ')}${suffix}`
}

export function sortNotesByUpdatedDesc(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

/** 综合筛选：关键字 + 文件夹 + 分类 + 状态，结果按更新时间倒序。 */
export function filterNotes(
  notes: readonly Note[],
  filters: NoteFilters = {},
): Note[] {
  const matched = notes.filter((note) => {
    if (filters.status && note.status !== filters.status) return false
    // folderId 显式传 null 表示"只取根目录笔记"，未传表示不限
    if (filters.folderId !== undefined && note.folder_id !== filters.folderId) {
      return false
    }
    if (filters.category != null && note.category !== filters.category) return false
    if (filters.query && !noteMatchesQuery(note, filters.query)) return false
    return true
  })
  return sortNotesByUpdatedDesc(matched)
}

/** 按文件夹分组，未归类的（folder_id 为 null）排在最后。 */
export function groupNotesByFolder(notes: readonly Note[]): NoteGroup[] {
  const buckets = new Map<string | null, Note[]>()
  for (const note of notes) {
    const bucket = buckets.get(note.folder_id)
    if (bucket) bucket.push(note)
    else buckets.set(note.folder_id, [note])
  }

  const sorted = [...buckets.entries()].sort(([a], [b]) => {
    if (a === null) return 1
    if (b === null) return -1
    return a.localeCompare(b)
  })

  return sorted.map(([folderId, group]) => ({
    folderId,
    notes: sortNotesByUpdatedDesc(group),
  }))
}

/** 汇总全部标签及出现次数，按出现次数倒序、同次数按名称正序。 */
export function collectNoteTags(
  notes: readonly Note[],
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const note of notes) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))
}

/** 列表排序方式。 */
export type NoteSortKey = 'updated' | 'title'

/**
 * 排序笔记列表。
 *
 * - 'updated'：按更新时间倒序（最近编辑的在前）—— 与仓储默认一致
 * - 'title'：按标题升序，用 localeCompare 以支持中文排序规则；
 *   用 getNoteTitle 取标题，保证空标题有一致的兜底（"未命名"），
 *   否则空标题会被排到最前且显示不一致。
 */
export function sortNotes(
  notes: readonly Note[],
  by: NoteSortKey = 'updated',
): Note[] {
  if (by === 'title') {
    return [...notes].sort((a, b) => {
      // ★ 无标题的沉底。
      //   兜底显示名是「(无标题)」，以半角括号开头（ASCII 40 < 'A'），
      //   若直接 localeCompare 会排到最前 —— 用户新建的空标题笔记
      //   会一直占据列表首位，很碍事。它们是「未完成的」，理应沉底。
      const aUntitled = a.title.trim().length === 0
      const bUntitled = b.title.trim().length === 0
      if (aUntitled !== bUntitled) return aUntitled ? 1 : -1

      return getNoteTitle(a).localeCompare(getNoteTitle(b), 'zh-Hans-CN')
    })
  }
  return sortNotesByUpdatedDesc(notes)
}
