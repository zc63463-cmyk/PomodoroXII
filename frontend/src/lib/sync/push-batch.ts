/**
 * Push 批处理与冲突响应（F1 §5.1–§5.4）。
 *
 * - buildPushEvents：outbox 行 → API SyncEvent（entityType→entity_type，createdAt→client_updated_at）
 * - handlePushResponse：applied/conflicts auto-clear outbox；errors 通用不清（重试），
 *   version_mismatch/content_hash_mismatch 进 conflicts（需用户裁决）
 * - pushAllPendingUnderFence：query-first durable receipt replay and push.
 *
 * F1-D11: applied/conflicts 全 auto-clear；errors(version_mismatch)/pre-push dirty 进面板。
 */

import { canonicalize } from 'json-canonicalize'
import type { AxiosInstance } from 'axios'
import type { MetaDB } from '@/services/meta-database'
import type { PomodoroXIDB, SyncPendingPushBatch } from '@/services/database'
import {
  decodeCanonicalBase64,
  encodeBase64,
  sha256HexBytes,
  validatePendingPushReceipt,
  loadAndValidateActiveReceiptInCurrentTransaction,
  selectionFromReceipt,
  reloadCompleteAuthorityAndRequireUnchangedSelection,
  selectOneAuthorityUnit,
  type PushSelection,
  PushAuthorityDriftError,
  PushAuthorityIntegrityError,
} from './authority-identity'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  withSpaceAuthorityFence,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { syncV2PushCanonical, syncV2QueryOperations } from './transport'
import {
  applyTerminalResultTwoPhase,
  reconcileSpaceCommittedTerminalEvidence,
} from './terminal-application'
import {
  admitTs3AwaitingS4,
  assertS4AdmissionReady,
  hasNewCompletePairedRoot,
} from './admission'
import { getOrCreateClientId } from './client-registry'
import { resumeImportedProvisionalReviews } from '@/lib/focus-session/focus-session-repository'
import type { ApiSyncV2Event } from './types'

export const SYNC_V2_PUSH_PATH = '/api/v1/sync/v2/push' as const

export type QueryDecision =
  | { kind: 'unknown' }
  | { kind: 'blocked'; state: 'pending' | 'recovery_required' }
  | { kind: 'terminal'; result: import('./types').ApiSyncV2PushResponse }

export async function classifyOperationQuery(
  api: AxiosInstance,
  clientId: string,
  operationIds: readonly string[],
): Promise<QueryDecision> {
  const response = await syncV2QueryOperations(api, {
    client_id: clientId, operation_ids: operationIds,
  })
  const items = response.data.items
  if (items.some((item) => item.state === 'recovery_required')) {
    return { kind: 'blocked', state: 'recovery_required' }
  }
  if (items.some((item) => item.state === 'pending')) {
    return { kind: 'blocked', state: 'pending' }
  }
  const terminal = items.filter((item) => item.state === 'terminal')
  if (terminal.length > 0) {
    if (terminal.length !== items.length) {
      throw new PushAuthorityIntegrityError('operation_query_mixed_terminal_authority')
    }
    return { kind: 'terminal', result: terminal[0]!.result! }
  }
  if (!items.every((item) => item.state === 'unknown')) {
    throw new PushAuthorityIntegrityError('operation_query_state_unclassified')
  }
  return { kind: 'unknown' }
}

export async function pushActivePendingBatch(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  api: AxiosInstance,
  token: SpaceAuthorityToken,
): Promise<{ state: 'empty' | 'blocked' | 'terminal' | 'pushed'; applied: number }> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction(db)
  if (!receipt) return { state: 'empty', applied: 0 }
  if (receipt.spaceId !== spaceId) throw new PushAuthorityIntegrityError('pending_receipt_space_mismatch')
  const selected = selectionFromReceipt(receipt)
  const decision = await classifyOperationQuery(api, receipt.clientId, receipt.operationIds)
  if (decision.kind === 'blocked') return { state: 'blocked', applied: 0 }
  if (decision.kind === 'terminal') {
    const applied = await applyTerminalResultTwoPhase(
      db, meta, spaceId, token, selected, decision.result, 'operation_query',
    )
    return { state: 'terminal', applied }
  }
  await reloadAndRevalidateReceiptImmediatelyBeforePush(
    db, meta, spaceId, selected, receipt, token,
  )
  const response = (await syncV2PushCanonical(
    api, canonicalRequestText(receipt),
  )).data
  const applied = await applyTerminalResultTwoPhase(
    db, meta, spaceId, token, selected, response, 'push_response',
  )
  return { state: 'pushed', applied }
}

export async function pushAllPendingUnderFence(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  clientId: string,
  api: AxiosInstance,
  token: SpaceAuthorityToken,
): Promise<{ state: 'empty' | 'blocked' | 'pushed' | 'terminal'; applied: number }> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  await reconcileSpaceCommittedTerminalEvidence(db, meta, spaceId, token)
  await resumeImportedProvisionalReviews(db, meta, spaceId, token)
  await admitTs3AwaitingS4(db, meta, spaceId, token)
  await assertS4AdmissionReady(db, meta, spaceId, token)
  const attempted = new Set<string>()
  let appliedTotal = 0
  let authorityRestarts = 0
  while (true) {
    const active = await db.transaction('r', db.syncPushBatches, async () =>
      loadAndValidateActiveReceiptInCurrentTransaction(db))
    if (active) {
      let result: Awaited<ReturnType<typeof pushActivePendingBatch>>
      try {
        result = await pushActivePendingBatch(db, meta, spaceId, api, token)
      } catch (error: unknown) {
        if (!(error instanceof PushAuthorityDriftError) ||
            error.code !== 'new_complete_paired_root') throw error
        if (authorityRestarts >= 1) {
          throw new PushAuthorityIntegrityError('push_authority_restart_exhausted')
        }
        authorityRestarts += 1
        await restartAdmissionAfterTypedDrift(db, meta, spaceId, token)
        continue
      }
      appliedTotal += result.applied
      if (result.state === 'blocked') return { state: 'blocked', applied: appliedTotal }
      active.operationIds.forEach((id) => attempted.add(id))
      continue
    }
    const selected = await selectOneAuthorityUnit(db, attempted)
    if (!selected) return { state: appliedTotal ? 'pushed' : 'empty', applied: appliedTotal }
    const query = await classifyOperationQuery(api, clientId, selected.operationIds)
    if (query.kind === 'blocked') return { state: 'blocked', applied: appliedTotal }
    if (query.kind === 'terminal') {
      const count = await applyTerminalResultTwoPhase(
        db, meta, spaceId, token, selected, query.result, 'operation_query',
      )
      await resumeImportedProvisionalReviews(db, meta, spaceId, token)
      appliedTotal += count
      selected.operationIds.forEach((id) => attempted.add(id))
      continue
    }
    let receipt: SyncPendingPushBatch
    try {
      receipt = await createPendingPushBatchAfterUnknown(
        db, meta, spaceId, clientId, selected, token,
      )
      await reloadAndRevalidateReceiptImmediatelyBeforePush(
        db, meta, spaceId, selected, receipt, token,
      )
    } catch (error: unknown) {
      if (!(error instanceof PushAuthorityDriftError) ||
          error.code !== 'new_complete_paired_root') throw error
      if (authorityRestarts >= 1) {
        throw new PushAuthorityIntegrityError('push_authority_restart_exhausted')
      }
      authorityRestarts += 1
      await restartAdmissionAfterTypedDrift(db, meta, spaceId, token)
      continue
    }
    const response = await syncV2PushCanonical(api, canonicalRequestText(receipt))
    const count = await applyTerminalResultTwoPhase(
      db, meta, spaceId, token, selectionFromReceipt(receipt), response.data, 'push_response',
    )
    await resumeImportedProvisionalReviews(db, meta, spaceId, token)
    appliedTotal += count
    selected.operationIds.forEach((id) => attempted.add(id))
    if (count === 0) return { state: 'pushed', applied: appliedTotal }
  }
}

function canonicalRequestText(receipt: SyncPendingPushBatch): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    decodeCanonicalBase64(receipt.requestCanonicalBase64),
  )
}

/** Public entrypoint: acquire the same per-Space fence used by the engine. */
export async function pushAllPending(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  api: AxiosInstance,
): Promise<{ state: 'empty' | 'blocked' | 'pushed' | 'terminal'; applied: number }> {
  return withSpaceAuthorityFence(spaceId, async (token) => {
    const clientId = await getOrCreateClientId(db, spaceId, token)
    return pushAllPendingUnderFence(db, meta, spaceId, clientId, api, token)
  })
}

export async function reloadAndRevalidateReceiptImmediatelyBeforePush(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  selected: PushSelection,
  receipt: SyncPendingPushBatch,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  if (await hasNewCompletePairedRoot(db, meta, spaceId, token)) {
    throw new PushAuthorityDriftError('new_complete_paired_root')
  }
  const active = await loadAndValidateActiveReceiptInCurrentTransaction(db)
  if (!active || active.key !== receipt.key ||
      canonicalize(active) !== canonicalize(receipt) ||
      canonicalize(selectionFromReceipt(active)) !== canonicalize(selected)) {
    throw new PushAuthorityIntegrityError('pending_receipt_authority_mismatch')
  }
  await reloadCompleteAuthorityAndRequireUnchangedSelection(db, selected)
}

async function restartAdmissionAfterTypedDrift(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  await db.transaction('rw', db.syncAdmissionState, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    await db.syncAdmissionState.put({
      key: 'active', state: 'pending', readyRoots: [],
      readyRootSetSha256: null, errorCode: null,
    })
  })
  await admitTs3AwaitingS4(db, meta, spaceId, token)
  await assertS4AdmissionReady(db, meta, spaceId, token)
}

function buildV2PushEvents(selection: PushSelection): ApiSyncV2Event[] {
  return selection.frozenRows.map((row) => {
    const payloadText = new TextDecoder().decode(decodeCanonicalBase64(row.payloadCanonicalBase64))
    const payload = JSON.parse(payloadText) as Record<string, unknown>
    return {
      entity_type: row.entityType,
      entity_id: row.entityId,
      action: row.action,
      payload,
      expected_version: row.expectedVersion,
      client_updated_at: row.createdAt,
      operation_id: row.operationId,
    }
  })
}

export async function createPendingPushBatchAfterUnknown(
  db: PomodoroXIDB,
  _meta: MetaDB,
  spaceId: string,
  clientId: string,
  selected: PushSelection,
  token: SpaceAuthorityToken,
): Promise<SyncPendingPushBatch> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const events = buildV2PushEvents(selected)
  const eventTexts = events.map((event) => {
    const text = canonicalize(event)
    if (text === undefined) throw new PushAuthorityIntegrityError('push_event_not_canonicalizable')
    return text
  })
  const eventBytes = eventTexts.map((text) => new TextEncoder().encode(text))
  const request = { client_id: clientId, batch_id: selected.authority.batchId, events }
  const requestText = canonicalize(request)
  if (requestText === undefined) throw new PushAuthorityIntegrityError('push_request_not_canonicalizable')
  const requestBytes = new TextEncoder().encode(requestText)
  const receipt: SyncPendingPushBatch = {
    key: 'active', spaceId, clientId,
    authorityKind: selected.authority.kind,
    compoundOperationId: selected.authority.compoundOperationId,
    batchId: selected.authority.batchId,
    operationIds: [...selected.operationIds],
    frozenRows: structuredClone([...selected.frozenRows]),
    readyRoots: structuredClone([...selected.readyRoots]),
    readyRootSetSha256: selected.readyRootSetSha256,
    events: structuredClone(events),
    idempotencyKey: selected.authority.batchId,
    requestMethod: 'POST', requestPath: SYNC_V2_PUSH_PATH,
    headers: {
      accept: 'application/vnd.pomodoroxii.error+json;version=2',
      contentType: 'application/json', idempotencyKey: selected.authority.batchId,
    },
    eventCanonicalBase64: eventBytes.map(encodeBase64),
    eventSha256: await Promise.all(eventBytes.map(sha256HexBytes)),
    requestCanonicalBase64: encodeBase64(requestBytes),
    requestSha256: await sha256HexBytes(requestBytes),
    receiptCreatedAt: new Date().toISOString(),
  }
  await validatePendingPushReceipt(receipt)
  await db.transaction('rw', db.syncPushBatches, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    if (await db.syncPushBatches.get('active')) {
      throw new PushAuthorityIntegrityError('pending_receipt_already_exists')
    }
    await db.syncPushBatches.add(receipt)
  })
  const persisted = await db.syncPushBatches.get('active')
  if (!persisted) throw new PushAuthorityIntegrityError('pending_receipt_persistence_missing')
  await validatePendingPushReceipt(persisted)
  return persisted
}
