import { canonicalize } from 'json-canonicalize'
import Dexie from 'dexie'

import type {
  FrozenOutboxIdentity,
  ReadyRootIdentity,
  SyncPendingPushBatch,
  SyncTerminalApplicationEvidence,
  PomodoroXIDB,
} from '@/services/database'
import type { OutboxEvent } from '@/types'
import { prepareHeldProvisionalBatch } from './outbox'
import {
  parsePersistedOutboxPayload,
  recomputeEntityBusinessPayloadHash,
} from './entity-payload-hash'
import {
  parseIJsonTextRejectingDuplicateKeys,
  parseSyncV2PushResponse,
  requireCanonicalStoredTimestamp,
} from './response-schema'
import {
  FINAL_SYNC_ENTITY_TYPE_SET,
  type ApiSyncV2PushResponse,
  type SyncEntityType,
} from './types'
import { SYNC_V2_PUSH_PATH } from './transport'

export class PushAuthorityIntegrityError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** A narrowly recoverable authority drift discovered before network send. */
export class PushAuthorityDriftError extends PushAuthorityIntegrityError {
  constructor(readonly code: 'new_complete_paired_root') { super(code) }
}

export type PushAuthority =
  | {
      kind: 'compound'
      batchId: string
      compoundOperationId: string
      orderedOperationIds: readonly string[]
    }
  | {
      kind: 'direct_note_retry' | 'standalone_batch'
      batchId: string
      compoundOperationId: null
      orderedOperationIds: readonly string[]
    }

export interface PushSelection {
  authority: PushAuthority
  operationIds: readonly string[]
  frozenRows: readonly FrozenOutboxIdentity[]
  readyRoots: readonly ReadyRootIdentity[]
  readyRootSetSha256: string
}

export async function authorityForRows(
  rows: readonly OutboxEvent[],
): Promise<PushAuthority> {
  if (rows.length === 0) throw new PushAuthorityIntegrityError('empty_push_authority')
  if (rows[0]!.compoundOperationId !== null) {
    const prepared = prepareHeldProvisionalBatch([...rows])
    return {
      kind: 'compound', batchId: prepared.batchId,
      compoundOperationId: prepared.batchId,
      orderedOperationIds: prepared.items.map((item) => item.operationId),
    }
  }
  if (rows.length === 1 && rows[0]!.entityType === 'workItemNote' &&
      rows[0]!.attemptCount > 0) {
    return {
      kind: 'direct_note_retry', batchId: rows[0]!.operationId,
      compoundOperationId: null, orderedOperationIds: [rows[0]!.operationId],
    }
  }
  if (rows.some((row) => row.attemptCount > 0 || row.compoundOperationId !== null)) {
    throw new PushAuthorityIntegrityError('standalone_batch_authority_invalid')
  }
  return {
    kind: 'standalone_batch',
    batchId: await sha256Utf8(rows.map((row) => row.operationId).join('\n')),
    compoundOperationId: null,
    orderedOperationIds: rows.map((row) => row.operationId),
  }
}

export async function reloadCompleteAuthorityAndRequireUnchangedSelection(
  db: PomodoroXIDB,
  selected: PushSelection,
): Promise<OutboxEvent[]> {
  const rows = await db.outbox.bulkGet(selected.frozenRows.map((row) => row.durableKey))
  if (rows.some((row) => !row)) {
    throw new PushAuthorityIntegrityError('selected_outbox_row_missing')
  }
  const actualRows = rows as OutboxEvent[]
  if (selected.authority.kind === 'compound') {
    const complete = (await db.outbox.filter((row) =>
      row.compoundOperationId === selected.authority.compoundOperationId).toArray())
      .sort((left, right) => left.compoundOrder! - right.compoundOrder!)
    if (complete.length > actualRows.length && complete.every((row) =>
      !row.synced && row.transportState === 'ready' &&
      row.compoundOperationId === selected.authority.compoundOperationId &&
      row.compoundOrder !== null)) {
      throw new PushAuthorityDriftError('new_complete_paired_root')
    }
    if (complete.length !== actualRows.length ||
        complete.some((row, index) => row.id !== actualRows[index]!.id)) {
      throw new PushAuthorityIntegrityError('compound_root_membership_drift')
    }
  }
  const actualFrozen = await Dexie.waitFor(Promise.all(actualRows.map(freezeOutboxIdentity)))
  selected.frozenRows.forEach((expected, index) =>
    requireSameFrozenIdentity(expected, actualFrozen[index]!))
  const roots = await Dexie.waitFor(buildReadyRootIdentities(actualRows))
  requireSameReadyRootSet(selected.readyRoots, selected.readyRootSetSha256,
    roots.readyRoots, roots.readyRootSetSha256)
  return actualRows
}

export async function selectOneAuthorityUnit(
  db: PomodoroXIDB,
  attemptedOperationIds: ReadonlySet<string> = new Set(),
): Promise<PushSelection | null> {
  const rows = (await db.outbox.filter((row) =>
    !row.synced && row.transportState === 'ready' &&
    !attemptedOperationIds.has(row.operationId),
  ).sortBy('createdAt'))
  if (rows.length === 0) return null
  const first = rows[0]!
  let selectedRows: OutboxEvent[]
  if (first.compoundOperationId !== null) {
    selectedRows = rows.filter((row) =>
      row.compoundOperationId === first.compoundOperationId)
      .sort((left, right) => left.compoundOrder! - right.compoundOrder!)
  } else if (first.entityType === 'workItemNote' && first.attemptCount > 0) {
    selectedRows = [first]
  } else {
    selectedRows = rows.filter((row) =>
      row.compoundOperationId === null && row.attemptCount === 0)
      .slice(0, 500)
  }
  const authority = await authorityForRows(selectedRows)
  const roots = await buildReadyRootIdentities(selectedRows)
  const frozenRows = roots.readyRoots.flatMap((root) => root.orderedChildren)
  return {
    authority,
    operationIds: [...authority.orderedOperationIds],
    frozenRows,
    readyRoots: roots.readyRoots,
    readyRootSetSha256: roots.readyRootSetSha256,
  }
}

export const FROZEN_OUTBOX_IDENTITY_KEYS = [
  'durableKey', 'spaceId', 'entityType', 'entityId', 'action',
  'payloadCanonicalBase64', 'payloadHash', 'operationId',
  'retryPredecessorOperationId', 'expectedVersion', 'createdAt', 'transportState',
  'compoundOperationId', 'compoundOrder', 'attemptCount',
] as const satisfies readonly (keyof FrozenOutboxIdentity)[]
type MissingFrozenKey = Exclude<
  keyof FrozenOutboxIdentity, typeof FROZEN_OUTBOX_IDENTITY_KEYS[number]
>
export const ALL_FROZEN_KEYS_ARE_LISTED:
  MissingFrozenKey extends never ? true : never = true

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function decodeCanonicalBase64(value: string): Uint8Array {
  let binary: string
  try { binary = atob(value) } catch {
    throw new PushAuthorityIntegrityError('invalid_base64')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64(bytes) !== value) {
    throw new PushAuthorityIntegrityError('noncanonical_base64')
  }
  return bytes
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Utf8(value: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(value))
}

export const sha256Hex = sha256Utf8

export async function sha256Canonical(value: unknown): Promise<string> {
  const canonical = canonicalize(value)
  if (canonical === undefined) {
    throw new PushAuthorityIntegrityError('canonical_json_unsupported')
  }
  return sha256HexBytes(new TextEncoder().encode(canonical))
}

/** @internal Shared terminal retry schedule; derived only from persisted evidence time. */
export function deterministicTerminalNextAttempt(
  attemptCount: number,
  terminalizedAt: string,
): string {
  const base = Date.parse(requireCanonicalStoredTimestamp(terminalizedAt))
  if (!Number.isFinite(base) || !Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    throw new PushAuthorityIntegrityError('terminal_retry_schedule_input_invalid')
  }
  const delaySeconds = Math.min(3600, 2 ** Math.min(attemptCount, 10))
  return requireCanonicalStoredTimestamp(
    new Date(base + delaySeconds * 1000).toISOString(),
  )
}

/** Validate every persisted identity before trusting a terminal result. */
export async function parseAndValidateTerminalEvidenceResult(
  evidence: SyncTerminalApplicationEvidence,
): Promise<ApiSyncV2PushResponse> {
  requireCanonicalStoredTimestamp(evidence.committedAt)
  if (evidence.metaReconciledAt !== null) {
    requireCanonicalStoredTimestamp(evidence.metaReconciledAt)
  }
  const children = evidence.readyRoots.flatMap((root) => root.orderedChildren)
  const childOperationIds = children.map((child) => child.operationId)
  const rootIds = evidence.readyRoots.map((root) => root.rootId)
  const identity = {
    spaceId: evidence.spaceId,
    batchId: evidence.batchId,
    authorityKind: evidence.authorityKind,
    readyRootSetSha256: evidence.readyRootSetSha256,
    operationIds: evidence.operationIds,
    operationIdsSha256: evidence.operationIdsSha256,
    resultSha256: evidence.resultSha256,
  }
  const directRoot = evidence.readyRoots.length === 1
    ? evidence.readyRoots[0]
    : undefined
  const authorityShapeValid = evidence.authorityKind === 'compound'
    ? evidence.compoundOperationId !== null &&
      evidence.batchId === evidence.compoundOperationId &&
      evidence.readyRoots.length === 1 && directRoot?.rootKind === 'compound' &&
      directRoot.rootId === evidence.compoundOperationId
    : evidence.authorityKind === 'direct_note_retry'
      ? evidence.compoundOperationId === null && evidence.operationIds.length === 1 &&
        evidence.batchId === evidence.operationIds[0] &&
        directRoot?.rootKind === 'standalone' &&
        directRoot.orderedChildren.length === 1 &&
        directRoot.orderedChildren[0]!.entityType === 'workItemNote' &&
        directRoot.orderedChildren[0]!.attemptCount > 0
      : evidence.authorityKind === 'standalone_batch' &&
        evidence.compoundOperationId === null &&
        evidence.batchId === await sha256Utf8(evidence.operationIds.join('\n'))
  if (!authorityShapeValid ||
      !['operation_query', 'push_response'].includes(evidence.source) ||
      !['space_committed', 'meta_reconciled'].includes(evidence.state) ||
      (evidence.state === 'space_committed') !== (evidence.metaReconciledAt === null) ||
      new Set(rootIds).size !== rootIds.length ||
      new Set(evidence.operationIds).size !== evidence.operationIds.length ||
      new Set(childOperationIds).size !== childOperationIds.length ||
      new Set(children.map((child) => child.durableKey)).size !== children.length ||
      canonicalize([...childOperationIds].sort()) !==
        canonicalize([...evidence.operationIds].sort()) ||
      await sha256Canonical(evidence.operationIds) !== evidence.operationIdsSha256 ||
      await sha256Canonical(evidence.readyRoots) !== evidence.readyRootSetSha256 ||
      await sha256Canonical(identity) !== evidence.evidenceId) {
    throw new PushAuthorityIntegrityError('terminal_evidence_identity_invalid')
  }
  for (const root of evidence.readyRoots) {
    const rootDocument = {
      rootKind: root.rootKind,
      rootId: root.rootId,
      orderedChildren: root.orderedChildren,
    }
    if (await sha256Canonical(rootDocument) !== root.rootSha256) {
      throw new PushAuthorityIntegrityError('terminal_evidence_root_hash_mismatch')
    }
  }
  const bytes = decodeCanonicalBase64(evidence.resultCanonicalBase64)
  if (await sha256HexBytes(bytes) !== evidence.resultSha256) {
    throw new PushAuthorityIntegrityError('terminal_evidence_result_hash_mismatch')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const result = parseSyncV2PushResponse(parseIJsonTextRejectingDuplicateKeys(text))
  if (canonicalize(result) !== text) {
    throw new PushAuthorityIntegrityError('terminal_evidence_result_not_canonical')
  }
  const resultOperationIds = [
    ...result.applied.map((item) => item.operation_id),
    ...result.conflicts.map((item) => item.operation_id),
    ...result.errors.map((item) => item.operation_id),
  ]
  if (result.batch_id !== evidence.batchId ||
      canonicalize([...resultOperationIds].sort()) !==
        canonicalize([...evidence.operationIds].sort()) ||
      result.applied.length !== evidence.appliedCount) {
    throw new PushAuthorityIntegrityError('terminal_evidence_result_coverage_mismatch')
  }
  const childByOperation = new Map(children.map((child) => [child.operationId, child]))
  for (const outcome of [...result.applied, ...result.conflicts, ...result.errors]) {
    const child = childByOperation.get(outcome.operation_id)
    if (!child || child.entityType !== outcome.entity_type || child.entityId !== outcome.entity_id) {
      throw new PushAuthorityIntegrityError('terminal_evidence_result_entity_mismatch')
    }
  }
  return result
}

interface RootGroup {
  kind: 'compound' | 'standalone'
  rows: OutboxEvent[]
}

function groupCompleteRoots(rows: readonly OutboxEvent[]): RootGroup[] {
  if (new Set(rows.map((row) => row.id)).size !== rows.length ||
      new Set(rows.map((row) => row.operationId)).size !== rows.length) {
    throw new PushAuthorityIntegrityError('duplicate_authority_identity')
  }
  const grouped = new Map<string, RootGroup>()
  for (const row of rows) {
    if ((row.compoundOperationId === null) !== (row.compoundOrder === null)) {
      throw new PushAuthorityIntegrityError('partial_compound_identity')
    }
    const compound = row.compoundOperationId !== null
    const key = compound
      ? `compound:${row.compoundOperationId}`
      : `standalone:${row.operationId}`
    const group = grouped.get(key) ?? {
      kind: compound ? 'compound' : 'standalone', rows: [],
    }
    group.rows.push(row)
    grouped.set(key, group)
  }
  for (const group of grouped.values()) {
    if (group.kind === 'standalone' && group.rows.length !== 1) {
      throw new PushAuthorityIntegrityError('standalone_root_has_multiple_children')
    }
    if (group.kind === 'compound') {
      group.rows.sort((left, right) => left.compoundOrder! - right.compoundOrder!)
      group.rows.forEach((row, index) => {
        if (row.compoundOrder !== index) {
          throw new PushAuthorityIntegrityError('compound_order_gap_or_duplicate')
        }
      })
      const prepared = prepareHeldProvisionalBatch(group.rows)
      if (prepared.batchId !== group.rows[0]!.compoundOperationId) {
        throw new PushAuthorityIntegrityError('compound_root_authority_changed')
      }
    }
  }
  const groups = [...grouped.values()]
  const rootIds = groups.map((group) => group.kind === 'compound'
    ? group.rows[0]!.compoundOperationId! : group.rows[0]!.operationId)
  if (new Set(rootIds).size !== rootIds.length) {
    throw new PushAuthorityIntegrityError('duplicate_authority_root_id')
  }
  return groups.sort((left, right) => {
    const leftId = left.kind === 'compound'
      ? left.rows[0]!.compoundOperationId! : left.rows[0]!.operationId
    const rightId = right.kind === 'compound'
      ? right.rows[0]!.compoundOperationId! : right.rows[0]!.operationId
    return `${left.kind}:${leftId}`.localeCompare(`${right.kind}:${rightId}`)
  })
}

const compareRootKindAndId = (left: ReadyRootIdentity, right: ReadyRootIdentity): number =>
  `${left.rootKind}:${left.rootId}`.localeCompare(`${right.rootKind}:${right.rootId}`)

export async function freezeOutboxIdentity(row: OutboxEvent): Promise<FrozenOutboxIdentity> {
  const durableKey = row.id
  if (typeof durableKey !== 'number' || !Number.isSafeInteger(durableKey) || durableKey < 1) {
    throw new PushAuthorityIntegrityError('outbox_durable_key_invalid')
  }
  if (typeof row.spaceId !== 'string' || row.spaceId.length === 0) {
    throw new PushAuthorityIntegrityError('outbox_space_identity_invalid')
  }
  if (!FINAL_SYNC_ENTITY_TYPE_SET.has(row.entityType)) {
    throw new PushAuthorityIntegrityError('outbox_entity_type_invalid')
  }
  const payloadValue = parsePersistedOutboxPayload(row.payload)
  const payloadCanonical = canonicalize(payloadValue)
  if (payloadCanonical === undefined) {
    throw new PushAuthorityIntegrityError('outbox_payload_not_canonicalizable')
  }
  const recomputedPayloadHash = await recomputeEntityBusinessPayloadHash(
    row.entityType as SyncEntityType, row.action, payloadValue,
  )
  if (recomputedPayloadHash !== row.payloadHash) {
    throw new PushAuthorityIntegrityError('outbox_payload_hash_mismatch')
  }
  return {
    durableKey,
    spaceId: row.spaceId,
    entityType: row.entityType as SyncEntityType,
    entityId: row.entityId,
    action: row.action,
    payloadCanonicalBase64: encodeBase64(new TextEncoder().encode(payloadCanonical)),
    payloadHash: recomputedPayloadHash,
    operationId: row.operationId,
    retryPredecessorOperationId: row.retryPredecessorOperationId,
    expectedVersion: row.expectedVersion,
    createdAt: requireCanonicalStoredTimestamp(row.createdAt),
    transportState: row.transportState,
    compoundOperationId: row.compoundOperationId,
    compoundOrder: row.compoundOrder,
    attemptCount: row.attemptCount,
  }
}

export async function buildReadyRootIdentities(
  rows: readonly OutboxEvent[],
): Promise<{ readyRoots: ReadyRootIdentity[]; readyRootSetSha256: string }> {
  if (rows.length === 0) {
    return { readyRoots: [], readyRootSetSha256: await sha256Canonical([]) }
  }
  const groups = groupCompleteRoots(rows)
  const readyRoots: ReadyRootIdentity[] = []
  for (const group of groups) {
    const prepared = group.kind === 'compound'
      ? prepareHeldProvisionalBatch(group.rows) : null
    const byOperationId = new Map(group.rows.map((row) => [row.operationId, row]))
    const ordered = prepared
      ? prepared.items.map((item) => byOperationId.get(item.operationId)!)
      : group.rows
    const orderedChildren = await Promise.all(ordered.map(freezeOutboxIdentity))
    const rootId = prepared ? prepared.batchId : orderedChildren[0]!.operationId
    const rootDocument = { rootKind: group.kind, rootId, orderedChildren }
    readyRoots.push({
      ...rootDocument,
      rootSha256: await sha256Canonical(rootDocument),
    })
  }
  readyRoots.sort(compareRootKindAndId)
  return { readyRoots, readyRootSetSha256: await sha256Canonical(readyRoots) }
}

export function requireSameFrozenIdentity(
  expected: FrozenOutboxIdentity,
  actual: FrozenOutboxIdentity,
): void {
  for (const key of FROZEN_OUTBOX_IDENTITY_KEYS) {
    if (expected[key] !== actual[key]) {
      throw new PushAuthorityIntegrityError(`outbox_identity_drift:${key}`)
    }
  }
}

export function requireSameReadyRootSet(
  expectedRoots: readonly ReadyRootIdentity[],
  expectedDigest: string,
  actualRoots: readonly ReadyRootIdentity[],
  actualDigest: string,
): void {
  if (expectedDigest !== actualDigest ||
      canonicalize(expectedRoots) !== canonicalize(actualRoots)) {
    throw new PushAuthorityIntegrityError('ready_root_identity_drift')
  }
}

export async function validatePendingPushReceipt(
  receipt: SyncPendingPushBatch,
): Promise<void> {
  if (receipt.key !== 'active' || receipt.requestMethod !== 'POST' ||
      receipt.requestPath !== SYNC_V2_PUSH_PATH ||
      receipt.headers.accept !== 'application/vnd.pomodoroxii.error+json;version=2' ||
      receipt.headers.contentType !== 'application/json' ||
      receipt.headers.idempotencyKey !== receipt.idempotencyKey ||
      receipt.idempotencyKey !== receipt.batchId ||
      receipt.operationIds.length === 0 ||
      new Set(receipt.operationIds).size !== receipt.operationIds.length ||
      receipt.operationIds.length !== receipt.frozenRows.length ||
      receipt.operationIds.length !== receipt.events.length ||
      receipt.operationIds.length !== receipt.eventCanonicalBase64.length ||
      receipt.operationIds.length !== receipt.eventSha256.length) {
    throw new PushAuthorityIntegrityError('pending_receipt_shape_invalid')
  }
  const requestBytes = decodeCanonicalBase64(receipt.requestCanonicalBase64)
  if (await sha256HexBytes(requestBytes) !== receipt.requestSha256) {
    throw new PushAuthorityIntegrityError('pending_receipt_request_hash_mismatch')
  }
  let requestText: string
  let parsedRequest: unknown
  try {
    requestText = new TextDecoder('utf-8', { fatal: true }).decode(requestBytes)
    parsedRequest = JSON.parse(requestText)
  } catch {
    throw new PushAuthorityIntegrityError('pending_receipt_request_invalid')
  }
  const expectedRequest = {
    client_id: receipt.clientId,
    batch_id: receipt.batchId,
    events: receipt.events,
  }
  if (canonicalize(parsedRequest) !== requestText ||
      canonicalize(expectedRequest) !== requestText) {
    throw new PushAuthorityIntegrityError('pending_receipt_request_authority_mismatch')
  }
  const eventIds = new Set<string>()
  for (let index = 0; index < receipt.events.length; index += 1) {
    const event = receipt.events[index]
    const canonical = canonicalize(event)
    if (canonical === undefined) throw new PushAuthorityIntegrityError('pending_receipt_event_invalid')
    const bytes = decodeCanonicalBase64(receipt.eventCanonicalBase64[index]!)
    if (new TextDecoder().decode(bytes) !== canonical ||
        await sha256HexBytes(bytes) !== receipt.eventSha256[index]) {
      throw new PushAuthorityIntegrityError('pending_receipt_event_hash_mismatch')
    }
    const operationId = (event as { operation_id?: unknown }).operation_id
    if (typeof operationId !== 'string' || eventIds.has(operationId) ||
        operationId !== receipt.operationIds[index]) {
      throw new PushAuthorityIntegrityError('pending_receipt_operation_identity_mismatch')
    }
    eventIds.add(operationId)
  }
  if (!receipt.frozenRows.every((row, index) =>
    row.operationId === receipt.operationIds[index] && row.spaceId === receipt.spaceId)) {
    throw new PushAuthorityIntegrityError('pending_receipt_frozen_identity_mismatch')
  }
  const flattened = receipt.readyRoots.flatMap((root) => root.orderedChildren)
  if (flattened.length !== receipt.frozenRows.length ||
      flattened.some((row, index) => canonicalize(row) !== canonicalize(receipt.frozenRows[index]))) {
    throw new PushAuthorityIntegrityError('pending_receipt_root_membership_mismatch')
  }
  const rootsWithDigests = await Promise.all(receipt.readyRoots.map(async (root) => {
    const document = {
      rootKind: root.rootKind, rootId: root.rootId, orderedChildren: root.orderedChildren,
    }
    if (await sha256Canonical(document) !== root.rootSha256) {
      throw new PushAuthorityIntegrityError('pending_receipt_root_hash_mismatch')
    }
    return root
  }))
  if (await sha256Canonical(rootsWithDigests) !== receipt.readyRootSetSha256) {
    throw new PushAuthorityIntegrityError('pending_receipt_root_hash_mismatch')
  }
  if (receipt.authorityKind === 'compound') {
    if (receipt.compoundOperationId === null ||
        receipt.batchId !== receipt.compoundOperationId ||
        !receipt.readyRoots.some((root) =>
          root.rootKind === 'compound' && root.rootId === receipt.compoundOperationId)) {
      throw new PushAuthorityIntegrityError('pending_receipt_compound_authority_invalid')
    }
  } else if (receipt.compoundOperationId !== null) {
    throw new PushAuthorityIntegrityError('pending_receipt_noncompound_authority_invalid')
  } else if (receipt.authorityKind === 'direct_note_retry') {
    if (receipt.operationIds.length !== 1 || receipt.batchId !== receipt.operationIds[0] ||
        receipt.frozenRows[0]?.entityType !== 'workItemNote' ||
        receipt.frozenRows[0]?.attemptCount === 0) {
      throw new PushAuthorityIntegrityError('pending_receipt_direct_note_authority_invalid')
    }
  } else if (receipt.batchId !== await sha256Utf8(receipt.operationIds.join('\n')) ||
      receipt.frozenRows.some((row) =>
        row.compoundOperationId !== null || row.attemptCount !== 0)) {
    throw new PushAuthorityIntegrityError('pending_receipt_standalone_authority_invalid')
  }
}

/** @internal Verify a retained terminal row is explained by exact evidence. */
export async function requireTerminalDiagnosticMatchesEvidence(
  row: OutboxEvent,
  evidence: SyncTerminalApplicationEvidence,
  result: ApiSyncV2PushResponse,
): Promise<void> {
  if (row.spaceId !== evidence.spaceId) {
    throw new PushAuthorityIntegrityError('terminal_row_space_mismatch')
  }
  const frozenMatches = evidence.readyRoots.flatMap((root) => root.orderedChildren)
    .filter((child) => child.operationId === row.operationId && child.durableKey === row.id)
  if (frozenMatches.length !== 1) {
    throw new PushAuthorityIntegrityError('terminal_row_evidence_coverage_mismatch')
  }
  const frozen = frozenMatches[0]!
  const actual = await freezeOutboxIdentity(row)
  for (const key of FROZEN_OUTBOX_IDENTITY_KEYS) {
    if (key !== 'transportState' && canonicalize(frozen[key]) !== canonicalize(actual[key])) {
      throw new PushAuthorityIntegrityError(`terminal_row_identity_drift:${key}`)
    }
  }
  const conflictOutcome = result.conflicts.find((item) => item.operation_id === row.operationId)
  const errorOutcome = result.errors.find((item) => item.operation_id === row.operationId)
  if (Number(Boolean(conflictOutcome)) + Number(Boolean(errorOutcome)) !== 1) {
    throw new PushAuthorityIntegrityError('terminal_row_outcome_state_mismatch')
  }
  const expectedOutcomeCanonical = canonicalize(conflictOutcome ?? errorOutcome!)
  if (expectedOutcomeCanonical === undefined) {
    throw new PushAuthorityIntegrityError('terminal_row_outcome_not_canonical')
  }
  const expectedRetryable = errorOutcome?.retryable ?? false
  const expectedNextAttemptAt = expectedRetryable
    ? deterministicTerminalNextAttempt(frozen.attemptCount, evidence.committedAt) : null
  if (row.transportState !== (conflictOutcome ? 'terminal_conflict' : 'terminal_error') ||
      row.serverOutcomeCanonicalBase64 !== encodeBase64(new TextEncoder().encode(expectedOutcomeCanonical)) ||
      row.retryable !== expectedRetryable || row.nextAttemptAt !== expectedNextAttemptAt) {
    throw new PushAuthorityIntegrityError('terminal_row_diagnostic_mismatch')
  }
}

export async function loadAndValidateActiveReceiptInCurrentTransaction(
  db: PomodoroXIDB,
): Promise<SyncPendingPushBatch | null> {
  const rows = await db.syncPushBatches.toArray()
  if (rows.length > 1) throw new PushAuthorityIntegrityError('multiple_active_receipts')
  if (rows.length === 0) return null
  await Dexie.waitFor(validatePendingPushReceipt(rows[0]!))
  return rows[0]!
}

export function selectionFromReceipt(receipt: SyncPendingPushBatch): PushSelection {
  const authority: PushAuthority = receipt.authorityKind === 'compound'
    ? {
        kind: 'compound', batchId: receipt.batchId,
        compoundOperationId: receipt.compoundOperationId!,
        orderedOperationIds: receipt.operationIds,
      }
    : {
        kind: receipt.authorityKind, batchId: receipt.batchId,
        compoundOperationId: null, orderedOperationIds: receipt.operationIds,
      }
  return {
    authority,
    operationIds: receipt.operationIds,
    frozenRows: receipt.frozenRows,
    readyRoots: receipt.readyRoots,
    readyRootSetSha256: receipt.readyRootSetSha256,
  }
}

/** @internal Ensure an active receipt is exactly the authority being applied. */
export function requireReceiptMatchesFrozenAuthority(
  receipt: SyncPendingPushBatch,
  selected: PushSelection,
): void {
  if (receipt.spaceId !== selected.frozenRows[0]?.spaceId ||
      receipt.batchId !== selected.authority.batchId ||
      receipt.authorityKind !== selected.authority.kind ||
      receipt.compoundOperationId !== selected.authority.compoundOperationId ||
      canonicalize(receipt.operationIds) !== canonicalize(selected.operationIds) ||
      canonicalize(receipt.frozenRows) !== canonicalize(selected.frozenRows) ||
      canonicalize(receipt.readyRoots) !== canonicalize(selected.readyRoots) ||
      receipt.readyRootSetSha256 !== selected.readyRootSetSha256) {
    throw new PushAuthorityIntegrityError('receipt_frozen_authority_mismatch')
  }
}
