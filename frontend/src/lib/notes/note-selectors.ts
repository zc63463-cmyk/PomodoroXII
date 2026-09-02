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
