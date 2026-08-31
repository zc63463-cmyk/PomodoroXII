import { afterEach, describe, expect, it } from 'vitest'
import { canonicalize } from 'json-canonicalize'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { INITIAL_S4_OUTBOX_FIELDS } from '@/services/database'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { buildProvisionalOperationRow, MetaDB } from '@/services/meta-database'
import { withSpaceAuthorityFence } from './space-authority-fence'

import type { PushSelection } from './authority-identity'
import type { ApiSyncV2PushResponse } from './types'
import { PushAuthorityIntegrityError, selectOneAuthorityUnit } from './authority-identity'
import {
  applyTerminalResultTwoPhase,
  applyTerminalOutcomesWithoutDeletingSuccessors,
  createRetrySuccessorFromTerminalError,
  reconcileSpaceCommittedTerminalEvidence,
  requireExactTerminalCoverage,
} from './terminal-application'

const databases: Array<{ delete: () => Promise<void> }> = []
const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')
class FakeLockManager {
  request<T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    return callback()
  }
}
afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
  if (locks) Object.defineProperty(navigator, 'locks', locks)
  else Reflect.deleteProperty(navigator, 'locks')
})

const frozen = (operationId: string, entityId: string) => ({
  durableKey: 1, spaceId: 'space-a', entityType: 'note' as const, entityId,
  action: 'create' as const, payloadCanonicalBase64: 'e30=', payloadHash: 'a'.repeat(64),
  operationId, retryPredecessorOperationId: null, expectedVersion: null,
  createdAt: '2026-07-14T10:00:00.000Z', transportState: 'ready' as const,
  compoundOperationId: null, compoundOrder: null, attemptCount: 0,
})

const selection: PushSelection = {
  authority: {
    kind: 'standalone_batch', batchId: 'batch-a', compoundOperationId: null,
    orderedOperationIds: ['op-a', 'op-b'],
  },
  operationIds: ['op-a', 'op-b'],
  frozenRows: [frozen('op-a', 'note-a'), frozen('op-b', 'note-b')],
  readyRoots: [], readyRootSetSha256: 'a'.repeat(64),
}

describe('terminal application coverage', () => {
  it('retains mixed terminal diagnostics with distinct states and deterministic retry schedule', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: new FakeLockManager() })
    const spaceId = `terminal-mixed-${crypto.randomUUID()}`
    const db = await openPomodoroXIDB(spaceId)
    const meta = new MetaDB(`terminal-mixed-meta-${crypto.randomUUID()}`)
    await meta.open()
    databases.push(db, meta)
    const createdAt = '2026-07-14T10:00:00.000Z'
    await db.outbox.bulkAdd([
        { id: 1, spaceId, entityType: 'note', entityId: 'note-a', action: 'create',
          payload: '{}', payloadHash: 'a'.repeat(64), operationId: 'op-a',
          compoundOperationId: null, compoundOrder: null, expectedVersion: null,
          requiresVersionRebase: false, transportState: 'ready', createdAt,
          synced: false, lastError: null, lastErrorCode: null, failedAt: null,
          attemptCount: 0, serverOutcomeCanonicalBase64: null, retryable: false,
          nextAttemptAt: null, retryPredecessorOperationId: null,
          retrySuccessorOperationId: null },
        { id: 2, spaceId, entityType: 'note', entityId: 'note-b', action: 'create',
          payload: '{}', payloadHash: 'b'.repeat(64), operationId: 'op-b',
          compoundOperationId: null, compoundOrder: null, expectedVersion: null,
          requiresVersionRebase: false, transportState: 'ready', createdAt,
          synced: false, lastError: null, lastErrorCode: null, failedAt: null,
          attemptCount: 1, serverOutcomeCanonicalBase64: null, retryable: false,
          nextAttemptAt: null, retryPredecessorOperationId: null,
          retrySuccessorOperationId: null },
    ])
    const result = {
      batch_id: 'batch-a', applied: [],
      conflicts: [{ operation_id: 'op-a', entity_type: 'note', entity_id: 'note-a',
        code: 'version_conflict', resolution: 'manual', details: {} }],
      errors: [{ operation_id: 'op-b', entity_type: 'note', entity_id: 'note-b',
        code: 'temporary', retryable: true, details: {} }],
    } as ApiSyncV2PushResponse
    await withSpaceAuthorityFence(spaceId, async (token) =>
      applyTerminalOutcomesWithoutDeletingSuccessors(
        db, spaceId, token, await db.outbox.toArray(), result,
        '2026-07-14T10:00:00.000Z',
      ))
    const rows = await db.outbox.orderBy('id').toArray()
    expect(rows.map((row) => row.transportState)).toEqual([
      'terminal_conflict', 'terminal_error',
    ])
    expect(rows[0]!.retryable).toBe(false)
    expect(rows[1]!.retryable).toBe(true)
    expect(rows[1]!.nextAttemptAt).toBe('2026-07-14T10:00:02.000Z')
  })

  it('creates one due retry successor and preserves a linear immutable link', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: new FakeLockManager() })
    const spaceId = `terminal-retry-${crypto.randomUUID()}`
    const db = await openPomodoroXIDB(spaceId)
    const meta = new MetaDB(`terminal-retry-meta-${crypto.randomUUID()}`)
    await meta.open()
    databases.push(db, meta)
    const createdAt = '2026-07-14T10:00:00.000Z'
    const payload = {
      id: 'schedule-a', title: 'Focus', due_at: createdAt, completed_at: null,
      priority: 'medium', color: '#123456', all_day: false,
      start_time: null, end_time: null, created_at: createdAt, updated_at: createdAt,
    }
    const payloadHash = await hashCommandPayload(payload)
    await db.outbox.add({
      id: 1, spaceId, entityType: 'schedule', entityId: 'schedule-a', action: 'create',
      payload: JSON.stringify(payload), payloadHash, operationId: 'op-retry',
      compoundOperationId: null, compoundOrder: null, expectedVersion: null,
      requiresVersionRebase: false, transportState: 'ready', createdAt,
      synced: false, lastError: null, lastErrorCode: null, failedAt: null,
      attemptCount: 0, ...INITIAL_S4_OUTBOX_FIELDS,
    })
    await withSpaceAuthorityFence(spaceId, async (token) => {
      const selected = await selectOneAuthorityUnit(db)
      expect(selected).not.toBeNull()
      await applyTerminalResultTwoPhase(db, meta, spaceId, token, selected!, {
        batch_id: selected!.authority.batchId, applied: [], conflicts: [],
        errors: [{ operation_id: 'op-retry', entity_type: 'schedule', entity_id: 'schedule-a',
          code: 'temporary', retryable: true, details: {} }],
      }, 'push_response')
      const original = await db.outbox.get(1)
      expect(original).toMatchObject({
        transportState: 'terminal_error', retryable: true,
        retrySuccessorOperationId: null,
      })
      expect(await selectOneAuthorityUnit(db)).toBeNull()
      await expect(createRetrySuccessorFromTerminalError({
        db, spaceId, token, durableKey: 1, operationId: 'op-retry', now: createdAt,
      })).rejects.toThrow('terminal_error_not_retryable')
      const exactEvidence = (await db.syncTerminalApplications.toArray())[0]!
      await db.syncTerminalApplications.update(exactEvidence.evidenceId, {
        resultSha256: '0'.repeat(64),
      })
      await expect(createRetrySuccessorFromTerminalError({
        db, spaceId, token, durableKey: 1, operationId: 'op-retry',
        now: original!.nextAttemptAt!,
      })).rejects.toThrow('terminal_evidence')
      await db.syncTerminalApplications.put(exactEvidence)
      await db.outbox.add({
        ...original!, id: undefined, operationId: 'rogue-branch',
        transportState: 'awaiting_s4', ...INITIAL_S4_OUTBOX_FIELDS,
        retryPredecessorOperationId: 'op-retry',
      })
      await expect(createRetrySuccessorFromTerminalError({
        db, spaceId, token, durableKey: 1, operationId: 'op-retry',
        now: original!.nextAttemptAt!,
      })).rejects.toThrow('terminal_retry_successor_lineage_invalid')
      expect(await db.outbox.count()).toBe(2)
      await db.outbox.where('operationId').equals('rogue-branch').delete()
      const successorId = await createRetrySuccessorFromTerminalError({
        db, spaceId, token, durableKey: 1, operationId: 'op-retry',
        now: original!.nextAttemptAt!,
      })
      const repeatedId = await createRetrySuccessorFromTerminalError({
        db, spaceId, token, durableKey: 1, operationId: 'op-retry',
        now: original!.nextAttemptAt!,
      })
      expect(repeatedId).toBe(successorId)
      expect(await db.outbox.get(1)).toMatchObject({
        transportState: 'terminal_error', retrySuccessorOperationId: successorId,
      })
      const successors = await db.outbox
        .filter((row) => row.retryPredecessorOperationId === 'op-retry').toArray()
      expect(successors).toHaveLength(1)
      expect(successors[0]).toMatchObject({
        operationId: successorId, payload: JSON.stringify(payload), payloadHash,
        transportState: 'awaiting_s4', retryPredecessorOperationId: 'op-retry',
        retrySuccessorOperationId: null,
      })
    })
  })

  it('accepts one complete one-of outcome for every selected operation', () => {
    expect(() => requireExactTerminalCoverage(selection, {
      batch_id: 'batch-a',
      applied: [{ operation_id: 'op-a', entity_type: 'note', entity_id: 'note-a', version: 1, resolution: null }],
      conflicts: [{ operation_id: 'op-b', entity_type: 'note', entity_id: 'note-b', code: 'version_conflict', resolution: 'manual', details: {} }],
      errors: [],
    })).not.toThrow()
  })

  it('writes a reviewable workItemNote conflict row on a snapshot-aware version_conflict', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: new FakeLockManager() })
    const spaceId = `terminal-note-conflict-${crypto.randomUUID()}`
    const db = await openPomodoroXIDB(spaceId)
    const meta = new MetaDB(`terminal-note-conflict-meta-${crypto.randomUUID()}`)
    await meta.open()
    databases.push(db, meta)
    const createdAt = '2026-07-14T10:00:00.000Z'
    const localDocument = { contentVersion: 1, blocks: [{ blockId: 'b1', type: 'paragraph', text: 'Local' }] }
    const remoteDocument = { contentVersion: 1, blocks: [{ blockId: 'b2', type: 'paragraph', text: 'Remote' }] }
    const documentJson = canonicalize(remoteDocument) as string
    await db.workItemNotes.put({
      id: 'note-1', noteId: 'note-1', workItemId: 'wi-1',
      document: localDocument, version: 3, localRevision: 2, syncState: 'dirty',
      createdAt, updatedAt: createdAt,
    })
    const postImage = {
      id: 'note-1', work_item_id: 'wi-1',
      document_json: canonicalize(localDocument) as string,
      created_at: createdAt, updated_at: createdAt, version: 4,
    }
    await db.outbox.add({
      id: 1, spaceId, entityType: 'workItemNote', entityId: 'note-1', action: 'update',
      payload: JSON.stringify(postImage),
      payloadHash: await hashCommandPayload({ document: localDocument }),
      operationId: 'op-note', compoundOperationId: null, compoundOrder: null,
      expectedVersion: 3, requiresVersionRebase: false, transportState: 'ready', createdAt,
      synced: false, lastError: null, lastErrorCode: null, failedAt: null,
      attemptCount: 0, ...INITIAL_S4_OUTBOX_FIELDS,
    })
    await withSpaceAuthorityFence(spaceId, async (token) => {
      const selected = await selectOneAuthorityUnit(db)
      expect(selected).not.toBeNull()
      await applyTerminalResultTwoPhase(db, meta, spaceId, token, selected!, {
        batch_id: selected!.authority.batchId,
        applied: [],
        conflicts: [{
          operation_id: 'op-note', entity_type: 'work_item_note', entity_id: 'note-1',
          code: 'version_conflict', resolution: 'manual', details: {},
          snapshot: {
            id: 'note-1', work_item_id: 'wi-1', document_json: documentJson,
            created_at: createdAt, updated_at: createdAt, version: 4,
          },
          version: 4,
        }],
        errors: [],
      }, 'push_response')
      const conflict = await db.workItemNoteConflicts.get('wi-1') as Record<string, unknown> | undefined
      expect(conflict).toBeDefined()
      expect((conflict!.localDocument as { blocks: Array<{ text: string }> }).blocks[0].text).toBe('Local')
      expect((conflict!.remoteDocument as { blocks: Array<{ text: string }> }).blocks[0].text).toBe('Remote')
      expect(conflict).toMatchObject({ baseVersion: 3, remoteVersion: 4 })
      expect((await db.workItemNotes.get('note-1'))?.syncState).toBe('conflict')
      expect((await db.outbox.get(1))?.transportState).toBe('blocked_conflict')
    })
  })

  it('rejects missing, duplicate, or wrong entity outcomes', () => {
    const base = {
      batch_id: 'batch-a', applied: [], conflicts: [], errors: [],
    }
    expect(() => requireExactTerminalCoverage(selection, {
      ...base,
      applied: [{ operation_id: 'op-a', entity_type: 'note', entity_id: 'note-a', version: 1, resolution: null }],
    })).toThrow(PushAuthorityIntegrityError)
    expect(() => requireExactTerminalCoverage(selection, {
      ...base,
      applied: [
        { operation_id: 'op-a', entity_type: 'note', entity_id: 'note-a', version: 1, resolution: null },
        { operation_id: 'op-a', entity_type: 'note', entity_id: 'note-a', version: 1, resolution: null },
      ],
    })).toThrow(PushAuthorityIntegrityError)
    expect(() => requireExactTerminalCoverage(selection, {
      ...base,
      applied: [
        { operation_id: 'op-a', entity_type: 'note', entity_id: 'wrong', version: 1, resolution: null },
        { operation_id: 'op-b', entity_type: 'note', entity_id: 'note-b', version: 1, resolution: null },
      ],
    })).toThrow(PushAuthorityIntegrityError)
  })

  it('converges _dirty for multi-word LWW entities when the server returns snake_case entity_type', async () => {
    // 回归：服务端 push 响应 entity_type 是 snake_case（quick_note），而
    // outbox 行是 camelCase（quickNote）。修复前 ENTITY_TYPE_TO_TABLE 用原始
    // snake_case 查表返回 undefined，quickNotes 表未加入事务清单，事务内
    // db.table('quickNotes').update(...) 抛 Dexie NotFoundError，小记同步永不收敛。
    Object.defineProperty(navigator, 'locks', { configurable: true, value: new FakeLockManager() })
    const spaceId = `terminal-qn-snake-${crypto.randomUUID()}`
    const db = await openPomodoroXIDB(spaceId)
    const meta = new MetaDB(`terminal-qn-snake-meta-${crypto.randomUUID()}`)
    await meta.open()
    databases.push(db, meta)
    const createdAt = '2026-07-14T10:00:00.000Z'
    await db.quickNotes.put({
      id: 'quick-1', content: 'hello', mood: null, tags: [], pinned: false,
      created_at: createdAt, updated_at: createdAt, _dirty: true,
    } as never)
    const payload = {
      id: 'quick-1', content: 'hello', mood: 'normal', tags: [], pinned: false,
      archived_at: null, archive_file_path: null, folder_id: null,
      trashed_at: null, migrated_to_note_id: null,
      created_at: createdAt, updated_at: createdAt,
    }
    await db.outbox.add({
      id: 1, spaceId, entityType: 'quickNote', entityId: 'quick-1', action: 'create',
      payload: JSON.stringify(payload), payloadHash: await hashCommandPayload(payload),
      operationId: 'op-qn', compoundOperationId: null, compoundOrder: null,
      expectedVersion: null, requiresVersionRebase: false, transportState: 'ready', createdAt,
      synced: false, lastError: null, lastErrorCode: null, failedAt: null,
      attemptCount: 0, ...INITIAL_S4_OUTBOX_FIELDS,
    })
    await withSpaceAuthorityFence(spaceId, async (token) => {
      const selected = await selectOneAuthorityUnit(db)
      expect(selected).not.toBeNull()
      await applyTerminalResultTwoPhase(db, meta, spaceId, token, selected!, {
        batch_id: selected!.authority.batchId,
        applied: [{ operation_id: 'op-qn', entity_type: 'quick_note', entity_id: 'quick-1', version: 1, resolution: null }],
        conflicts: [],
        errors: [],
      }, 'push_response')
    })
    expect(await db.outbox.get(1)).toBeUndefined()
    expect((await db.quickNotes.get('quick-1'))?._dirty).toBe(false)
    expect(await db.syncPushBatches.count()).toBe(0)
  })

  it('reconciles a space-committed compound terminal after a crash', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: new FakeLockManager() })
    const spaceId = `terminal-${crypto.randomUUID()}`
    const db = await openPomodoroXIDB(spaceId)
    const meta = new MetaDB(`terminal-meta-${crypto.randomUUID()}`)
    await meta.open()
    databases.push(db, meta)
    const rootSha = 'a'.repeat(64)
    const evidenceId = 'b'.repeat(64)
    const resultSha = 'c'.repeat(64)
    const operationIdsSha = 'd'.repeat(64)
    const operation = await buildProvisionalOperationRow({
      operationId: 'compound-root', spaceId, sessionId: 'session-1',
      deviceId: 'device-1', tabId: 'tab-1', level2WorkItemId: 'l2',
      level3WorkItemIds: [], plannedSeconds: 60,
      startedAt: '2026-07-14T10:00:00.000Z', expectedWorkItemVersions: { l2: 1 },
    }, null)
    await meta.provisionalOperations.put({
      ...operation,
      state: 'transport_ready',
      transportReadyRootSha256: rootSha,
    })
    await db.syncTerminalApplications.put({
      evidenceId, spaceId, source: 'push_response', state: 'space_committed',
      authorityKind: 'compound', batchId: 'batch-1', compoundOperationId: 'compound-root',
      operationIds: ['op-1'], operationIdsSha256: operationIdsSha,
      readyRoots: [{ rootKind: 'compound', rootId: 'compound-root',
        orderedChildren: [], rootSha256: rootSha }],
      readyRootSetSha256: rootSha, resultCanonicalBase64: 'e30=', resultSha256: resultSha,
      appliedCount: 1, committedAt: '2026-07-14T10:00:00.000Z', metaReconciledAt: null,
    })

    await withSpaceAuthorityFence(spaceId, (token) =>
      reconcileSpaceCommittedTerminalEvidence(db, meta, spaceId, token))

    expect(await meta.provisionalOperations.get('compound-root')).toMatchObject({
      state: 'transport_resolved', terminalEvidenceId: evidenceId,
      terminalResultSha256: resultSha, terminalOperationIdsSha256: operationIdsSha,
    })
    expect(await db.syncTerminalApplications.get(evidenceId)).toMatchObject({
      state: 'meta_reconciled', metaReconciledAt: expect.any(String),
    })
  })
})
