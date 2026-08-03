/**
 * Push 批处理与冲突响应（F1 §5.1–§5.4）。
 *
 * - buildPushEvents：outbox 行 → API SyncEvent（entityType→entity_type，createdAt→client_updated_at）
 * - handlePushResponse：applied/conflicts auto-clear outbox；errors 通用不清（重试），
 *   version_mismatch/content_hash_mismatch 进 conflicts（需用户裁决）
 * - pushAllPending：循环分批 100，遇需用户裁决冲突停止
 *
 * F1-D11: applied/conflicts 全 auto-clear；errors(version_mismatch)/pre-push dirty 进面板。
 */

import type { AxiosInstance } from 'axios'
import type { PomodoroXIDB } from '@/services/database'
import type { OutboxEvent } from '@/types'
import { listUnsyncedOutbox, deleteOutboxByIds, markOutboxEventsFailed } from './outbox'
import { buildBatchIdempotencyKey } from '@/services/idempotency'
import {
  ENTITY_TYPE_TO_TABLE,
  type ApiSyncEvent,
  type ApiSyncPushResponse,
  type HandlePushResult,
  type SyncConflict,
} from './types'

export const DEFAULT_PUSH_BATCH_SIZE = 100

/** outbox 行 → API SyncEvent（F1 §5.1，DR-1 createdAt(number) → client_updated_at ISO） */
export function buildPushEvents(rows: OutboxEvent[]): ApiSyncEvent[] {
  return rows.map((e) => ({
    entity_type: e.entityType,
    entity_id: e.entityId,
    action: e.action,
    payload: JSON.parse(e.payload) as { [key: string]: unknown },
    // createdAt is already a canonical UTC RFC3339 caller-intent timestamp;
    // preserve its exact bytes instead of normalizing away an optional .000.
    client_updated_at: e.createdAt,
  }))
}

/** 处理 push 响应（F1 §5.2c：清 outbox + 填充 conflicts + tombstone 标记） */
async function handlePushResponse(
  db: PomodoroXIDB,
  response: ApiSyncPushResponse,
  batch: OutboxEvent[],
): Promise<HandlePushResult> {
  const clearIds: number[] = []
  const conflicts: SyncConflict[] = []
  const failedOutboxEvents: Parameters<typeof markOutboxEventsFailed>[1] = []
  let remoteWinCount = 0
  let circularRefCount = 0
  let retriableErrorCount = 0

  // 1. applied → 清 outbox（无 resolution / resolution='remote' 均 auto-clear）
  for (const item of response.applied) {
    const outboxRow = batch.find(
      (b) => b.entityType === item.entity_type && b.entityId === item.entity_id,
    )
    if (outboxRow && outboxRow.id != null) {
      clearIds.push(outboxRow.id)
    }
    if (item.resolution === 'remote') remoteWinCount++
  }

  // 2. conflicts → auto-clear outbox（local/tombstone/circular_ref）
  for (const item of response.conflicts) {
    const outboxRow = batch.find(
      (b) => b.entityType === item.entity_type && b.entityId === item.entity_id,
    )
    if (outboxRow && outboxRow.id != null) {
      clearIds.push(outboxRow.id)
    }

    // tombstone → 本地标记 deletion_state='deleted'
    if (item.resolution === 'tombstone') {
      const tableName =
        ENTITY_TYPE_TO_TABLE[item.entity_type as keyof typeof ENTITY_TYPE_TO_TABLE]
      if (tableName) {
        const table = (
          db as unknown as Record<
            string,
            { update: (id: string, changes: Record<string, unknown>) => Promise<unknown> }
          >
        )[tableName]
        if (table) {
          try {
            await table.update(item.entity_id, { deletion_state: 'deleted', _dirty: false })
          } catch {
            /* already gone */
          }
        }
      }
    }
    if (item.resolution === 'circular_ref') circularRefCount++
    // resolution === 'local' → no-op（本地已最新）
  }

  // 3. errors → 不清 outbox；检查需用户裁决（version_mismatch / content_hash_mismatch）
  for (const item of response.errors) {
    const outboxRow = batch.find(
      (b) => b.entityType === item.entity_type && b.entityId === item.entity_id,
    )
    if (outboxRow?.id != null) {
      failedOutboxEvents.push({
        outboxId: outboxRow.id,
        error: item.error,
      })
    }

    if (
      item.error.includes('version_mismatch') ||
      item.error.includes('content_hash_mismatch')
    ) {
      conflicts.push({
        outboxId: outboxRow && outboxRow.id != null ? outboxRow.id : -1,
        entityType: item.entity_type,
        entityId: item.entity_id,
        localVersion: null,
        remoteVersion: null,
        conflictType: 'version',
      })
    } else {
      retriableErrorCount++
    }
  }

  // 4. 失败事件落库；清 outbox（applied + conflicts auto-clear）
  await markOutboxEventsFailed(db, failedOutboxEvents)
  await deleteOutboxByIds(db, clearIds)

  return {
    clearedOutboxIds: clearIds,
    conflicts,
    remoteWinCount,
    circularRefCount,
    retriableErrorCount,
  }
}

/** 推送一批 outbox 事件并处理响应 */
export async function pushBatch(
  db: PomodoroXIDB,
  api: AxiosInstance,
  rows: OutboxEvent[],
): Promise<HandlePushResult> {
  if (rows.length === 0) {
    return {
      clearedOutboxIds: [],
      conflicts: [],
      remoteWinCount: 0,
      circularRefCount: 0,
      retriableErrorCount: 0,
    }
  }
  // S3-Task10: filter out rows that require version rebase - they must not enter push
  const pushable = rows.filter((row) => !row.requiresVersionRebase)
  if (pushable.length === 0) {
    return {
      clearedOutboxIds: [],
      conflicts: [],
      remoteWinCount: 0,
      circularRefCount: 0,
      retriableErrorCount: 0,
    }
  }
  const events = buildPushEvents(pushable)
  const idempotencyKey = await buildBatchIdempotencyKey(pushable)
  const res = await api.post<ApiSyncPushResponse>('/sync/push', { events }, {
    headers: { 'Idempotency-Key': idempotencyKey },
  })
  return handlePushResponse(db, res.data, pushable)
}

/** 循环推送直至 outbox 空或遇需用户裁决冲突（F1 §5.4 分批 100） */
export async function pushAllPending(
  db: PomodoroXIDB,
  api: AxiosInstance,
  batchSize?: number,
): Promise<HandlePushResult> {
  const size = batchSize ?? DEFAULT_PUSH_BATCH_SIZE
  const aggregated: HandlePushResult = {
    clearedOutboxIds: [],
    conflicts: [],
    remoteWinCount: 0,
    circularRefCount: 0,
    retriableErrorCount: 0,
  }

  while (true) {
    const pending = await listUnsyncedOutbox(db)
    if (pending.length === 0) break

    // S3-Task10: filter out rows that require version rebase - they must not enter push
    const pushable = pending.filter((row) => !row.requiresVersionRebase)
    if (pushable.length === 0) break

    const batch = pushable.slice(0, size)
    const result = await pushBatch(db, api, batch)

    aggregated.clearedOutboxIds.push(...result.clearedOutboxIds)
    aggregated.conflicts.push(...result.conflicts)
    aggregated.remoteWinCount += result.remoteWinCount
    aggregated.circularRefCount += result.circularRefCount
    aggregated.retriableErrorCount += result.retriableErrorCount

    // 有需用户裁决冲突 → 停止推送（不应继续推送待裁决 outbox）
    if (result.conflicts.length > 0) break
    // S3-Task10: 本轮无进展（未清除任何 outbox 行，或存在可重试错误）→ 立即停止，避免无限循环
    if (result.clearedOutboxIds.length === 0 || result.retriableErrorCount > 0) break
    // batch 未满 → outbox 已空，无需再拉
    if (batch.length < size) break
  }

  return aggregated
}
