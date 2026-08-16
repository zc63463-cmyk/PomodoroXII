import Dexie from 'dexie'
import { canonicalize } from 'json-canonicalize'

import type {
  PomodoroXIDB,
  ReadyRootIdentity,
  SyncAdmissionState,
} from '@/services/database'
import type { MetaDB } from '@/services/meta-database'
import type { OutboxEvent } from '@/types'
import {
  PushAuthorityIntegrityError,
  buildReadyRootIdentities,
  parseAndValidateTerminalEvidenceResult,
  requireSameReadyRootSet,
} from './authority-identity'
import { markTransportReady } from './provisional-operation-authority'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'

interface ActiveAdmissionMetaRow {
  operationId: string
  spaceId: string
  state: 'awaiting_s4' | 'transport_ready'
  transportReadyRootSha256: string | null
}

interface ValidatedAdmissionSnapshot {
  admittedRows: OutboxEvent[]
  readyRootIdentities: ReadyRootIdentity[]
  readyRootSetSha256: string
}

export async function hasNewCompletePairedRoot(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<boolean> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const marker = await db.syncAdmissionState.get('active')
  if (!marker || marker.state !== 'ready' || marker.readyRootSetSha256 === null) return false
  const metaRows = await loadSameSpaceAdmissionMeta(meta, spaceId)
  const rows = await db.outbox.orderBy('id').toArray()
  if (!rows.some((row) => row.transportState === 'awaiting_s4')) return false
  const projected = await validateAwaitingS4Snapshot(spaceId, rows, metaRows)
  return projected.admittedRows.length > 0 &&
    projected.readyRootSetSha256 !== marker.readyRootSetSha256
}

async function loadSameSpaceAdmissionMeta(
  meta: MetaDB,
  spaceId: string,
): Promise<ActiveAdmissionMetaRow[]> {
  return meta.transaction('r', meta.provisionalOperations, async () =>
    (await meta.provisionalOperations.where('spaceId').equals(spaceId).toArray())
      .filter((row) => row.state === 'awaiting_s4' || row.state === 'transport_ready')
      .map((row) => ({
        operationId: row.operationId,
        spaceId: row.spaceId,
        state: row.state as ActiveAdmissionMetaRow['state'],
        transportReadyRootSha256: row.transportReadyRootSha256,
      })),
  )
}

async function validateAwaitingS4Snapshot(
  spaceId: string,
  allRows: readonly OutboxEvent[],
  metaRows: readonly ActiveAdmissionMetaRow[],
): Promise<ValidatedAdmissionSnapshot> {
  if (new Set(allRows.map((row) => row.id)).size !== allRows.length ||
      new Set(allRows.map((row) => row.operationId)).size !== allRows.length ||
      allRows.some((row) => row.spaceId !== spaceId)) {
    throw new PushAuthorityIntegrityError('admission_input_identity_invalid')
  }
  const awaitingRows = allRows.filter((row) => row.transportState === 'awaiting_s4')
  for (const row of awaitingRows) {
    if ((row.compoundOperationId === null) !== (row.compoundOrder === null) ||
        !Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0 ||
        (row.attemptCount > 0 &&
          (row.entityType !== 'workItemNote' || row.compoundOperationId !== null))) {
      throw new PushAuthorityIntegrityError('awaiting_s4_row_invalid')
    }
  }
  const admittedRows = awaitingRows.map((row) => ({
    ...row, transportState: 'ready' as const,
  }))
  const admittedByKey = new Map(admittedRows.map((row) => [row.id, row]))
  const projectedReadyRows = allRows
    .map((row) => admittedByKey.get(row.id) ?? row)
    .filter((row) => row.transportState === 'ready')
  const roots = await buildReadyRootIdentities(projectedReadyRows)

  const metaByOperationId = new Map(metaRows.map((row) => [row.operationId, row]))
  if (metaByOperationId.size !== metaRows.length ||
      metaRows.some((row) => row.spaceId !== spaceId)) {
    throw new PushAuthorityIntegrityError('admission_meta_identity_invalid')
  }
  const expectedMetaIds = new Set<string>()
  for (const root of roots.readyRoots.filter((item) => item.rootKind === 'compound')) {
    const sourceRows = allRows.filter((row) => row.compoundOperationId === root.rootId)
    if (sourceRows.length !== root.orderedChildren.length) {
      throw new PushAuthorityIntegrityError('admission_compound_membership_invalid')
    }
    const states = new Set(sourceRows.map((row) => row.transportState))
    if (states.size !== 1 || ![...states].every((state) =>
      state === 'awaiting_s4' || state === 'ready')) {
      throw new PushAuthorityIntegrityError('admission_compound_state_mixed')
    }
    const expectedState = states.has('awaiting_s4') ? 'awaiting_s4' : 'transport_ready'
    const metaRow = metaByOperationId.get(root.rootId)
    if (!metaRow || metaRow.state !== expectedState ||
        (expectedState === 'awaiting_s4'
          ? metaRow.transportReadyRootSha256 !== null
          : metaRow.transportReadyRootSha256 !== root.rootSha256)) {
      throw new PushAuthorityIntegrityError('admission_meta_root_binding_invalid')
    }
    expectedMetaIds.add(root.rootId)
  }
  if (metaRows.some((row) => !expectedMetaIds.has(row.operationId))) {
    throw new PushAuthorityIntegrityError('admission_meta_orphan')
  }
  return {
    admittedRows,
    readyRootIdentities: roots.readyRoots,
    readyRootSetSha256: roots.readyRootSetSha256,
  }
}

function stableAdmissionErrorCode(error: unknown): string {
  return error instanceof PushAuthorityIntegrityError
    ? error.code : error instanceof Error
      ? error.message : 's4_admission_validation_failed'
}

export async function assertS4AdmissionReady(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const metaRows = await loadSameSpaceAdmissionMeta(meta, spaceId)
  const validatedEvidence = await db.syncTerminalApplications
    .where('spaceId').equals(spaceId)
    .and((row) => row.state === 'space_committed' || row.state === 'meta_reconciled')
    .toArray()
  await Promise.all(validatedEvidence.map((item) =>
    parseAndValidateTerminalEvidenceResult(item)))
  await db.transaction('r', db.outbox, db.syncAdmissionState, db.syncTerminalApplications, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const marker = await db.syncAdmissionState.get('active')
    if (!marker || marker.state !== 'ready' || marker.readyRootSetSha256 === null) {
      throw new Error('S4 admission is not ready')
    }
    const allRows = await db.outbox.orderBy('id').toArray()
    if (allRows.some((row) => row.transportState === 'awaiting_s4')) {
      throw new PushAuthorityIntegrityError('admission_awaiting_rows_after_ready')
    }
    const readyRows = allRows.filter((row) => row.transportState === 'ready')
    const actual = await Dexie.waitFor(buildReadyRootIdentities(readyRows))
    const evidence = await db.syncTerminalApplications
      .where('spaceId').equals(spaceId)
      .and((row) => row.state === 'space_committed' || row.state === 'meta_reconciled')
      .toArray()
    if (canonicalize(evidence) !== canonicalize(validatedEvidence)) {
      throw new PushAuthorityIntegrityError('terminal_evidence_changed_during_ready_proof')
    }
    const isExplainedByEvidence = (root: ReadyRootIdentity): boolean =>
      evidence.some((item) => item.readyRoots.some((candidate) =>
        canonicalize(candidate) === canonicalize(root)))
    if (canonicalize(marker.readyRoots) !== canonicalize(actual.readyRoots) ||
        marker.readyRootSetSha256 !== actual.readyRootSetSha256) {
      const explained = marker.readyRoots.every((root) => {
        const live = actual.readyRoots.find((candidate) =>
          canonicalize(candidate) === canonicalize(root))
        if (live) return true
        return isExplainedByEvidence(root)
      })
      if (!explained) {
        throw new PushAuthorityIntegrityError('ready_root_identity_drift')
      }
    }
    const compoundRoots = marker.readyRoots.filter((root) => root.rootKind === 'compound')
    const unresolvedCompoundRoots = compoundRoots.filter((root) => {
      const matching = evidence.filter((item) => item.readyRoots.some((candidate) =>
        canonicalize(candidate) === canonicalize(root)))
      return matching.length !== 1 || matching[0]!.state === 'space_committed'
    })
    if (metaRows.length !== unresolvedCompoundRoots.length ||
        unresolvedCompoundRoots.some((root) => {
      const metaRow = metaRows.find((row) => row.operationId === root.rootId)
      return !metaRow || metaRow.state !== 'transport_ready' ||
        metaRow.transportReadyRootSha256 !== root.rootSha256
    })) {
      throw new PushAuthorityIntegrityError('admission_meta_ready_proof_invalid')
    }
  })
}

export async function admitTs3AwaitingS4(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  let pending = await db.syncAdmissionState.get('active')
  if (pending?.state === 'ready') {
    await assertS4AdmissionReady(db, meta, spaceId, token)
    return
  }
  if (pending?.state !== 'meta_pending') {
    const metaRows = await loadSameSpaceAdmissionMeta(meta, spaceId)
    const decision = await db.transaction(
      'rw', db.outbox, db.syncAdmissionState, async () => {
        requireSpaceAuthorityToken(token, spaceId)
        const rows = await db.outbox.orderBy('id').toArray()
        try {
          const validated = await Dexie.waitFor(
            validateAwaitingS4Snapshot(spaceId, rows, metaRows),
          )
          await db.outbox.bulkPut(validated.admittedRows)
          const next: SyncAdmissionState = {
            key: 'active', state: 'meta_pending',
            readyRoots: validated.readyRootIdentities,
            readyRootSetSha256: validated.readyRootSetSha256,
            errorCode: null,
          }
          await db.syncAdmissionState.put(next)
          return { next, error: null }
        } catch (error: unknown) {
          const code = stableAdmissionErrorCode(error)
          await db.syncAdmissionState.put({
            key: 'active', state: 'failed', readyRoots: [],
            readyRootSetSha256: null, errorCode: code,
          })
          return { next: null, error: new Error(code) }
        }
      },
    )
    if (decision.error) throw decision.error
    pending = decision.next!
  }
  if (!pending || pending.state !== 'meta_pending' ||
      pending.readyRootSetSha256 === null) {
    throw new Error('invalid S4 admission state')
  }
  for (const root of pending.readyRoots.filter((item) => item.rootKind === 'compound')) {
    await markTransportReady(
      meta, spaceId, token, root.rootId, root.rootSha256,
      new Date().toISOString(),
    )
  }
  await db.transaction('rw', db.outbox, db.syncAdmissionState, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const rows = (await db.outbox.orderBy('id').toArray())
      .filter((row) => row.transportState === 'ready')
    const actual = await Dexie.waitFor(buildReadyRootIdentities(rows))
    requireSameReadyRootSet(
      pending.readyRoots, pending.readyRootSetSha256!,
      actual.readyRoots, actual.readyRootSetSha256,
    )
    if (await db.outbox.filter((row) => row.transportState === 'awaiting_s4').count()) {
      throw new PushAuthorityIntegrityError('admission_awaiting_rows_after_meta')
    }
    await db.syncAdmissionState.put({ ...pending, state: 'ready' })
  })
  await assertS4AdmissionReady(db, meta, spaceId, token)
}
