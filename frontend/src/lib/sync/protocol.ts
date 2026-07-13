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
const nonEmptyString = z.string().trim().min(1)
const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const syncEntityType = z.enum([
  'task', 'session', 'note', 'folder', 'quickNote', 'reflection', 'habit',
  'habitCheckIn', 'schedule', 'timeBlock', 'memoComment', 'sessionQuickNote',
  'scheduleQuickNote', 'taskQuickNote',
])
const entityRow = z.object({
  id: nonEmptyString,
  updated_at: isoTimestamp,
}).loose()

const requiredDomainField: Record<(typeof SYNC_PULL_KEYS)[number], string> = {
  tasks: 'title',
  sessions: 'type',
  notes: 'title',
  folders: 'name',
  quickNotes: 'content',
  reflections: 'date',
  habits: 'title',
  habitCheckIns: 'habit_id',
  schedules: 'title',
  timeBlocks: 'date',
  memoComments: 'note_id',
  sessionQuickNotes: 'session_id',
  scheduleQuickNotes: 'schedule_id',
  taskQuickNotes: 'task_id',
}
const tombstone = z.object({
  entity_type: syncEntityType,
  entity_id: nonEmptyString,
  deleted_at: isoTimestamp,
}).loose()

const entityGroups = Object.fromEntries(
  SYNC_PULL_KEYS.map((key) => [key, z.array(entityRow.refine(
    (row) => nonEmptyString.safeParse(row[requiredDomainField[key]]).success,
    `sync ${key} row requires ${requiredDomainField[key]}`,
  ))]),
) as unknown as Record<(typeof SYNC_PULL_KEYS)[number], z.ZodArray<z.ZodType<Record<string, unknown>>>>

const pageSchema = z.object({
  server_time: isoTimestamp,
  has_more: z.boolean(),
  tombstones_has_more: z.boolean(),
  next_since: z.string(),
  next_since_id: z.string(),
  next_tombstone_since_id: z.string(),
  tombstones: z.array(tombstone),
  next_cursor: nonNegativeSafeInteger.nullish(),
  cursor_version: z.union([z.literal(2), z.null()]).optional(),
  snapshot_token: z.string().nullish(),
  snapshot_offset: nonNegativeSafeInteger.nullish(),
  recovery_continuation: z.string().nullish(),
  recovery_proof: z.string().nullish(),
  ...entityGroups,
}).loose()

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
