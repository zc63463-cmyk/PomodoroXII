import Dexie from 'dexie'
import { canonicalize } from 'json-canonicalize'
import { assertResponseSpace } from '@/lib/contracts/task-space'
import {
  activeSessionSchema,
  activateProvisionalPayloadSchema,
  deriveClockStateFromPersistedFacts,
  focusSessionAggregateSchema,
  focusSessionCommandPostImageSchema,
  sessionCommandReceiptSchema,
  sessionCommandReceiptWireSchema,
  sessionAttributionRevisionCommandPostImageSchema,
  sessionTaskContextCommandPostImageSchema,
  sessionWorkItemPlanCommandPostImageSchema,
  sessionReviewDraftSchema,
  type FocusSessionAggregateView,
  type SessionCommandReceiptView,
  type SessionCommandReceiptWireView,
  type ProvisionalActivationPayload,
} from '@/lib/contracts/focus-session'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import { canonicalNow, executeDurableDirectCommand, prepareDirectCommandIntent } from '@/lib/direct-command-intents'
import { requirePersistedExactSessionReviewDraft, type SessionReviewDraft } from './session-review-draft-registry'
import { focusSessionApi } from '@/services/focus-session-api'
import { TS3_LOCAL_ENTITY_TO_TABLE } from '@/lib/sync/types'
import { boundedChildOperationId, enqueueOutbox } from '@/lib/sync/outbox'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  withSpaceAuthorityFence,
  type SpaceAuthorityToken,
} from '@/lib/sync/space-authority-fence'
import {
  claimProvisionalOperation,
  transitionProvisionalOperation,
} from '@/lib/sync/provisional-operation-authority'
import { parseAndValidateTerminalEvidenceResult } from '@/lib/sync/authority-identity'
import type { PomodoroXIDB } from '@/services/database'
import {
  buildProvisionalOperationRow,
  type CanonicalProvisionalStartIntent,
  type MetaDB,
  type ProvisionalOperationRow,
} from '@/services/meta-database'
import type {
  CachedFocusSession,
  CachedSessionAttributionRevision,
  CachedSessionCommandEnvelope,
  CachedSessionTaskContext,
  CachedSessionWorkItemOutcome,
  CachedSessionWorkItemPlan,
  DirectCommandIntentRow,
  SessionActivationApplicationReceiptRow,
  SessionActivationConflictRow,
  SessionReviewDraftRow,
} from '@/types'
import type { ProvisionalOperationLock } from './provisional-operation-lock'

export interface TabIdentity {
  deviceId: string
  tabId: string
}

export interface LocalFocusSessionAggregate {
  session: CachedFocusSession
  context: CachedSessionTaskContext | null
  attribution: CachedSessionAttributionRevision
  plan: CachedSessionWorkItemPlan[]
  outcomes: CachedSessionWorkItemOutcome[]
  commandEnvelopes: CachedSessionCommandEnvelope[]
  commandReceipts: Array<Record<string, unknown>>
}

export type ProvisionalStartInput = CanonicalProvisionalStartIntent

export interface FocusSessionRows {
  session: CachedFocusSession
  context: CachedSessionTaskContext | null
  attributions: CachedSessionAttributionRevision[]
  plans: CachedSessionWorkItemPlan[]
  outcomes: CachedSessionWorkItemOutcome[]
  envelopes: CachedSessionCommandEnvelope[]
  receipts: Array<Record<string, unknown>>
}

type LocalFocusSessionAggregateView = Omit<FocusSessionAggregateView, 'commandReceipts'> & {
  commandReceipts: SessionCommandReceiptView[]
}

export async function resumeImportedProvisionalReviews(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const draftRows = await db.sessionReviewDrafts
    .where('spaceId').equals(spaceId).sortBy('sessionId') as unknown as SessionReviewDraftRow[]
  for (const draftRow of draftRows) {
    const draft = sessionReviewDraftSchema.parse(JSON.parse(draftRow.draftJson))
    if (draft.spaceId !== spaceId || draft.sessionId !== draftRow.sessionId ||
        draft.operationId !== draftRow.operationId) {
      throw new Error('imported_review_draft_identity_mismatch')
    }
    const roots = await meta.provisionalOperations.where('sessionId').equals(draft.sessionId)
      .and((row) => row.spaceId === spaceId && row.state === 'transport_resolved').toArray()
    if (roots.length === 0) continue
    if (roots.length !== 1) throw new Error('imported_review_root_ambiguous')
    const root = roots[0]!
    if (!root.terminalEvidenceId || !root.terminalResultSha256 ||
        !root.terminalOperationIdsSha256 || !root.transportReadyRootSha256) {
      throw new Error('imported_review_transport_resolution_incomplete')
    }
    const evidence = await db.syncTerminalApplications.get(root.terminalEvidenceId)
    if (!evidence || evidence.state !== 'meta_reconciled' || evidence.spaceId !== spaceId ||
        evidence.compoundOperationId !== root.operationId ||
        evidence.resultSha256 !== root.terminalResultSha256 ||
        evidence.operationIdsSha256 !== root.terminalOperationIdsSha256 ||
        evidence.readyRoots.length !== 1 ||
        evidence.readyRoots[0]!.rootKind !== 'compound' ||
        evidence.readyRoots[0]!.rootId !== root.operationId ||
        evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256) {
      throw new Error('imported_review_terminal_evidence_mismatch')
    }
    const terminal = await parseAndValidateTerminalEvidenceResult(evidence)
    const importedRoot = evidence.readyRoots[0]!
    const focusChildren = importedRoot.orderedChildren.filter((child) =>
      child.entityType === 'focusSession' && child.entityId === draft.sessionId &&
      child.action === 'create' && child.compoundOperationId === root.operationId)
    if (terminal.conflicts.length !== 0 || terminal.errors.length !== 0 ||
        terminal.applied.length !== evidence.operationIds.length ||
        evidence.appliedCount !== evidence.operationIds.length || focusChildren.length !== 1 ||
        !terminal.applied.some((item) => item.operation_id === focusChildren[0]!.operationId &&
          item.entity_type === 'focusSession' && item.entity_id === draft.sessionId)) {
      throw new Error('imported_review_root_not_fully_applied')
    }
    const existingIntent = await db.directCommandIntents.get(
      draft.operationId,
    ) as unknown as DirectCommandIntentRow | undefined
    let intent: DirectCommandIntentRow
    if (existingIntent) {
      const exactRequest = sessionReviewDraftSchema.parse(JSON.parse(existingIntent.requestJson))
      const { expectedVersion: _persistedCas, ...persistedBusiness } = exactRequest
      const { expectedVersion: _preImportCas, ...draftBusiness } = draft
      if (existingIntent.kind !== 'submit_review' ||
          existingIntent.spaceId !== spaceId ||
          existingIntent.targetId !== draft.sessionId ||
          !['prepared', 'in_flight'].includes(existingIntent.state) ||
          exactRequest.operationId !== draft.operationId ||
          exactRequest.expectedVersion <= 0 ||
          canonicalize(exactRequest) !== existingIntent.requestJson ||
          canonicalize(persistedBusiness) !== canonicalize(draftBusiness) ||
          await hashCommandPayload(exactRequest) !== existingIntent.requestHash) {
        throw new Error('imported_review_existing_intent_mismatch')
      }
      intent = existingIntent
    } else {
      const session = await db.focusSessions.get(
        draft.sessionId,
      ) as unknown as CachedFocusSession | undefined
      const outcomes = await db.sessionWorkItemOutcomes.where('sessionId').equals(draft.sessionId).count()
      if (!session || session.version <= 0 || session.endedAt === null ||
          session.clockState !== 'ended' || session.ownershipState !== 'local_provisional' ||
          session.validity !== 'pending' || session.reviewState !== 'pending' || outcomes !== 0) {
        throw new Error('imported_review_authoritative_session_not_ready')
      }
      intent = await prepareDirectCommandIntent(db, {
        kind: 'submit_review', spaceId, targetId: draft.sessionId,
        request: sessionReviewDraftSchema.parse({ ...draft, expectedVersion: session.version }),
        now: canonicalNow(),
      }, draft.operationId)
    }
    await executeDurableDirectCommand({
      db, intent,
      businessTables: [db.focusSessions, db.sessionWorkItemOutcomes,
        db.sessionCommandEnvelopes, db.sessionCommandReceipts,
        db.sessionCommandQueue, db.sessionReviewDrafts],
      sendExactRequest: (request) => focusSessionApi.submitReview(
        sessionReviewDraftSchema.parse(request),
      ),
      parseResult: (value) => focusSessionAggregateSchema.parse(value),
      applyResult: (response) => applyAuthoritativeReviewAndClearDraft(
        db, spaceId, draft.sessionId, intent.requestJson, 'import_rebased', response,
      ),
      now: canonicalNow,
    })
  }
}

function receiptContent(receipt: SessionCommandReceiptView): string {
  const value = {
    commandId: receipt.commandId,
    state: receipt.state,
    errorCode: receipt.errorCode,
    detail: receipt.detail,
    recordedAt: receipt.recordedAt,
    ...(receipt.retryable === undefined ? {} : { retryable: receipt.retryable }),
    ...(receipt.result === undefined ? {} : { result: receipt.result }),
  }
  const canonical = canonicalize(value)
  if (canonical === undefined) throw new Error('session_command_receipt_not_canonical')
  return canonical
}

function assertReceiptEnvelopeMembership(
  receipts: SessionCommandReceiptView[],
  envelopes: Array<{ commandId: string }>,
): void {
  const envelopeIds = new Set(envelopes.map((envelope) => envelope.commandId))
  if (envelopeIds.size !== envelopes.length ||
      receipts.some((receipt) => !envelopeIds.has(receipt.commandId))) {
    throw new Error('authoritative_review_response_receipt_mismatch')
  }
  const receiptKeys = new Set(receipts.map((receipt) => `${receipt.commandId}\0${receipt.attempt}`))
  if (receiptKeys.size !== receipts.length) {
    throw new Error('authoritative_review_response_receipt_mismatch')
  }
}

function isLocalReceipt(receipt: SessionCommandReceiptWireView): receipt is SessionCommandReceiptView {
  return 'attempt' in receipt && 'recordedAt' in receipt
}

export async function normalizeSessionCommandReceipts(
  database: PomodoroXIDB,
  rawReceipts: unknown[],
): Promise<SessionCommandReceiptView[]> {
  const parsed = rawReceipts.map((raw) => sessionCommandReceiptWireSchema.parse(raw))
  const commandIds = [...new Set(parsed.map((receipt) => receipt.commandId))]
  const existing = (await database.sessionCommandReceipts.toArray())
    .filter((receipt) => commandIds.includes(receipt.commandId))
    .sort((left, right) => left.attempt - right.attempt)
  const known = new Map<string, SessionCommandReceiptView[]>()
  for (const receipt of existing) {
    const rows = known.get(receipt.commandId) ?? []
    rows.push(receipt)
    known.set(receipt.commandId, rows)
  }

  const normalized: SessionCommandReceiptView[] = []
  for (const receipt of parsed) {
    if (isLocalReceipt(receipt)) {
      const local = sessionCommandReceiptSchema.parse(receipt)
      const rows = known.get(local.commandId) ?? []
      const sameIdentity = rows.find((row) => row.attempt === local.attempt)
      if (sameIdentity && receiptContent(sameIdentity) !== receiptContent(local)) {
        throw new Error('session_command_receipt_mutation')
      }
      if (!sameIdentity) rows.push(local)
      known.set(local.commandId, rows)
      normalized.push(local)
      continue
    }

    const backend = receipt
    const candidate: Omit<SessionCommandReceiptView, 'attempt'> = {
      commandId: backend.commandId,
      state: backend.state,
      errorCode: backend.errorCode,
      detail: backend.details,
      recordedAt: backend.updatedAt,
      retryable: backend.retryable,
      result: backend.result,
    }
    const rows = known.get(backend.commandId) ?? []
    const existingMatch = rows.find((row) => receiptContent(row) === receiptContent({ ...candidate, attempt: row.attempt }))
    const attempt = existingMatch?.attempt ?? ((rows.length > 0 ? Math.max(...rows.map((row) => row.attempt)) : 0) + 1)
    const local = sessionCommandReceiptSchema.parse({ ...candidate, attempt })
    if (!existingMatch) rows.push(local)
    known.set(backend.commandId, rows)
    normalized.push(local)
  }
  return normalized
}

async function normalizeAggregateReceipts(
  database: PomodoroXIDB,
  raw: unknown,
): Promise<LocalFocusSessionAggregateView> {
  const parsed = focusSessionAggregateSchema.parse(raw)
  const receipts = await normalizeSessionCommandReceipts(database, parsed.commandReceipts)
  assertReceiptEnvelopeMembership(receipts, parsed.commandEnvelopes)
  return { ...parsed, commandReceipts: receipts } as LocalFocusSessionAggregateView
}

export async function persistImmutableSessionCommandReceipts(
  database: PomodoroXIDB,
  rawReceipts: unknown[],
  allowedCommandIds: ReadonlySet<string>,
): Promise<SessionCommandReceiptView[]> {
  const parsed = await normalizeSessionCommandReceipts(database, rawReceipts)
  if (parsed.some((receipt) => !allowedCommandIds.has(receipt.commandId))) {
    throw new Error('authoritative_review_response_receipt_mismatch')
  }
  const byIdentity = new Map<string, SessionCommandReceiptView>()
  for (const receipt of parsed) {
    const identity = `${receipt.commandId}\0${receipt.attempt}`
    const previous = byIdentity.get(identity)
    if (previous && canonicalize(previous) !== canonicalize(receipt)) {
      throw new Error('session_command_receipt_mutation')
    }
    byIdentity.set(identity, receipt)
  }
  const receipts = [...byIdentity.values()]
  const existing = await database.sessionCommandReceipts.bulkGet(
    receipts.map((receipt) => [receipt.commandId, receipt.attempt] as [string, number]),
  ) as Array<SessionCommandReceiptView | undefined>
  for (const [index, row] of existing.entries()) {
    if (row && canonicalize(row) !== canonicalize(receipts[index])) {
      throw new Error('session_command_receipt_mutation')
    }
  }
  if (receipts.length > 0) {
    await database.sessionCommandReceipts.bulkPut(receipts)
  }
  return receipts
}

export async function readSessionCommandReceipts(
  database: PomodoroXIDB,
  sessionId: string,
): Promise<SessionCommandReceiptView[]> {
  const envelopes = await database.sessionCommandEnvelopes
    .where('sessionId').equals(sessionId).toArray()
  const commandIds = new Set(envelopes.map((envelope) => envelope.commandId))
  return (await database.sessionCommandReceipts.toArray())
    .filter((receipt) => commandIds.has(receipt.commandId))
}

async function runTransaction(
  database: PomodoroXIDB,
  tables: unknown[],
  effect: () => Promise<void> | void,
): Promise<void> {
  await (database.transaction as unknown as (...args: unknown[]) => Promise<void>)('rw', ...tables, effect)
}

const withoutSpace = <T extends { spaceId: string }>(row: T, expectedSpaceId: string): Omit<T, 'spaceId'> => {
  assertResponseSpace(row, expectedSpaceId)
  const { spaceId: _spaceId, ...persisted } = row
  return persisted
}

function assertSessionIdentity(aggregate: LocalFocusSessionAggregate): void {
  const sessionId = aggregate.session.sessionId
  if (aggregate.context && aggregate.context.sessionId !== sessionId) {
    throw new Error('focus_session_identity_mismatch')
  }
  if (aggregate.attribution.sessionId !== sessionId ||
      aggregate.plan.some((row) => row.sessionId !== sessionId) ||
      aggregate.outcomes.some((row) => row.sessionId !== sessionId) ||
      aggregate.commandEnvelopes.some((row) => row.sessionId !== sessionId)) {
    throw new Error('focus_session_identity_mismatch')
  }
  assertReceiptEnvelopeMembership(
    aggregate.commandReceipts.map((receipt) => sessionCommandReceiptSchema.parse(receipt)),
    aggregate.commandEnvelopes,
  )
}

export function toSpaceRows(raw: LocalFocusSessionAggregateView): FocusSessionRows {
  const parsed = focusSessionAggregateSchema.parse(raw)
  const localReceipts = parsed.commandReceipts.map((receipt) => sessionCommandReceiptSchema.parse(receipt))
  assertReceiptEnvelopeMembership(localReceipts, parsed.commandEnvelopes)
  const sessionWire = parsed.session
  const derivedState = deriveClockStateFromPersistedFacts(sessionWire)
  if (derivedState !== sessionWire.clockState) {
    throw new Error('focus_session_clock_state_mismatch')
  }
  const { id: sessionId, spaceId: _spaceId, ...sessionFacts } = sessionWire
  // Dexie v18 keys this table by the wire entity id, while the business
  // projection addresses the same row through sessionId. The storage key is
  // added only by putFocusSessionRows and never leaks into the projection.
  const session = { sessionId, ...sessionFacts } as CachedFocusSession
  const context = parsed.context === null
    ? null
    : withoutSpace(parsed.context, sessionWire.spaceId) as CachedSessionTaskContext
  const attribution = withoutSpace(
    parsed.attribution,
    sessionWire.spaceId,
  ) as CachedSessionAttributionRevision
  const plans = parsed.plan.map((row) => withoutSpace(row, sessionWire.spaceId) as CachedSessionWorkItemPlan)
  const outcomes = parsed.outcomes.map((row) => withoutSpace(row, sessionWire.spaceId) as CachedSessionWorkItemOutcome)
  for (const row of parsed.commandEnvelopes) assertResponseSpace(row, sessionWire.spaceId)
  const envelopes = parsed.commandEnvelopes as CachedSessionCommandEnvelope[]
  const receipts = localReceipts as Array<Record<string, unknown>>
  const aggregate: LocalFocusSessionAggregate = {
    session, context, attribution, plan: plans, outcomes,
    commandEnvelopes: envelopes, commandReceipts: receipts,
  }
  assertSessionIdentity(aggregate)
  return {
    session, context, attributions: [attribution], plans, outcomes,
    envelopes, receipts,
  }
}

export async function putFocusSessionRows(
  database: PomodoroXIDB,
  rows: FocusSessionRows,
): Promise<void> {
  await database.focusSessions.put({ id: rows.session.sessionId, ...rows.session })
  if (rows.context) await database.sessionTaskContexts.put(rows.context)
  await database.sessionAttributionRevisions.bulkPut(rows.attributions)
  await database.sessionWorkItemPlans.bulkPut(rows.plans)
  await database.sessionWorkItemOutcomes.bulkPut(rows.outcomes)
  await database.sessionCommandEnvelopes.bulkPut(rows.envelopes)
  await persistImmutableSessionCommandReceipts(
    database,
    rows.receipts,
    new Set(rows.envelopes.map((envelope) => envelope.commandId)),
  )
}

async function removeReplacedSessionChildren(
  database: PomodoroXIDB,
  sessionId: string,
  replacement: FocusSessionRows,
): Promise<void> {
  const contextId = replacement.context?.id ?? null
  const contexts = await database.sessionTaskContexts.where('sessionId').equals(sessionId).toArray()
  for (const row of contexts) if (row.id !== contextId) await database.sessionTaskContexts.delete(row.id)

  const attributionIds = new Set(replacement.attributions.map((row) => row.id))
  const attributions = await database.sessionAttributionRevisions.where('sessionId').equals(sessionId).toArray()
  for (const row of attributions) {
    const id = String((row as Record<string, unknown>).id)
    if (!attributionIds.has(id)) await database.sessionAttributionRevisions.delete(id)
  }

  const planIds = new Set(replacement.plans.map((row) => row.id))
  const plans = await database.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray()
  for (const row of plans) {
    const id = String((row as Record<string, unknown>).id)
    if (!planIds.has(id)) await database.sessionWorkItemPlans.delete(id)
  }
}

async function assertCompleteProvisionalOutbox(
  database: PomodoroXIDB,
  spaceId: string,
  operationId: string,
  aggregate: LocalFocusSessionAggregate,
): Promise<void> {
  const expected = absorbedProvisionalOutboxKeys(aggregate)
  const rows = (await database.outbox.toArray()).filter((row) =>
    row.spaceId === spaceId && row.compoundOperationId === operationId &&
    expected.has(provisionalOutboxKey(row.entityType, row.entityId)))
  const actual = new Set(rows.map((row) => provisionalOutboxKey(row.entityType, row.entityId)))
  if (rows.length !== expected.size || actual.size !== expected.size ||
      [...expected].some((key) => !actual.has(key)) || rows.some((row) =>
        row.action !== 'create' || row.expectedVersion !== null || row.transportState !== 'awaiting_s4' ||
        row.attemptCount !== 0 || row.synced || row.requiresVersionRebase ||
        row.lastError !== null || row.lastErrorCode !== null || row.failedAt !== null)) {
    throw new Error('provisional_start_recovery_required')
  }
}

export async function cacheFocusSession(
  database: PomodoroXIDB,
  expectedSpaceId: string,
  raw: unknown,
): Promise<CachedFocusSession> {
  const aggregate = await normalizeAggregateReceipts(database, raw)
  assertResponseSpace(aggregate.session, expectedSpaceId)
  for (const row of [aggregate.context, aggregate.attribution, ...aggregate.plan, ...aggregate.outcomes]) {
    if (row) assertResponseSpace(row, expectedSpaceId)
  }
  const rows = toSpaceRows(aggregate)
  await runTransaction(database, [
    database.focusSessions, database.sessionTaskContexts,
    database.sessionAttributionRevisions, database.sessionWorkItemPlans,
    database.sessionWorkItemOutcomes, database.sessionCommandEnvelopes,
    database.sessionCommandReceipts,
  ], () => putFocusSessionRows(database, rows))
  return rows.session
}

export type CachedSessionReview = {
  session: CachedFocusSession
  outcomes: CachedSessionWorkItemOutcome[]
  envelopes: CachedSessionCommandEnvelope[]
  receipts: Array<Record<string, unknown>>
}

/**
 * Validate the complete response identity before projecting any review rows.
 * Receipts intentionally have no space/session fields in the wire contract;
 * their command IDs are therefore bound to the unique envelope set here.
 */
export async function toReviewRows(
  database: PomodoroXIDB,
  response: FocusSessionAggregateView,
  expectedSpaceId: string,
  expectedSessionId: string,
): Promise<CachedSessionReview> {
  const normalized = await normalizeAggregateReceipts(database, response)
  if (normalized.session.spaceId !== expectedSpaceId || normalized.session.id !== expectedSessionId ||
      (normalized.context !== null && (normalized.context.spaceId !== expectedSpaceId || normalized.context.sessionId !== expectedSessionId)) ||
      normalized.attribution.spaceId !== expectedSpaceId || normalized.attribution.sessionId !== expectedSessionId ||
      normalized.plan.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) ||
      normalized.outcomes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) ||
      normalized.commandEnvelopes.some((row) => row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId)) {
    throw new Error('authoritative_review_response_identity_mismatch')
  }
  const envelopeIds = new Set(normalized.commandEnvelopes.map((row) => row.commandId))
  if (normalized.outcomes.some((row) => row.commandId !== null && !envelopeIds.has(row.commandId))) {
    throw new Error('authoritative_review_response_command_link_mismatch')
  }
  const rows = toSpaceRows(normalized)
  return {
    session: rows.session,
    outcomes: rows.outcomes,
    envelopes: rows.envelopes,
    receipts: rows.receipts,
  }
}

type ReviewExpectedVersionMode = 'exact' | 'import_rebased'

function parseExactBoundReviewRequest(requestJson: string): SessionReviewDraft {
  let request: SessionReviewDraft
  try {
    request = sessionReviewDraftSchema.parse(JSON.parse(requestJson))
  } catch {
    throw new Error('authoritative_review_bound_request_invalid')
  }
  if (canonicalize(request) !== requestJson) throw new Error('authoritative_review_bound_request_invalid')
  return request
}

function requireReviewDraftMatchesBoundRequest(
  row: Record<string, unknown> | undefined,
  spaceId: string,
  sessionId: string,
  boundRequest: SessionReviewDraft,
  mode: ReviewExpectedVersionMode,
  stage: 'apply' | 'delete',
): void {
  const error = `authoritative_review_draft_changed_before_${stage}`
  if (!row || row.spaceId !== spaceId || row.sessionId !== sessionId || row.operationId !== boundRequest.operationId ||
      typeof row.draftJson !== 'string') throw new Error(error)
  let current: SessionReviewDraft
  try { current = sessionReviewDraftSchema.parse(JSON.parse(row.draftJson)) } catch { throw new Error(error) }
  const { expectedVersion: currentVersion, ...currentBusiness } = current
  const { expectedVersion: boundVersion, ...boundBusiness } = boundRequest
  if (canonicalize(current) !== row.draftJson || current.spaceId !== spaceId || current.sessionId !== sessionId ||
      current.operationId !== row.operationId || canonicalize(currentBusiness) !== canonicalize(boundBusiness) ||
      (mode === 'exact' && currentVersion !== boundVersion) ||
      (mode === 'import_rebased' && boundVersion <= 0)) throw new Error(error)
}

function requireAuthoritativeReviewTransaction(db: PomodoroXIDB): void {
  const transaction = Dexie.currentTransaction
  const required = [
    'directCommandIntents', 'focusSessions', 'sessionWorkItemOutcomes',
    'sessionCommandEnvelopes', 'sessionCommandReceipts', 'sessionCommandQueue',
    'sessionReviewDrafts',
  ]
  if (!transaction || transaction.db !== db || required.some((name) => !transaction.storeNames.includes(name))) {
    throw new Error('authoritative_review_transaction_required')
  }
}

function latestReviewReceipt(
  receipts: Array<Record<string, unknown>>,
  commandId: string,
): Record<string, unknown> | undefined {
  return receipts.filter((row) => row.commandId === commandId)
    .sort((left, right) => Number(right.attempt ?? 0) - Number(left.attempt ?? 0))[0]
}

export async function applyAuthoritativeReviewAndClearDraft(
  db: PomodoroXIDB,
  spaceId: string,
  sessionId: string,
  boundRequestJson: string,
  expectedVersionMode: ReviewExpectedVersionMode,
  response: FocusSessionAggregateView,
): Promise<void> {
  requireAuthoritativeReviewTransaction(db)
  const boundRequest = parseExactBoundReviewRequest(boundRequestJson)
  const draft = await db.sessionReviewDrafts.get([spaceId, sessionId]) as Record<string, unknown> | undefined
  requireReviewDraftMatchesBoundRequest(draft, spaceId, sessionId, boundRequest, expectedVersionMode, 'apply')
  const rows = await toReviewRows(db, response, spaceId, sessionId)

  // Command envelopes and materialized outcomes are append-only facts. A
  // response may repeat an existing row, but it may not rewrite its bytes.
  const existingEnvelopes = await db.sessionCommandEnvelopes.bulkGet(
    rows.envelopes.map((row) => row.commandId),
  ) as Array<Record<string, unknown> | undefined>
  for (const [index, existing] of existingEnvelopes.entries()) {
    if (!existing) continue
    const incoming = rows.envelopes[index]
    if (canonicalize(existing) !== canonicalize(incoming)) {
      throw new Error('authoritative_review_envelope_mutation')
    }
  }
  const existingOutcomes = await db.sessionWorkItemOutcomes.bulkGet(
    rows.outcomes.map((row) => row.id),
  ) as Array<Record<string, unknown> | undefined>
  for (const [index, existing] of existingOutcomes.entries()) {
    if (!existing) continue
    const incoming = rows.outcomes[index]
    if (canonicalize(existing) !== canonicalize(incoming)) {
      throw new Error('authoritative_review_outcome_mutation')
    }
  }

  await db.focusSessions.put({ id: rows.session.sessionId, ...rows.session })
  await db.sessionWorkItemOutcomes.bulkPut(rows.outcomes)
  await db.sessionCommandEnvelopes.bulkPut(rows.envelopes)
  await persistImmutableSessionCommandReceipts(
    db,
    rows.receipts,
    new Set(rows.envelopes.map((envelope) => envelope.commandId)),
  )
  for (const envelope of rows.envelopes) {
    const envelopeJson = canonicalize(envelope)
    if (envelopeJson === undefined) throw new Error('authoritative_review_envelope_not_canonical')
    const receipt = latestReviewReceipt(rows.receipts, envelope.commandId)
    const receiptState = typeof receipt?.state === 'string' ? receipt.state : 'pending'
    await db.sessionCommandQueue.put({
      commandId: envelope.commandId, spaceId, sessionId,
      payloadHash: envelope.payloadHash, replaySafe: envelope.replaySafe,
      envelopeJson,
      state: receiptState === 'pending' || receiptState === 'unknown' ? 'held' : 'terminal',
      lastReceiptState: receiptState,
      createdAt: envelope.createdAt, updatedAt: canonicalNow(),
    })
  }

  const currentDraft = await db.sessionReviewDrafts.get([spaceId, sessionId]) as Record<string, unknown> | undefined
  requireReviewDraftMatchesBoundRequest(currentDraft, spaceId, sessionId, boundRequest, expectedVersionMode, 'delete')
  await db.sessionReviewDrafts.delete([spaceId, sessionId])
}

export const provisionalOutboxKey = (entityType: string, entityId: string) =>
  `${entityType}\0${entityId}`

export function absorbedProvisionalOutboxKeys(
  provisional: LocalFocusSessionAggregate,
): Set<string> {
  const sessionId = provisional.session.sessionId
  if (!provisional.context || provisional.context.sessionId !== sessionId ||
      provisional.attribution.sessionId !== sessionId ||
      !provisional.attribution.effective ||
      provisional.plan.some((item) => item.sessionId !== sessionId)) {
    throw new Error('authoritative_activation_snapshot_identity_mismatch')
  }
  return new Set([
    provisionalOutboxKey('focusSession', sessionId),
    provisionalOutboxKey('sessionTaskContext', provisional.context.id),
    provisionalOutboxKey('sessionAttributionRevision', provisional.attribution.id),
    ...provisional.plan.map((item) => provisionalOutboxKey('sessionWorkItemPlan', item.id)),
  ])
}

export function absorbedProvisionalEntityIds(
  provisional: LocalFocusSessionAggregate,
): string[] {
  absorbedProvisionalOutboxKeys(provisional)
  return [...new Set([
    provisional.session.sessionId,
    provisional.context!.id,
    provisional.attribution.id,
    ...provisional.plan.map((item) => item.id),
  ])]
}

export function buildActivateProvisionalPayload(
  aggregate: LocalFocusSessionAggregate,
  operation: ProvisionalOperationRow,
): ProvisionalActivationPayload {
  if (!aggregate.context) throw new Error('provisional_context_required')
  if (aggregate.session.endedAt !== null || aggregate.session.clockState === 'ended') {
    throw new Error('terminal_provisional_requires_s4_import')
  }
  const expectedWorkItemVersions: Record<string, number> = {
    [aggregate.context.level2WorkItemId]: aggregate.context.level2VersionSnapshot,
  }
  for (const item of aggregate.plan) expectedWorkItemVersions[item.workItemId] = item.workItemVersionSnapshot
  return activateProvisionalPayloadSchema.parse({
    cachedAt: operation.createdAt,
    cachedOwnershipEpoch: operation.cachedOwnershipEpoch,
    ownerDeviceId: operation.deviceId,
    ownerTabId: operation.tabId,
    snapshot: {
      session: {
        sessionRevision: aggregate.session.sessionRevision,
        startedAt: aggregate.session.startedAt,
        pauseStartedAt: aggregate.session.pauseStartedAt,
        plannedSeconds: aggregate.session.plannedSeconds,
        grossSeconds: aggregate.session.grossSeconds,
        pausedSeconds: aggregate.session.pausedSeconds,
        breakSeconds: aggregate.session.breakSeconds,
        focusedSeconds: aggregate.session.focusedSeconds,
        validity: 'pending',
        validityReason: aggregate.session.validityReason,
        reviewState: 'not_required',
        ownershipState: 'local_provisional',
        sessionNote: aggregate.session.sessionNote,
      },
      context: {
        projectId: aggregate.context.projectId,
        projectTitleSnapshot: aggregate.context.projectTitleSnapshot,
        level2WorkItemId: aggregate.context.level2WorkItemId,
        level2TitleSnapshot: aggregate.context.level2TitleSnapshot,
        level2ParentIdSnapshot: aggregate.context.level2ParentIdSnapshot,
        level2StatusDefinitionIdSnapshot: aggregate.context.level2StatusDefinitionIdSnapshot,
        level2VersionSnapshot: aggregate.context.level2VersionSnapshot,
        level2EffortLowerSecondsSnapshot: aggregate.context.level2EffortLowerSecondsSnapshot,
        level2EffortUpperSecondsSnapshot: aggregate.context.level2EffortUpperSecondsSnapshot,
        linkedAt: aggregate.context.linkedAt,
        linkMethod: aggregate.context.linkMethod,
      },
      plan: aggregate.plan.map((item) => ({
        id: item.id,
        workItemId: item.workItemId,
        titleSnapshot: item.titleSnapshot,
        level2WorkItemIdSnapshot: item.level2WorkItemIdSnapshot,
        workItemVersionSnapshot: item.workItemVersionSnapshot,
        planRank: item.planRank,
        source: item.source,
        addedAt: item.addedAt,
        removedAt: item.removedAt,
        removalReason: item.removalReason,
        currentDuringSession: item.currentDuringSession,
        completionDraft: item.completionDraft,
      })),
    },
    expectedWorkItemVersions,
  })
}

function activationReceiptId(operationId: string): string {
  return operationId
}

export async function cacheAuthoritativeActivation(
  database: PomodoroXIDB,
  operation: ProvisionalOperationRow,
  rawResult: unknown,
  provisional: LocalFocusSessionAggregate,
): Promise<CachedFocusSession> {
  const result = activeSessionSchema.parse(rawResult)
  if (result.kind !== 'authoritative' && result.kind !== 'resumed') {
    throw new Error('authoritative_activation_result_kind_required')
  }
  const aggregate = await normalizeAggregateReceipts(database, result.session)
  assertResponseSpace(aggregate.session, operation.spaceId)
  if (operation.sessionId !== provisional.session.sessionId ||
      result.spaceId !== operation.spaceId || result.sessionId !== operation.sessionId ||
      aggregate.session.id !== operation.sessionId) {
    throw new Error('authoritative_activation_snapshot_identity_mismatch')
  }
  const rows = toSpaceRows(aggregate)
  const resultHash = await hashCommandPayload(result as unknown as JsonValue)
  const absorbedKeys = absorbedProvisionalOutboxKeys(provisional)
  const absorbedEntityIds = absorbedProvisionalEntityIds(provisional)

  const resultKind = result.kind
  await runTransaction(database, [
    database.focusSessions, database.sessionTaskContexts,
    database.sessionAttributionRevisions, database.sessionWorkItemPlans,
    database.sessionWorkItemOutcomes, database.sessionCommandEnvelopes,
    database.sessionCommandReceipts, database.sessionActivationApplications,
    database.outbox,
  ], async () => {
      const possibleRows = await database.outbox.where('entityId').anyOf(absorbedEntityIds).toArray()
      const absorbedRows = possibleRows.filter((row) =>
        row.spaceId === operation.spaceId &&
        absorbedKeys.has(provisionalOutboxKey(row.entityType, row.entityId)))
      const existing = await database.sessionActivationApplications.get(operation.operationId)
      if (existing) {
        if (existing.resultHash !== resultHash || existing.resultKind !== resultKind ||
            existing.provisionalSpaceId !== operation.spaceId ||
            existing.provisionalSessionId !== operation.sessionId ||
            existing.activeSpaceId !== result.spaceId || existing.activeSessionId !== result.sessionId ||
            existing.activeSessionVersion !== aggregate.session.version ||
            existing.ownershipEpoch !== result.ownershipEpoch || absorbedRows.length !== 0) {
          throw new Error('activation_application_receipt_mismatch')
        }
        await removeReplacedSessionChildren(database, operation.sessionId, rows)
        await putFocusSessionRows(database, rows)
        return
      }
      const unsafe = absorbedRows.find((row) =>
        row.transportState !== 'awaiting_s4' || row.attemptCount !== 0 || row.synced ||
        row.action !== 'create' || row.expectedVersion !== null || row.requiresVersionRebase ||
        row.lastError !== null || row.lastErrorCode !== null || row.failedAt !== null)
      if (unsafe) throw new Error(`authoritative_activation_outbox_not_consumable:${unsafe.id}`)
      const seenKeys = new Set(absorbedRows.map((row) => provisionalOutboxKey(row.entityType, row.entityId)))
      if (absorbedRows.length !== absorbedKeys.size || seenKeys.size !== absorbedKeys.size ||
          [...absorbedKeys].some((key) => !seenKeys.has(key))) {
        throw new Error('authoritative_activation_outbox_incomplete')
      }
      await removeReplacedSessionChildren(database, operation.sessionId, rows)
      await putFocusSessionRows(database, rows)
      const receipt: SessionActivationApplicationReceiptRow & { receiptId: string } = {
        receiptId: activationReceiptId(operation.operationId),
        operationId: operation.operationId,
        provisionalSpaceId: operation.spaceId,
        provisionalSessionId: operation.sessionId,
        resultKind: resultKind as 'authoritative' | 'resumed',
        resultHash,
        resultJson: JSON.stringify(result),
        activeSpaceId: result.spaceId,
        activeSessionId: result.sessionId,
        activeSessionVersion: aggregate.session.version,
        ownershipEpoch: result.ownershipEpoch,
        absorbedOutboxIds: absorbedRows.map((row) => row.id!).sort((a, b) => a - b),
        appliedAt: result.updatedAt,
      }
      await database.sessionActivationApplications.add(receipt as unknown as Record<string, unknown>)
      await database.outbox.bulkDelete(receipt.absorbedOutboxIds)
  })
  return rows.session
}

export async function cacheResolvedProvisionalWinner(
  database: PomodoroXIDB,
  operation: Pick<ProvisionalOperationRow, 'operationId' | 'spaceId' | 'sessionId'>,
  conflict: SessionActivationConflictRow,
  resolution: { operationId: string; selectedRole: 'candidate'; resolvedAt: string },
  rawResult: unknown,
): Promise<CachedFocusSession> {
  const result = activeSessionSchema.parse(rawResult)
  const aggregate = await normalizeAggregateReceipts(database, result.session)
  if (conflict.provisionalOperationId !== operation.operationId ||
      conflict.provisionalSpaceId !== operation.spaceId ||
      conflict.provisionalSessionId !== operation.sessionId ||
      result.spaceId !== operation.spaceId || result.sessionId !== operation.sessionId ||
      aggregate.session.id !== operation.sessionId) {
    throw new Error('resolved_candidate_identity_mismatch')
  }
  const rows = toSpaceRows(aggregate)
  const resultHash = await hashCommandPayload(result as unknown as JsonValue)
  await runTransaction(database, [
    database.focusSessions, database.sessionTaskContexts,
    database.sessionAttributionRevisions, database.sessionWorkItemPlans,
    database.sessionWorkItemOutcomes, database.sessionCommandEnvelopes,
    database.sessionCommandReceipts, database.sessionActivationApplications,
    database.outbox,
  ], async () => {
      const conflictReceipt = await database.sessionActivationApplications.get(operation.operationId) as
        (SessionActivationApplicationReceiptRow & { receiptId: string }) | undefined
      if (!conflictReceipt || conflictReceipt.resultKind !== 'activation_conflict' ||
          conflictReceipt.provisionalSpaceId !== operation.spaceId ||
          conflictReceipt.provisionalSessionId !== operation.sessionId ||
          conflictReceipt.activeSpaceId !== conflict.authoritativeSpaceId ||
          conflictReceipt.activeSessionId !== conflict.authoritativeSessionId) {
        throw new Error('activation_conflict_receipt_missing_or_mismatched')
      }
      const heldRows = await database.outbox.bulkGet(conflictReceipt.absorbedOutboxIds)
      const existing = await database.sessionActivationApplications.get(resolution.operationId)
      if (existing) {
        if (existing.resultKind !== 'authoritative' || existing.resultHash !== resultHash ||
            heldRows.some((row) => row !== undefined)) throw new Error('activation_resolution_application_receipt_mismatch')
        await removeReplacedSessionChildren(database, operation.sessionId, rows)
        await putFocusSessionRows(database, rows)
        return
      }
      if (heldRows.some((row) => !row || row.transportState !== 'blocked_conflict' ||
          row.attemptCount !== 0 || row.synced || row.action !== 'create' ||
          row.expectedVersion !== null || row.requiresVersionRebase ||
          row.lastError !== null || row.lastErrorCode !== null || row.failedAt !== null)) {
        throw new Error('resolved_candidate_outbox_not_consumable')
      }
      await removeReplacedSessionChildren(database, operation.sessionId, rows)
      await putFocusSessionRows(database, rows)
      const receipt: SessionActivationApplicationReceiptRow & { receiptId: string } = {
        receiptId: resolution.operationId,
        operationId: resolution.operationId,
        provisionalSpaceId: operation.spaceId,
        provisionalSessionId: operation.sessionId,
        resultKind: 'authoritative', resultHash,
        resultJson: JSON.stringify(result),
        activeSpaceId: result.spaceId, activeSessionId: result.sessionId,
        activeSessionVersion: aggregate.session.version,
        ownershipEpoch: result.ownershipEpoch,
        absorbedOutboxIds: [...conflictReceipt.absorbedOutboxIds],
        appliedAt: resolution.resolvedAt,
      }
      await database.sessionActivationApplications.add(receipt as unknown as Record<string, unknown>)
      await database.outbox.bulkDelete(receipt.absorbedOutboxIds)
  })
  return rows.session
}

export interface OwnedActiveSessionMutations {
  updateSessionNote(input: { sessionId: string; sessionNote: string }): Promise<FocusSessionAggregateView>
  setCurrentPlanItem(input: { sessionId: string; workItemId: string | null }): Promise<FocusSessionAggregateView>
  setCompletionDraft(input: { sessionId: string; planItemId: string; completionDraft: boolean }): Promise<FocusSessionAggregateView>
  addPlanItem(input: {
    sessionId: string; workItemId: string; expectedWorkItemVersion: number;
    planRank: number; addedAt: string;
  }): Promise<FocusSessionAggregateView>
  removePlanItem(input: {
    sessionId: string; planItemId: string; removedAt: string; removalReason: string;
  }): Promise<FocusSessionAggregateView>
}

const localTransportState = (session: CachedFocusSession) => {
  if (session.ownershipState === 'local_provisional') return 'awaiting_s4' as const
  throw new Error('authoritative running content must use ActiveSessionCoordinator')
}

const assertLocalContentWritable = (session: CachedFocusSession): void => {
  if (session.ownershipState === 'activation_conflict') throw new Error('blocked_conflict')
}

interface LocalOwnerProof {
  operation: ProvisionalOperationRow
  transportState: 'awaiting_s4'
}

const serializeFocusSessionCommandPostImage = (row: CachedFocusSession) => {
  const { id: _id, sessionId, clockState: _clockState, ...persisted } = row as CachedFocusSession & { id?: string }
  return focusSessionCommandPostImageSchema.parse({ id: sessionId, ...persisted })
}

const serializeSessionTaskContextCommandPostImage = (row: CachedSessionTaskContext) =>
  sessionTaskContextCommandPostImageSchema.parse(row)

const serializeSessionAttributionCommandPostImage = (row: CachedSessionAttributionRevision) =>
  sessionAttributionRevisionCommandPostImageSchema.parse(row)

const serializeSessionPlanCommandPostImage = (row: CachedSessionWorkItemPlan) =>
  sessionWorkItemPlanCommandPostImageSchema.parse(row)

const localSessionCreateHashPayload = (row: CachedFocusSession): JsonValue => ({
  session_revision: row.sessionRevision,
  started_at: row.startedAt,
  ended_at: row.endedAt,
  pause_started_at: row.pauseStartedAt,
  planned_seconds: row.plannedSeconds,
  gross_seconds: row.grossSeconds,
  paused_seconds: row.pausedSeconds,
  break_seconds: row.breakSeconds,
  focused_seconds: row.focusedSeconds,
  timer_completion: row.timerCompletion,
  validity: row.validity,
  validity_reason: row.validityReason,
  overall_progress: row.overallProgress,
  mood: row.mood,
  review_state: row.reviewState,
  ownership_state: row.ownershipState,
  session_note: row.sessionNote,
})

const localContextCreateHashPayload = (row: CachedSessionTaskContext): JsonValue => ({
  session_id: row.sessionId,
  project_id: row.projectId,
  level2_work_item_id: row.level2WorkItemId,
  project_title_snapshot: row.projectTitleSnapshot,
  level2_title_snapshot: row.level2TitleSnapshot,
  level2_parent_id_snapshot: row.level2ParentIdSnapshot,
  level2_status_definition_id_snapshot: row.level2StatusDefinitionIdSnapshot,
  level2_version_snapshot: row.level2VersionSnapshot,
  level2_effort_lower_seconds_snapshot: row.level2EffortLowerSecondsSnapshot,
  level2_effort_upper_seconds_snapshot: row.level2EffortUpperSecondsSnapshot,
  linked_at: row.linkedAt,
  link_method: row.linkMethod,
})

const localAttributionCreateHashPayload = (row: CachedSessionAttributionRevision): JsonValue => ({
  session_id: row.sessionId,
  revision: row.revision,
  project_id: row.projectId,
  level2_work_item_id: row.level2WorkItemId,
  reason: row.reason,
  corrected_from_revision: row.correctedFromRevision,
  effective: row.effective,
  created_at: row.createdAt,
})

const localPlanCreateHashPayload = (row: CachedSessionWorkItemPlan): JsonValue => ({
  session_id: row.sessionId,
  work_item_id: row.workItemId,
  title_snapshot: row.titleSnapshot,
  level2_work_item_id_snapshot: row.level2WorkItemIdSnapshot,
  work_item_version_snapshot: row.workItemVersionSnapshot,
  plan_rank: row.planRank,
  source: row.source,
  added_at: row.addedAt,
  removed_at: row.removedAt,
  removal_reason: row.removalReason,
  current_during_session: row.currentDuringSession,
  completion_draft: row.completionDraft,
})

async function reindexUnattemptedProvisionalPlanOutbox(
  db: PomodoroXIDB,
  compoundOperationId: string,
  sessionId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, db.spaceId)
  requireSpaceDatabaseBinding(db, db.spaceId)
  const plans = await db.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray() as CachedSessionWorkItemPlan[]
  plans.sort((left, right) => left.planRank - right.planRank || left.id.localeCompare(right.id))
  const outboxRows = (await db.outbox.toArray()).filter((row) =>
    row.compoundOperationId === compoundOperationId && row.entityType === 'sessionWorkItemPlan')
  const byEntityId = new Map(outboxRows.map((row) => [row.entityId, row]))
  for (const [index, plan] of plans.entries()) {
    const row = byEntityId.get(plan.id)
    const expectedOperationId = await Dexie.waitFor(
      boundedChildOperationId(compoundOperationId, `plan:${plan.id}`),
    )
    if (!row || row.attemptCount !== 0 || row.operationId !== expectedOperationId ||
        row.transportState !== 'awaiting_s4') {
      throw new Error('provisional_plan_outbox_not_reindexable')
    }
    await db.outbox.update(row.id!, { compoundOrder: 3 + index })
  }
}

export class FocusSessionRepository {
  constructor(
    readonly db: PomodoroXIDB,
    readonly meta: MetaDB,
    private readonly spaceId: string,
    private readonly identity: TabIdentity,
    private readonly active: OwnedActiveSessionMutations,
    private readonly provisionalLock: ProvisionalOperationLock,
  ) {
    if (db.spaceId !== spaceId) throw new Error('focus_session_repository_database_mismatch')
  }

  async cacheAggregate(raw: unknown): Promise<CachedFocusSession> {
    return cacheFocusSession(this.db, this.spaceId, raw)
  }

  async listCached(): Promise<CachedFocusSession[]> {
    const rows = (await this.db.focusSessions.toArray()).map((row) => {
      const { id: _id, ...projection } = row as CachedFocusSession & { id?: string }
      return projection as CachedFocusSession
    })
    return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async refreshHistory(): Promise<CachedFocusSession[]> {
    return this.listCached()
  }

  async submitReview(input: SessionReviewDraft): Promise<CachedSessionReview> {
    const draft = sessionReviewDraftSchema.parse(input)
    if (draft.spaceId !== this.spaceId) throw new Error('space_scope_mismatch')
    const cached = await this.requireSession(draft.sessionId)
    assertLocalContentWritable(cached)

    if (cached.ownershipState === 'local_provisional') {
      const candidates = await this.meta.provisionalOperations
        .where('sessionId').equals(draft.sessionId)
        .and((row) => row.spaceId === this.spaceId && row.deviceId === this.identity.deviceId &&
          row.tabId === this.identity.tabId && row.state === 'awaiting_s4')
        .toArray()
      if (candidates.length !== 1) throw new Error('provisional_review_import_not_pending')
      const operationId = candidates[0]!.operationId
      return this.provisionalLock.run(
        operationId,
        () => this.submitProvisionalReviewLocked(draft, operationId),
      )
    }

    await requirePersistedExactSessionReviewDraft(this.db, draft)
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'submit_review', spaceId: draft.spaceId, targetId: draft.sessionId,
      request: draft as unknown as Record<string, JsonValue>,
      now: canonicalNow(),
    }, draft.operationId)
    const response = await executeDurableDirectCommand({
      db: this.db,
      intent,
      businessTables: [
        this.db.focusSessions, this.db.sessionWorkItemOutcomes,
        this.db.sessionCommandEnvelopes, this.db.sessionCommandReceipts,
        this.db.sessionCommandQueue, this.db.sessionReviewDrafts,
      ],
      sendExactRequest: (request) => focusSessionApi.submitReview(request as never),
      parseResult: (value) => focusSessionAggregateSchema.parse(value),
      applyResult: (authoritative) => applyAuthoritativeReviewAndClearDraft(
        this.db, this.spaceId, draft.sessionId, intent.requestJson, 'exact', authoritative,
      ),
      now: canonicalNow,
    })
    return toReviewRows(this.db, response, this.spaceId, draft.sessionId)
  }

  private async submitProvisionalReviewLocked(
    draft: SessionReviewDraft,
    lockedOperationId: string,
  ): Promise<CachedSessionReview> {
    await requirePersistedExactSessionReviewDraft(this.db, draft)
    const cached = await this.requireSession(draft.sessionId)
    assertLocalContentWritable(cached)
    if (cached.ownershipState !== 'local_provisional') throw new Error('provisional_review_import_not_pending')
    if (cached.endedAt === null || cached.clockState !== 'ended') {
      throw new Error('provisional_review_requires_terminal_session')
    }
    if (cached.validity !== 'pending' || cached.reviewState !== 'pending') {
      throw new Error('provisional_review_import_boundary_mismatch')
    }
    const candidates = await this.meta.provisionalOperations
      .where('sessionId').equals(draft.sessionId)
      .and((row) => row.spaceId === this.spaceId && row.deviceId === this.identity.deviceId &&
        row.tabId === this.identity.tabId && row.state === 'awaiting_s4')
      .toArray()
    if (candidates.length !== 1) throw new Error('provisional_review_import_not_pending')
    const operation = candidates[0]!
    if (operation.operationId !== lockedOperationId) {
      throw new Error('provisional_review_import_boundary_mismatch')
    }
    const heldOutcomes = (await this.db.outbox.toArray())
      .filter((row) => row.compoundOperationId === operation.operationId && row.entityType === 'sessionWorkItemOutcome').length
    const outcomes = await this.db.sessionWorkItemOutcomes.where('sessionId').equals(draft.sessionId).count()
    const directIntent = await this.db.directCommandIntents.get(draft.operationId)
    const tab = await this.meta.sessionTabs.get(this.identity.tabId)
    if (!tab || tab.deviceId !== this.identity.deviceId || tab.closedAt !== null ||
        operation.spaceId !== this.spaceId || operation.sessionId !== draft.sessionId ||
        operation.deviceId !== this.identity.deviceId || operation.tabId !== this.identity.tabId ||
        operation.state !== 'awaiting_s4' || heldOutcomes !== 0 || outcomes !== 0 || directIntent) {
      throw new Error('provisional_review_import_boundary_mismatch')
    }
    return {
      session: cached,
      outcomes: [],
      envelopes: await this.db.sessionCommandEnvelopes.where('sessionId').equals(draft.sessionId).toArray() as CachedSessionCommandEnvelope[],
      receipts: await readSessionCommandReceipts(this.db, draft.sessionId) as Array<Record<string, unknown>>,
    }
  }

  private async cacheAuthoritative(action: Promise<FocusSessionAggregateView>): Promise<void> {
    await cacheFocusSession(this.db, this.spaceId, await action)
  }

  private async requireSession(sessionId: string): Promise<CachedFocusSession> {
    const stored = await this.db.focusSessions.get(sessionId) as (CachedFocusSession & { id?: string }) | undefined
    if (!stored) throw new Error('focus_session_not_found')
    const { id: _id, ...session } = stored
    return session as CachedFocusSession
  }

  private async requireLocalOwner(session: CachedFocusSession): Promise<LocalOwnerProof> {
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional') throw new Error('active_session_not_owned')
    const operations = await this.meta.provisionalOperations
      .where('sessionId').equals(session.sessionId)
      .and((row) => row.spaceId === this.spaceId && row.state === 'pending')
      .toArray()
    const tab = await this.meta.sessionTabs.get(this.identity.tabId)
    const operation = operations.length === 1 ? operations[0] : null
    if (!operation || operation.deviceId !== this.identity.deviceId ||
        operation.tabId !== this.identity.tabId || !tab ||
        tab.deviceId !== this.identity.deviceId || tab.closedAt !== null) {
      throw new Error('active_session_not_owned')
    }
    return { operation, transportState: localTransportState(session) }
  }

  private async withLocalOwner<T>(
    staleSession: CachedFocusSession,
    effect: (session: CachedFocusSession, proof: LocalOwnerProof, token: SpaceAuthorityToken) => Promise<T>,
  ): Promise<T> {
    return withSpaceAuthorityFence(this.spaceId, async (token) => {
      requireSpaceAuthorityToken(token, this.spaceId)
      requireSpaceDatabaseBinding(this.db, this.spaceId)
      assertLocalContentWritable(staleSession)
      const candidates = await this.meta.provisionalOperations
        .where('sessionId').equals(staleSession.sessionId)
        .and((row) => row.spaceId === this.spaceId &&
          row.deviceId === this.identity.deviceId && row.tabId === this.identity.tabId &&
          (row.state === 'pending' || row.state === 'activating'))
        .toArray()
      if (candidates.length !== 1) throw new Error('active_session_not_owned')
      return this.provisionalLock.run(candidates[0]!.operationId, async () => {
        const current = await this.requireSession(staleSession.sessionId)
        const proof = await this.requireLocalOwner(current)
        return effect(current, proof, token)
      })
    })
  }

  private clockAt(
    session: CachedFocusSession,
    occurredAt: string,
  ): { grossSeconds: number; pausedSeconds: number; focusedSeconds: number } {
    if (!occurredAt.endsWith('Z') || !Number.isFinite(Date.parse(occurredAt))) {
      throw new Error('occurredAt must be canonical UTC')
    }
    const occurredMs = Date.parse(occurredAt)
    const startedMs = Date.parse(session.startedAt)
    const pauseMs = session.pauseStartedAt === null ? null : Date.parse(session.pauseStartedAt)
    if ((pauseMs !== null && !Number.isFinite(pauseMs)) ||
        occurredMs < startedMs || (pauseMs !== null && occurredMs < pauseMs)) {
      throw new Error('session_clock_time_regression')
    }
    const extraPause = session.pauseStartedAt === null
      ? 0 : Math.floor((occurredMs - Date.parse(session.pauseStartedAt)) / 1000)
    const grossSeconds = Math.floor((occurredMs - startedMs) / 1000)
    const pausedSeconds = session.pausedSeconds + Math.max(0, extraPause)
    return {
      grossSeconds,
      pausedSeconds,
      focusedSeconds: Math.max(0, grossSeconds - pausedSeconds - session.breakSeconds),
    }
  }

  private async persistProvisionalClock(
    previous: CachedFocusSession,
    next: CachedFocusSession,
    operation: ProvisionalOperationRow,
    token: SpaceAuthorityToken,
  ): Promise<CachedFocusSession> {
    requireSpaceAuthorityToken(token, this.spaceId)
    requireSpaceDatabaseBinding(this.db, this.spaceId)
    const payloadHash = await hashCommandPayload(localSessionCreateHashPayload(next))
    const operationId = await boundedChildOperationId(operation.operationId, 'focus_session')
    await this.db.transaction('rw', this.db.focusSessions, this.db.outbox, async () => {
      const existing = await this.db.outbox.where('spaceId').equals(this.spaceId)
        .and((row) => row.entityType === 'focusSession' && row.entityId === next.sessionId && !row.synced)
        .first()
      await this.db.focusSessions.put({ id: next.sessionId, ...next })
      await enqueueOutbox(this.db, this.spaceId, token, 'focusSession', next.sessionId,
        previous.version === 0 ? 'create' : 'update', serializeFocusSessionCommandPostImage(next), {
          operationId,
          payloadHash,
          hashPayload: localSessionCreateHashPayload(next),
          expectedVersion: previous.version === 0 ? null : previous.version,
          transportState: 'awaiting_s4',
          createdAt: next.updatedAt,
          compoundOperationId: existing?.compoundOperationId ?? null,
          compoundOrder: existing?.compoundOrder ?? null,
        })
    })
    return next
  }

  async pauseProvisional(sessionId: string, occurredAt: string): Promise<CachedFocusSession> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional' || session.clockState !== 'running') {
      throw new Error('provisional_session_not_running')
    }
    return this.withLocalOwner(session, (current, { operation }, token) => this.persistProvisionalClock(current, {
      ...current,
      ...this.clockAt(current, occurredAt),
      sessionRevision: current.sessionRevision + 1,
      pauseStartedAt: occurredAt,
      clockState: 'paused',
      updatedAt: occurredAt,
    }, operation, token))
  }

  async resumeProvisional(sessionId: string, occurredAt: string): Promise<CachedFocusSession> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional' || session.clockState !== 'paused') {
      throw new Error('provisional_session_not_paused')
    }
    return this.withLocalOwner(session, (current, { operation }, token) => this.persistProvisionalClock(current, {
      ...current,
      ...this.clockAt(current, occurredAt),
      sessionRevision: current.sessionRevision + 1,
      pauseStartedAt: null,
      clockState: 'running',
      updatedAt: occurredAt,
    }, operation, token))
  }

  async endProvisional(
    sessionId: string,
    input: { occurredAt: string; timerCompletion: 'completed' | 'ended_early' | 'interrupted' },
  ): Promise<CachedFocusSession> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional' || session.clockState === 'ended') {
      throw new Error('provisional_session_not_active')
    }
    return this.withLocalOwner(session, async (current, { operation }, token) => {
      const next = await this.persistProvisionalClock(current, {
        ...current,
        ...this.clockAt(current, input.occurredAt),
        sessionRevision: current.sessionRevision + 1,
        endedAt: input.occurredAt,
        pauseStartedAt: null,
        clockState: 'ended',
        timerCompletion: input.timerCompletion,
        validity: 'pending',
        reviewState: 'pending',
        updatedAt: input.occurredAt,
      }, operation, token)
      await transitionProvisionalOperation(this.meta, this.spaceId, token,
        operation.operationId, ['pending', 'activating'], {
          state: 'awaiting_s4', updatedAt: input.occurredAt,
        })
      return next
    })
  }

  async setCurrentPlanItem(sessionId: string, workItemId: string | null): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const rows = await this.db.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray() as CachedSessionWorkItemPlan[]
    if (workItemId !== null && !rows.some((row) => row.workItemId === workItemId && row.removedAt === null)) {
      throw new Error('session_plan_item_not_found')
    }
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.setCurrentPlanItem({ sessionId, workItemId }))
      return
    }
    const createdAt = new Date().toISOString()
    await this.withLocalOwner(session, async (_current, { operation, transportState }, token) => {
      const lockedRows = await this.db.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray() as CachedSessionWorkItemPlan[]
      if (workItemId !== null && !lockedRows.some((row) => row.workItemId === workItemId && row.removedAt === null)) {
        throw new Error('session_plan_item_not_found')
      }
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
        for (const row of lockedRows) {
          const next: CachedSessionWorkItemPlan = {
            ...row,
            currentDuringSession: row.removedAt === null && row.workItemId === workItemId,
            updatedAt: createdAt,
          }
          if (next.currentDuringSession === row.currentDuringSession) continue
          const localCreate = row.version === 0
          const payloadHash = await Dexie.waitFor(hashCommandPayload(localPlanCreateHashPayload(next)))
          const operationId = await Dexie.waitFor(boundedChildOperationId(operation.operationId, `plan:${row.id}`))
          await this.db.sessionWorkItemPlans.put(next)
          await enqueueOutbox(this.db, this.spaceId, token, 'sessionWorkItemPlan', row.id,
            localCreate ? 'create' : 'update', serializeSessionPlanCommandPostImage(next), {
              operationId, payloadHash,
              hashPayload: localPlanCreateHashPayload(next),
              expectedVersion: localCreate ? null : row.version,
              transportState, createdAt,
              compoundOperationId: operation.operationId,
              compoundOrder: null,
            })
        }
      })
    })
  }

  async updateSessionNote(sessionId: string, sessionNote: string): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.updateSessionNote({ sessionId, sessionNote }))
      return
    }
    const createdAt = new Date().toISOString()
    await this.withLocalOwner(session, async (current, { operation, transportState }, token) => {
      const operationId = await boundedChildOperationId(operation.operationId, 'focus_session')
      await this.db.transaction('rw', this.db.focusSessions, this.db.outbox, async () => {
        const next = { ...current, sessionNote, updatedAt: createdAt }
        const localCreate = current.version === 0
        const payloadHash = await Dexie.waitFor(hashCommandPayload(localSessionCreateHashPayload(next)))
        const existing = await this.db.outbox.where('spaceId').equals(this.spaceId)
          .and((row) => row.entityType === 'focusSession' && row.entityId === sessionId && !row.synced)
          .first()
        await this.db.focusSessions.put({ id: next.sessionId, ...next })
        await enqueueOutbox(this.db, this.spaceId, token, 'focusSession', sessionId,
          localCreate ? 'create' : 'update', serializeFocusSessionCommandPostImage(next), {
            operationId, payloadHash,
            hashPayload: localSessionCreateHashPayload(next),
            expectedVersion: localCreate ? null : current.version,
            transportState, createdAt,
            compoundOperationId: existing?.compoundOperationId ?? null,
            compoundOrder: existing?.compoundOrder ?? null,
          })
      })
    })
  }

  async setCompletionDraft(
    sessionId: string,
    planItemId: string,
    completionDraft: boolean,
  ): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const row = await this.db.sessionWorkItemPlans.get(planItemId) as CachedSessionWorkItemPlan | undefined
    if (!row || row.sessionId !== sessionId) throw new Error('session_plan_item_not_found')
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.setCompletionDraft({ sessionId, planItemId, completionDraft }))
      return
    }
    const createdAt = new Date().toISOString()
    await this.withLocalOwner(session, async (_current, { operation, transportState }, token) => {
      const lockedRow = await this.db.sessionWorkItemPlans.get(planItemId) as CachedSessionWorkItemPlan | undefined
      if (!lockedRow || lockedRow.sessionId !== sessionId) throw new Error('session_plan_item_not_found')
      const next: CachedSessionWorkItemPlan = { ...lockedRow, completionDraft, updatedAt: createdAt }
      const localCreate = lockedRow.version === 0
      const payloadHash = await Dexie.waitFor(hashCommandPayload(localPlanCreateHashPayload(next)))
      const operationId = await boundedChildOperationId(operation.operationId, `plan:${lockedRow.id}`)
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
        await this.db.sessionWorkItemPlans.put(next)
        await enqueueOutbox(this.db, this.spaceId, token, 'sessionWorkItemPlan', lockedRow.id,
          localCreate ? 'create' : 'update', serializeSessionPlanCommandPostImage(next), {
            operationId, payloadHash,
            hashPayload: localPlanCreateHashPayload(next),
            expectedVersion: localCreate ? null : lockedRow.version,
            transportState, createdAt,
            compoundOperationId: operation.operationId,
            compoundOrder: null,
          })
      })
    })
  }

  async addPlanItem(
    sessionId: string,
    workItemId: string,
    planRank: number,
    addedAt: string,
  ): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const context = await this.db.sessionTaskContexts.where('sessionId').equals(sessionId).first()
    const workItem = await this.db.workItems.get(workItemId) as {
      id: string; title: string; depth: number; parentId: string | null; version: number;
    } | undefined
    if (!context || !workItem || workItem.depth !== 3 || workItem.parentId !== context.level2WorkItemId) {
      throw new Error('plan_item_must_be_same_parent_level3')
    }
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.addPlanItem({
        sessionId, workItemId, expectedWorkItemVersion: workItem.version, planRank, addedAt,
      }))
      return
    }
    await this.withLocalOwner(session, async (_current, { operation, transportState }, token) => {
      const lockedContext = await this.db.sessionTaskContexts.where('sessionId').equals(sessionId).first() as CachedSessionTaskContext | undefined
      const lockedWorkItem = await this.db.workItems.get(workItemId) as typeof workItem
      if (!lockedContext || !lockedWorkItem || lockedWorkItem.depth !== 3 ||
          lockedWorkItem.parentId !== lockedContext.level2WorkItemId) {
        throw new Error('plan_item_must_be_same_parent_level3')
      }
      const next: CachedSessionWorkItemPlan = {
        id: crypto.randomUUID(), sessionId, workItemId,
        titleSnapshot: lockedWorkItem.title,
        level2WorkItemIdSnapshot: lockedContext.level2WorkItemId,
        workItemVersionSnapshot: lockedWorkItem.version,
        planRank, source: 'during_session', addedAt, removedAt: null,
        removalReason: null, currentDuringSession: false, completionDraft: false,
        version: 0, createdAt: addedAt, updatedAt: addedAt,
      }
      const payloadHash = await hashCommandPayload(localPlanCreateHashPayload(next))
      const operationId = await boundedChildOperationId(operation.operationId, `plan:${next.id}`)
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
        await this.db.sessionWorkItemPlans.add(next)
        await enqueueOutbox(this.db, this.spaceId, token, 'sessionWorkItemPlan', next.id, 'create',
          serializeSessionPlanCommandPostImage(next), {
            operationId, payloadHash, expectedVersion: null, transportState,
            hashPayload: localPlanCreateHashPayload(next),
            createdAt: addedAt, compoundOperationId: operation.operationId, compoundOrder: 0,
          })
        await reindexUnattemptedProvisionalPlanOutbox(this.db, operation.operationId, sessionId, token)
      })
    })
  }

  async removePlanItem(
    sessionId: string,
    planItemId: string,
    removedAt: string,
    removalReason: string,
  ): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const row = await this.db.sessionWorkItemPlans.get(planItemId)
    if (!row || row.sessionId !== sessionId) throw new Error('session_plan_item_not_found')
    if (!removalReason.trim()) throw new Error('removalReason must be nonblank')
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.removePlanItem({ sessionId, planItemId, removedAt, removalReason }))
      return
    }
    await this.withLocalOwner(session, async (_current, { operation, transportState }, token) => {
      const lockedRow = await this.db.sessionWorkItemPlans.get(planItemId) as CachedSessionWorkItemPlan | undefined
      if (!lockedRow || lockedRow.sessionId !== sessionId) throw new Error('session_plan_item_not_found')
      const next: CachedSessionWorkItemPlan = {
        ...lockedRow, removedAt, removalReason, currentDuringSession: false, updatedAt: removedAt,
      }
      const localCreate = lockedRow.version === 0
      const payloadHash = await hashCommandPayload(localPlanCreateHashPayload(next))
      const operationId = await boundedChildOperationId(operation.operationId, `plan:${lockedRow.id}`)
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
        await this.db.sessionWorkItemPlans.put(next)
        await enqueueOutbox(this.db, this.spaceId, token, 'sessionWorkItemPlan', lockedRow.id,
          localCreate ? 'create' : 'update', serializeSessionPlanCommandPostImage(next), {
            operationId, payloadHash,
            hashPayload: localPlanCreateHashPayload(next),
            expectedVersion: localCreate ? null : lockedRow.version,
            transportState, createdAt: removedAt,
            compoundOperationId: operation.operationId, compoundOrder: null,
          })
      })
    })
  }

  private async readCachedAggregate(sessionId: string): Promise<LocalFocusSessionAggregate> {
    const session = await this.requireSession(sessionId)
    const context = await this.db.sessionTaskContexts.where('sessionId').equals(sessionId).first() as CachedSessionTaskContext | undefined
    const attributions = await this.db.sessionAttributionRevisions.where('sessionId').equals(sessionId).toArray() as CachedSessionAttributionRevision[]
    const plans = await this.db.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray() as CachedSessionWorkItemPlan[]
    const outcomes = await this.db.sessionWorkItemOutcomes.where('sessionId').equals(sessionId).toArray() as CachedSessionWorkItemOutcome[]
    const envelopes = await this.db.sessionCommandEnvelopes.where('sessionId').equals(sessionId).toArray() as CachedSessionCommandEnvelope[]
    const receipts = await readSessionCommandReceipts(this.db, sessionId) as Array<Record<string, unknown>>
    const attribution = attributions.find((row) => row.effective) ?? attributions.sort((left, right) => right.revision - left.revision)[0]
    if (!attribution) throw new Error('focus_session_attribution_not_found')
    const aggregate = {
      session, context: context ?? null, attribution, plan: plans,
      outcomes, commandEnvelopes: envelopes, commandReceipts: receipts,
    }
    assertSessionIdentity(aggregate)
    return aggregate
  }

  private async requireCachedStartSnapshots(input: ProvisionalStartInput): Promise<{
    project: Record<string, unknown>
    level2: Record<string, unknown>
    level3: Array<Record<string, unknown>>
  }> {
    if (input.spaceId !== this.spaceId) throw new Error('focus_session_space_mismatch')
    const level2 = await this.db.workItems.get(input.level2WorkItemId) as Record<string, unknown> | undefined
    if (!level2 || level2.depth !== 2 || typeof level2.statusDefinitionId !== 'string' ||
        !String(level2.statusDefinitionId).trim()) throw new Error('provisional_start_snapshot_missing')
    const project = await this.db.projects.get(String(level2.projectId)) as Record<string, unknown> | undefined
    if (!project || project.id !== level2.projectId || typeof project.name !== 'string' || !project.name.trim()) {
      throw new Error('provisional_start_snapshot_missing')
    }
    const level3: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const id of input.level3WorkItemIds) {
      if (seen.has(id)) throw new Error('provisional_start_plan_duplicate')
      seen.add(id)
      const row = await this.db.workItems.get(id) as Record<string, unknown> | undefined
      if (!row || row.depth !== 3 || row.parentId !== input.level2WorkItemId || row.projectId !== level2.projectId ||
          typeof row.title !== 'string' || !row.title.trim()) {
        throw new Error('provisional_start_snapshot_missing')
      }
      level3.push(row)
    }
    const expected = {
      [input.level2WorkItemId]: level2.version,
      ...Object.fromEntries(level3.map((row) => [String(row.id), row.version])),
    }
    const actualKeys = Object.keys(input.expectedWorkItemVersions).sort()
    const expectedKeys = Object.keys(expected).sort()
    if (actualKeys.join('\0') !== expectedKeys.join('\0') ||
        expectedKeys.some((id) => input.expectedWorkItemVersions[id] !== expected[id])) {
      throw new Error('provisional_start_snapshot_version_mismatch')
    }
    return { project: project ?? {}, level2, level3 }
  }

  private async persistProvisionalAggregateAndOutbox(
    aggregate: LocalFocusSessionAggregate,
    operation: ProvisionalOperationRow,
    token: SpaceAuthorityToken,
  ): Promise<void> {
    requireSpaceAuthorityToken(token, this.spaceId)
    requireSpaceDatabaseBinding(this.db, this.spaceId)
    if (!aggregate.context || aggregate.attribution.revision !== 1 || !aggregate.attribution.effective ||
        aggregate.plan.some((item) => item.source === 'review_materialized')) {
      throw new Error('invalid_initial_provisional_aggregate')
    }
    const orderedPlan = [...aggregate.plan].sort((left, right) => left.planRank - right.planRank || left.id.localeCompare(right.id))
    const descriptors = [
      {
        entityType: 'focusSession' as const, entityId: aggregate.session.sessionId,
        suffix: 'focus_session', row: aggregate.session,
        postImage: serializeFocusSessionCommandPostImage(aggregate.session),
        businessPayload: localSessionCreateHashPayload(aggregate.session),
      },
      {
        entityType: 'sessionTaskContext' as const, entityId: aggregate.context.id,
        suffix: 'session_task_context', row: aggregate.context,
        postImage: serializeSessionTaskContextCommandPostImage(aggregate.context),
        businessPayload: localContextCreateHashPayload(aggregate.context),
      },
      {
        entityType: 'sessionAttributionRevision' as const,
        entityId: aggregate.attribution.id, suffix: 'attribution:0001',
        row: aggregate.attribution,
        postImage: serializeSessionAttributionCommandPostImage(aggregate.attribution),
        businessPayload: localAttributionCreateHashPayload(aggregate.attribution),
      },
      ...orderedPlan.map((row) => ({
        entityType: 'sessionWorkItemPlan' as const, entityId: row.id,
        suffix: `plan:${row.id}`, row,
        postImage: serializeSessionPlanCommandPostImage(row),
        businessPayload: localPlanCreateHashPayload(row),
      })),
    ]
    const prepared = await Promise.all(descriptors.map(async (descriptor, compoundOrder) => ({
      ...descriptor,
      compoundOrder,
      operationId: await boundedChildOperationId(operation.operationId, descriptor.suffix),
      payloadHash: await hashCommandPayload(descriptor.businessPayload),
    })))
    if (new Set(prepared.map((item) => item.operationId)).size !== prepared.length) {
      throw new Error('duplicate_provisional_child_operation_id')
    }
    await this.db.transaction(
      'rw', this.db.focusSessions, this.db.sessionTaskContexts,
      this.db.sessionAttributionRevisions, this.db.sessionWorkItemPlans,
        this.db.outbox,
      async () => {
        for (const item of prepared) {
          const storedRow = item.entityType === 'focusSession'
            ? { id: item.entityId, ...item.row }
            : item.row
          await this.db.table(TS3_LOCAL_ENTITY_TO_TABLE[item.entityType]).put(storedRow)
          await enqueueOutbox(this.db, this.spaceId, token, item.entityType, item.entityId, 'create', item.postImage, {
            operationId: item.operationId, payloadHash: item.payloadHash,
            hashPayload: item.businessPayload,
            expectedVersion: null, transportState: 'awaiting_s4',
            createdAt: operation.createdAt,
            compoundOperationId: operation.operationId, compoundOrder: item.compoundOrder,
          })
        }
      },
    )
  }

  private async resumeExistingProvisionalStart(
    input: ProvisionalStartInput,
    snapshots: { project: Record<string, unknown>; level2: Record<string, unknown>; level3: Array<Record<string, unknown>> } | null,
    operation: ProvisionalOperationRow,
    token: SpaceAuthorityToken,
  ): Promise<LocalFocusSessionAggregate> {
    requireSpaceAuthorityToken(token, this.spaceId)
    requireSpaceDatabaseBinding(this.db, this.spaceId)
    const existing = await this.db.focusSessions.get(operation.sessionId)
    if (existing) {
      if (operation.state === 'awaiting_s4' &&
          (existing.endedAt !== null || existing.clockState === 'ended')) {
        throw new Error('terminal_provisional_requires_s4_import')
      }
      if (operation.state === 'activating' || operation.state === 'conflict' || operation.state === 'activation_resolved') {
        throw new Error('provisional_start_recovery_required')
      }
      const aggregate = await this.readCachedAggregate(operation.sessionId)
      await assertCompleteProvisionalOutbox(this.db, this.spaceId, operation.operationId, aggregate)
      return aggregate
    }
    if (operation.state === 'awaiting_s4' || operation.state === 'conflict' || operation.state === 'activation_resolved') {
      throw new Error('provisional_start_recovery_required')
    }
    const aggregate = buildLocalProvisionalAggregate(
      input,
      snapshots ?? await this.requireCachedStartSnapshots(input),
    )
    await transitionProvisionalOperation(this.meta, this.spaceId, token,
      operation.operationId, ['pending'], { state: 'activating', updatedAt: input.startedAt })
    try {
      await this.persistProvisionalAggregateAndOutbox(aggregate, operation, token)
      await transitionProvisionalOperation(this.meta, this.spaceId, token,
        operation.operationId, ['activating'], { state: 'pending', updatedAt: input.startedAt })
      return aggregate
    } catch (error) {
      const current = await this.meta.provisionalOperations.get(operation.operationId)
      if (current?.intentJson === operation.intentJson && current.payloadHash === operation.payloadHash &&
          current.state === 'activating') {
        await transitionProvisionalOperation(this.meta, this.spaceId, token,
          operation.operationId, ['activating'], {
            state: 'pending', updatedAt: new Date().toISOString(),
          })
      }
      throw error
    }
  }

  async startProvisional(input: ProvisionalStartInput): Promise<LocalFocusSessionAggregate> {
    return withSpaceAuthorityFence(this.spaceId, (token) => this.provisionalLock.run(input.operationId, async () => {
      const cachedLocator = await this.meta.activeSessionLocator.get('active')
      const metaRow = await buildProvisionalOperationRow(input, cachedLocator?.ownershipEpoch ?? null)
      const existing = await this.meta.provisionalOperations.get(metaRow.operationId)
      if (existing) {
        const claim = await claimProvisionalOperation(this.meta, this.spaceId, token, metaRow)
        if (claim.disposition === 'existing') return this.resumeExistingProvisionalStart(input, null, claim.row, token)
      }
      const snapshots = await this.requireCachedStartSnapshots(input)
      const claim = await claimProvisionalOperation(this.meta, this.spaceId, token, metaRow)
      if (claim.disposition === 'existing') return this.resumeExistingProvisionalStart(input, snapshots, claim.row, token)
      await transitionProvisionalOperation(this.meta, this.spaceId, token,
        metaRow.operationId, ['pending'], { state: 'activating', updatedAt: input.startedAt })
      try {
        const aggregate = buildLocalProvisionalAggregate(input, snapshots)
        await this.persistProvisionalAggregateAndOutbox(aggregate, metaRow, token)
        await transitionProvisionalOperation(this.meta, this.spaceId, token,
          metaRow.operationId, ['activating'], { state: 'pending', updatedAt: input.startedAt })
        return aggregate
      } catch (error) {
        const current = await this.meta.provisionalOperations.get(metaRow.operationId)
        if (current?.intentJson === metaRow.intentJson && current.payloadHash === metaRow.payloadHash && current.state === 'activating') {
          await transitionProvisionalOperation(this.meta, this.spaceId, token,
            metaRow.operationId, ['activating'], {
              state: 'pending', updatedAt: new Date().toISOString(),
            })
        }
        throw error
      }
    }))
  }

  async saveReviewCache(row: Record<string, unknown>): Promise<void> {
    if (row.spaceId !== this.spaceId) throw new Error('focus_session_space_mismatch')
    await this.db.sessionReviewDrafts.put(row)
  }
}

function buildLocalProvisionalAggregate(
  input: ProvisionalStartInput,
  snapshots: { project: Record<string, unknown>; level2: Record<string, unknown>; level3: Array<Record<string, unknown>> },
): LocalFocusSessionAggregate {
  const project = snapshots.project
  const level2 = snapshots.level2
  const statusDefinitionId = level2.statusDefinitionId
  if (typeof statusDefinitionId !== 'string' || !statusDefinitionId.trim()) {
    throw new Error('provisional_start_snapshot_missing')
  }
  const sessionId = input.sessionId
  const session = {
    sessionId,
    sessionRevision: 1,
    startedAt: input.startedAt,
    endedAt: null,
    pauseStartedAt: null,
    plannedSeconds: input.plannedSeconds,
    grossSeconds: 0,
    pausedSeconds: 0,
    breakSeconds: 0,
    focusedSeconds: 0,
    timerCompletion: null,
    validity: 'pending' as const,
    validityReason: null,
    overallProgress: null,
    mood: null,
    reviewState: 'not_required' as const,
    ownershipState: 'local_provisional' as const,
    sessionNote: '',
    version: 0,
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
    clockState: 'running' as const,
  } as CachedFocusSession
  const context: CachedSessionTaskContext = {
    id: crypto.randomUUID(), sessionId,
    projectId: String(level2.projectId),
    level2WorkItemId: input.level2WorkItemId,
    projectTitleSnapshot: typeof project.name === 'string' ? project.name : String(level2.projectId),
    level2TitleSnapshot: String(level2.title),
    level2ParentIdSnapshot: (level2.parentId as string | null | undefined) ?? null,
    level2StatusDefinitionIdSnapshot: statusDefinitionId,
    level2VersionSnapshot: Number(level2.version),
    level2EffortLowerSecondsSnapshot: (level2.effortEstimateLowerSeconds as number | null | undefined) ?? null,
    level2EffortUpperSecondsSnapshot: (level2.effortEstimateUpperSeconds as number | null | undefined) ?? null,
    linkedAt: input.startedAt, linkMethod: 'explicit',
    version: 0, createdAt: input.startedAt, updatedAt: input.startedAt,
  }
  const attribution: CachedSessionAttributionRevision = {
    id: crypto.randomUUID(), sessionId, revision: 1,
    projectId: context.projectId, level2WorkItemId: input.level2WorkItemId,
    reason: null, correctedFromRevision: null, effective: true,
    version: 0, createdAt: input.startedAt, updatedAt: input.startedAt,
  }
  const plan = snapshots.level3.map((item, planRank) => ({
    id: crypto.randomUUID(), sessionId, workItemId: String(item.id),
    titleSnapshot: String(item.title), level2WorkItemIdSnapshot: input.level2WorkItemId,
    workItemVersionSnapshot: Number(item.version), planRank,
    source: 'before_start' as const, addedAt: input.startedAt, removedAt: null,
    removalReason: null, currentDuringSession: planRank === 0, completionDraft: false,
    version: 0, createdAt: input.startedAt, updatedAt: input.startedAt,
  }))
  return {
    session, context, attribution, plan,
    outcomes: [], commandEnvelopes: [], commandReceipts: [],
  }
}
