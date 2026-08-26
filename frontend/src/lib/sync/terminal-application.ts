import { canonicalize } from 'json-canonicalize'
import Dexie from 'dexie'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { MetaDB } from '@/services/meta-database'
import {
  INITIAL_S4_OUTBOX_FIELDS,
} from '@/services/database'
import type {
  PomodoroXIDB,
  SyncPendingPushBatch,
  SyncTerminalApplicationEvidence,
} from '@/services/database'
import type { OutboxEvent } from '@/types'
import type { ApiSyncV2PushResponse, RetainedLwwSyncEntityType } from './types'
import { ENTITY_TYPE_TO_TABLE } from './types'
import { requireCanonicalStoredTimestamp } from './response-schema'
import {
  encodeBase64,
  deterministicTerminalNextAttempt,
  freezeOutboxIdentity,
  loadAndValidateActiveReceiptInCurrentTransaction,
  parseAndValidateTerminalEvidenceResult,
  PushAuthorityIntegrityError,
  reloadCompleteAuthorityAndRequireUnchangedSelection,
  requireSameFrozenIdentity,
  requireReceiptMatchesFrozenAuthority,
  requireTerminalDiagnosticMatchesEvidence,
  sha256Canonical,
  sha256HexBytes,
  type PushSelection,
} from './authority-identity'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { resolveTransportTerminal } from './provisional-operation-authority'

export function requireExactTerminalCoverage(
  selected: PushSelection,
  result: ApiSyncV2PushResponse,
): void {
  if (result.batch_id !== selected.authority.batchId) {
    throw new PushAuthorityIntegrityError('terminal_batch_identity_mismatch')
  }
  const outcomes = [
    ...result.applied, ...result.conflicts, ...result.errors,
  ]
  const outcomeIds = outcomes.map((item) => item.operation_id)
  if (new Set(outcomeIds).size !== outcomeIds.length ||
      new Set(outcomeIds).size !== selected.operationIds.length ||
      outcomeIds.some((id) => !selected.operationIds.includes(id))) {
    throw new PushAuthorityIntegrityError('terminal_operation_coverage_mismatch')
  }
  const frozenByOperation = new Map(
    selected.frozenRows.map((row) => [row.operationId, row]),
  )
  for (const outcome of outcomes) {
    const frozen = frozenByOperation.get(outcome.operation_id)
    if (!frozen || outcome.entity_type !== frozen.entityType ||
        outcome.entity_id !== frozen.entityId) {
      throw new PushAuthorityIntegrityError('terminal_entity_identity_mismatch')
    }
  }
}

async function buildEvidence(
  spaceId: string,
  selected: PushSelection,
  result: ApiSyncV2PushResponse,
  source: SyncTerminalApplicationEvidence['source'],
): Promise<SyncTerminalApplicationEvidence> {
  requireExactTerminalCoverage(selected, result)
  const resultCanonical = canonicalize(result)
  if (resultCanonical === undefined) {
    throw new PushAuthorityIntegrityError('terminal_result_not_canonical')
  }
  const resultBytes = new TextEncoder().encode(resultCanonical)
  const operationIdsSha256 = await sha256Canonical(selected.operationIds)
  const resultSha256 = await sha256HexBytes(resultBytes)
  const identity = {
    spaceId, batchId: selected.authority.batchId,
    authorityKind: selected.authority.kind,
    readyRootSetSha256: selected.readyRootSetSha256,
    operationIds: [...selected.operationIds], operationIdsSha256, resultSha256,
  }
  return {
    evidenceId: await sha256Canonical(identity),
    spaceId, source, state: 'space_committed',
    authorityKind: selected.authority.kind,
    batchId: selected.authority.batchId,
    compoundOperationId: selected.authority.compoundOperationId,
    operationIds: [...selected.operationIds], operationIdsSha256,
    readyRoots: structuredClone([...selected.readyRoots]),
    readyRootSetSha256: selected.readyRootSetSha256,
    resultCanonicalBase64: encodeBase64(resultBytes), resultSha256,
    appliedCount: result.applied.length,
    committedAt: canonicalNow(), metaReconciledAt: null,
  }
}

/** @internal Compare only immutable terminal evidence identity and payload fields. */
export function requireSameTerminalEvidence(
  existing: SyncTerminalApplicationEvidence,
  candidate: SyncTerminalApplicationEvidence,
): void {
  const keys = [
    'evidenceId', 'spaceId', 'authorityKind', 'batchId', 'compoundOperationId',
    'operationIds', 'operationIdsSha256', 'readyRoots', 'readyRootSetSha256',
    'resultCanonicalBase64', 'resultSha256', 'appliedCount',
  ] as const
  for (const key of keys) {
    if (canonicalize(existing[key]) !== canonicalize(candidate[key])) {
      throw new PushAuthorityIntegrityError(`terminal_evidence_mismatch:${key}`)
    }
  }
}

/** @internal Test seam: retain each terminal diagnostic without deleting successors. */
export async function applyTerminalOutcomesWithoutDeletingSuccessors(
  db: PomodoroXIDB, spaceId: string, token: SpaceAuthorityToken,
  rows: readonly OutboxEvent[], result: ApiSyncV2PushResponse,
  terminalizedAt: string,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const currentByOperation = new Map(rows.map((row) => [row.operationId, row]))
  for (const [kind, outcome] of [
    ...result.conflicts.map((item) => ['terminal_conflict', item] as const),
    ...result.errors.map((item) => ['terminal_error', item] as const),
  ]) {
    const row = currentByOperation.get(outcome.operation_id)
    if (!row) throw new PushAuthorityIntegrityError('terminal_rejection_row_missing')
    const outcomeCanonical = canonicalize(outcome)
    if (outcomeCanonical === undefined) throw new PushAuthorityIntegrityError('terminal_outcome_not_canonical')
    if (!Number.isSafeInteger(row.id) || row.id! < 1) {
      throw new PushAuthorityIntegrityError('terminal_rejection_durable_key_invalid')
    }
    await db.outbox.update(row.id!, {
      serverOutcomeCanonicalBase64: encodeBase64(new TextEncoder().encode(outcomeCanonical)),
      transportState: kind,
      retryable: 'retryable' in outcome ? outcome.retryable : false,
      nextAttemptAt: 'retryable' in outcome && outcome.retryable
        ? deterministicTerminalNextAttempt(row.attemptCount, terminalizedAt) : null,
    })
  }
}

const RETRY_SUCCESSOR_IMMUTABLE_KEYS = [
  'entityType', 'entityId', 'action', 'payload', 'payloadHash',
  'expectedVersion', 'requiresVersionRebase', 'createdAt',
] as const satisfies readonly (keyof OutboxEvent)[]

function requireRetrySuccessorMatchesOriginal(
  original: OutboxEvent, successor: OutboxEvent, successorOperationId: string,
): void {
  if (successor.operationId !== successorOperationId || successorOperationId === original.operationId ||
      successor.retryPredecessorOperationId !== original.operationId ||
      successor.compoundOperationId !== null || successor.compoundOrder !== null) {
    throw new PushAuthorityIntegrityError('terminal_retry_successor_link_mismatch')
  }
  for (const key of RETRY_SUCCESSOR_IMMUTABLE_KEYS) {
    if (canonicalize(successor[key]) !== canonicalize(original[key])) {
      throw new PushAuthorityIntegrityError(`terminal_retry_successor_drift:${key}`)
    }
  }
}

async function requireExistingRetrySuccessor(
  db: PomodoroXIDB, original: OutboxEvent, successorOperationId: string,
  evidenceRows: readonly SyncTerminalApplicationEvidence[],
): Promise<void> {
  const liveSuccessors = await db.outbox.filter((row) =>
    row.retryPredecessorOperationId === original.operationId).toArray()
  const appliedEvidence: SyncTerminalApplicationEvidence[] = []
  for (const evidence of evidenceRows) {
    if (!evidence.readyRoots.some((root) => root.orderedChildren.some((child) =>
      child.operationId === successorOperationId))) continue
    const result = await parseAndValidateTerminalEvidenceResult(evidence)
    if (result.applied.some((item) => item.operation_id === successorOperationId)) {
      appliedEvidence.push(evidence)
    }
  }
  if (liveSuccessors.length === 1 && appliedEvidence.length === 0) {
    requireRetrySuccessorMatchesOriginal(original, liveSuccessors[0]!, successorOperationId)
    return
  }
  if (liveSuccessors.length === 0 && appliedEvidence.length === 1) return
  throw new PushAuthorityIntegrityError('terminal_retry_successor_lineage_invalid')
}

export async function createRetrySuccessorFromTerminalError(input: {
  db: PomodoroXIDB; spaceId: string; token: SpaceAuthorityToken;
  durableKey: number; operationId: string; now: string;
}): Promise<string> {
  requireSpaceAuthorityToken(input.token, input.spaceId)
  requireSpaceDatabaseBinding(input.db, input.spaceId)
  const now = requireCanonicalStoredTimestamp(input.now)
  const nowMs = Date.parse(now)
  return input.db.transaction('rw', input.db.outbox, input.db.syncTerminalApplications, async () => {
    const original = await input.db.outbox.get(input.durableKey)
    if (!original || original.spaceId !== input.spaceId || original.operationId !== input.operationId) {
      throw new PushAuthorityIntegrityError('terminal_error_not_retryable')
    }
    const evidenceRows = await input.db.syncTerminalApplications.where('spaceId').equals(input.spaceId).toArray()
    const matching = evidenceRows.filter((evidence) => evidence.readyRoots.some((root) =>
      root.orderedChildren.some((child) => child.operationId === original.operationId && child.durableKey === original.id)))
    if (matching.length !== 1) throw new PushAuthorityIntegrityError('terminal_retry_evidence_coverage_mismatch')
    const evidence = matching[0]!
    const result = await Dexie.waitFor(parseAndValidateTerminalEvidenceResult(evidence))
    await Dexie.waitFor(requireTerminalDiagnosticMatchesEvidence(original, evidence, result))
    const nextAttemptMs = original.nextAttemptAt === null ? Number.NaN : Date.parse(original.nextAttemptAt)
    if (original.transportState !== 'terminal_error' || !original.retryable || original.nextAttemptAt === null ||
        original.compoundOperationId !== null || !Number.isFinite(nowMs) || !Number.isFinite(nextAttemptMs) || nowMs < nextAttemptMs) {
      throw new PushAuthorityIntegrityError('terminal_error_not_retryable')
    }
    if (original.retrySuccessorOperationId !== null) {
      await Dexie.waitFor(requireExistingRetrySuccessor(input.db, original, original.retrySuccessorOperationId, evidenceRows))
      return original.retrySuccessorOperationId
    }
    const unlinkedSuccessors = await input.db.outbox.filter((row) =>
      row.retryPredecessorOperationId === original.operationId).count()
    if (unlinkedSuccessors !== 0) {
      throw new PushAuthorityIntegrityError('terminal_retry_successor_lineage_invalid')
    }
    const successorOperationId = crypto.randomUUID()
    await input.db.outbox.add({
      ...original, id: undefined, operationId: successorOperationId,
      transportState: 'awaiting_s4', attemptCount: 0,
      compoundOperationId: null, compoundOrder: null,
      ...INITIAL_S4_OUTBOX_FIELDS,
      retryPredecessorOperationId: original.operationId,
      synced: false, lastError: null, lastErrorCode: null, failedAt: null,
    })
    const consumed = await input.db.outbox.where(':id').equals(original.id!)
      .and((row) => row.operationId === original.operationId && row.retrySuccessorOperationId === null)
      .modify({ retrySuccessorOperationId: successorOperationId })
    if (consumed !== 1) throw new PushAuthorityIntegrityError('terminal_retry_intent_cas_failed')
    return successorOperationId
  })
}

export async function applyTerminalResultTwoPhase(
  db: PomodoroXIDB,
  _meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  selected: PushSelection,
  result: ApiSyncV2PushResponse,
  source: SyncTerminalApplicationEvidence['source'],
): Promise<number> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const evidence = await buildEvidence(spaceId, selected, result, source)
  // QN-S2 补强：applied 的 RetainedLWW 实体行收敛 _dirty=false（仅限 LWW 实体，避开 TS3/S4）
  const appliedIds = new Set(result.applied.map((item) => item.operation_id))
  const appliedEntityTables = new Set<string>()
  for (const outcome of result.applied) {
    const tableName =
      ENTITY_TYPE_TO_TABLE[outcome.entity_type as RetainedLwwSyncEntityType]
    if (tableName) appliedEntityTables.add(tableName)
  }
  const transactionTables: Array<string | Dexie.Table> = [
    db.outbox, db.syncPushBatches, db.syncTerminalApplications,
  ]
  for (const tableName of appliedEntityTables) {
    transactionTables.push(db.table(tableName))
  }
  await db.transaction(
    'rw', transactionTables,
    async () => {
      requireSpaceAuthorityToken(token, spaceId)
      await reloadCompleteAuthorityAndRequireUnchangedSelection(db, selected)
      const existing = await db.syncTerminalApplications.get(evidence.evidenceId)
      if (existing) {
        requireSameTerminalEvidence(existing, evidence)
      }
      if (!existing) await db.syncTerminalApplications.put(evidence)
      const terminalizedAt = existing?.committedAt ?? evidence.committedAt
      for (const frozen of selected.frozenRows) {
        const current = await db.outbox.get(frozen.durableKey)
        if (!current) throw new PushAuthorityIntegrityError('terminal_outbox_row_missing')
        requireSameFrozenIdentity(
          frozen,
          await Dexie.waitFor(freezeOutboxIdentity(current)),
        )
        if (!appliedIds.has(frozen.operationId)) continue
        await db.outbox.delete(frozen.durableKey)
        const tableName =
          ENTITY_TYPE_TO_TABLE[frozen.entityType as RetainedLwwSyncEntityType]
        if (tableName) {
          await db.table(tableName).update(frozen.entityId, { _dirty: false })
        }
      }
      const rejected = [...result.conflicts, ...result.errors]
      for (const outcome of rejected) {
        const frozen = selected.frozenRows.find((row) => row.operationId === outcome.operation_id)
        if (!frozen) throw new PushAuthorityIntegrityError('terminal_rejection_row_missing')
        const current = await db.outbox.get(frozen.durableKey)
        if (!current) throw new PushAuthorityIntegrityError('terminal_rejection_row_missing')
        const canonicalOutcome = canonicalize(outcome)
        if (canonicalOutcome === undefined) throw new PushAuthorityIntegrityError('terminal_outcome_not_canonical')
        await db.outbox.update(frozen.durableKey, {
          transportState: result.conflicts.some((item) => item.operation_id === outcome.operation_id)
            ? 'terminal_conflict' : 'terminal_error',
          serverOutcomeCanonicalBase64: encodeBase64(new TextEncoder().encode(canonicalOutcome)),
          retryable: 'retryable' in outcome ? outcome.retryable : false,
          nextAttemptAt: 'retryable' in outcome && outcome.retryable
            ? deterministicTerminalNextAttempt(frozen.attemptCount, terminalizedAt) : null,
        } satisfies Partial<OutboxEvent>)
      }
      const activeReceipt = await loadAndValidateActiveReceiptInCurrentTransaction(db)
      if (activeReceipt) {
        requireReceiptMatchesFrozenAuthority(activeReceipt, selected)
        await db.syncPushBatches.delete('active')
      }
    },
  )
  if (evidence.compoundOperationId !== null) {
    const compoundRoot = evidence.readyRoots.find((root) =>
      root.rootKind === 'compound' && root.rootId === evidence.compoundOperationId)
    if (!compoundRoot) {
      throw new PushAuthorityIntegrityError('terminal_compound_root_missing')
    }
    await resolveTransportTerminal(_meta, spaceId, token, {
      operationId: evidence.compoundOperationId,
      transportReadyRootSha256: compoundRoot.rootSha256,
      terminalEvidenceId: evidence.evidenceId,
      terminalResultSha256: evidence.resultSha256,
      terminalOperationIdsSha256: evidence.operationIdsSha256,
      updatedAt: evidence.committedAt,
    })
  }
  await markEvidenceMetaReconciled(db, spaceId, token, evidence.evidenceId)
  return result.applied.length
}

/** Resume Meta reconciliation after a renderer/process crash at space_committed. */
export async function reconcileSpaceCommittedTerminalEvidence(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<number> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const pending = await db.syncTerminalApplications
    .where('spaceId').equals(spaceId)
    .and((row) => row.state === 'space_committed')
    .toArray()
  for (const evidence of pending) {
    if (evidence.compoundOperationId !== null) {
      const compoundRoot = evidence.readyRoots.find((root) =>
        root.rootKind === 'compound' && root.rootId === evidence.compoundOperationId)
      if (!compoundRoot) {
        throw new PushAuthorityIntegrityError('terminal_compound_root_missing')
      }
      await resolveTransportTerminal(meta, spaceId, token, {
        operationId: evidence.compoundOperationId,
        transportReadyRootSha256: compoundRoot.rootSha256,
        terminalEvidenceId: evidence.evidenceId,
        terminalResultSha256: evidence.resultSha256,
        terminalOperationIdsSha256: evidence.operationIdsSha256,
        updatedAt: evidence.committedAt,
      })
    }
    await markEvidenceMetaReconciled(db, spaceId, token, evidence.evidenceId)
  }
  return pending.length
}

async function markEvidenceMetaReconciled(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  evidenceId: string,
): Promise<void> {
  await db.transaction('rw', db.syncTerminalApplications, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const current = await db.syncTerminalApplications.get(evidenceId)
    if (current?.state === 'space_committed') {
      await db.syncTerminalApplications.update(evidenceId, {
        state: 'meta_reconciled', metaReconciledAt: canonicalNow(),
      })
    }
  })
}

export type { SyncPendingPushBatch }
