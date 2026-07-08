import { describe, expect, it } from 'vitest'
import {
  getSelectedQuickNote,
  isDetailRead,
  isFocusEdit,
  isFocusRead,
} from '@/lib/quick-notes/quick-note-focus'
import type { QuickNote } from '@/types'

function makeNote(id: string): QuickNote {
  return {
    id,
    content: `${id} content`,
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
  }
}

describe('quick-note-focus helpers', () => {
  it('returns the selected quick note only when the id exists', () => {
    const notes = [makeNote('a'), makeNote('b')]

    expect(getSelectedQuickNote(notes, 'b')?.id).toBe('b')
    expect(getSelectedQuickNote(notes, 'missing')).toBeNull()
    expect(getSelectedQuickNote(notes, null)).toBeNull()
  })

  it('classifies quick note focus modes', () => {
    expect(isFocusEdit('focus-edit')).toBe(true)
    expect(isFocusEdit('normal')).toBe(false)
    expect(isFocusRead('focus-read')).toBe(true)
    expect(isFocusRead('detail-read')).toBe(false)
    expect(isDetailRead('detail-read')).toBe(true)
    expect(isDetailRead('focus-read')).toBe(false)
  })
})
