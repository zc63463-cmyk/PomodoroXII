import { describe, expect, it } from 'vitest'
import {
  compareQuickNotes,
  getQuickNoteTitle,
  isActiveQuickNote,
  isConvertedQuickNote,
  isTrashedQuickNote,
  quickNoteMatchesQuery,
  getQuickNoteSearchNeedle,
  getQuickNoteTagQuery,
  selectActiveQuickNotes,
} from '@/lib/quick-notes/quick-note-selectors'
import type { QuickNote } from '@/types'

function makeNote(id: string, overrides: Partial<QuickNote> = {}): QuickNote {
  return {
    id,
    content: 'First line\nbody',
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    session_id: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('quick-note-selectors', () => {
  it('classifies active, trash, and converted semantics', () => {
    const active = makeNote('active')
    const trashed = makeNote('trash', { trashed_at: '2026-01-02T00:00:00.000Z' })
    const converted = makeNote('converted', {
      trashed_at: '2026-01-02T00:00:00.000Z',
      migrated_to_note_id: 'note-1',
    })

    expect(isActiveQuickNote(active)).toBe(true)
    expect(isTrashedQuickNote(trashed)).toBe(true)
    expect(isConvertedQuickNote(converted)).toBe(true)
    expect(isTrashedQuickNote(converted)).toBe(false)
  })

  it('searches content and tags with contains matching', () => {
    const note = makeNote('n1', { content: 'Read memos source', tags: ['ideas'] })

    expect(quickNoteMatchesQuery(note, 'memo')).toBe(true)
    expect(quickNoteMatchesQuery(note, 'idea')).toBe(true)
    expect(quickNoteMatchesQuery(note, 'missing')).toBe(false)
  })

  it('supports explicit hash-tag searches with exact tag semantics', () => {
    const note = makeNote('n1', { content: 'Read #memos source', tags: ['capture'] })

    expect(getQuickNoteTagQuery('#capture')).toBe('capture')
    expect(getQuickNoteSearchNeedle('#capture')).toBe('capture')
    expect(quickNoteMatchesQuery(note, '#capture')).toBe(true)
    expect(quickNoteMatchesQuery(note, '#cap')).toBe(false)
    expect(quickNoteMatchesQuery(note, '#missing')).toBe(false)
  })

  it('excludes trashed, archived, and converted notes from active selection', () => {
    const notes = [
      makeNote('active'),
      makeNote('trash', { trashed_at: '2026-01-02T00:00:00.000Z' }),
      makeNote('archived', { archived_at: '2026-01-02T00:00:00.000Z' }),
      makeNote('converted', { migrated_to_note_id: 'note-1' }),
    ]

    expect(selectActiveQuickNotes(notes).map((note) => note.id)).toEqual(['active'])
  })

  it('sorts pinned first, then updated_at desc, then created_at desc', () => {
    const notes = [
      makeNote('old', {
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
      makeNote('new', {
        created_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-03T00:00:00.000Z',
      }),
      makeNote('pinned', {
        pinned: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
    ]

    expect([...notes].sort(compareQuickNotes).map((note) => note.id)).toEqual([
      'pinned',
      'new',
      'old',
    ])
  })

  it('derives title from first non-empty line', () => {
    expect(getQuickNoteTitle(makeNote('n1', { content: '\n  Hello world\nbody' }))).toBe('Hello world')
  })
})
