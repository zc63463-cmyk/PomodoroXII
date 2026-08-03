/**
 * Outbox 入队 + merge 矩阵（F1 §3.1 + F1-D6 + F1-D12）。
 *
 * enqueueOutbox 设计为在 db.transaction('rw', db.<entity>, db.outbox, ...) 内调用，
 * 确保实体写入与 outbox 入队在同一事务内（F1-D12 方案 A）。
 *
 * 所有函数首参 db: PomodoroXIDB（HC-6 per-space db 注入）。
 */

import Dexie from 'dexie'
import type { PomodoroXIDB } from '@/services/database'
import type { OutboxEvent } from '@/types'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import {
  ENTITY_TYPE_TO_TABLE,
  TS3_LOCAL_ENTITY_TO_TABLE,
  type TS3LocalEntityType,
  type OutboxAction,
  type OutboxMergeResult,
  type SyncEntityType,
} from './types'

export interface OutboxFailurePatch {
  outboxId: number
  error: string
  errorCode?: string | null
  failedAt?: string
}

export interface OutboxIdentity {
  operationId: string
  payloadHash: string
  expectedVersion: number | null
  transportState: 'ready' | 'awaiting_s4' | 'blocked_conflict'
  createdAt: string
  compoundOperationId?: string | null
  compoundOrder?: number | null
}

export async function buildOutboxIdentity(
  payload: unknown,
  input: Omit<OutboxIdentity, 'payloadHash'>,
): Promise<OutboxIdentity> {
  // Keep a caller-owned Dexie transaction alive while WebCrypto resolves.
  return { ...input, payloadHash: await Dexie.waitFor(hashCommandPayload(payload)) }
}

export interface PreparedEntityCommand {
  requestIndex: number
  operationId: string
  entityType: SyncEntityType | TS3LocalEntityType
  entityId: string
  action: OutboxAction
  expectedVersion: number | null
  payload: unknown
  payloadHash: string
}

export interface PreparedEntityBatch {
  batchId: string
  items: PreparedEntityCommand[]
}

const canonicalUtcRfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?Z$/

function requireCanonicalUtcRfc3339(value: string): void {
  if (!canonicalUtcRfc3339.test(value) || Number.isNaN(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new Error('createdAt must be canonical UTC RFC3339')
  }
}

/** Byte-identical child-v1 operation ID derivation shared with S3. */
export async function boundedChildOperationId(parentId: string, suffix: string): Promise<string> {
  if (!/^[\x21-\x7e]{1,128}$/.test(parentId)) {
    throw new Error('operation and batch IDs must use the exact 1-128-byte printable-ASCII validator')
  }
  if (!/^[A-Za-z0-9._:-]{1,512}$/.test(suffix)) {
    throw new Error('invalid child operation suffix')
  }
  const candidate = `childp:${new TextEncoder().encode(parentId).byteLength}:${parentId}:${suffix}`
  if (new TextEncoder().encode(candidate).byteLength <= 128) return candidate
  const parentBytes = new TextEncoder().encode(parentId)
  const suffixBytes = new TextEncoder().encode(suffix)
  const input = new Uint8Array(11 + parentBytes.byteLength + suffixBytes.byteLength)
  input.set(new TextEncoder().encode('child-v1\0'), 0)
  new DataView(input.buffer).setUint16(9, parentBytes.byteLength, false)
  input.set(parentBytes, 11)
  input.set(suffixBytes, 11 + parentBytes.byteLength)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input as unknown as BufferSource)
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `childh:${hex}`
}

/**
 * 纯函数：outbox merge 矩阵（F1 §3.1，与 Vue database.ts 一致）。
 *
 * 六分支：
 *   create+delete → drop_existing（删 outbox + 删本地实体）
 *   create+{create,update} → replace（合并到 latest 行）
 *   update+delete → replace(newAction=delete)
 *   update+{create,update} → replace
 *   delete+create → replace(newAction=update) [resurrect, F1 V9]
 *   delete+{update,delete} → keep_existing
 */
export function resolveOutboxMerge(
  existing: OutboxAction,
  incoming: OutboxAction,
): OutboxMergeResult {
  if (existing === 'create') {
    if (incoming === 'delete') return { action: 'drop_existing' }
    return { action: 'replace' }
  }
  if (existing === 'update') {
    if (incoming === 'delete') return { action: 'replace', newAction: 'delete' }
    return { action: 'replace' }
  }
  // existing === 'delete'
  if (incoming === 'create') return { action: 'replace', newAction: 'update' }
  return { action: 'keep_existing' }
}

/**
 * 向 outbox 入队（F1 §3.1 + F1-D12 方案 A）。
 *
 * 必须在 db.transaction('rw', db.<entity>, db.outbox, ...) 内调用。
 * 同 (entityType, entityId) 的未同步行合并到 createdAt 最大的一行。
 * entityType 必须是 14 sync-enabled 类型之一，否则 throw。
 *
 * payload 约束：必须可被 JSON.stringify 序列化（不可含 BigInt / 循环引用）。
 * payload 为 undefined 时抛错（F1-D6 要求 payload 为 string）。
 */
export async function enqueueOutbox(
  db: PomodoroXIDB,
  spaceId: string,
  entityType: SyncEntityType | TS3LocalEntityType,
  entityId: string,
  action: OutboxAction,
  payload: unknown,
  identity: OutboxIdentity,
): Promise<void> {
  if (!spaceId) throw new Error('spaceId is required')
  if (db.spaceId !== spaceId) throw new Error('outbox_space_database_mismatch')
  if (!(entityType in ENTITY_TYPE_TO_TABLE) && !(entityType in TS3_LOCAL_ENTITY_TO_TABLE)) {
    throw new Error(`Invalid sync entity type: ${entityType}`)
  }
  if (!entityId || !entityId.trim()) {
    throw new Error('entityId must not be empty')
  }
  if (payload === undefined) {
    throw new Error('payload must not be undefined')
  }
  if (!identity.operationId) throw new Error('operationId is required')
  if (action === 'create' && identity.expectedVersion !== null) {
    throw new Error('create expectedVersion must be null')
  }
  if (
    action !== 'create'
    && (identity.expectedVersion === null
      || !Number.isInteger(identity.expectedVersion)
      || identity.expectedVersion < 0)
  ) {
    throw new Error('requires a non-negative integer expectedVersion')
  }
  requireCanonicalUtcRfc3339(identity.createdAt)
  const compoundOperationId = identity.compoundOperationId ?? null
  const compoundOrder = identity.compoundOrder ?? null
  if ((compoundOperationId === null) !== (compoundOrder === null) ||
      (compoundOrder !== null && (!Number.isInteger(compoundOrder) || compoundOrder < 0))) {
    throw new Error('compound identity must be null or a nonnegative ordered pair')
  }
  const payloadStr = JSON.stringify(payload)
  if (payloadStr === undefined) throw new Error('payload must be JSON serializable')
  // Validate the caller-provided identity against the exact payload while
  // keeping the surrounding Dexie transaction alive across WebCrypto.
  const computedPayloadHash = await Dexie.waitFor(hashCommandPayload(payload))
  if (computedPayloadHash !== identity.payloadHash) {
    throw new Error('payloadHash_mismatch')
  }

  const existing = await db.outbox
    .where('spaceId').equals(spaceId)
    .and((e) => e.entityType === entityType && e.entityId === entityId && !e.synced)
    .toArray()

  if (existing.length > 0) {
    const latest = existing.reduce((a, b) =>
      a.createdAt > b.createdAt ? a : b,
    )
    const merge = resolveOutboxMerge(latest.action, action)

    if (merge.action === 'drop_existing') {
      // 删 outbox 行 + 尝试删 Dexie 实体表对应行
      await db.outbox.bulkDelete(existing.map((e) => e.id!))
      const tableName = entityType in ENTITY_TYPE_TO_TABLE
        ? ENTITY_TYPE_TO_TABLE[entityType as SyncEntityType]
        : TS3_LOCAL_ENTITY_TO_TABLE[entityType as TS3LocalEntityType]
      const table = (
        db as unknown as Record<
          string,
          { delete: (id: string) => Promise<unknown> }
        >
      )[tableName]
      if (table) {
        try {
          await table.delete(entityId)
        } catch {
          // 表不存在或行不存在 → no-op
        }
      }
      return
    }

    if (merge.action === 'keep_existing') {
      latest.createdAt = identity.createdAt
      clearOutboxFailure(latest)
      if (latest.attemptCount > 0) throw new Error('outbox_command_immutable_after_attempt')
      latest.payload = payloadStr
      latest.payloadHash = identity.payloadHash
      latest.transportState = identity.transportState
      latest.compoundOperationId = compoundOperationId
      latest.compoundOrder = compoundOrder
      await db.outbox.put(latest)
      return
    }

    // replace：合并到 latest 行
    latest.payload = payloadStr
    if (latest.attemptCount > 0) throw new Error('outbox_command_immutable_after_attempt')
    latest.createdAt = identity.createdAt
    latest.payloadHash = identity.payloadHash
    latest.transportState = identity.transportState
    latest.compoundOperationId = compoundOperationId
    latest.compoundOrder = compoundOrder
    clearOutboxFailure(latest)
    if (merge.newAction) latest.action = merge.newAction
    if (latest.action === 'create') {
      latest.expectedVersion = null
      latest.requiresVersionRebase = false
    } else {
      latest.expectedVersion = identity.expectedVersion
      latest.requiresVersionRebase = false
    }
    await db.outbox.put(latest)

    // 删除其余重复行
    const olderIds = existing
      .filter((e) => e.id !== latest.id)
      .map((e) => e.id!)
    if (olderIds.length > 0) await db.outbox.bulkDelete(olderIds)
    return
  }

  // 无已有行 → 直接 add
  await db.outbox.add({
    spaceId,
    entityType,
    entityId,
    action,
    payload: payloadStr,
    payloadHash: identity.payloadHash,
    compoundOperationId,
    compoundOrder,
    createdAt: identity.createdAt,
    synced: false,
    lastError: null,
    lastErrorCode: null,
    failedAt: null,
    attemptCount: 0,
    operationId: identity.operationId,
    expectedVersion: identity.expectedVersion,
    requiresVersionRebase: false,
    transportState: identity.transportState,
  })
}

/** 未同步 outbox 行数 — 用 filter 避免 boolean 索引查询（DataError） */
export async function countUnsyncedOutbox(db: PomodoroXIDB): Promise<number> {
  return db.outbox.filter((e) => !e.synced && e.transportState === 'ready').count()
}

/** 未同步 outbox 行列表（按 createdAt 升序，供 S1-2 push-batch 使用，F1 §5.1） */
export async function listUnsyncedOutbox(db: PomodoroXIDB): Promise<OutboxEvent[]> {
  return db.outbox.filter((e) => !e.synced && e.transportState === 'ready').sortBy('createdAt')
}

/** 按主键列表批量删除 outbox 行（push 成功后清行用） */
export async function deleteOutboxByIds(
  db: PomodoroXIDB,
  ids: number[],
): Promise<void> {
  if (ids.length > 0) await db.outbox.bulkDelete(ids)
}

/** Persist per-event push failure metadata without clearing the outbox row. */
export async function markOutboxEventsFailed(
  db: PomodoroXIDB,
  failures: OutboxFailurePatch[],
): Promise<void> {
  if (failures.length === 0) return

  const failedAtFallback = new Date().toISOString()
  await db.transaction('rw', db.outbox, async () => {
    for (const failure of failures) {
      const row = await db.outbox.get(failure.outboxId)
      if (!row || row.synced) continue

      await db.outbox.update(failure.outboxId, {
        lastError: failure.error,
        lastErrorCode: failure.errorCode ?? classifyOutboxError(failure.error),
        failedAt: failure.failedAt ?? failedAtFallback,
        attemptCount: (row.attemptCount ?? 0) + 1,
      })
    }
  })
}

function clearOutboxFailure(row: OutboxEvent): void {
  row.lastError = null
  row.lastErrorCode = null
  row.failedAt = null
  row.attemptCount = 0
}

function classifyOutboxError(error: string): string {
  if (error.includes('version_mismatch')) return 'version_mismatch'
  if (error.includes('content_hash_mismatch')) return 'content_hash_mismatch'
  return 'push_error'
}
