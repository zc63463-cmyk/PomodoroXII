import { workItemNoteDocumentSchema, type NoteBlock, type WorkItemNoteDocument } from '@/lib/contracts/task-space'

export type ChecklistChildItem = {
  itemId: string
  text: string
  checked: boolean
  children: never[]
}

export type ChecklistItem = {
  itemId: string
  text: string
  checked: boolean
  children: ChecklistChildItem[]
}

type ChecklistBlock = {
  type: 'checklist'
  blockId: string
  items: ChecklistItem[]
}

const checked = (document: WorkItemNoteDocument): WorkItemNoteDocument =>
  workItemNoteDocumentSchema.parse(document)

function checklistBlock(document: WorkItemNoteDocument, blockId: string): ChecklistBlock {
  const block = document.blocks.find((candidate) => candidate.blockId === blockId)
  if (!block || block.type !== 'checklist') throw new Error('Checklist block not found')
  return block as unknown as ChecklistBlock
}

function replaceChecklistBlock(
  document: WorkItemNoteDocument,
  blockId: string,
  block: ChecklistBlock,
): WorkItemNoteDocument {
  return checked({
    ...document,
    blocks: document.blocks.map((candidate) => candidate.blockId === blockId
      ? block as unknown as NoteBlock
      : candidate),
  })
}

function appendChildById(items: ChecklistItem[], parentId: string, child: ChecklistChildItem): ChecklistItem[] {
  return items.map((item) => item.itemId === parentId
    ? { ...item, children: [...item.children, child] }
    : item)
}

function removeNestedItem(
  items: ChecklistItem[],
  itemId: string,
): { items: ChecklistItem[]; item: ChecklistItem | ChecklistChildItem | null; parentId: string | null } {
  let removed: ChecklistItem | ChecklistChildItem | null = null
  let parentId: string | null = null
  const next = items.flatMap((item) => {
    if (item.itemId === itemId) {
      removed = item
      return []
    }
    const child = item.children.find((candidate) => candidate.itemId === itemId)
    if (!child) return [item]
    removed = child
    parentId = item.itemId
    return [{ ...item, children: item.children.filter((candidate) => candidate.itemId !== itemId) }]
  })
  return { items: next, item: removed, parentId }
}

function itemDepth(items: ChecklistItem[], itemId: string): 0 | 1 | null {
  if (items.some((item) => item.itemId === itemId)) return 0
  if (items.some((item) => item.children.some((child) => child.itemId === itemId))) return 1
  return null
}

export function insertBlock(
  document: WorkItemNoteDocument,
  block: NoteBlock,
  index: number,
): WorkItemNoteDocument {
  const blocks = document.blocks.slice()
  blocks.splice(Math.max(0, Math.min(index, blocks.length)), 0, block)
  return checked({ ...document, blocks })
}

export function updateBlock(
  document: WorkItemNoteDocument,
  blockId: string,
  replacement: NoteBlock,
): WorkItemNoteDocument {
  if (replacement.blockId !== blockId) throw new Error('Block ID is immutable')
  if (!document.blocks.some((block) => block.blockId === blockId)) throw new Error('Block not found')
  return checked({
    ...document,
    blocks: document.blocks.map((block) => block.blockId === blockId ? replacement : block),
  })
}

export function removeBlock(document: WorkItemNoteDocument, blockId: string): WorkItemNoteDocument {
  if (!document.blocks.some((block) => block.blockId === blockId)) throw new Error('Block not found')
  return checked({ ...document, blocks: document.blocks.filter((block) => block.blockId !== blockId) })
}

export function moveBlock(
  document: WorkItemNoteDocument,
  blockId: string,
  targetIndex: number,
): WorkItemNoteDocument {
  const index = document.blocks.findIndex((block) => block.blockId === blockId)
  if (index < 0) throw new Error('Block not found')
  const blocks = document.blocks.slice()
  const [block] = blocks.splice(index, 1)
  blocks.splice(Math.max(0, Math.min(targetIndex, blocks.length)), 0, block!)
  return checked({ ...document, blocks })
}

export function insertChecklistItem(
  document: WorkItemNoteDocument,
  blockId: string,
  item: ChecklistItem | ChecklistChildItem,
  index: number,
  parentItemId?: string,
): WorkItemNoteDocument {
  const block = checklistBlock(document, blockId)
  let items: ChecklistItem[]
  if (parentItemId) {
    if (itemDepth(block.items, parentItemId) !== 0) throw new Error('Checklist supports at most two levels')
    const parent = block.items.find((candidate) => candidate.itemId === parentItemId)
    if (!parent) throw new Error('Checklist item not found')
    if ('children' in item && item.children.length > 0) throw new Error('Checklist supports at most two levels')
    const child: ChecklistChildItem = { itemId: item.itemId, text: item.text, checked: item.checked, children: [] }
    const children = parent.children.slice()
    children.splice(Math.max(0, Math.min(index, children.length)), 0, child)
    items = block.items.map((candidate) => candidate.itemId === parentItemId
      ? { ...candidate, children }
      : candidate)
  } else {
    const root: ChecklistItem = {
      itemId: item.itemId,
      text: item.text,
      checked: item.checked,
      children: 'children' in item ? item.children : [],
    }
    items = block.items.slice()
    items.splice(Math.max(0, Math.min(index, items.length)), 0, root)
  }
  return replaceChecklistBlock(document, blockId, { ...block, items })
}

export function removeChecklistItem(
  document: WorkItemNoteDocument,
  blockId: string,
  itemId: string,
): WorkItemNoteDocument {
  const block = checklistBlock(document, blockId)
  const removal = removeNestedItem(block.items, itemId)
  if (!removal.item) throw new Error('Checklist item not found')
  return replaceChecklistBlock(document, blockId, { ...block, items: removal.items })
}

export function updateChecklistItem(
  document: WorkItemNoteDocument,
  blockId: string,
  itemId: string,
  replacement: { text?: string; checked?: boolean },
): WorkItemNoteDocument {
  const block = checklistBlock(document, blockId)
  let found = false
  const children = (items: ChecklistChildItem[]): ChecklistChildItem[] => items.map((item) => {
    if (item.itemId !== itemId) return item
    found = true
    return { ...item, ...replacement }
  })
  const items = block.items.map((item) => {
    if (item.itemId === itemId) {
      found = true
      return { ...item, ...replacement }
    }
    return { ...item, children: children(item.children) }
  })
  if (!found) throw new Error('Checklist item not found')
  return replaceChecklistBlock(document, blockId, { ...block, items })
}

export function indentChecklistItem(
  document: WorkItemNoteDocument,
  blockId: string,
  itemId: string,
  targetItemId: string,
): WorkItemNoteDocument {
  const block = checklistBlock(document, blockId)
  if (itemDepth(block.items, targetItemId) !== 0) throw new Error('Checklist supports at most two levels')
  const removal = removeNestedItem(block.items, itemId)
  if (!removal.item) throw new Error('Checklist item not found')
  if (removal.parentId !== null || removal.item.itemId === targetItemId) {
    throw new Error('Checklist supports at most two levels')
  }
  if ('children' in removal.item && removal.item.children.length > 0) {
    throw new Error('Checklist supports at most two levels')
  }
  const child: ChecklistChildItem = {
    itemId: removal.item.itemId,
    text: removal.item.text,
    checked: removal.item.checked,
    children: [],
  }
  return replaceChecklistBlock(document, blockId, {
    ...block,
    items: appendChildById(removal.items, targetItemId, child),
  })
}

export function outdentChecklistItem(
  document: WorkItemNoteDocument,
  blockId: string,
  itemId: string,
): WorkItemNoteDocument {
  const block = checklistBlock(document, blockId)
  const parentIndex = block.items.findIndex((item) => item.children.some((child) => child.itemId === itemId))
  if (parentIndex < 0) {
    if (itemDepth(block.items, itemId) === 0) return document
    throw new Error('Checklist item not found')
  }
  const parent = block.items[parentIndex]!
  const child = parent.children.find((candidate) => candidate.itemId === itemId)
  if (!child) throw new Error('Checklist item not found')
  const items = block.items.slice()
  items[parentIndex] = {
    ...parent,
    children: parent.children.filter((candidate) => candidate.itemId !== itemId),
  }
  items.splice(parentIndex + 1, 0, { ...child, children: [] })
  return replaceChecklistBlock(document, blockId, { ...block, items })
}
