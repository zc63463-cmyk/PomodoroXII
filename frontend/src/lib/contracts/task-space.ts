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

/**
 * ★ 2026-09-11 WorkItem 枚举值域（单一事实来源）。
 * 与后端 `backend/app/task_space/contracts.py` 的 WORK_ITEM_PRIORITY_VALUES /
 * WORK_ITEM_CONFIDENCE_VALUES 逐值一致（同源 DB CHECK）；存储值恒为英文
 * 规范值，中文标签只存在于展示层，绝不写回业务载荷。
 */
export const WORK_ITEM_PRIORITY_VALUES = ['low', 'medium', 'high', 'urgent'] as const
export const WORK_ITEM_CONFIDENCE_VALUES = ['low', 'medium', 'high'] as const
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITY_VALUES)[number]
export type WorkItemConfidence = (typeof WORK_ITEM_CONFIDENCE_VALUES)[number]

/**
 * ★ 2026-09-11 WorkItem 层级上限与派生 depth 的类型。
 * depth 是**读模型派生值**（不是实体字段，见下方 workItemSchema 注释）；
 * 类型的唯一消费方是 UI 读模型，派生实现在 lib/task-space/work-item-read-model。
 */
export const WORK_ITEM_MAX_DEPTH = 3
export type WorkItemDepth = 1 | 2 | 3

/**
 * ★ 2026-09-11 WorkItem **实体契约**：depth 被剔除。
 *
 * 契约判定：depth 是读模型派生值，不是实体字段 ——
 *   - DB 无列；后端在读取时从 parent 链派生（task_space/queries.py::_depth_of）；
 *   - sync post-image 白名单不含 depth，push 通道逐字段相等、多余字段直接拒
 *     （compiler.py WORK_ITEM_SYNC_FIELDS + _full_work_item_sync_candidate）；
 *   - 业务载荷哈希（REST typed command）也不覆盖它。
 * 因此实体契约、Dexie 业务行、业务哈希都不含 depth；UI 需要的 depth 由
 * `lib/task-space/work-item-read-model` 在读取边界派生（唯一实现）。
 * 服务端的**读投影**（GET / work-items 响应附带 depth）由 `workItemReadSchema`
 * 校验 —— 它是展示投影，不是实体字段。
 */
export const workItemSchema = z.object({
  id: entityId,
  spaceId: entityId,
  projectId: entityId,
  displayKey: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  typeDefinitionId: entityId,
  statusDefinitionId: entityId,
  priority: z.enum(WORK_ITEM_PRIORITY_VALUES).nullable(),
  parentId: entityId.nullable(),
  childRank: z.number().int().nonnegative(),
  completionWindowStart: utc.nullable(),
  completionWindowEnd: utc.nullable(),
  reviewPoint: utc.nullable(),
  hardDeadline: utc.nullable(),
  effortEstimateLowerSeconds: z.number().int().nonnegative().nullable(),
  effortEstimateUpperSeconds: z.number().int().nonnegative().nullable(),
  effortActualSeconds: z.number().int().nonnegative(),
  confidence: z.enum(WORK_ITEM_CONFIDENCE_VALUES).nullable(),
  completedAt: utc.nullable(),
  cancelledAt: utc.nullable(),
  archivedAt: utc.nullable(),
  markedAsAttention: z.boolean(),
  // D5 Y: read-only labelIds projection sourced from the work_item
  // post-image (the junction table itself never syncs standalone reads).
  labelIds: z.array(entityId).default([]),
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()

/**
 * ★ 2026-09-11 WorkItem **读投影**：GET / work-items 响应在实体之上附带服务端
 * 派生的 depth。它只用于校验读响应（展示投影），绝不进入实体存储或业务哈希。
 *
 * ★ 2026-09-12（ADR-0003）：读投影还附带**等待前态**
 * `preWaitingStatusDefinitionId`（服务端事实，只出站）。optional：
 * 旧服务端不返回它；本地 Dexie 行一律忽略该值（见 work-item-read-model）。
 */
export const workItemReadSchema = workItemSchema.extend({
  depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  preWaitingStatusDefinitionId: z.string().min(1).max(64).nullable().optional(),
})
export type WorkItemRead = z.infer<typeof workItemReadSchema>

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

// ---- Dependency domain (Relation) -----------------------------------------

/** Only these two readings block; ``relates_to`` is a non-blocking link. */
export const BLOCKING_RELATION_TYPES = ['depends_on', 'blocks'] as const
export const RELATION_TYPES = ['depends_on', 'blocks', 'relates_to'] as const

/**
 * ★ 2026-09-12（D2 / ADR-0004）：依赖解除确认的取值（目前唯一合法值）。
 * 与后端 `task_space/contracts.py::RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED`
 * 及 `queries.py` 真值表共用闭集；新增取值必须三处同步。
 */
export const RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED = 'confirmed_not_required' as const

export const relationSchema = z.object({
  id: entityId,
  spaceId: entityId,
  fromWorkItemId: entityId,
  toWorkItemId: entityId,
  relationType: z.enum(RELATION_TYPES),
  // ★ 2026-09-12（D2 / ADR-0004）：解除确认两列（服务端自持，客户端只读）。
  //   **必填可空**（不是 optional）—— 与服务端出站逐字段对齐：DB 行 / 命令
  //   后像 / sync 事件恒携带它们（z.strictObject 缺字段即拒收）。
  //   写入唯一通道 = POST /relations/{id}/resolve（ResolveDependency）。
  resolution: z.enum([RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED]).nullable(),
  resolvedAt: utc.nullable(),
  version: z.number().int().positive(),
  createdAt: utc,
  updatedAt: utc,
}).strict()

/**
 * Cross-project leak guard: a foreign endpoint is projected into FIVE fields
 * only — never note bodies, never session history.
 */
export const workItemMinimalSchema = z.object({
  id: entityId,
  displayKey: z.string(),
  projectId: entityId,
  title: z.string(),
  statusDefinitionId: entityId,
}).strict()

export type Relation = z.infer<typeof relationSchema>
export type WorkItemMinimal = z.infer<typeof workItemMinimalSchema>

export const relationEdgeSchema = z.object({
  relation: relationSchema,
  workItem: workItemMinimalSchema,
}).strict()

export const relationSetSchema = z.object({
  blockers: z.array(relationEdgeSchema),
  blocking: z.array(relationEdgeSchema),
}).strict()

export const blockedMapSchema = z.object({
  items: z.record(z.string(), z.object({
    blockedByDependency: z.boolean(),
    isBlocked: z.boolean(),
  }).strict()),
}).strict()

export type RelationEdge = z.infer<typeof relationEdgeSchema>
export type RelationSet = z.infer<typeof relationSetSchema>
export type BlockedMap = z.infer<typeof blockedMapSchema>

type TaskSpaceSyncEntityType = Extract<SyncEntityType,
  'project' | 'statusDefinition' | 'typeDefinition' | 'label' |
  'workItemLabel' | 'workItem' | 'workItemNote' | 'relation'>

const cachedProjectSchema = projectSchema.omit({ spaceId: true })
const cachedWorkItemSchema = workItemSchema.omit({ spaceId: true })
const cachedRelationSchema = relationSchema.omit({ spaceId: true })

/** Local (Dexie) row shape: the cached relation never repeats space identity. */
export type CachedRelation = z.infer<typeof cachedRelationSchema>
export { cachedRelationSchema }
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
        // ★ 2026-09-11：depth 不在业务载荷里（它是读模型派生值，后端 post-image
        // 白名单也不含它）。以前哈希覆盖 depth，与后端 canonical 载荷不一致。
        project_id: row.projectId, display_key: row.displayKey,
        title: row.title, description: row.description,
        type_definition_id: row.typeDefinitionId,
        status_definition_id: row.statusDefinitionId,
        priority: row.priority, parent_id: row.parentId, child_rank: row.childRank,
        completion_window_start: row.completionWindowStart,
        completion_window_end: row.completionWindowEnd,
        review_point: row.reviewPoint, hard_deadline: row.hardDeadline,
        effort_estimate_lower_seconds: row.effortEstimateLowerSeconds,
        effort_estimate_upper_seconds: row.effortEstimateUpperSeconds,
        effort_actual_seconds: row.effortActualSeconds, confidence: row.confidence,
        completed_at: row.completedAt, cancelled_at: row.cancelledAt,
        archived_at: row.archivedAt, marked_as_attention: row.markedAsAttention,
        // D5 Y: the label_ids projection participates in the canonical work
        // item business hash exactly like every other sync post-image field.
        label_ids: row.labelIds,
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
    case 'relation': {
      const row = cachedRelationSchema.parse(postImage)
      // The derived relation id is NOT part of the business payload: it is a
      // pure function of space + endpoints + type, which the server already
      // holds.  Hashing it would make the envelope self-referential.
      return {
        from_work_item_id: row.fromWorkItemId,
        to_work_item_id: row.toWorkItemId,
        relation_type: row.relationType,
      }
    }
    default: {
      const exhaustive: never = entityType
      throw new Error(`missing Task Space hash builder: ${String(exhaustive)}`)
    }
  }
}

export const projectPageSchema = z.object({ items: z.array(projectSchema), nextCursor: z.string().nullable() }).strict()
// ★ 2026-09-11：列表响应是读投影（带 depth），用 workItemReadSchema 校验。
export const workItemPageSchema = z.object({ items: z.array(workItemReadSchema), nextCursor: z.string().nullable() }).strict()
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
/** 实体（无 depth）：post-image / 本地业务行 / 业务哈希的输入。 */
export type WorkItem = z.infer<typeof workItemSchema>
/** 读投影（含服务端或本地派生的 depth）：UI 消费的视图。 */
export type WorkItemView = WorkItemRead
export type Label = z.infer<typeof labelSchema>
export type WorkItemNote = z.infer<typeof workItemNoteSchema>
export type WorkItemNoteView = WorkItemNote
export type TaskSpaceDefinitions = z.infer<typeof definitionsSchema>

/**
 * ★ 2026-09-11 REST typed-command 的规范业务载荷（RFC 8785 哈希输入）。
 *
 * 与后端 `task_space/module.py::_business_payload` 逐字对应，并由两侧共享的
 * fixture `task_space_session_payload_hash_vectors.json` 锁定哈希。depth 不在
 * 其中 —— 后端 post-image 白名单也没有它（读模型派生值，不是实体字段）。
 */
export const workItemCreateBusinessPayload = (input: {
  title: string
  description: string | null
  parent_id: string | null
  type_definition_id: string | null
  status_definition_id: string | null
  priority: string | null
}): Record<string, JsonValue> => ({
  title: input.title,
  description: input.description,
  parent_id: input.parent_id,
  type_definition_id: input.type_definition_id,
  status_definition_id: input.status_definition_id,
  priority: input.priority,
})

/** PATCH 的业务载荷：只含调用方显式给出的字段（显式 null 保留在哈希里）。 */
export const workItemPatchBusinessPayload = (
  patch: Record<string, JsonValue>,
): Record<string, JsonValue> => ({ patch })

export const parseProject = (value: unknown) => projectSchema.parse(value)
export const parseDefinitions = (value: unknown) => definitionsSchema.parse(value)
// ★ 2026-09-11：读接口返回读投影（带 depth），因此用 workItemReadSchema。
export const parseWorkItem = (value: unknown) => workItemReadSchema.parse(value)
export const parseWorkItemNote = (value: unknown) => workItemNoteSchema.parse(value)
export const parseNoteDocument = (value: unknown) => workItemNoteDocumentSchema.parse(typeof value === 'string' ? JSON.parse(value) : value)

export function assertResponseSpace<T extends { spaceId: string }>(value: T, expectedSpaceId: string): T {
  if (value.spaceId !== expectedSpaceId) throw new Error(`space_scope_mismatch:${value.spaceId}:${expectedSpaceId}`)
  return value
}
