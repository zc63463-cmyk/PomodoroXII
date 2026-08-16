import { z } from 'zod'
import { canonicalize } from 'json-canonicalize'

import type { JsonValue } from '@/lib/contracts/payload-hash'
import type {
  ApiSyncV2AckResponse,
  ApiSyncV2OperationQueryResponse,
  ApiSyncV2PullResponse,
  ApiSyncV2PushResponse,
  ApiSyncV2RecoveryResponse,
  ApiSyncV2StatusResponse,
  OutboxAction,
  RetainedLwwSyncEntityType,
} from './types'

export type IJsonValue = JsonValue

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

export function validateIJsonGraph(value: unknown): asserts value is IJsonValue {
  const pending: unknown[] = [value]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'boolean') continue
    if (typeof current === 'string') {
      if (!hasOnlyUnicodeScalarValues(current)) throw new Error('I-JSON lone surrogate')
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) ||
          (Number.isInteger(current) && !Number.isSafeInteger(current))) {
        throw new Error('I-JSON number is not finite/JS-safe')
      }
      continue
    }
    if (typeof current !== 'object') throw new Error('value is not JSON')
    if (seen.has(current)) throw new Error('JSON graph is cyclic')
    seen.add(current)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('JSON object has a non-JSON prototype')
    }
    for (const [key, child] of Object.entries(current)) {
      if (!hasOnlyUnicodeScalarValues(key)) throw new Error('I-JSON key has lone surrogate')
      pending.push(child)
    }
  }
}

export function parseIJsonTextRejectingDuplicateKeys(raw: string): IJsonValue {
  let offset = 0
  const fail = (message: string): never => {
    throw new Error(`${message} at byte/code-unit offset ${offset}`)
  }
  const skipWhitespace = (): void => {
    while (/[\t\n\r ]/.test(raw[offset] ?? '')) offset += 1
  }
  const scanString = (): string => {
    if (raw[offset] !== '"') return fail('expected JSON string')
    const start = offset++
    while (offset < raw.length) {
      const character = raw[offset++]!
      if (character === '"') return JSON.parse(raw.slice(start, offset)) as string
      if (character === '\\') {
        if (offset >= raw.length) return fail('incomplete JSON escape')
        const escaped = raw[offset++]!
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(offset, offset + 4))) {
            return fail('invalid JSON Unicode escape')
          }
          offset += 4
        } else if (!/["\\/bfnrt]/.test(escaped)) {
          return fail('invalid JSON escape')
        }
      } else if (character.charCodeAt(0) < 0x20) {
        return fail('unescaped JSON control character')
      }
    }
    return fail('unterminated JSON string')
  }
  const scanScalar = (): void => {
    const start = offset
    while (offset < raw.length && !/[\t\n\r ,\]}]/.test(raw[offset]!)) offset += 1
    if (start === offset) return fail('missing JSON scalar')
    JSON.parse(raw.slice(start, offset))
  }
  const scanValue = (): void => {
    skipWhitespace()
    if (raw[offset] === '{') {
      offset += 1
      skipWhitespace()
      const keys = new Set<string>()
      if (raw[offset] === '}') { offset += 1; return }
      while (true) {
        const key = scanString()
        if (keys.has(key)) return fail(`duplicate JSON object key ${JSON.stringify(key)}`)
        keys.add(key)
        skipWhitespace()
        if (raw[offset++] !== ':') return fail('expected JSON name separator')
        scanValue()
        skipWhitespace()
        const separator = raw[offset++]
        if (separator === '}') return
        if (separator !== ',') return fail('expected JSON object separator')
        skipWhitespace()
      }
    }
    if (raw[offset] === '[') {
      offset += 1
      skipWhitespace()
      if (raw[offset] === ']') { offset += 1; return }
      while (true) {
        scanValue()
        skipWhitespace()
        const separator = raw[offset++]
        if (separator === ']') return
        if (separator !== ',') return fail('expected JSON array separator')
        skipWhitespace()
      }
    }
    if (raw[offset] === '"') { scanString(); return }
    scanScalar()
  }
  scanValue()
  skipWhitespace()
  if (offset !== raw.length) fail('trailing JSON text')
  const parsed: unknown = JSON.parse(raw)
  validateIJsonGraph(parsed)
  return parsed
}

const shortId = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/)
const safeNonnegativeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const canonicalUtcTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .superRefine((value, context) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
    if (!match) return
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    const instant = new Date(0)
    instant.setUTCFullYear(year!, month! - 1, day!)
    instant.setUTCHours(hour!, minute!, second!, 0)
    if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month! - 1 ||
        instant.getUTCDate() !== day || instant.getUTCHours() !== hour ||
        instant.getUTCMinutes() !== minute || instant.getUTCSeconds() !== second) {
      context.addIssue({ code: 'custom', message: 'timestamp is not a real UTC instant' })
    }
  })
const nullableUtc = canonicalUtcTimestamp.nullable()
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clockText = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const retainedClockOrUtc = z.union([clockText, canonicalUtcTimestamp])
const jsonNumber = z.number().finite().refine(
  (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
  'integer JSON values must be JS-safe',
)
const jsonString = z.string().refine(hasOnlyUnicodeScalarValues)
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), jsonNumber, jsonString,
  z.array(jsonValue), z.record(z.string(), jsonValue),
]))
const retainedBase = {
  id: shortId,
  created_at: canonicalUtcTimestamp,
  updated_at: canonicalUtcTimestamp,
}

const retainedLwwOutboxPostImageSchemas = {
  note: z.strictObject({
    ...retainedBase,
    title: z.string().max(500), content: z.string(), summary: z.string().max(500),
    tags: z.array(z.string()), category: z.string().max(200).nullable(),
    folder_id: shortId.nullable(), status: z.enum(['active', 'archived']),
    trashed_at: nullableUtc,
  }),
  folder: z.strictObject({
    ...retainedBase,
    name: z.string().min(1).max(200), parent_id: shortId.nullable(),
    icon: z.string().max(50).nullable(), color: z.string().max(20).nullable(),
    sort_order: safeNonnegativeInt, is_system: z.boolean(), trashed_at: nullableUtc,
  }),
  quickNote: z.strictObject({
    ...retainedBase,
    content: z.string().max(50_000),
    mood: z.enum(['normal', 'happy', 'sad', 'tired', 'excited', 'calm']).nullable(),
    tags: z.array(z.string()), pinned: z.boolean(), archived_at: nullableUtc,
    archive_file_path: z.string().max(500).nullable(), folder_id: shortId.nullable(),
    trashed_at: nullableUtc, migrated_to_note_id: shortId.nullable(),
  }),
  reflection: z.strictObject({
    ...retainedBase,
    date: calendarDate, content: z.string().max(50_000),
    mood: z.enum(['great', 'good', 'normal', 'bad', 'terrible']).nullable(),
    tags: z.array(z.string()), sections: z.array(jsonValue), is_structured: z.boolean(),
  }),
  habit: z.strictObject({
    ...retainedBase,
    title: z.string().min(1).max(500), description: z.string().max(10_000),
    color: z.string().max(20), icon: z.string().max(20),
    target_count: safeNonnegativeInt, rest_day_protection: z.boolean(),
    rest_days: z.array(z.number().int().min(0).max(6)),
    sort_order: safeNonnegativeInt, archived: z.boolean(),
  }),
  habitCheckIn: z.strictObject({
    ...retainedBase,
    habit_id: shortId, date: calendarDate, count: safeNonnegativeInt,
    note: z.string().max(10_000),
  }),
  schedule: z.strictObject({
    ...retainedBase,
    title: z.string().min(1).max(500), due_at: canonicalUtcTimestamp,
    completed_at: nullableUtc, priority: z.enum(['high', 'medium', 'low']),
    color: z.string().max(20), all_day: z.boolean(),
    start_time: retainedClockOrUtc.nullable(), end_time: retainedClockOrUtc.nullable(),
  }),
  timeBlock: z.strictObject({
    ...retainedBase,
    title: z.string().max(500), date: calendarDate,
    start_time: retainedClockOrUtc, end_time: retainedClockOrUtc,
    planned_duration: safeNonnegativeInt, actual_duration: safeNonnegativeInt,
    block_type: z.enum(['work', 'short_break', 'long_break']),
    status: z.enum(['planned', 'in_progress', 'completed', 'skipped']),
    sort_order: safeNonnegativeInt,
  }),
  memoComment: z.strictObject({
    ...retainedBase,
    note_id: shortId, content: z.string().max(10_000),
  }),
  scheduleQuickNote: z.strictObject({
    ...retainedBase,
    schedule_id: shortId, quick_note_id: shortId,
  }),
} as const satisfies Record<RetainedLwwSyncEntityType, z.ZodTypeAny>

const retainedDeletePostImageSchema = z.strictObject({ id: shortId })

export function parseRetainedLwwOutboxPostImage(
  entityType: RetainedLwwSyncEntityType,
  action: OutboxAction,
  postImage: unknown,
): IJsonValue {
  return (action === 'delete'
    ? retainedDeletePostImageSchema
    : retainedLwwOutboxPostImageSchemas[entityType]).parse(postImage) as IJsonValue
}

export function requireCanonicalStoredTimestamp(value: string): string {
  canonicalUtcTimestamp.parse(value)
  if (new Date(value).toISOString() !== value) {
    throw new Error('timestamp is not canonical UTC')
  }
  return value
}

const operationId = z.string().superRefine((value, context) => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length < 1 || bytes.length > 128 ||
      [...bytes].some((byte) => byte < 0x21 || byte > 0x7e)) {
    context.addIssue({ code: 'custom', message: 'invalid operation/batch ID' })
  }
})
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const opaqueToken = z.string().min(16).max(2048)
const details = z.record(jsonString, jsonValue)
const eventRecord = z.strictObject({
  operation_id: operationId,
  batch_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  action: z.enum(['create', 'update', 'delete']),
  payload: z.record(jsonString, jsonValue),
  version: safeNonnegativeInt,
  created_at: canonicalUtcTimestamp,
})
const pushApplied = z.strictObject({
  operation_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  version: safeNonnegativeInt,
  resolution: z.literal('remote').nullable(),
})
const pushConflict = z.strictObject({
  operation_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  code: z.enum(['version_conflict', 'tombstone_conflict', 'cycle_detected']),
  resolution: z.enum(['local', 'tombstone', 'circular_ref', 'manual']),
  details,
})
const pushError = z.strictObject({
  operation_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  code: z.string().min(1),
  retryable: z.boolean(),
  details,
})
const pushResponse = z.strictObject({
  batch_id: operationId,
  applied: z.array(pushApplied).max(500),
  conflicts: z.array(pushConflict).max(500),
  errors: z.array(pushError).max(500),
}).superRefine((result, context) => {
  const operationIds = [
    ...result.applied.map((item) => item.operation_id),
    ...result.conflicts.map((item) => item.operation_id),
    ...result.errors.map((item) => item.operation_id),
  ]
  if (operationIds.length > 500 || new Set(operationIds).size !== operationIds.length) {
    context.addIssue({ code: 'custom', message: 'push result operation IDs invalid' })
  }
})
const operationQueryItem = z.strictObject({
  operation_id: operationId,
  state: z.enum(['unknown', 'pending', 'terminal', 'recovery_required']),
  batch_id: operationId.nullable(),
  result: pushResponse.nullable(),
}).superRefine((item, context) => {
  if (item.state === 'unknown') {
    if (item.batch_id !== null || item.result !== null) {
      context.addIssue({ code: 'custom', message: 'unknown operation exposes a binding' })
    }
  } else if (item.batch_id === null) {
    context.addIssue({ code: 'custom', message: 'known operation has no batch binding' })
  } else if (item.state === 'terminal') {
    if (item.result === null || item.result.batch_id !== item.batch_id) {
      context.addIssue({ code: 'custom', message: 'terminal operation result mismatch' })
    }
  } else if (item.result !== null) {
    context.addIssue({ code: 'custom', message: 'nonterminal operation exposes a result' })
  }
})
const operationQueryResponse = z.strictObject({
  items: z.array(operationQueryItem).min(1).max(500),
})
const recoveryResponse = z.strictObject({
  payload_jsonl_base64: z.string().max(11_184_812),
  entity_count: safeNonnegativeInt.max(500),
  chunk_sha256: hash,
  next_page_token: opaqueToken.nullable(),
  has_more: z.boolean(),
  catalog_hash: hash,
  waterline_cursor: opaqueToken,
}).superRefine((page, context) => {
  if (page.has_more !== (page.next_page_token !== null)) {
    context.addIssue({ code: 'custom', message: 'recovery token/has_more mismatch' })
  }
  try {
    const bytes = decodeCanonicalStandardBase64(page.payload_jsonl_base64)
    if (bytes.length > 8 * 1024 * 1024) throw new Error('decoded recovery page exceeds 8 MiB')
    if (bytes.length === 0) {
      if (page.entity_count !== 0) throw new Error('empty recovery page count mismatch')
      return
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.endsWith('\n')) throw new Error('canonical JSONL must end with LF')
    const lines = text.slice(0, -1).split('\n')
    if (lines.length !== page.entity_count || lines.some((line) => line.length === 0)) {
      throw new Error('recovery JSONL entity count mismatch')
    }
    for (const line of lines) {
      const parsed = parseIJsonTextRejectingDuplicateKeys(line)
      if (canonicalize(parsed) !== line) throw new Error('recovery JSONL line is not canonical')
    }
  } catch (error: unknown) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'invalid canonical recovery page',
    })
  }
})

const pullResponseBounded = z.strictObject({
  events: z.array(eventRecord).max(500),
  next_cursor: opaqueToken,
  has_more: z.boolean(),
  catalog_hash: hash,
}).superRefine((page, context) => {
  const canonical = canonicalize(page)
  if (canonical === undefined ||
      new TextEncoder().encode(canonical).byteLength > 8 * 1024 * 1024) {
    context.addIssue({ code: 'custom', message: 'canonical pull page exceeds 8 MiB' })
  }
})
const ackResponse = z.strictObject({
  client_id: shortId,
  accepted: z.literal(true),
  requires_recovery: z.boolean(),
  catalog_hash: hash,
})
const statusResponse = z.strictObject({
  catalog_hash: hash,
  client_id: shortId.nullable(),
  registered: z.boolean(),
  requires_recovery: z.boolean().nullable(),
  recovery_action: z.literal('full_recovery').nullable(),
  visible_event_count: safeNonnegativeInt,
  active_client_count: safeNonnegativeInt,
  recovery_client_count: safeNonnegativeInt,
})

export const parseSyncV2PushResponse = (value: unknown): ApiSyncV2PushResponse =>
  pushResponse.parse(value) as ApiSyncV2PushResponse

export function parseSyncV2OperationQueryResponse(
  value: unknown,
  expectedOperationIds: readonly string[],
): ApiSyncV2OperationQueryResponse {
  if (new Set(expectedOperationIds).size !== expectedOperationIds.length) {
    throw new Error('operation query expected IDs are not unique')
  }
  const parsed = operationQueryResponse.parse(value)
  if (parsed.items.length !== expectedOperationIds.length ||
      parsed.items.some((item, index) => item.operation_id !== expectedOperationIds[index])) {
    throw new Error('operation query response order/coverage mismatch')
  }
  let terminalBatchId: string | null = null
  let terminalResultCanonical: string | null = null
  for (const item of parsed.items) {
    if (item.state !== 'terminal') continue
    const result = item.result!
    const outcomeIds = [
      ...result.applied.map((outcome) => outcome.operation_id),
      ...result.conflicts.map((outcome) => outcome.operation_id),
      ...result.errors.map((outcome) => outcome.operation_id),
    ]
    if (outcomeIds.filter((id) => id === item.operation_id).length !== 1) {
      throw new Error('operation query terminal authority lacks exactly one outcome')
    }
    const resultCanonical = canonicalize(result)
    if (terminalBatchId === null) {
      terminalBatchId = item.batch_id
      terminalResultCanonical = resultCanonical
    } else if (item.batch_id !== terminalBatchId ||
               resultCanonical !== terminalResultCanonical) {
      throw new Error('operation query terminal authorities disagree on original result')
    }
  }
  return parsed as ApiSyncV2OperationQueryResponse
}

export const parseSyncV2PullResponse = (value: unknown): ApiSyncV2PullResponse =>
  pullResponseBounded.parse(value) as ApiSyncV2PullResponse
export const parseSyncV2RecoveryResponse = (value: unknown): ApiSyncV2RecoveryResponse =>
  recoveryResponse.parse(value) as ApiSyncV2RecoveryResponse
export const parseSyncV2AckResponse = (value: unknown): ApiSyncV2AckResponse =>
  ackResponse.parse(value) as ApiSyncV2AckResponse
export const parseSyncV2StatusResponse = (value: unknown): ApiSyncV2StatusResponse =>
  statusResponse.parse(value) as ApiSyncV2StatusResponse

function encodeStandardBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function decodeCanonicalStandardBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('recovery payload is not canonical standard base64')
  }
  let binary: string
  try { binary = atob(value) } catch { throw new Error('invalid recovery base64') }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeStandardBase64(bytes) !== value) {
    throw new Error('recovery base64 does not round-trip canonically')
  }
  return bytes
}
