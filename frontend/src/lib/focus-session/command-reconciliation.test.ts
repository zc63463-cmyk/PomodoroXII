import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { CommandReconciliation, prepareReconciliationAttempt } from './command-reconciliation'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []

const aggregate = (receipts: Array<Record<string, unknown>>) => ({
  commandReceipts: receipts,
})

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
})

async function fixture() {
  const db = await openPomodoroXIDB(`reconciliation-${crypto.randomUUID()}`)
  databases.push(db)
  await db.sessionCommandEnvelopes.put({
    commandId: 'cmd-a', spaceId: db.spaceId, sessionId: 'fs-1',
    sessionRevision: 2, workItemId: 'wi-1', expectedVersion: 4,
    targetTransition: 'complete', replaySafe: true, payloadHash: 'a'.repeat(64),
    createdAt: '2026-07-15T08:00:00Z',
  })
  await db.sessionCommandQueue.put({
    commandId: 'cmd-a', spaceId: db.spaceId, sessionId: 'fs-1',
    payloadHash: 'a'.repeat(64), replaySafe: true, envelopeJson: '{}',
    state: 'held', lastReceiptState: 'unknown',
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  })
  const calls: Array<Record<string, unknown>> = []
  const api = {
    reconcileCommands: vi.fn(async (input: Record<string, unknown>) => {
      calls.push(input)
      return aggregate([{ commandId: 'cmd-a', attempt: 1, state: 'succeeded' }])
    }),
  }
  return { db, api, calls, reconciliation: new CommandReconciliation(db, api as never) }
}

describe('CommandReconciliation', () => {
  it('queries the original result before a replay decision', async () => {
    const f = await fixture()
    await f.reconciliation.queryOriginalBeforeReplay('fs-1', 'cmd-a')

    expect(f.api.reconcileCommands).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: f.db.spaceId, sessionId: 'fs-1', commandIds: ['cmd-a'],
      replaySafe: false, abandonCommandIds: [], decisionAt: null,
    }))
  })

  it('sends replay only when the caller asks and the immutable envelope allows it', async () => {
    const f = await fixture()
    await f.reconciliation.reconcile('fs-1', 'cmd-a', true)
    expect(f.calls[0]).toMatchObject({ replaySafe: true })
  })

  it('keeps a real terminal result when abandon races completion', async () => {
    const f = await fixture()
    await f.reconciliation.abandon('fs-1', 'cmd-a', '2026-07-15T09:00:00Z')
    expect(f.calls[0]).toMatchObject({
      replaySafe: false, abandonCommandIds: ['cmd-a'],
      decisionAt: '2026-07-15T09:00:00Z',
    })
    expect(await f.db.sessionCommandQueue.get('cmd-a')).toMatchObject({
      state: 'terminal', lastReceiptState: 'succeeded',
    })
  })

  it('reuses the exact root and request after response loss until the attempt is terminal', async () => {
    const f = await fixture()
    f.api.reconcileCommands.mockRejectedValueOnce(new Error('transport_response_lost'))
    await expect(f.reconciliation.reconcile('fs-1', 'cmd-a', true)).rejects.toThrow('transport_response_lost')
    const inFlight = await f.db.sessionCommandReconciliationAttempts.toCollection().first()
    expect(inFlight).toMatchObject({ state: 'in_flight', operationId: expect.any(String) })

    f.api.reconcileCommands.mockResolvedValueOnce(aggregate([{ commandId: 'cmd-a', attempt: 2, state: 'succeeded' }]))
    await f.reconciliation.reconcile('fs-1', 'cmd-a', true)
    expect(f.calls[1]).toEqual(f.calls[0])
    expect(await f.db.sessionCommandReconciliationAttempts.toCollection().first()).toMatchObject({ state: 'terminal' })
  })

  it('rotates the reconciliation root only after the prior result is terminal', async () => {
    const f = await fixture()
    await f.reconciliation.reconcile('fs-1', 'cmd-a', true)
    await f.reconciliation.reconcile('fs-1', 'cmd-a', true)
    expect(f.calls[1]?.operationId).not.toBe(f.calls[0]?.operationId)
    expect(f.calls[1]).toMatchObject({ commandIds: ['cmd-a'], replaySafe: true })
  })

  it('rejects a changed request under one persisted root operation', async () => {
    const f = await fixture()
    const request = {
      spaceId: f.db.spaceId, sessionId: 'fs-1', commandIds: ['cmd-a'],
      replaySafe: false, abandonCommandIds: [], decisionAt: null,
    }
    await prepareReconciliationAttempt(f.db, request, 'root-reconcile-1')
    await expect(prepareReconciliationAttempt(f.db, { ...request, replaySafe: true }, 'root-reconcile-1'))
      .rejects.toThrow('reconciliation_operation_payload_mismatch')
    expect(f.api.reconcileCommands).not.toHaveBeenCalled()
  })
})
