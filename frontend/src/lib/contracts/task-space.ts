import { canonicalize } from 'json-canonicalize'
import { z } from 'zod'
import type { JsonValue } from './payload-hash'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'

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
  priority: z.string().nullable(),
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
  confidence: z.string().nullable(),
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
// The S4 sync wire post-image uses the server catalog's snake_case fields.
export const workItemNoteSyncPostImageSchema = z.object({
  id: entityId,
  work_item_id: entityId,
  document_json: z.string(),
  version: z.number().int().positive(),
  created_at: utc,
  updated_at: utc,
}).strict()

export const statusDefinitionSchema = z.object({
  id: entityId,
  category: z.string().min(1),
  name: z.string().min(1).max(200),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  rank: z.number().int().nonnegative(),
  system: z.boolean(),
  archivedAt: utc.nullable(),
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()

export const typeDefinitionSchema = z.object({
  id: entityId,
  name: z.string().min(1).max(200),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  rank: z.number().int().nonnegative(),
  system: z.boolean(),
  archivedAt: utc.nullable(),
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()

export const labelSchema = z.object({
  id: entityId,
  name: z.string().min(1).max(200),
  color: z.string().nullable(),
  archivedAt: utc.nullable(),
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()

export const workItemLabelSchema = z.object({
  workItemId: entityId,
  labelId: entityId,
}).strict()

type TaskSpaceSyncEntityType = Extract<SyncEntityType,
  'project' | 'statusDefinition' | 'typeDefinition' | 'label' |
  'workItemLabel' | 'workItem' | 'workItemNote'>

const cachedProjectSchema = projectSchema.omit({ spaceId: true })
const cachedWorkItemSchema = workItemSchema.omit({ spaceId: true })
const genericDeleteSchema = z.strictObject({ id: entityId })

export function taskSpaceEntityBusinessPayloadForHash(
  entityType: TaskSpaceSyncEntityType,
  action: OutboxAction,
  postImage: JsonValue,
): JsonValue {
  if (action === 'delete') return genericDeleteSchema.parse(postImage)
  switch (entityType) {
    case 'project': {
      const row = cachedProjectSchema.parse(postImage)
      return {
        name: row.name, key: row.key, description: row.description,
        next_work_item_number: row.nextWorkItemNumber,
        rank: row.rank, archived_at: row.archivedAt,
      }
    }
    case 'statusDefinition': {
      const row = statusDefinitionSchema.parse(postImage)
      return {
        category: row.category, name: row.name, icon: row.icon, color: row.color,
        rank: row.rank, system: row.system, archived_at: row.archivedAt,
      }
    }
    case 'typeDefinition': {
      const row = typeDefinitionSchema.parse(postImage)
      return {
        name: row.name, icon: row.icon, color: row.color, rank: row.rank,
        system: row.system, archived_at: row.archivedAt,
      }
    }
    case 'label': {
      const row = labelSchema.parse(postImage)
      return { name: row.name, color: row.color, archived_at: row.archivedAt }
    }
    case 'workItemLabel': {
      const row = workItemLabelSchema.parse(postImage)
      return { work_item_id: row.workItemId, label_id: row.labelId }
    }
    case 'workItem': {
      const row = cachedWorkItemSchema.parse(postImage)
      return {
        project_id: row.projectId, display_key: row.displayKey,
        title: row.title, description: row.description,
        type_definition_id: row.typeDefinitionId,
        status_definition_id: row.statusDefinitionId,
        priority: row.priority, parent_id: row.parentId, child_rank: row.childRank,
        depth: row.depth, completion_window_start: row.completionWindowStart,
        completion_window_end: row.completionWindowEnd,
        review_point: row.reviewPoint, hard_deadline: row.hardDeadline,
        effort_estimate_lower_seconds: row.effortEstimateLowerSeconds,
        effort_estimate_upper_seconds: row.effortEstimateUpperSeconds,
        effort_actual_seconds: row.effortActualSeconds, confidence: row.confidence,
        completed_at: row.completedAt, cancelled_at: row.cancelledAt,
        archived_at: row.archivedAt, marked_as_attention: row.markedAsAttention,
      }
    }
    case 'workItemNote': {
      const camel = workItemNoteCommandPostImageSchema.safeParse(postImage)
      if (camel.success) return { document: camel.data.document }
      // S4 sync wire form is the server catalog's snake_case post-image; the
      // business payload for the hash is still just the document object.
      const wire = workItemNoteSyncPostImageSchema.parse(postImage)
      let parsedDocument: unknown
      try {
        parsedDocument = JSON.parse(wire.document_json)
      } catch {
        throw new Error('note_document_json_invalid')
      }
      return { document: parsedDocument as JsonValue }
    }
    default: {
      const exhaustive: never = entityType
      throw new Error(`missing Task Space hash builder: ${String(exhaustive)}`)
    }
  }
}

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
