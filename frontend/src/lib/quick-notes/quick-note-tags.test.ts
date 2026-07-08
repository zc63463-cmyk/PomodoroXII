import { describe, expect, it } from 'vitest'
import {
  extractQuickNoteTags,
  mergeQuickNoteTags,
  normalizeQuickNoteTag,
  normalizeQuickNoteTags,
} from '@/lib/quick-notes/quick-note-tags'

describe('quick-note-tags', () => {
  it('extracts Chinese English numeric underscore and dash tags', () => {
    expect(
      extractQuickNoteTags('今天记录 #灵感42 #Daily_Note #产品-v1 and #daily_note'),
    ).toEqual(['灵感42', 'daily_note', '产品-v1'])
  })

  it('normalizes explicit tags and removes duplicates by first appearance', () => {
    expect(normalizeQuickNoteTag('##Capture')).toBe('capture')
    expect(normalizeQuickNoteTags([' Capture ', '#capture', '灵感', '#灵感'])).toEqual([
      'capture',
      '灵感',
    ])
  })

  it('merges explicit and extracted tags predictably', () => {
    expect(mergeQuickNoteTags(['work', '#Daily'], ['daily', '灵感'])).toEqual([
      'work',
      'daily',
      '灵感',
    ])
  })
})
