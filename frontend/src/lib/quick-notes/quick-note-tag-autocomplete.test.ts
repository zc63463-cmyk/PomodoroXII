import { describe, expect, it } from 'vitest'
import {
  applyQuickNoteTagAutocomplete,
  getQuickNoteTagAutocompleteState,
} from '@/lib/quick-notes/quick-note-tag-autocomplete'

describe('quick-note-tag-autocomplete', () => {
  it('opens on a hash token at the caret and filters normalized tag suggestions', () => {
    const state = getQuickNoteTagAutocompleteState(
      'ship #wo',
      'ship #wo'.length,
      ['life', 'Work', 'work/frontend', 'writing', 'daily'],
    )

    expect(state).toEqual({
      query: 'wo',
      range: { start: 5, end: 8 },
      suggestions: ['work', 'work/frontend'],
    })
  })

  it('shows top existing tags when the token is only a hash', () => {
    const state = getQuickNoteTagAutocompleteState(
      'remember #',
      'remember #'.length,
      ['work', 'life', 'daily'],
    )

    expect(state).toMatchObject({
      query: '',
      range: { start: 9, end: 10 },
      suggestions: ['work', 'life', 'daily'],
    })
  })

  it('deduplicates suggestions and limits the result set', () => {
    const state = getQuickNoteTagAutocompleteState(
      '#',
      1,
      ['Work', '#work', 'life', 'daily', 'project', 'idea', 'focus', 'read', 'ship', 'later'],
    )

    expect(state?.suggestions).toEqual([
      'work',
      'life',
      'daily',
      'project',
      'idea',
      'focus',
      'read',
      'ship',
    ])
  })

  it('does not open outside the current hash token', () => {
    expect(getQuickNoteTagAutocompleteState('ship #work ', 'ship #work '.length, ['work'])).toBeNull()
    expect(getQuickNoteTagAutocompleteState('ship work', 'ship work'.length, ['work'])).toBeNull()
    expect(getQuickNoteTagAutocompleteState('email test#a', 'email test#a'.length, ['a'])).toBeNull()
  })

  it('replaces the current hash token and returns the next caret index', () => {
    expect(
      applyQuickNoteTagAutocomplete(
        'ship #wo today',
        { start: 5, end: 8 },
        'work/frontend',
      ),
    ).toEqual({
      value: 'ship #work/frontend today',
      caretIndex: 'ship #work/frontend '.length,
    })
  })
})
