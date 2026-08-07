import { canonicalize } from 'json-canonicalize'

import {
  S4_PROVISIONAL_OPERATION_STATES,
  type MetaDB,
  type ProvisionalClaimResult,
  type ProvisionalOperationRow,
} from '@/services/meta-database'
import {
  requireSpaceAuthorityToken,
  type SpaceAuthorityToken,
} from './space-authority-fence'

const S4_PROVISIONAL_FIELD_NAMES = [
  'transportReadyRootSha256', 'terminalEvidenceId',
  'terminalResultSha256', 'terminalOperationIdsSha256',
] as const satisfies readonly (keyof ProvisionalOperationRow)[]

function assertCompleteS4ProvisionalFields(row: ProvisionalOperationRow): void {
  if (!S4_PROVISIONAL_OPERATION_STATES.includes(row.state)) {
    throw new Error('invalid_s4_provisional_state')
  }
  if (S4_PROVISIONAL_FIELD_NAMES.some((field) =>
    !Object.prototype.hasOwnProperty.call(row, field))) {
    throw new Error('incomplete_s4_provisional_fields')
  }
  const rootValid = row.transportReadyRootSha256 === null ||
    /^[0-9a-f]{64}$/.test(row.transportReadyRootSha256)
  const terminal = [
    row.terminalEvidenceId, row.terminalResultSha256,
    row.terminalOperationIdsSha256,
  ]
  const terminalNull = terminal.every((value) => value === null)
  const terminalBound = terminal.every((value) =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
  const bindingsValid = row.state === 'transport_ready'
    ? row.transportReadyRootSha256 !== null && terminalNull
    : row.state === 'transport_resolved'
      ? row.transportReadyRootSha256 !== null && terminalBound
      : row.transportReadyRootSha256 === null && terminalNull
  if (!rootValid || !bindingsValid) {
    throw new Error('invalid_s4_provisional_state_bindings')
  }
}

export async function claimProvisionalOperation(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  row: ProvisionalOperationRow,
): Promise<ProvisionalClaimResult> {
  requireSpaceAuthorityToken(token, spaceId)
  if (row.spaceId !== spaceId) throw new Error('provisional_operation_space_mismatch')
  assertCompleteS4ProvisionalFields(row)
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const existing = await meta.provisionalOperations.get(row.operationId)
    if (existing) {
      if (existing.spaceId !== spaceId || existing.intentJson !== row.intentJson ||
          existing.payloadHash !== row.payloadHash || existing.sessionId !== row.sessionId ||
          existing.deviceId !== row.deviceId || existing.tabId !== row.tabId ||
          existing.cachedOwnershipEpoch !== row.cachedOwnershipEpoch ||
          existing.createdAt !== row.createdAt) {
        throw new Error('idempotency_conflict')
      }
      assertCompleteS4ProvisionalFields(existing)
      return { disposition: 'existing', row: existing } as const
    }
    const blockingStates = new Set<ProvisionalOperationRow['state']>([
      'pending', 'activating', 'conflict',
    ])
    const active = await meta.provisionalOperations.where('deviceId')
      .equals(row.deviceId).and((item) => blockingStates.has(item.state)).first()
    if (active) throw new Error('active_session_exists')
    await meta.provisionalOperations.add(row)
    return { disposition: 'created', row } as const
  })
}

export async function transitionProvisionalOperation(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  operationId: string,
  expectedStates: readonly ProvisionalOperationRow['state'][],
  patch: Readonly<Partial<ProvisionalOperationRow>>,
): Promise<ProvisionalOperationRow> {
  requireSpaceAuthorityToken(token, spaceId)
  if (expectedStates.length === 0 ||
      ['operationId', 'spaceId', 'sessionId', 'deviceId', 'tabId', 'intentJson',
        'payloadHash', 'createdAt'].some((field) =>
        Object.prototype.hasOwnProperty.call(patch, field)) ||
      patch.state === 'transport_ready' || patch.state === 'transport_resolved') {
    throw new Error('invalid_provisional_transition_patch')
  }
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(operationId)
    if (!current || current.spaceId !== spaceId || !expectedStates.includes(current.state)) {
      throw new Error('provisional_operation_transition_conflict')
    }
    const next = { ...current, ...patch }
    assertCompleteS4ProvisionalFields(next)
    await meta.provisionalOperations.put(next)
    return next
  })
}

export async function markTransportReady(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  operationId: string,
  transportReadyRootSha256: string,
  updatedAt: string,
): Promise<ProvisionalOperationRow> {
  requireSpaceAuthorityToken(token, spaceId)
  if (!/^[0-9a-f]{64}$/.test(transportReadyRootSha256)) {
    throw new Error('invalid_transport_ready_root')
  }
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(operationId)
    if (!current || current.spaceId !== spaceId) {
      throw new Error('provisional_operation_transport_ready_conflict')
    }
    if (current.state === 'transport_ready') {
      if (current.transportReadyRootSha256 !== transportReadyRootSha256) {
        throw new Error('provisional_ready_root_identity_mismatch')
      }
      assertCompleteS4ProvisionalFields(current)
      return current
    }
    if (current.state !== 'awaiting_s4') {
      throw new Error('provisional_operation_not_awaiting_transport')
    }
    const next: ProvisionalOperationRow = {
      ...current,
      state: 'transport_ready',
      transportReadyRootSha256,
      terminalEvidenceId: null,
      terminalResultSha256: null,
      terminalOperationIdsSha256: null,
      updatedAt,
    }
    assertCompleteS4ProvisionalFields(next)
    await meta.provisionalOperations.put(next)
    return next
  })
}

export async function resolveTransportTerminal(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  input: Readonly<{
    operationId: string
    transportReadyRootSha256: string
    terminalEvidenceId: string
    terminalResultSha256: string
    terminalOperationIdsSha256: string
    updatedAt: string
  }>,
): Promise<ProvisionalOperationRow> {
  requireSpaceAuthorityToken(token, spaceId)
  for (const digest of [
    input.transportReadyRootSha256, input.terminalEvidenceId,
    input.terminalResultSha256, input.terminalOperationIdsSha256,
  ]) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('invalid_transport_terminal_hash')
  }
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(input.operationId)
    if (!current || current.spaceId !== spaceId ||
        current.transportReadyRootSha256 !== input.transportReadyRootSha256) {
      throw new Error('terminal_meta_root_mismatch')
    }
    const next: ProvisionalOperationRow = {
      ...current,
      state: 'transport_resolved',
      terminalEvidenceId: input.terminalEvidenceId,
      terminalResultSha256: input.terminalResultSha256,
      terminalOperationIdsSha256: input.terminalOperationIdsSha256,
      updatedAt: input.updatedAt,
    }
    if (current.state === 'transport_resolved') {
      assertCompleteS4ProvisionalFields(current)
      if (canonicalize(current) !== canonicalize(next)) {
        throw new Error('terminal_meta_resolution_mismatch')
      }
      return current
    }
    if (current.state !== 'transport_ready') throw new Error('terminal_meta_state_mismatch')
    assertCompleteS4ProvisionalFields(next)
    await meta.provisionalOperations.put(next)
    return next
  })
}

export async function deleteProvisionalOperation(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  operationId: string,
  expectedStates: readonly ProvisionalOperationRow['state'][],
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  await meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(operationId)
    if (!current || current.spaceId !== spaceId || !expectedStates.includes(current.state)) {
      throw new Error('provisional_operation_delete_conflict')
    }
    await meta.provisionalOperations.delete(operationId)
  })
}
