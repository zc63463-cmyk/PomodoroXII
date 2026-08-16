import { describe, expect, it } from 'vitest'
import { canonicalize } from 'json-canonicalize'
import {
  MAX_NOTE_BLOCKS, MAX_NOTE_DOCUMENT_BYTES, MAX_NOTE_ITEMS,
  workItemNoteDocumentSchema,
} from './task-space'

const valid = {
  contentVersion: 1 as const,
  blocks: [
    { type: 'paragraph' as const, blockId: 'p-1', text: 'Context' },
    { type: 'checklist' as const, blockId: 'cl-1', items: [{
      itemId: 'i-1', text: 'Ship', checked: false,
      children: [{ itemId: 'i-2', text: 'Verify', checked: false, children: [] }],
    }] },
  ],
}

const canonicalBytes = (value: unknown) => new TextEncoder().encode(canonicalize(value)!).byteLength

describe('WorkItemNote document v1', () => {
  it('accepts only paragraph and two-level checklist blocks', () => {
    expect(workItemNoteDocumentSchema.parse(valid)).toEqual(valid)
  })

  it('rejects duplicate IDs and a third checklist level', () => {
    const duplicate = structuredClone(valid)
    duplicate.blocks[1]!.blockId = 'p-1'
    expect(() => workItemNoteDocumentSchema.parse(duplicate)).toThrow(/unique/i)

    const deep = structuredClone(valid)
    const deepChecklist = deep.blocks[1]
    if (deepChecklist.type !== 'checklist' || !deepChecklist.items[0] || !deepChecklist.items[0].children[0]) throw new Error('invalid fixture')
    ;(deepChecklist.items[0].children[0].children as unknown[]).push({
      itemId: 'i-3', text: 'Too deep', checked: false, children: [],
    })
    expect(() => workItemNoteDocumentSchema.parse(deep)).toThrow()
  })

  it('rejects forbidden block/item shapes and blank checklist text', () => {
    expect(() => workItemNoteDocumentSchema.parse({
      contentVersion: 1, blocks: [{ type: 'heading', blockId: 'h', text: 'No' }],
    })).toThrow()
    const blank = structuredClone(valid)
    const blankChecklist = blank.blocks[1]
    if (blankChecklist.type !== 'checklist' || !blankChecklist.items[0]) throw new Error('invalid fixture')
    blankChecklist.items[0].text = ' \t '
    expect(() => workItemNoteDocumentSchema.parse(blank)).toThrow(/nonblank/i)
  })

  it('enforces the block and recursively counted item limits', () => {
    const blocks = Array.from({ length: MAX_NOTE_BLOCKS }, (_, index) => ({
      type: 'paragraph' as const, blockId: `p-${index}`, text: '',
    }))
    expect(workItemNoteDocumentSchema.parse({ contentVersion: 1, blocks })).toBeTruthy()
    expect(() => workItemNoteDocumentSchema.parse({
      contentVersion: 1, blocks: [...blocks, { type: 'paragraph', blockId: 'overflow', text: '' }],
    })).toThrow(/256|block/i)

    const items = Array.from({ length: MAX_NOTE_ITEMS - 1 }, (_, index) => ({
      itemId: `i-${index}`, text: 'x', checked: false, children: [],
    }))
    ;(items[0]!.children as unknown[]).push({ itemId: 'nested', text: 'x', checked: false, children: [] })
    expect(workItemNoteDocumentSchema.parse({ contentVersion: 1, blocks: [{ type: 'checklist', blockId: 'wide', items }] })).toBeTruthy()
    const tooMany = structuredClone(items)
    ;(tooMany[1]!.children as unknown[]).push({ itemId: 'nested-overflow', text: 'x', checked: false, children: [] })
    expect(() => workItemNoteDocumentSchema.parse({ contentVersion: 1, blocks: [{ type: 'checklist', blockId: 'wide', items: tooMany }] })).toThrow(/item/i)
  })

  it('uses canonical UTF-8 bytes for the 128 KiB boundary', () => {
    const blocks = Array.from({ length: 14 }, (_, index) => ({
      type: 'paragraph' as const, blockId: `size-${index}`, text: index < 13 ? 'x'.repeat(9_500) : '',
    }))
    const document = { contentVersion: 1 as const, blocks }
    const remaining = MAX_NOTE_DOCUMENT_BYTES - canonicalBytes(document)
    blocks.at(-1)!.text = 'x'.repeat(remaining)
    expect(canonicalBytes(document)).toBe(MAX_NOTE_DOCUMENT_BYTES)
    expect(workItemNoteDocumentSchema.parse(document)).toEqual(document)
    const tooLarge = structuredClone(document)
    tooLarge.blocks.at(-1)!.text += 'x'
    expect(() => workItemNoteDocumentSchema.parse(tooLarge)).toThrow(/byte/i)
  })
})
