import type { QuickNote } from '@/types'
import { normalizeQuickNoteTag } from '@/lib/quick-notes/quick-note-tags'

export interface QuickNoteTimelineGroup {
  date: string
  label: string
  notes: QuickNote[]
}

export interface QuickNoteTagStat {
  tag: string
  count: number
}

export interface QuickNoteTagTreeNode {
  path: string
  name: string
  count: number
  totalCount: number
  children: QuickNoteTagTreeNode[]
  depth: number
}

export type QuickNoteActivityData = Record<string, number>

export interface QuickNoteExplorerFilters {
  query?: string
  selectedTags?: string[]
  selectedDate?: string | null
}

export function isConvertedQuickNote(note: QuickNote): boolean {
  return note.migrated_to_note_id !== null
}

export function isTrashedQuickNote(note: QuickNote): boolean {
  return note.trashed_at !== null && !isConvertedQuickNote(note)
}

export function isActiveQuickNote(note: QuickNote): boolean {
  return (
    note.trashed_at === null &&
    note.archived_at === null &&
    note.migrated_to_note_id === null
  )
}

export function getQuickNoteTitle(note: QuickNote): string {
  const firstLine = note.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return firstLine?.slice(0, 80) ?? '无标题小记'
}

export function getQuickNoteSummary(note: QuickNote): string {
  return note.content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n')
    .slice(0, 280)
}

export function quickNoteMatchesQuery(note: QuickNote, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  const tagQuery = getQuickNoteTagQuery(query)
  if (tagQuery) {
    return note.tags.some((tag) => normalizeQuickNoteTag(tag) === tagQuery)
  }

  return (
    note.content.toLowerCase().includes(q) ||
    note.tags.some((tag) => tag.toLowerCase().includes(q))
  )
}

export function getQuickNoteTagQuery(query: string): string | null {
  const q = query.trim().toLowerCase()
  if (!q.startsWith('#')) return null

  const tag = normalizeQuickNoteTag(q.slice(1))
  return tag.length > 0 ? tag : null
}

export function getQuickNoteSearchNeedle(query: string): string {
  return getQuickNoteTagQuery(query) ?? query.trim()
}

export function compareQuickNotes(a: QuickNote, b: QuickNote): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1

  const updated = b.updated_at.localeCompare(a.updated_at)
  if (updated !== 0) return updated

  return b.created_at.localeCompare(a.created_at)
}

export function selectActiveQuickNotes(notes: QuickNote[], query = ''): QuickNote[] {
  return [...notes]
    .filter(isActiveQuickNote)
    .filter((note) => quickNoteMatchesQuery(note, query))
    .sort(compareQuickNotes)
}

export function selectQuickNotesForExplorer(
  notes: QuickNote[],
  filters: QuickNoteExplorerFilters = {},
): QuickNote[] {
  const selectedTags = normalizeExplorerTags(filters.selectedTags ?? [])
  const selectedDate = filters.selectedDate ?? null

  return [...notes]
    .filter(isActiveQuickNote)
    .filter((note) => quickNoteMatchesQuery(note, filters.query ?? ''))
    .filter((note) => {
      if (selectedTags.length === 0) return true
      const noteTags = new Set(note.tags.map(normalizeQuickNoteTag))
      return selectedTags.every((tag) => noteTags.has(tag))
    })
    .filter((note) => {
      if (!selectedDate) return true
      return toLocalDateKey(note.created_at) === selectedDate
    })
    .sort(compareQuickNotes)
}

export function selectTrashedQuickNotes(notes: QuickNote[]): QuickNote[] {
  return [...notes]
    .filter(isTrashedQuickNote)
    .sort((a, b) => (b.trashed_at ?? '').localeCompare(a.trashed_at ?? ''))
}

export function getQuickNoteTagStats(notes: QuickNote[]): QuickNoteTagStat[] {
  const counts = new Map<string, number>()

  for (const note of notes) {
    if (!isActiveQuickNote(note)) continue
    const uniqueTags = new Set(note.tags.map(normalizeQuickNoteTag).filter(Boolean))
    for (const tag of uniqueTags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort(compareTagStats)
}

export function buildQuickNoteTagTree(stats: QuickNoteTagStat[]): QuickNoteTagTreeNode[] {
  type MutableTagNode = {
    path: string
    name: string
    count: number
    children: Map<string, MutableTagNode>
  }

  const roots = new Map<string, MutableTagNode>()

  for (const stat of stats) {
    const parts = stat.tag.split('/').map((part) => part.trim()).filter(Boolean)
    if (parts.length === 0) continue

    let siblings = roots
    let path = ''
    let current: MutableTagNode | null = null

    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      current = siblings.get(part) ?? {
        path,
        name: part,
        count: 0,
        children: new Map(),
      }
      siblings.set(part, current)
      siblings = current.children
    }

    if (current) current.count += stat.count
  }

  function toNode(node: MutableTagNode, depth: number): QuickNoteTagTreeNode {
    const children = Array.from(node.children.values())
      .map((child) => toNode(child, depth + 1))
      .sort(compareTagTreeNodes)
    const totalCount = node.count + children.reduce((sum, child) => sum + child.totalCount, 0)

    return {
      path: node.path,
      name: node.name,
      count: node.count,
      totalCount,
      children,
      depth,
    }
  }

  return Array.from(roots.values())
    .map((node) => toNode(node, 0))
    .sort(compareTagTreeNodes)
}

export function getQuickNoteActivityData(notes: QuickNote[]): QuickNoteActivityData {
  const data: QuickNoteActivityData = {}

  for (const note of notes) {
    if (!isActiveQuickNote(note)) continue
    const date = toLocalDateKey(note.created_at)
    data[date] = (data[date] ?? 0) + 1
  }

  return data
}

export function groupQuickNotesByDate(notes: QuickNote[]): QuickNoteTimelineGroup[] {
  const groups = new Map<string, QuickNote[]>()

  for (const note of notes) {
    const date = toLocalDateKey(note.updated_at || note.created_at)
    const group = groups.get(date) ?? []
    group.push(note)
    groups.set(date, group)
  }

  return Array.from(groups.entries()).map(([date, groupNotes]) => ({
    date,
    label: formatDateLabel(date),
    notes: groupNotes,
  }))
}

function toLocalDateKey(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '1970-01-01'

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeExplorerTags(tags: string[]): string[] {
  const normalizedTags: string[] = []
  const seen = new Set<string>()

  for (const tag of tags) {
    const normalizedTag = normalizeQuickNoteTag(tag)
    if (!normalizedTag || seen.has(normalizedTag)) continue
    seen.add(normalizedTag)
    normalizedTags.push(normalizedTag)
  }

  return normalizedTags
}

function compareTagStats(a: QuickNoteTagStat, b: QuickNoteTagStat): number {
  if (a.count !== b.count) return b.count - a.count
  return a.tag.localeCompare(b.tag, 'zh-CN')
}

function compareTagTreeNodes(
  a: Pick<QuickNoteTagTreeNode, 'name' | 'totalCount'>,
  b: Pick<QuickNoteTagTreeNode, 'name' | 'totalCount'>,
): number {
  if (a.totalCount !== b.totalCount) return b.totalCount - a.totalCount
  return a.name.localeCompare(b.name, 'zh-CN')
}

function formatDateLabel(dateKey: string): string {
  const today = toLocalDateKey(new Date().toISOString())
  const yesterday = toLocalDateKey(new Date(Date.now() - 86_400_000).toISOString())

  if (dateKey === today) return '今天'
  if (dateKey === yesterday) return '昨天'

  const [, month, day] = dateKey.split('-')
  if (!month || !day) return dateKey
  return `${Number(month)}月${Number(day)}日`
}
