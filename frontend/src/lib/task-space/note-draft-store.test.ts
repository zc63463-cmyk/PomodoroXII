import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import {
  buildNoteEditDraft,
  clearNoteEditDraft,
  loadNoteEditDraft,
  parseNoteEditDraft,
  persistNoteEditDraft,
} from './note-draft-store'

const documentWithText = (text: string): WorkItemNoteDocument => ({
  contentVersion: 1,
  blocks: [{ type: 'paragraph', blockId: 'p-1', text }],
})

const draft = (spaceId: string, workItemId: string, text: string) =>
  buildNoteEditDraft({
    spaceId,
    workItemId,
    expectedLocalRevision: 3,
    document: documentWithText(text),
    operationId: 'op-1',
    now: '2026-08-26T00:00:00.000Z',
  })

describe('note-draft-store (durable retryable draft)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('persists, loads and clears a durable draft', () => {
    persistNoteEditDraft(draft('space-a', 'wi-1', 'Draft'))
    const loaded = loadNoteEditDraft('space-a', 'wi-1')
    expect(loaded).not.toBeNull()
    expect(loaded?.workItemId).toBe('wi-1')
    expect(loaded?.expectedLocalRevision).toBe(3)
    expect(loaded?.document).toEqual(documentWithText('Draft'))
    expect(loaded?.operationId).toBe('op-1')

    clearNoteEditDraft('space-a', 'wi-1')
    expect(loadNoteEditDraft('space-a', 'wi-1')).toBeNull()
  })

  it('is space-scoped: a draft never leaks into another space', () => {
    persistNoteEditDraft(draft('space-a', 'wi-1', 'A'))
    expect(loadNoteEditDraft('space-b', 'wi-1')).toBeNull()
    expect(loadNoteEditDraft('space-a', 'wi-2')).toBeNull()
  })

  it('rejects malformed or foreign drafts', () => {
    expect(parseNoteEditDraft('not-json', 'space-a', 'wi-1')).toBeNull()
    localStorage.setItem('pxii:noteDraft:space-a:wi-1', JSON.stringify({
      ...draft('space-a', 'wi-1', 'x'),
      spaceId: 'space-b', // foreign space id in the payload
    }))
    expect(loadNoteEditDraft('space-a', 'wi-1')).toBeNull()
  })

  it('is independent of any repository/controller closure (survives rebind)', () => {
    persistNoteEditDraft(draft('space-a', 'wi-1', 'Durable'))
    // A completely fresh reader (no shared closure) recovers the draft.
    expect(loadNoteEditDraft('space-a', 'wi-1')?.document.blocks[0]).toMatchObject({
      text: 'Durable',
    })
  })
})
