import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalize } from 'json-canonicalize'
import {
  MAX_NOTE_BLOCKS, MAX_NOTE_DOCUMENT_BYTES, MAX_NOTE_ITEMS,
  WORK_ITEM_CONFIDENCE_VALUES, WORK_ITEM_PRIORITY_VALUES,
  taskSpaceEntityBusinessPayloadForHash,
  workItemNoteDocumentSchema, workItemReadSchema, workItemSchema,
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

/**
 * ★ 2026-09-11 WorkItem 实体契约夹具（**不含 depth**）：depth 是读模型派生值，
 * 不在实体契约 / post-image / 业务哈希里（见 workItemSchema 注释）。
 */
const wireItem = (priority: unknown, confidence: unknown = null) => ({
  id: 'w1', spaceId: 's1', projectId: 'p1', displayKey: 'RM-1', title: 'Item',
  description: null, typeDefinitionId: 't1', statusDefinitionId: 'st1',
  priority, parentId: null, childRank: 0,
  completionWindowStart: null, completionWindowEnd: null, reviewPoint: null,
  hardDeadline: null, effortEstimateLowerSeconds: null, effortEstimateUpperSeconds: null,
  effortActualSeconds: 0, confidence, completedAt: null, cancelledAt: null,
  archivedAt: null, markedAsAttention: false, labelIds: [], version: 1,
  createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z',
})

const backendDomain = (alias: string): string[] => {
  // 直接读后端 contracts.py 的 Literal 声明，保证跨语言同源而非人工同步。
  const source = readFileSync(
    resolve(process.cwd(), '../backend/app/task_space/contracts.py'),
    'utf8',
  )
  const match = new RegExp(`${alias}[^=]*=\\s*Literal\\[([^\\]]*)\\]`).exec(source)
  if (!match) throw new Error(`missing backend enum domain: ${alias}`)
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]!)
}

describe('WorkItem enum domains', () => {
  it('matches the backend contracts value-for-value', () => {
    expect(WORK_ITEM_PRIORITY_VALUES).toEqual(backendDomain('WorkItemPriorityValue'))
    expect(WORK_ITEM_CONFIDENCE_VALUES).toEqual(backendDomain('WorkItemConfidenceValue'))
    expect(WORK_ITEM_PRIORITY_VALUES).toEqual(['low', 'medium', 'high', 'urgent'])
    expect(WORK_ITEM_CONFIDENCE_VALUES).toEqual(['low', 'medium', 'high'])
  })

  it('accepts only canonical English values and null on the wire schema', () => {
    for (const priority of WORK_ITEM_PRIORITY_VALUES) {
      expect(workItemSchema.parse(wireItem(priority)).priority).toBe(priority)
    }
    expect(workItemSchema.parse(wireItem(null)).priority).toBeNull()
    // 中文/大写/自由文本一律拒绝：绝不能把越界值写进业务载荷。
    for (const dirty of ['高', 'HIGH', 'p1', 1, {}, ['high']]) {
      expect(() => workItemSchema.parse(wireItem(dirty))).toThrow()
    }
  })

  it('accepts only canonical confidence values and null', () => {
    for (const confidence of WORK_ITEM_CONFIDENCE_VALUES) {
      expect(workItemSchema.parse(wireItem(null, confidence)).confidence).toBe(confidence)
    }
    expect(workItemSchema.parse(wireItem('high', null)).confidence).toBeNull()
    expect(() => workItemSchema.parse(wireItem(null, '很确定'))).toThrow()
  })
})

/**
 * ★ 2026-09-11 WorkItem depth 契约回归。
 * depth 是**读模型派生值**：实体契约（post-image / 本地行 / 业务哈希）不含它，
 * 服务端读投影（GET/list）才带它。以前前端把它当必填实体字段，导致 sync pull
 * 落下的无 depth 行在 tree 里静默消失。
 */
describe('WorkItem depth contract', () => {
  it('rejects depth on the entity contract (post-image shape)', () => {
    expect(() => workItemSchema.parse({ ...wireItem('high'), depth: 1 })).toThrow()
  })

  it('keeps depth on the read projection only', () => {
    expect(workItemReadSchema.parse({ ...wireItem('high'), depth: 2 }).depth).toBe(2)
    expect(() => workItemReadSchema.parse({ ...wireItem('high'), depth: 4 })).toThrow()
    // 读投影仍要求 depth 来自服务端；缺失时解析失败（不静默给默认值）。
    expect(() => workItemReadSchema.parse(wireItem('high'))).toThrow()
  })

  it('excludes depth from the workItem business payload for hashing', () => {
    // 本地业务行（cached 形状）不含 space 身份，也不含 depth。
    const { spaceId: _spaceId, ...entity } = wireItem('high')
    const payload = taskSpaceEntityBusinessPayloadForHash(
      'workItem', 'update', entity as never,
    ) as Record<string, unknown>
    expect(payload).not.toHaveProperty('depth')
    expect(payload).toMatchObject({ title: 'Item', parent_id: null, child_rank: 0 })
  })
})
