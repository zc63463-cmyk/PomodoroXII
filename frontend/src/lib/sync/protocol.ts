import { z } from 'zod'
import type { components } from '@/types/api-generated'
import {
  SYNC_PULL_KEYS,
  type ApiSyncFullResponse,
  type ApiSyncPullResponse,
  type SyncAckResponse,
  type SyncClientRegistrationResponse,
} from './types'

export class SyncProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SyncProtocolError'
  }
}

export class SnapshotRecoveryError extends SyncProtocolError {
  readonly recoveryAction = 'restart_full_sync'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SnapshotRecoveryError'
  }
}

const isoTimestamp = z.string().datetime({ offset: true })
const nullableTimestamp = isoTimestamp.nullable()
const nonEmptyString = z.string().trim().min(1)
const wireId = z.string()
  .min(1)
  .max(36)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'invalid wire id')
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const nonNegativeSafeInteger = safeInteger.min(0)
const positiveSafeInteger = safeInteger.min(1)
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day
}, 'invalid calendar date')
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
const clockTimeOrTimestamp = z.union([clockTime, isoTimestamp])
const nullableWireId = wireId.nullable()
const stringArray = z.array(z.string())
const wireStringArray = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  if (value === '') return []
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, stringArray)
const reflectionSection = z.record(z.string(), z.unknown())
const wireReflectionSections = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  if (value === '') return []
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, z.array(reflectionSection))
const wireRestDays = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  if (value === '') return []
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, z.array(safeInteger))
const cognitiveMarkRecord = z.record(z.string(), z.number().finite())
const wireCognitiveMarkSummary = z.string().max(10000).nullable().transform((value) => {
  if (value === null || value === '') return value
  try {
    const parsed = JSON.parse(value)
    const result = cognitiveMarkRecord.safeParse(parsed)
    return result.success ? result.data : value
  } catch {
    return value
  }
})
const contentHash = z.union([z.literal(''), z.string().regex(/^[0-9a-f]{64}$/i)])
const entityBase = {
  id: wireId,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  version: positiveSafeInteger,
}

function entitySchema<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...entityBase, ...shape }).strict()
}

const taskEntity = entitySchema({
  title: z.string().max(500),
  description: z.string().max(10000),
  status: z.enum(['todo', 'in_progress', 'done', 'archived']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  tags: stringArray,
  plan: z.string().max(10000),
  completion: z.string().max(10000),
  due_date: nullableTimestamp,
  estimated_pomodoros: safeInteger,
  actual_pomodoros: safeInteger,
  archived_at: nullableTimestamp,
})

const sessionEntity = entitySchema({
  task_id: nullableWireId,
  type: z.enum(['work', 'short_break', 'long_break', 'free', 'countdown']),
  duration: safeInteger,
  completed: z.boolean(),
  plan: z.string().max(10000),
  completion: z.string().max(10000),
  started_at: isoTimestamp,
  ended_at: nullableTimestamp,
  mood: z.enum(['great', 'good', 'normal', 'bad', 'terrible']).nullable(),
  note: z.string().max(10000),
  attention_score: safeInteger.min(0).max(100).nullable(),
  flow_state_detected: z.boolean().nullable(),
  flow_state_confidence: z.number().min(0).max(1).nullable(),
  interruption_count: nonNegativeSafeInteger.nullable(),
  total_interruption_duration: nonNegativeSafeInteger.nullable(),
  avg_recovery_time: nonNegativeSafeInteger.nullable(),
  pause_count: nonNegativeSafeInteger.nullable(),
  total_pause_duration: nonNegativeSafeInteger.nullable(),
  cognitive_mark_summary: wireCognitiveMarkSummary,
})

const noteEntity = entitySchema({
  title: z.string().max(500),
  content_hash: contentHash,
  word_count: nonNegativeSafeInteger,
  summary: z.string().max(500),
  tags: stringArray,
  category: z.string().max(200).nullable(),
  folder_id: nullableWireId,
  status: z.enum(['active', 'archived']),
  trashed_at: nullableTimestamp,
  content: z.string(),
  content_missing: z.boolean(),
}).superRefine((note, context) => {
  if (note.content_missing && note.content !== '') {
    context.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'content_missing note must carry an empty placeholder body',
    })
  }
})

const folderEntity = entitySchema({
  name: z.string().max(200),
  parent_id: nullableWireId,
  icon: z.string().max(50).nullable(),
  color: z.string().max(20).nullable(),
  sort_order: safeInteger,
  is_system: z.boolean(),
  trashed_at: nullableTimestamp,
}).refine((folder) => folder.parent_id !== folder.id, {
  path: ['parent_id'],
  message: 'folder cannot be its own parent',
})

const quickNoteEntity = entitySchema({
  content: z.string().max(50000),
  mood: z.enum(['normal', 'happy', 'sad', 'tired', 'excited', 'calm']).nullable(),
  tags: stringArray,
  pinned: z.boolean(),
  archived_at: nullableTimestamp,
  archive_file_path: z.string().max(500).nullable(),
  folder_id: nullableWireId,
  trashed_at: nullableTimestamp,
  migrated_to_note_id: nullableWireId,
  session_id: nullableWireId,
})

const reflectionEntity = entitySchema({
  date: calendarDate,
  content: z.string().max(50000),
  mood: z.enum(['great', 'good', 'normal', 'bad', 'terrible']).nullable(),
  related_task_ids: wireStringArray,
  tags: stringArray,
  sections: wireReflectionSections,
  is_structured: z.boolean(),
  auto_linked_session_ids: wireStringArray,
})

const habitEntity = entitySchema({
  title: z.string().max(500),
  description: z.string().max(10000),
  color: z.string().max(20),
  icon: z.string().max(20),
  target_count: safeInteger,
  rest_day_protection: z.boolean(),
  rest_days: wireRestDays,
  sort_order: safeInteger,
  archived: z.boolean(),
})

const habitCheckInEntity = entitySchema({
  habit_id: wireId,
  date: calendarDate,
  count: safeInteger,
  note: z.string().max(10000),
})

const scheduleEntity = entitySchema({
  title: z.string().max(500),
  due_at: isoTimestamp,
  completed_at: nullableTimestamp,
  priority: z.enum(['high', 'medium', 'low']),
  color: z.string().max(20),
  all_day: z.boolean(),
  start_time: clockTimeOrTimestamp.nullable(),
  end_time: clockTimeOrTimestamp.nullable(),
})

const timeBlockEntity = entitySchema({
  task_id: nullableWireId,
  title: z.string().max(500),
  date: calendarDate,
  start_time: clockTimeOrTimestamp,
  end_time: clockTimeOrTimestamp,
  planned_duration: nonNegativeSafeInteger,
  actual_duration: nonNegativeSafeInteger,
  block_type: z.enum(['work', 'short_break', 'long_break']),
  status: z.enum(['planned', 'in_progress', 'completed', 'skipped']),
  sort_order: safeInteger,
})

const memoCommentEntity = entitySchema({
  note_id: wireId,
  content: z.string().max(10000),
})

const sessionQuickNoteEntity = entitySchema({
  session_id: wireId,
  quick_note_id: wireId,
})

const scheduleQuickNoteEntity = entitySchema({
  schedule_id: wireId,
  quick_note_id: wireId,
})

const taskQuickNoteEntity = entitySchema({
  task_id: wireId,
  quick_note_id: wireId,
})

function upsertOperation<EntityType extends string, Schema extends z.ZodType>(
  entityType: EntityType,
  schema: Schema,
) {
  return z.object({
    operation: z.literal('upsert'),
    entity_type: z.literal(entityType),
    payload: schema,
  }).strict()
}

const entitySchemaRegistry = {
  task: { pullKey: 'tasks', operation: upsertOperation('task', taskEntity) },
  session: { pullKey: 'sessions', operation: upsertOperation('session', sessionEntity) },
  note: { pullKey: 'notes', operation: upsertOperation('note', noteEntity) },
  folder: { pullKey: 'folders', operation: upsertOperation('folder', folderEntity) },
  quickNote: { pullKey: 'quickNotes', operation: upsertOperation('quickNote', quickNoteEntity) },
  reflection: { pullKey: 'reflections', operation: upsertOperation('reflection', reflectionEntity) },
  habit: { pullKey: 'habits', operation: upsertOperation('habit', habitEntity) },
  habitCheckIn: {
    pullKey: 'habitCheckIns', operation: upsertOperation('habitCheckIn', habitCheckInEntity),
  },
  schedule: { pullKey: 'schedules', operation: upsertOperation('schedule', scheduleEntity) },
  timeBlock: { pullKey: 'timeBlocks', operation: upsertOperation('timeBlock', timeBlockEntity) },
  memoComment: {
    pullKey: 'memoComments', operation: upsertOperation('memoComment', memoCommentEntity),
  },
  sessionQuickNote: {
    pullKey: 'sessionQuickNotes',
    operation: upsertOperation('sessionQuickNote', sessionQuickNoteEntity),
  },
  scheduleQuickNote: {
    pullKey: 'scheduleQuickNotes',
    operation: upsertOperation('scheduleQuickNote', scheduleQuickNoteEntity),
  },
  taskQuickNote: {
    pullKey: 'taskQuickNotes', operation: upsertOperation('taskQuickNote', taskQuickNoteEntity),
  },
} as const
const syncEntityType = z.enum(Object.keys(entitySchemaRegistry) as [
  keyof typeof entitySchemaRegistry,
  ...(keyof typeof entitySchemaRegistry)[],
])
const tombstone = z.object({
  entity_type: syncEntityType,
  entity_id: wireId,
  deleted_at: isoTimestamp,
}).strict()
const deleteOperation = z.object({
  operation: z.literal('delete'),
  tombstone,
}).strict()
const syncOperation = z.union([
  entitySchemaRegistry.task.operation,
  entitySchemaRegistry.session.operation,
  entitySchemaRegistry.note.operation,
  entitySchemaRegistry.folder.operation,
  entitySchemaRegistry.quickNote.operation,
  entitySchemaRegistry.reflection.operation,
  entitySchemaRegistry.habit.operation,
  entitySchemaRegistry.habitCheckIn.operation,
  entitySchemaRegistry.schedule.operation,
  entitySchemaRegistry.timeBlock.operation,
  entitySchemaRegistry.memoComment.operation,
  entitySchemaRegistry.sessionQuickNote.operation,
  entitySchemaRegistry.scheduleQuickNote.operation,
  entitySchemaRegistry.taskQuickNote.operation,
  deleteOperation,
])
const entityGroups = Object.fromEntries(
  Object.entries(entitySchemaRegistry).map(([entityType, { pullKey }]) => [
    pullKey,
    z.array(z.preprocess(
      (payload) => ({ operation: 'upsert', entity_type: entityType, payload }),
      syncOperation,
    ).transform((operation) => {
      if (operation.operation !== 'upsert') throw new Error('expected upsert operation')
      return operation.payload
    })),
  ]),
) as unknown as Record<
  (typeof SYNC_PULL_KEYS)[number],
  z.ZodArray<z.ZodType<Record<string, unknown>>>
>
const tombstoneGroup = z.array(z.preprocess(
  (value) => ({ operation: 'delete', tombstone: value }),
  syncOperation,
).transform((operation) => {
  if (operation.operation !== 'delete') throw new Error('expected delete operation')
  return operation.tombstone
}))

const pageSchema = z.object({
  server_time: isoTimestamp,
  has_more: z.boolean(),
  tombstones_has_more: z.boolean(),
  next_since: z.string(),
  next_since_id: z.string(),
  next_tombstone_since_id: z.string(),
  tombstones: tombstoneGroup,
  next_cursor: nonNegativeSafeInteger.nullish(),
  cursor_version: z.union([z.literal(2), z.null()]).optional(),
  snapshot_token: z.string().nullish(),
  snapshot_offset: nonNegativeSafeInteger.nullish(),
  recovery_continuation: z.string().nullish(),
  recovery_proof: z.string().nullish(),
  is_full: z.boolean().optional(),
  ...entityGroups,
}).strict()

type ParsedPage = z.infer<typeof pageSchema>
type ProtocolName = 'legacy' | 'materialized'

export interface SyncPullParseContext {
  requestCursor: number | null
  since: string
  sinceId: string
  tombstoneSinceId: string
}

export interface SyncFullParseContext {
  protocol: ProtocolName | null
  snapshotToken: string | null
  expectedSnapshotOffset: number
  snapshotCursor: number | null
  recoveryRequired: boolean
}

const registrationSchema = z.object({
  client_id: nonEmptyString,
  display_name: z.string().nullable(),
  ack_cursor: nonNegativeSafeInteger,
  lease_expires_at: isoTimestamp,
  snapshot_required: z.boolean(),
}).strict()

const ackSchema = z.object({
  ack_cursor: nonNegativeSafeInteger,
  lease_expires_at: isoTimestamp,
  retention_floor: nonNegativeSafeInteger,
  current_cursor: nonNegativeSafeInteger,
}).strict()

function protocolError(message: string, cause?: unknown): never {
  throw new SyncProtocolError(message, { cause })
}

function snapshotError(message: string, cause?: unknown): never {
  throw new SnapshotRecoveryError(message, { cause })
}

function hasValue(page: ParsedPage, key: keyof ParsedPage): boolean {
  return page[key] !== undefined && page[key] !== null
}

function hasSnapshotOrRecoveryValue(page: ParsedPage): boolean {
  return hasValue(page, 'snapshot_token')
    || hasValue(page, 'snapshot_offset')
    || hasValue(page, 'recovery_continuation')
    || hasValue(page, 'recovery_proof')
}

function parsePage(input: unknown, snapshot: boolean): ParsedPage {
  const result = pageSchema.safeParse(input)
  if (result.success) return result.data
  if (snapshot) snapshotError('sync snapshot response has an invalid structure', result.error)
  return protocolError('sync pull response has an invalid structure', result.error)
}

function isTerminal(page: ParsedPage): boolean {
  return !page.has_more && !page.tombstones_has_more
}

function assertLegacyContinuation(page: ParsedPage, context: SyncPullParseContext): void {
  const timeMovedBack = page.next_since < context.since
  const entityMovedBack = page.next_since === context.since && page.next_since_id < context.sinceId
  const tombstoneMovedBack = page.next_since === context.since
    && page.next_tombstone_since_id < context.tombstoneSinceId
  const unchanged = page.next_since === context.since
    && page.next_since_id === context.sinceId
    && page.next_tombstone_since_id === context.tombstoneSinceId
  if (timeMovedBack || entityMovedBack || tombstoneMovedBack || (!isTerminal(page) && unchanged)) {
    protocolError('sync legacy continuation moved backwards or did not advance')
  }
}

export function parseSyncClientRegistrationResponse(
  input: unknown,
  expectedClientId: string,
): SyncClientRegistrationResponse {
  const result = registrationSchema.safeParse(input)
  if (!result.success || result.data.client_id !== expectedClientId) {
    protocolError('sync client registration returned an invalid response', result.error)
  }
  return result.data
}

export function parseSyncAckResponse(input: unknown, expectedAckCursor: number): SyncAckResponse {
  const result = ackSchema.safeParse(input)
  if (!result.success) protocolError('sync ACK returned an invalid response', result.error)
  const data = result.data
  if (
    data.ack_cursor !== expectedAckCursor
    || data.ack_cursor > data.current_cursor
    || data.retention_floor > data.ack_cursor
  ) {
    protocolError('sync ACK response did not prove the pending cursor was acknowledged')
  }
  return data
}

export function parseSyncPullResponse(
  input: unknown,
  context: SyncPullParseContext,
): ApiSyncPullResponse {
  const page = parsePage(input, false)
  if (page.cursor_version === 2) {
    if (page.next_cursor == null) protocolError('sync cursor v2 response requires next_cursor')
    const requestedCursor = context.requestCursor ?? -1
    if (
      (!isTerminal(page) && page.next_cursor <= requestedCursor)
      || (isTerminal(page) && page.next_cursor < requestedCursor)
    ) {
      protocolError('sync cursor v2 continuation moved backwards or did not advance')
    }
    if (hasSnapshotOrRecoveryValue(page)) {
      protocolError('sync cursor v2 pull response contains snapshot recovery fields')
    }
  } else {
    if (hasValue(page, 'next_cursor') || hasSnapshotOrRecoveryValue(page)) {
      protocolError('sync legacy pull response contains v2 or snapshot recovery fields')
    }
    assertLegacyContinuation(page, context)
  }
  return page as ApiSyncPullResponse
}

export function parseSyncFullResponse(
  input: unknown,
  context: SyncFullParseContext,
): ApiSyncFullResponse {
  const materializedInput = (
    typeof input === 'object'
    && input !== null
    && (input as Record<string, unknown>).cursor_version === 2
  ) || context.protocol === 'materialized'
  const page = parsePage(input, materializedInput)

  if ((page as ParsedPage & { is_full?: unknown }).is_full !== true) {
    if (materializedInput) snapshotError('sync snapshot response requires is_full=true')
    protocolError('sync full response requires is_full=true')
  }

  const protocol: ProtocolName = page.cursor_version === 2 ? 'materialized' : 'legacy'
  if (context.protocol !== null && protocol !== context.protocol) {
    snapshotError('sync snapshot protocol changed during pagination')
  }

  if (protocol === 'legacy') {
    if (hasValue(page, 'next_cursor') || hasSnapshotOrRecoveryValue(page)) {
      protocolError('sync legacy full response contains materialized snapshot fields')
    }
    return page as unknown as ApiSyncFullResponse
  }

  if (page.notes.some((note) => note.content_missing === true)) {
    snapshotError('sync materialized snapshot cannot contain missing note content')
  }
  if (
    !hasValue(page, 'snapshot_token')
    || !hasValue(page, 'snapshot_offset')
    || page.next_cursor == null
  ) {
    snapshotError('sync materialized snapshot requires token, offset, and cursor')
  }
  const token = page.snapshot_token!.trim()
  if (token.length === 0) snapshotError('sync materialized snapshot requires a non-empty token')
  if (context.snapshotToken !== null && token !== context.snapshotToken) {
    snapshotError('sync snapshot token changed during pagination')
  }
  if (context.snapshotCursor !== null && page.next_cursor !== context.snapshotCursor) {
    snapshotError('sync snapshot cursor changed during pagination')
  }
  const isContinuationPage = context.snapshotToken !== null || context.expectedSnapshotOffset > 0
  if (
    (!isTerminal(page) && page.snapshot_offset! <= context.expectedSnapshotOffset)
    || (isTerminal(page) && (
      page.snapshot_offset! < context.expectedSnapshotOffset
      || (isContinuationPage && page.snapshot_offset! === context.expectedSnapshotOffset)
    ))
  ) {
    snapshotError('sync snapshot continuation did not advance')
  }

  const continuation = page.recovery_continuation?.trim() || null
  const proof = page.recovery_proof?.trim() || null
  if (!isTerminal(page)) {
    if (continuation === null) snapshotError('sync snapshot non-terminal page requires recovery_continuation')
    if (proof !== null) snapshotError('sync snapshot non-terminal page forbids recovery_proof')
  } else {
    if (continuation !== null) snapshotError('sync snapshot terminal page forbids recovery_continuation')
    if (context.recoveryRequired && proof === null) {
      snapshotError('sync snapshot terminal page requires recovery_proof')
    }
    if (!context.recoveryRequired && proof !== null) {
      snapshotError('sync snapshot terminal page forbids recovery_proof')
    }
  }
  return page as unknown as ApiSyncFullResponse
}

export type GeneratedSyncAckResponse = components['schemas']['SyncAckResponse']
export type GeneratedSyncClientRegistrationResponse = components['schemas']['SyncClientRegistrationResponse']
