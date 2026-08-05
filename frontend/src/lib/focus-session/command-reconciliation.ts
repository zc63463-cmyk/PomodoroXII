import { canonicalize } from 'json-canonicalize'
import type { PomodoroXIDB } from '@/services/database'
import { focusSessionAggregateSchema } from '@/lib/contracts/focus-session'
import { focusSessionApi, type ReconcileInput } from '@/services/focus-session-api'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import type { CommandReconciliationAttemptRow, SessionCommandQueueRow } from '@/types'
import { persistImmutableSessionCommandReceipts, toReviewRows } from './focus-session-repository'

type ReconciliationRequestIntent = Omit<ReconcileInput, 'operationId'>

const canonicalRequest = (request: ReconciliationRequestIntent): string => {
  const json = canonicalize(request)
  if (json === undefined) throw new Error('reconciliation_request_not_canonical')
  return json
}

const reconciliationHashPayload = (request: ReconciliationRequestIntent): JsonValue => ({
  command_ids: request.commandIds,
  replay_safe: request.replaySafe,
  abandon_command_ids: request.abandonCommandIds,
  decision_at: request.decisionAt,
})

const now = () => new Date().toISOString()

async function findAttempt(db: PomodoroXIDB, operationId: string): Promise<CommandReconciliationAttemptRow | undefined> {
  return await db.sessionCommandReconciliationAttempts.get(operationId) as CommandReconciliationAttemptRow | undefined
}

export async function prepareReconciliationAttempt(
  db: PomodoroXIDB,
  request: ReconciliationRequestIntent,
  requestedOperationId?: string,
): Promise<CommandReconciliationAttemptRow> {
  if (db.spaceId !== request.spaceId) throw new Error('reconciliation_space_mismatch')
  const requestJson = canonicalRequest(request)
  const requestHash = await hashCommandPayload(reconciliationHashPayload(request))
  return db.transaction('rw', db.sessionCommandReconciliationAttempts, async () => {
    if (requestedOperationId) {
      const bound = await findAttempt(db, requestedOperationId)
      if (bound && (bound.requestHash !== requestHash || bound.requestJson !== requestJson)) {
        throw new Error('reconciliation_operation_payload_mismatch')
      }
      if (bound?.state === 'terminal') throw new Error('reconciliation_operation_terminal')
      if (bound) return bound
    }

    const active = await db.sessionCommandReconciliationAttempts
      .toCollection()
      .filter((row) => row.spaceId === request.spaceId && row.sessionId === request.sessionId && row.state !== 'terminal')
      .toArray() as unknown as CommandReconciliationAttemptRow[]
    const reusable = active.filter((row) => {
      try {
        const previous = JSON.parse(row.requestJson) as ReconciliationRequestIntent
        return JSON.stringify(previous.commandIds) === JSON.stringify(request.commandIds)
      } catch {
        return false
      }
    })
    if (reusable.length > 1) throw new Error('reconciliation_attempt_ambiguous')
    if (reusable[0]) {
      if (reusable[0].requestHash !== requestHash || reusable[0].requestJson !== requestJson) {
        throw new Error('reconciliation_operation_payload_mismatch')
      }
      return reusable[0]
    }

    const timestamp = now()
    const row: CommandReconciliationAttemptRow = {
      operationId: requestedOperationId ?? crypto.randomUUID(),
      spaceId: request.spaceId,
      sessionId: request.sessionId,
      requestJson,
      requestHash,
      state: 'prepared',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await db.sessionCommandReconciliationAttempts.put(row as unknown as Record<string, unknown>)
    return row
  })
}

function latestReceipt(receipts: Array<Record<string, unknown>>, commandId: string): Record<string, unknown> | undefined {
  return receipts
    .filter((receipt) => receipt.commandId === commandId)
    .sort((left, right) => Number(right.attempt ?? 0) - Number(left.attempt ?? 0))[0]
}

function terminalState(value: unknown): boolean {
  return typeof value === 'string' && !['pending', 'unknown'].includes(value)
}

export class CommandReconciliation {
  constructor(
    private readonly db: PomodoroXIDB,
    private readonly api: Pick<typeof focusSessionApi, 'reconcileCommands'>,
  ) {}

  async queryOriginalBeforeReplay(sessionId: string, commandId: string) {
    return this.run(sessionId, commandId, false, [], null)
  }

  async reconcile(sessionId: string, commandId: string, requestedReplaySafe: boolean) {
    return this.run(sessionId, commandId, requestedReplaySafe, [], null)
  }

  async abandon(sessionId: string, commandId: string, decisionAt: string) {
    return this.run(sessionId, commandId, false, [commandId], decisionAt)
  }

  private async run(
    sessionId: string,
    commandId: string,
    requestedReplaySafe: boolean,
    abandonCommandIds: string[],
    decisionAt: string | null,
  ) {
    const envelope = await this.db.sessionCommandEnvelopes.get(commandId) as Record<string, unknown> | undefined
    if (!envelope) throw new Error('command_envelope_not_found')
    if (envelope.sessionId !== sessionId) throw new Error('command_session_mismatch')
    const queue = await this.db.sessionCommandQueue.get(commandId) as SessionCommandQueueRow | undefined
    if (queue?.lastReceiptState === 'abandoned') {
      throw new Error('reconciliation_abandoned_command')
    }
    const request: ReconciliationRequestIntent = {
      spaceId: String(envelope.spaceId),
      sessionId,
      commandIds: [commandId],
      replaySafe: requestedReplaySafe && envelope.replaySafe === true,
      abandonCommandIds,
      decisionAt,
    }
    const attempt = await prepareReconciliationAttempt(this.db, request)
    const boundRequest = JSON.parse(attempt.requestJson) as ReconciliationRequestIntent
    const exactBoundJson = canonicalRequest(boundRequest)
    if (exactBoundJson !== attempt.requestJson) throw new Error('reconciliation_operation_payload_mismatch')

    await this.db.transaction('rw', this.db.sessionCommandQueue, this.db.sessionCommandReconciliationAttempts, async () => {
      const claimed = await findAttempt(this.db, attempt.operationId)
      if (!claimed || claimed.state === 'terminal' || claimed.requestJson !== attempt.requestJson || claimed.requestHash !== attempt.requestHash) {
        throw new Error('reconciliation_claim_lost')
      }
      await this.db.sessionCommandQueue.update(commandId, { state: 'querying', updatedAt: now() })
      await this.db.sessionCommandReconciliationAttempts.update(attempt.operationId, { state: 'in_flight', updatedAt: now() })
    })

    let aggregate: ReturnType<typeof focusSessionAggregateSchema.parse>
    let terminal: Record<string, unknown> | undefined
    let state: 'held' | 'terminal'
    try {
      aggregate = focusSessionAggregateSchema.parse(
        await this.api.reconcileCommands({ operationId: attempt.operationId, ...boundRequest }),
      )
      const rows = await toReviewRows(this.db, aggregate, request.spaceId, sessionId)
      const receipts = await persistImmutableSessionCommandReceipts(
        this.db,
        rows.receipts,
        new Set(rows.envelopes.map((envelope) => envelope.commandId)),
      )
      terminal = latestReceipt(receipts, commandId)
      state = terminalState(terminal?.state) ? 'terminal' : 'held'
    } catch (error) {
      await this.db.sessionCommandQueue.update(commandId, { state: 'held', lastReceiptState: 'unknown', updatedAt: now() })
      throw error
    }
    await this.db.transaction('rw', this.db.sessionCommandQueue, this.db.sessionCommandReconciliationAttempts, async () => {
      await this.db.sessionCommandQueue.update(commandId, {
        state,
        lastReceiptState: terminal?.state ?? 'unknown',
        updatedAt: now(),
      })
      await this.db.sessionCommandReconciliationAttempts.update(attempt.operationId, {
        state: 'terminal', updatedAt: now(),
      })
    })
    return terminal
  }
}
