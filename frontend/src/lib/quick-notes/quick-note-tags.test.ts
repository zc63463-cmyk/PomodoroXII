import { describe, expect, it } from 'vitest'
import {
  cleanupQuickNoteTags,
  extractQuickNoteTags,
  mergeQuickNoteTags,
  normalizeQuickNoteTag,
  normalizeQuickNoteTags,
  renameQuickNoteTagInList,
  replaceInlineQuickNoteHashtag,
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

  it('cleans empty dirty and duplicate tags', () => {
    expect(cleanupQuickNoteTags(['', '#', ' Work ', '#work', 'life'])).toEqual([
      'work',
      'life',
    ])
  })

  it('renames tags in a list and merges existing targets without duplicates', () => {
    expect(renameQuickNoteTagInList(['work', 'life'], 'work', 'project')).toEqual([
      'project',
      'life',
    ])
    expect(renameQuickNoteTagInList(['work', 'project'], 'work', 'project')).toEqual([
      'project',
    ])
  })

  it('replaces exact simple inline hashtags without touching longer tags', () => {
    expect(replaceInlineQuickNoteHashtag(
      'ship #work and #work-now and #Work',
      'work',
      'project',
    )).toBe('ship #project and #work-now and #project')
  })

  it('does not rewrite slash hashtag prefixes when renaming a parent tag', () => {
    expect(replaceInlineQuickNoteHashtag(
      'keep #work/frontend stable while #work changes',
      'work',
      'project',
    )).toBe('keep #work/frontend stable while #project changes')
  })

  it('does not replace inline content for slash tags', () => {
    expect(replaceInlineQuickNoteHashtag(
      'ship #work/frontend and keep text stable',
      'work/frontend',
      'project',
    )).toBe('ship #work/frontend and keep text stable')
  })
})
