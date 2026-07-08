import type { QuickNote } from '@/types'
import { normalizeQuickNoteTag } from '@/lib/quick-notes/quick-note-tags'

export interface QuickNoteTimelineGroup {
  date: string
  label: string
  notes: QuickNote[]
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

export function selectTrashedQuickNotes(notes: QuickNote[]): QuickNote[] {
  return [...notes]
    .filter(isTrashedQuickNote)
    .sort((a, b) => (b.trashed_at ?? '').localeCompare(a.trashed_at ?? ''))
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

function formatDateLabel(dateKey: string): string {
  const today = toLocalDateKey(new Date().toISOString())
  const yesterday = toLocalDateKey(new Date(Date.now() - 86_400_000).toISOString())

  if (dateKey === today) return '今天'
  if (dateKey === yesterday) return '昨天'

  const [, month, day] = dateKey.split('-')
  if (!month || !day) return dateKey
  return `${Number(month)}月${Number(day)}日`
}
