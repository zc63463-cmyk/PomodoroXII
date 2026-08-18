import { canonicalize } from 'json-canonicalize'
import type { Table } from 'dexie'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import type { DirectCommandIntentRow } from '@/types'
import type { PomodoroXIDB } from '@/services/database'

/** One canonical caller-intent timestamp is used for every newly-created row. */
export const canonicalNow = (): string => new Date().toISOString()

export type DirectCommandKind = DirectCommandIntentRow['kind']

export type DirectCommandHandlerMap = Record<DirectCommandKind, {
  executeExact(intent: DirectCommandIntentRow): Promise<void>
}>

export interface DirectCommandResumeResult {
  failed: Array<{ operationId: string; code: string }>
}

type PrepareInput = Omit<
  DirectCommandIntentRow,
  'operationId' | 'requestJson' | 'requestHash' | 'state' | 'resultJson' |
  'resultHash' | 'failureCode' | 'createdAt' | 'updatedAt'
> & {
  request: Record<string, JsonValue>
  now: string
}

/**
 * Persist one immutable direct-command envelope before transport.
 * Reusing an operation ID is allowed only when every identity field and the
 * canonical request are byte-for-byte identical.
 */
export async function prepareDirectCommandIntent(
  db: PomodoroXIDB,
  input: PrepareInput,
  requestedOperationId = crypto.randomUUID(),
): Promise<DirectCommandIntentRow> {
  const exactRequest: Record<string, JsonValue> = {
    ...input.request,
    operationId: requestedOperationId,
  }
  const requestJson = canonicalize(exactRequest)
  if (requestJson === undefined) throw new Error('direct_command_request_not_canonical')
  const requestHash = await hashCommandPayload(exactRequest)
  const row: DirectCommandIntentRow = {
    operationId: requestedOperationId,
    kind: input.kind,
    spaceId: input.spaceId,
    targetId: input.targetId,
    requestJson,
    requestHash,
    state: 'prepared',
    resultJson: null,
    resultHash: null,
    failureCode: null,
    createdAt: input.now,
    updatedAt: input.now,
  }

  return db.transaction('rw', db.directCommandIntents, async () => {
    const existing = await db.directCommandIntents.get(row.operationId)
    if (existing) {
      if (
        existing.requestJson !== row.requestJson ||
        existing.requestHash !== row.requestHash ||
        existing.kind !== row.kind ||
        existing.spaceId !== row.spaceId ||
        existing.targetId !== row.targetId
      ) {
        throw new Error('direct_command_operation_payload_mismatch')
      }
      return existing as unknown as DirectCommandIntentRow
    }
    await db.directCommandIntents.add(row as unknown as Record<string, unknown>)
    return row
  })
}

interface DurableDirectCommandInput<TResult> {
  db: PomodoroXIDB
  intent: DirectCommandIntentRow
  businessTables: Table[]
  parseResult(value: unknown): TResult
  sendExactRequest(value: Record<string, JsonValue>): Promise<unknown>
  applyResult(result: TResult): Promise<void>
  now(): string
}

/**
 * Send an immutable intent and atomically install its business post-image and
 * terminal result. A transport response loss leaves the intent in_flight so a
 * restart can retry the exact request without inventing a new operation ID.
 */
export async function executeDurableDirectCommand<TResult>(
  input: DurableDirectCommandInput<TResult>,
): Promise<TResult> {
  const exactRequest = JSON.parse(input.intent.requestJson) as Record<string, JsonValue>
  const started = await input.db.transaction(
    'rw', input.db.directCommandIntents,
    async (): Promise<{ terminal: TResult; hasTerminal: boolean }> => {
      const current = await input.db.directCommandIntents.get(input.intent.operationId)
      if (
        !current ||
        current.requestJson !== input.intent.requestJson ||
        current.requestHash !== input.intent.requestHash ||
        current.kind !== input.intent.kind ||
        current.spaceId !== input.intent.spaceId
      ) {
        throw new Error('direct_command_intent_lost')
      }
      const typed = current as unknown as DirectCommandIntentRow
      if (typed.state === 'terminal') {
        if (!typed.resultJson || !typed.resultHash) {
          throw new Error('direct_command_terminal_result_missing')
        }
        return { terminal: input.parseResult(JSON.parse(typed.resultJson)), hasTerminal: true }
      }
      if (typed.state === 'failed') throw new Error('direct_command_intent_failed')
      await input.db.directCommandIntents.update(input.intent.operationId, {
        state: 'in_flight', updatedAt: input.now(),
      })
      return { terminal: undefined as TResult, hasTerminal: false }
    },
  )
  if (started.hasTerminal) return started.terminal

  const result = input.parseResult(await input.sendExactRequest(exactRequest))
  const resultJson = canonicalize(result)
  if (resultJson === undefined) throw new Error('direct_command_result_not_canonical')
  const resultHash = await hashCommandPayload(result)

  const transaction = input.db.transaction.bind(input.db) as unknown as (...args: unknown[]) => Promise<unknown>
  await transaction(
    'rw', input.db.directCommandIntents, ...input.businessTables,
    async () => {
      const current = await input.db.directCommandIntents.get(input.intent.operationId)
      if (
        !current ||
        current.requestJson !== input.intent.requestJson ||
        current.requestHash !== input.intent.requestHash ||
        current.kind !== input.intent.kind ||
        current.state === 'terminal'
      ) {
        throw new Error('direct_command_intent_lost')
      }
      await input.applyResult(result)
      await input.db.directCommandIntents.update(input.intent.operationId, {
        state: 'terminal', resultJson, resultHash, failureCode: null, updatedAt: input.now(),
      })
    },
  )
  return result
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function responseField(value: unknown, field: string): unknown {
  if (!isRecord(value)) return undefined
  const direct = value[field]
  if (direct !== undefined) return direct
  const detail = value.detail
  return isRecord(detail) ? detail[field] : undefined
}

function nonRetryableFailureCode(error: unknown): string | null {
  const response = isRecord(error) ? error.response : undefined
  const data = isRecord(response) ? response.data : undefined
  const code = responseField(data, 'code')
  const retryable = responseField(data, 'retryable')
  return typeof code === 'string' && code.length > 0 && retryable === false ? code : null
}

async function markIntentFailed(
  db: PomodoroXIDB,
  intent: DirectCommandIntentRow,
  failureCode: string,
): Promise<void> {
  await db.transaction('rw', db.directCommandIntents, async () => {
    const current = await db.directCommandIntents.get(intent.operationId)
    if (
      !current ||
      current.requestJson !== intent.requestJson ||
      current.requestHash !== intent.requestHash ||
      current.kind !== intent.kind ||
      current.spaceId !== intent.spaceId ||
      current.state === 'terminal' ||
      current.state === 'failed'
    ) {
      throw new Error('direct_command_intent_lost')
    }
    await db.directCommandIntents.update(intent.operationId, {
      state: 'failed', failureCode, resultJson: null, resultHash: null, updatedAt: canonicalNow(),
    })
  })
}

export async function resumePendingDirectCommandIntents(
  db: PomodoroXIDB,
  handlers: DirectCommandHandlerMap,
): Promise<DirectCommandResumeResult> {
  const pending = await db.directCommandIntents
    .where('state')
    .anyOf('prepared', 'in_flight')
    .sortBy('createdAt')
  const failed: DirectCommandResumeResult['failed'] = []
  for (const row of pending) {
    const handler = handlers[row.kind as DirectCommandKind]
    if (!handler) throw new Error(`direct_command_handler_missing:${row.kind}`)
    const intent = row as unknown as DirectCommandIntentRow
    try {
      await handler.executeExact(intent)
    } catch (error) {
      const failureCode = nonRetryableFailureCode(error)
      if (!failureCode) throw error
      await markIntentFailed(db, intent, failureCode)
      failed.push({ operationId: intent.operationId, code: failureCode })
    }
  }
  return { failed }
}
