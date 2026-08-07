import { afterEach, describe, expect, it } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

import { INITIAL_S4_OUTBOX_FIELDS, type PomodoroXIDB } from '@/services/database'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { spaceApi } from '@/services/api'
import {
  buildProvisionalOperationRow,
  INITIAL_S4_PROVISIONAL_FIELDS,
  MetaDB,
} from '@/services/meta-database'
import type { OutboxEvent } from '@/types'
import {
  decodeCanonicalBase64,
  encodeBase64,
  selectOneAuthorityUnit,
  sha256Canonical,
  sha256Utf8,
  type PushSelection,
} from './authority-identity'
import {
  classifyOperationQuery,
  createPendingPushBatchAfterUnknown,
  pushActivePendingBatch,
  pushAllPendingUnderFence,
} from './push-batch'
import { withSpaceAuthorityFence } from './space-authority-fence'
import { recomputeEntityBusinessPayloadHash } from './entity-payload-hash'
import type { JsonValue } from '@/lib/contracts/payload-hash'

const originalAdapter = spaceApi.defaults.adapter

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

describe('Sync v2 push receipt', () => {
  let db: PomodoroXIDB | undefined
  let meta: MetaDB | undefined
  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    if (db) await db.delete()
    if (meta) await meta.delete()
    db = undefined
    meta = undefined
  })

  async function scheduleRow(
    spaceId: string,
    id: number,
    transportState: OutboxEvent['transportState'] = 'ready',
  ): Promise<OutboxEvent> {
    const entityId = `schedule-${id}`
    const timestamp = '2026-08-07T01:00:00.000Z'
    const payload = {
      id: entityId, title: 'Focus', due_at: timestamp, completed_at: null,
      priority: 'medium', color: '#123456', all_day: false,
      start_time: null, end_time: null, created_at: timestamp, updated_at: timestamp,
    }
    return {
      id, spaceId, entityType: 'schedule', entityId, action: 'create',
      payload: JSON.stringify(payload),
      payloadHash: await recomputeEntityBusinessPayloadHash('schedule', 'create', payload),
      operationId: `schedule-operation-${id}`,
      compoundOperationId: null, compoundOrder: null, expectedVersion: null,
      requiresVersionRebase: false, transportState, createdAt: timestamp,
      synced: false, lastError: null, lastErrorCode: null, failedAt: null,
      attemptCount: 0, ...INITIAL_S4_OUTBOX_FIELDS,
    }
  }

  async function addAwaitingCompound(
    targetDb: PomodoroXIDB,
    targetMeta: MetaDB,
    suffix: string,
    firstId: number,
  ): Promise<void> {
    const timestamp = '2026-08-07T01:00:00.000Z'
    const root = `compound-${suffix}`
    const sessionId = `session-${suffix}`
    const payloads = [
      {
        id: sessionId, version: 1, createdAt: timestamp, updatedAt: timestamp,
        sessionRevision: 1, startedAt: timestamp, endedAt: null,
        pauseStartedAt: null, plannedSeconds: 1500, grossSeconds: 0,
        pausedSeconds: 0, breakSeconds: 0, focusedSeconds: 0,
        timerCompletion: null, validity: 'pending', validityReason: null,
        overallProgress: null, mood: null, reviewState: 'pending',
        ownershipState: 'local_provisional', sessionNote: '',
      },
      {
        id: `context-${suffix}`, version: 1, createdAt: timestamp, updatedAt: timestamp,
        sessionId, projectId: 'project-a', level2WorkItemId: 'work-a',
        projectTitleSnapshot: 'Project', level2TitleSnapshot: 'Work',
        level2ParentIdSnapshot: null, level2StatusDefinitionIdSnapshot: 'status-a',
        level2VersionSnapshot: 1, level2EffortLowerSecondsSnapshot: null,
        level2EffortUpperSecondsSnapshot: null, linkedAt: timestamp, linkMethod: 'explicit',
      },
      {
        id: `attribution-${suffix}`, version: 1, createdAt: timestamp, updatedAt: timestamp,
        sessionId, revision: 1, projectId: 'project-a', level2WorkItemId: 'work-a',
        reason: null, correctedFromRevision: null, effective: true,
      },
    ]
    const entityTypes = [
      'focusSession', 'sessionTaskContext', 'sessionAttributionRevision',
    ] as const
    const rows = await Promise.all(payloads.map(async (payload, index): Promise<OutboxEvent> => {
      const payloadValue = JSON.parse(JSON.stringify(payload)) as JsonValue
      return {
        id: firstId + index, spaceId: targetDb.spaceId, entityType: entityTypes[index]!,
        entityId: String(payload.id), action: 'create', payload: JSON.stringify(payloadValue),
        payloadHash: await recomputeEntityBusinessPayloadHash(
          entityTypes[index]!, 'create', payloadValue,
        ),
        operationId: `${root}-operation-${index}`, compoundOperationId: root,
        compoundOrder: index, expectedVersion: null, requiresVersionRebase: false,
        transportState: 'awaiting_s4', createdAt: timestamp, synced: false,
        lastError: null, lastErrorCode: null, failedAt: null, attemptCount: 0,
        ...INITIAL_S4_OUTBOX_FIELDS,
      }
    }))
    await targetDb.outbox.bulkPut(rows)
    const provisional = await buildProvisionalOperationRow({
      operationId: root, spaceId: targetDb.spaceId, sessionId,
      deviceId: 'device-a', tabId: 'tab-a', level2WorkItemId: 'work-a',
      level3WorkItemIds: [], plannedSeconds: 1500, startedAt: timestamp,
      expectedWorkItemVersions: { 'work-a': 1 },
    }, null)
    await targetMeta.provisionalOperations.put({
      ...provisional, state: 'awaiting_s4', ...INITIAL_S4_PROVISIONAL_FIELDS,
    })
  }

  it('persists exact canonical request authority before any push', async () => {
    db = await openPomodoroXIDB(`push-test-${crypto.randomUUID()}`)
    const payloadText = '{"id":"note-a"}'
    const frozen = {
      durableKey: 1, spaceId: db.spaceId, entityType: 'note' as const,
      entityId: 'note-a', action: 'delete' as const,
      payloadCanonicalBase64: encodeBase64(new TextEncoder().encode(payloadText)),
      payloadHash: 'a'.repeat(64), operationId: 'op-a',
      retryPredecessorOperationId: null, expectedVersion: 1,
      createdAt: '2026-07-14T10:00:00.000Z', transportState: 'ready' as const,
      compoundOperationId: null, compoundOrder: null, attemptCount: 0,
    }
    const document = { rootKind: 'standalone' as const, rootId: 'op-a',
      orderedChildren: [frozen] }
    const readyRoots = [{ ...document, rootSha256: await sha256Canonical(document) }]
    const selected: PushSelection = {
      authority: { kind: 'standalone_batch', batchId: await sha256Utf8('op-a'),
        compoundOperationId: null, orderedOperationIds: ['op-a'] },
      operationIds: ['op-a'], frozenRows: [frozen], readyRoots,
      readyRootSetSha256: await sha256Canonical(readyRoots),
    }
    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      const receipt = await createPendingPushBatchAfterUnknown(
        db!, {} as MetaDB, db!.spaceId, 'client-a', selected, token,
      )
      expect(receipt.operationIds).toEqual(['op-a'])
      expect(receipt.requestPath).toBe('/api/v1/sync/v2/push')
      expect(await db!.syncPushBatches.get('active')).toEqual(receipt)
    })
  })

  it('classifies blockers before terminal or unknown work', async () => {
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => ok({ items: [
      { operation_id: 'op-a', state: 'pending', batch_id: 'batch-a', result: null },
      { operation_id: 'op-b', state: 'unknown', batch_id: null, result: null },
    ] }, config)
    await expect(classifyOperationQuery(spaceApi, 'client-a', ['op-a', 'op-b']))
      .resolves.toEqual({ kind: 'blocked', state: 'pending' })
  })

  it('replays the exact persisted canonical request bytes', async () => {
    db = await openPomodoroXIDB(`push-replay-${crypto.randomUUID()}`)
    meta = new MetaDB(`push-replay-meta-${crypto.randomUUID()}`)
    await meta.open()
    await db.outbox.put(await scheduleRow(db.spaceId, 1))
    const selected = (await selectOneAuthorityUnit(db))!
    let sentBody: unknown
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      if (config.url?.endsWith('/operations/query')) {
        return ok({ items: selected.operationIds.map((operationId) => ({
          operation_id: operationId, state: 'unknown', batch_id: null, result: null,
        })) }, config)
      }
      sentBody = config.data
      return ok({
        batch_id: selected.authority.batchId,
        applied: selected.frozenRows.map((row) => ({
          operation_id: row.operationId, entity_type: row.entityType,
          entity_id: row.entityId, version: 1, resolution: null,
        })),
        conflicts: [], errors: [],
      }, config)
    }
    await withSpaceAuthorityFence(db.spaceId, async (token) => {
      const receipt = await createPendingPushBatchAfterUnknown(
        db!, meta!, db!.spaceId, 'client-a', selected, token,
      )
      const expected = new TextDecoder('utf-8', { fatal: true }).decode(
        decodeCanonicalBase64(receipt.requestCanonicalBase64),
      )
      await pushActivePendingBatch(db!, meta!, db!.spaceId, spaceApi, token)
      expect(sentBody).toBe(expected)
    })
  })

  it('stops after one typed authority restart', async () => {
    db = await openPomodoroXIDB(`push-restart-${crypto.randomUUID()}`)
    meta = new MetaDB(`push-restart-meta-${crypto.randomUUID()}`)
    await meta.open()
    await db.outbox.put(await scheduleRow(db.spaceId, 1, 'awaiting_s4'))
    let queryCount = 0
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      if (!config.url?.endsWith('/operations/query')) {
        throw new Error('push_must_not_be_reached')
      }
      queryCount += 1
      await addAwaitingCompound(db!, meta!, String(queryCount), queryCount * 10)
      const operationIds = (JSON.parse(String(config.data)) as { operation_ids: string[] })
        .operation_ids
      return ok({ items: operationIds.map((operationId) => ({
        operation_id: operationId, state: 'unknown', batch_id: null, result: null,
      })) }, config)
    }
    await expect(withSpaceAuthorityFence(db.spaceId, (token) =>
      pushAllPendingUnderFence(db!, meta!, db!.spaceId, 'client-a', spaceApi, token)))
      .rejects.toThrow('push_authority_restart_exhausted')
    expect(queryCount).toBe(2)
    expect(await db.syncPushBatches.get('active')).toMatchObject({
      operationIds: ['schedule-operation-1'],
    })
  })
})
