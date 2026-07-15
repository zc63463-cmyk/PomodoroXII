import { describe, expect, it } from 'vitest'
import {
  buildQuickNoteTagTree,
  compareQuickNotes,
  getQuickNoteActivityData,
  getQuickNoteActivityDateKey,
  getQuickNoteSearchSnippet,
  getQuickNoteTagStats,
  getQuickNoteTitle,
  isActiveQuickNote,
  isConvertedQuickNote,
  isTrashedQuickNote,
  quickNoteMatchesQuery,
  getQuickNoteSearchNeedle,
  getQuickNoteTagQuery,
  selectActiveQuickNotes,
  selectQuickNotesForExplorer,
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

  it('counts tags from active quick notes and ignores duplicate tags per note', () => {
    const notes = [
      makeNote('a', { tags: ['work', 'frontend', 'work'] }),
      makeNote('b', { tags: ['work'] }),
      makeNote('archived', {
        tags: ['hidden'],
        archived_at: '2026-01-03T00:00:00.000Z',
      }),
    ]

    expect(getQuickNoteTagStats(notes)).toEqual([
      { tag: 'work', count: 2 },
      { tag: 'frontend', count: 1 },
    ])
  })

  it('builds slash-separated tag tree with descendant totals', () => {
    const tree = buildQuickNoteTagTree([
      { tag: 'work/frontend', count: 2 },
      { tag: 'work/backend', count: 1 },
      { tag: 'work', count: 1 },
      { tag: 'life', count: 1 },
    ])

    expect(tree).toMatchObject([
      {
        path: 'work',
        name: 'work',
        count: 1,
        totalCount: 4,
        depth: 0,
        children: [
          { path: 'work/frontend', name: 'frontend', count: 2, totalCount: 2, depth: 1 },
          { path: 'work/backend', name: 'backend', count: 1, totalCount: 1, depth: 1 },
        ],
      },
      {
        path: 'life',
        name: 'life',
        count: 1,
        totalCount: 1,
        depth: 0,
        children: [],
      },
    ])
  })

  it('counts activity by activity date for active quick notes', () => {
    const notes = [
      makeNote('a', { created_at: '2026-07-01T01:00:00.000Z', updated_at: '2026-07-01T01:00:00.000Z' }),
      makeNote('b', { created_at: '2026-07-01T12:00:00.000Z', updated_at: '2026-07-01T12:00:00.000Z' }),
      makeNote('c', { created_at: '2026-07-02T01:00:00.000Z', updated_at: '2026-07-02T01:00:00.000Z' }),
      makeNote('trash', {
        created_at: '2026-07-01T09:00:00.000Z',
        updated_at: '2026-07-01T09:00:00.000Z',
        trashed_at: '2026-07-03T00:00:00.000Z',
      }),
    ]

    expect(getQuickNoteActivityData(notes)).toEqual({
      '2026-07-01': 2,
      '2026-07-02': 1,
    })
  })

  it('uses valid updated_at, then created_at, as the sole activity date key', () => {
    expect(
      getQuickNoteActivityDateKey(makeNote('updated', {
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-05T10:00:00.000Z',
      })),
    ).toBe('2026-07-05')
    expect(
      getQuickNoteActivityDateKey(makeNote('fallback', {
        created_at: '2026-07-02T10:00:00.000Z',
        updated_at: 'not-a-date',
      })),
    ).toBe('2026-07-02')
  })

  it('centers a search snippet around the first deep body match', () => {
    const note = makeNote('deep-match', {
      content: `标题\n\n${'前文 '.repeat(45)}关键字在正文深处${' 后文'.repeat(45)}`,
    })

    const snippet = getQuickNoteSearchSnippet(note, '关键字')
    expect(snippet).toContain('关键字在正文深处')
    expect(snippet.startsWith('...')).toBe(true)
    expect(snippet.endsWith('...')).toBe(true)
  })

  it('filters explorer notes by search, all selected tags, and created date', () => {
    const notes = [
      makeNote('match', {
        content: 'release plan',
        tags: ['work', 'frontend'],
        created_at: '2026-07-01T09:00:00.000Z',
        updated_at: '2026-07-01T09:00:00.000Z',
      }),
      makeNote('missing-tag', {
        content: 'release plan',
        tags: ['work'],
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-01T10:00:00.000Z',
      }),
      makeNote('wrong-date', {
        content: 'release plan',
        tags: ['work', 'frontend'],
        created_at: '2026-07-02T10:00:00.000Z',
        updated_at: '2026-07-02T10:00:00.000Z',
      }),
      makeNote('wrong-search', {
        content: 'other note',
        tags: ['work', 'frontend'],
        created_at: '2026-07-01T11:00:00.000Z',
        updated_at: '2026-07-01T11:00:00.000Z',
      }),
    ]

    expect(
      selectQuickNotesForExplorer(notes, {
        query: 'release',
        selectedTags: ['work', 'frontend'],
        selectedDate: '2026-07-01',
      }).map((note) => note.id),
    ).toEqual(['match'])
  })
})
