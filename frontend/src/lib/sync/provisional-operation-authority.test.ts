import { afterEach, describe, expect, it } from 'vitest'

import {
  INITIAL_S4_PROVISIONAL_FIELDS,
  MetaDB,
  buildProvisionalOperationRow,
} from '@/services/meta-database'
import {
  claimProvisionalOperation,
  markTransportReady,
  resolveTransportTerminal,
  transitionProvisionalOperation,
} from './provisional-operation-authority'
import { withSpaceAuthorityFence, type SpaceAuthorityToken } from './space-authority-fence'

class FakeLockManager {
  request<T>(
    _name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T> {
    return callback()
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const databases: MetaDB[] = []

afterEach(async () => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
  await Promise.all(databases.splice(0).map((db) => db.delete()))
})

const installLocks = () => Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: new FakeLockManager(),
})

async function openMeta(): Promise<MetaDB> {
  const meta = new MetaDB(`pxii-authority-${crypto.randomUUID()}`)
  databases.push(meta)
  await meta.open()
  return meta
}

async function operation(spaceId = 'space-a') {
  return buildProvisionalOperationRow({
    operationId: 'operation-a', spaceId, sessionId: 'session-a',
    deviceId: 'device-a', tabId: 'tab-a', level2WorkItemId: 'work-a',
    level3WorkItemIds: [], plannedSeconds: 1500,
    startedAt: '2026-08-07T01:00:00.000Z', expectedWorkItemVersions: { 'work-a': 1 },
  }, null)
}

describe('provisional operation authority', () => {
  it('rejects a forged or expired Space authority token before reading or writing', async () => {
    installLocks()
    const meta = await openMeta()
    const forged = { spaceId: 'space-a' } as SpaceAuthorityToken

    await expect(claimProvisionalOperation(meta, 'space-a', forged, await operation()))
      .rejects.toThrow('space_authority_token_invalid')
    expect(await meta.provisionalOperations.count()).toBe(0)

    let expired!: SpaceAuthorityToken
    await withSpaceAuthorityFence('space-a', async (token) => { expired = token })
    await expect(claimProvisionalOperation(meta, 'space-a', expired, await operation()))
      .rejects.toThrow('space_authority_token_invalid')
  })

  it('claims idempotently and keeps generic transitions out of transport states', async () => {
    installLocks()
    const meta = await openMeta()
    await withSpaceAuthorityFence('space-a', async (token) => {
      const row = await operation()
      await expect(claimProvisionalOperation(meta, 'space-a', token, row))
        .resolves.toMatchObject({ disposition: 'created' })
      await expect(claimProvisionalOperation(meta, 'space-a', token, { ...row }))
        .resolves.toMatchObject({ disposition: 'existing' })
      await expect(transitionProvisionalOperation(
        meta, 'space-a', token, row.operationId, ['pending'],
        { state: 'transport_ready' },
      )).rejects.toThrow('invalid_provisional_transition_patch')
      await expect(transitionProvisionalOperation(
        meta, 'space-a', token, row.operationId, ['pending'],
        { state: 'awaiting_s4', updatedAt: '2026-08-07T01:01:00.000Z' },
      )).resolves.toMatchObject({ state: 'awaiting_s4' })
    })
  })

  it('binds ready and terminal evidence to one immutable root digest', async () => {
    installLocks()
    const meta = await openMeta()
    const rootSha256 = 'a'.repeat(64)
    const evidenceId = 'b'.repeat(64)
    const resultSha256 = 'c'.repeat(64)
    const operationIdsSha256 = 'd'.repeat(64)

    await meta.provisionalOperations.add({
      ...await operation(), state: 'awaiting_s4', ...INITIAL_S4_PROVISIONAL_FIELDS,
    })
    await withSpaceAuthorityFence('space-a', async (token) => {
      await expect(markTransportReady(
        meta, 'space-a', token, 'operation-a', rootSha256,
        '2026-08-07T01:01:00.000Z',
      )).resolves.toMatchObject({
        state: 'transport_ready', transportReadyRootSha256: rootSha256,
      })

      const input = {
        operationId: 'operation-a', transportReadyRootSha256: rootSha256,
        terminalEvidenceId: evidenceId, terminalResultSha256: resultSha256,
        terminalOperationIdsSha256: operationIdsSha256,
        updatedAt: '2026-08-07T01:02:00.000Z',
      }
      await expect(resolveTransportTerminal(meta, 'space-a', token, input))
        .resolves.toMatchObject({ state: 'transport_resolved', terminalEvidenceId: evidenceId })
      await expect(resolveTransportTerminal(meta, 'space-a', token, input))
        .resolves.toMatchObject({ state: 'transport_resolved' })
      await expect(resolveTransportTerminal(meta, 'space-a', token, {
        ...input, terminalResultSha256: 'e'.repeat(64),
      })).rejects.toThrow('terminal_meta_resolution_mismatch')
    })
  })
})
