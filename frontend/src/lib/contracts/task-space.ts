import { canonicalize } from 'json-canonicalize'
import { z } from 'zod'

const id = z.string().min(1).max(64)
const entityId = z.string().min(1).max(36)
const utc = z.string().datetime({ offset: true })

export const MAX_NOTE_DOCUMENT_BYTES = 128 * 1024
export const MAX_NOTE_BLOCKS = 256
export const MAX_NOTE_ITEMS = 2048

const checklistLeaf = z.object({
  itemId: id,
  text: z.string().max(10_000).refine((value) => value.trim().length > 0, 'checklist item requires nonblank text'),
  checked: z.boolean(),
  children: z.array(z.never()).max(0, 'Checklist supports at most two levels'),
}).strict()

const checklistItem = z.object({
  itemId: id,
  text: z.string().max(10_000).refine((value) => value.trim().length > 0, 'checklist item requires nonblank text'),
  checked: z.boolean(),
  children: z.array(checklistLeaf).max(MAX_NOTE_ITEMS),
}).strict()

const paragraphBlockSchema = z.object({ type: z.literal('paragraph'), blockId: id, text: z.string().max(10_000) }).strict()
const checklistBlockSchema = z.object({ type: z.literal('checklist'), blockId: id, items: z.array(checklistItem).max(MAX_NOTE_ITEMS) }).strict()
export const noteBlockSchema = z.discriminatedUnion('type', [paragraphBlockSchema, checklistBlockSchema])

export const workItemNoteDocumentSchema = z.object({
  contentVersion: z.literal(1),
  blocks: z.array(noteBlockSchema).max(MAX_NOTE_BLOCKS),
}).strict().superRefine((document, context) => {
  const seen = new Set<string>()
  let itemCount = 0
  const visit = (item: { itemId: string; children: Array<{ itemId: string; children: never[] }> }) => {
    itemCount += 1
    if (seen.has(item.itemId)) context.addIssue({ code: 'custom', message: 'Block and item IDs must be unique' })
    seen.add(item.itemId)
    for (const child of item.children) visit(child)
  }
  for (const block of document.blocks) {
    if (seen.has(block.blockId)) context.addIssue({ code: 'custom', message: 'Block and item IDs must be unique' })
    seen.add(block.blockId)
    if (block.type === 'checklist') for (const item of block.items) visit(item)
  }
  if (itemCount > MAX_NOTE_ITEMS) context.addIssue({ code: 'custom', message: 'Note item count exceeds limit' })
  const canonical = canonicalize(document)
  if (canonical === undefined) context.addIssue({ code: 'custom', message: 'Note document is not canonical JSON' })
  else if (new TextEncoder().encode(canonical).byteLength > MAX_NOTE_DOCUMENT_BYTES) context.addIssue({ code: 'custom', message: 'Note document exceeds the canonical byte limit' })
})

export const projectSchema = z.object({
  id: entityId,
  spaceId: entityId,
  name: z.string().min(1).max(200),
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  description: z.string().nullable(),
  nextWorkItemNumber: z.number().int().positive(),
  rank: z.number().int().nonnegative(),
  archivedAt: utc.nullable(),
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()

export const workItemSchema = z.object({
  id: entityId,
  spaceId: entityId,
  projectId: entityId,
  displayKey: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  typeDefinitionId: entityId,
  statusDefinitionId: entityId,
  priority: z.number().int().nullable(),
  parentId: entityId.nullable(),
  childRank: z.number().int().nonnegative(),
  depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  completionWindowStart: utc.nullable(),
  completionWindowEnd: utc.nullable(),
  reviewPoint: utc.nullable(),
  hardDeadline: utc.nullable(),
  effortEstimateLowerSeconds: z.number().int().nonnegative().nullable(),
  effortEstimateUpperSeconds: z.number().int().nonnegative().nullable(),
  effortActualSeconds: z.number().int().nonnegative(),
  confidence: z.number().nullable(),
  completedAt: utc.nullable(),
  cancelledAt: utc.nullable(),
  archivedAt: utc.nullable(),
  markedAsAttention: z.boolean(),
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()

export const workItemNoteSchema = z.object({
  spaceId: entityId,
  noteId: entityId,
  workItemId: entityId,
  document: workItemNoteDocumentSchema,
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()
export const workItemNoteCommandPostImageSchema = workItemNoteSchema.omit({ spaceId: true })

export const projectPageSchema = z.object({ items: z.array(projectSchema), nextCursor: z.string().nullable() }).strict()
export const workItemPageSchema = z.object({ items: z.array(workItemSchema), nextCursor: z.string().nullable() }).strict()
export const definitionsSchema = z.object({
  statuses: z.array(z.record(z.string(), z.unknown())),
  types: z.array(z.record(z.string(), z.unknown())),
  labels: z.array(z.record(z.string(), z.unknown())),
}).strict()
export const acceptedMutationSchema = z.object({
  commandId: z.string().min(1), entityType: z.string().min(1), entityId: id,
  version: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()),
}).strict()

export type WorkItemNoteDocument = z.infer<typeof workItemNoteDocumentSchema>
export type NoteBlock = z.infer<typeof noteBlockSchema>
export type Project = z.infer<typeof projectSchema>
export type ProjectView = Project
export type WorkItem = z.infer<typeof workItemSchema>
export type WorkItemView = WorkItem
export type WorkItemNote = z.infer<typeof workItemNoteSchema>
export type WorkItemNoteView = WorkItemNote
export type TaskSpaceDefinitions = z.infer<typeof definitionsSchema>

export const parseProject = (value: unknown) => projectSchema.parse(value)
export const parseDefinitions = (value: unknown) => definitionsSchema.parse(value)
export const parseWorkItem = (value: unknown) => workItemSchema.parse(value)
export const parseWorkItemNote = (value: unknown) => workItemNoteSchema.parse(value)
export const parseNoteDocument = (value: unknown) => workItemNoteDocumentSchema.parse(typeof value === 'string' ? JSON.parse(value) : value)

export function assertResponseSpace<T extends { spaceId: string }>(value: T, expectedSpaceId: string): T {
  if (value.spaceId !== expectedSpaceId) throw new Error(`space_scope_mismatch:${value.spaceId}:${expectedSpaceId}`)
  return value
}
