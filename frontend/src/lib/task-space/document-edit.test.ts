import { describe, expect, it } from 'vitest'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import {
  indentChecklistItem,
  insertBlock,
  insertChecklistItem,
  moveBlock,
  outdentChecklistItem,
  removeBlock,
  removeChecklistItem,
  updateBlock,
  updateChecklistItem,
} from './document-edit'

const twoLevelChecklistDocument = (): WorkItemNoteDocument => ({
  contentVersion: 1,
  blocks: [{
    type: 'checklist',
    blockId: 'checklist-1',
    items: [
      {
        itemId: 'root-1',
        text: 'Plan',
        checked: false,
        children: [{ itemId: 'child-1', text: 'Draft', checked: false, children: [] }],
      },
      { itemId: 'root-2', text: 'Ship', checked: false, children: [] },
    ],
  }],
})

describe('WorkItemNote document reducers', () => {
  it('creates both v1 Blocks with stable caller-supplied IDs', () => {
    let document: WorkItemNoteDocument = { contentVersion: 1, blocks: [] }
    document = insertBlock(document, { type: 'paragraph', blockId: 'p', text: '' }, 0)
    document = insertBlock(document, { type: 'checklist', blockId: 'c', items: [] }, 1)

    expect(document.blocks.map((block) => block.type)).toEqual(['paragraph', 'checklist'])
    expect(document.blocks.map((block) => block.blockId)).toEqual(['p', 'c'])
  })

  it('rejects assigning an item under an existing child', () => {
    const document = twoLevelChecklistDocument()

    expect(() => indentChecklistItem(document, 'checklist-1', 'root-2', 'child-1'))
      .toThrow('Checklist supports at most two levels')
  })

  it('updates Checklist text and checked state without changing item identity', () => {
    const next = updateChecklistItem(
      twoLevelChecklistDocument(),
      'checklist-1',
      'root-1',
      { text: 'Ship', checked: true },
    )

    expect(next.blocks[0]).toMatchObject({ type: 'checklist', blockId: 'checklist-1' })
    expect((next.blocks[0] as Extract<typeof next.blocks[number], { type: 'checklist' }>).items[0])
      .toMatchObject({ itemId: 'root-1', text: 'Ship', checked: true })
  })

  it('updates, moves, and removes Blocks immutably', () => {
    const original: WorkItemNoteDocument = {
      contentVersion: 1,
      blocks: [
        { type: 'paragraph', blockId: 'p', text: 'before' },
        { type: 'checklist', blockId: 'c', items: [] },
      ],
    }
    const updated = updateBlock(original, 'p', { type: 'paragraph', blockId: 'p', text: 'after' })
    const moved = moveBlock(updated, 'p', 1)
    const removed = removeBlock(moved, 'c')

    expect(original.blocks[0]).toMatchObject({ blockId: 'p', text: 'before' })
    expect(moved.blocks.map((block) => block.blockId)).toEqual(['c', 'p'])
    expect(removed.blocks).toEqual([{ type: 'paragraph', blockId: 'p', text: 'after' }])
    expect(() => updateBlock(original, 'p', { type: 'paragraph', blockId: 'other', text: '' }))
      .toThrow('Block ID is immutable')
  })

  it('inserts and removes root and child Checklist items without parentItemId or rank', () => {
    const root = { itemId: 'root-3', text: 'Review', checked: false, children: [] }
    const child = { itemId: 'child-3', text: 'Proofread', checked: false, children: [] }
    const withRoot = insertChecklistItem({ contentVersion: 1, blocks: [{ type: 'checklist', blockId: 'c', items: [] }] }, 'c', root, 0)
    const withChild = insertChecklistItem(withRoot, 'c', child, 0, 'root-3')
    const removed = removeChecklistItem(withChild, 'c', 'child-3')

    expect(withChild.blocks[0]).toMatchObject({
      items: [{ itemId: 'root-3', children: [{ itemId: 'child-3' }] }],
    })
    expect(JSON.stringify(withChild)).not.toMatch(/parentItemId|rank/)
    expect(removed.blocks[0]).toMatchObject({ items: [{ itemId: 'root-3', children: [] }] })
  })

  it('rejects inserting a populated root beneath another root', () => {
    const populated = { itemId: 'root-3', text: 'Nested', checked: false, children: [
      { itemId: 'child-3', text: 'Too deep', checked: false, children: [] },
    ] }
    expect(() => insertChecklistItem(
      twoLevelChecklistDocument(),
      'checklist-1',
      populated,
      0,
      'root-2',
    )).toThrow('Checklist supports at most two levels')
  })

  it('outdents a child immediately after its former parent', () => {
    const next = outdentChecklistItem(twoLevelChecklistDocument(), 'checklist-1', 'child-1')
    const block = next.blocks[0]
    if (block.type !== 'checklist') throw new Error('expected Checklist')
    expect(block.items.map((item) => item.itemId)).toEqual(['root-1', 'child-1', 'root-2'])
    expect(block.items[1]!.children).toEqual([])
  })
})
