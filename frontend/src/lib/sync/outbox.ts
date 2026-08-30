/**
 * Outbox 入队 + merge 矩阵（F1 §3.1 + F1-D6 + F1-D12）。
 *
 * enqueueOutbox 设计为在 db.transaction('rw', db.<entity>, db.outbox, ...) 内调用，
 * 确保实体写入与 outbox 入队在同一事务内（F1-D12 方案 A）。
 *
 * 所有函数首参 db: PomodoroXIDB（HC-6 per-space db 注入）。
 */

import Dexie from 'dexie'
import { INITIAL_S4_OUTBOX_FIELDS, type PomodoroXIDB } from '@/services/database'
import type { CachedSessionWorkItemPlan, OutboxEvent } from '@/types'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import {
  ENTITY_TYPE_TO_TABLE,
  FINAL_SYNC_ENTITY_TO_TABLE,
  TS3_LOCAL_ENTITY_TO_TABLE,
  type TS3LocalEntityType,
  type OutboxAction,
  type OutboxMergeResult,
  type SyncEntityType,
} from './types'
import { syncEngine } from './index'

export interface OutboxIdentity {
  operationId: string
  payloadHash: string
  /** Optional canonical command-hash projection when storage payload is a post-image. */
  hashPayload?: unknown
  expectedVersion: number | null
  transportState: 'ready' | 'awaiting_s4' | 'blocked_conflict'
  createdAt: string
  compoundOperationId?: string | null
  compoundOrder?: number | null
  preserveExisting?: boolean
}

export async function buildOutboxIdentity(
  payload: unknown,
  input: Omit<OutboxIdentity, 'payloadHash'>,
): Promise<OutboxIdentity> {
  // Keep a caller-owned Dexie transaction alive while WebCrypto resolves.
  return {
    ...input,
    payloadHash: await Dexie.waitFor(hashCommandPayload(input.hashPayload ?? payload)),
  }
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

export function prepareHeldProvisionalBatch(rows: OutboxEvent[]): PreparedEntityBatch {
  if (rows.length < 3) throw new Error('provisional_compound_batch_incomplete')
  const spaceId = rows[0]!.spaceId
  const compoundOperationId = rows[0]!.compoundOperationId
  if (!compoundOperationId || rows.some((row) =>
    row.spaceId !== spaceId || row.compoundOperationId !== compoundOperationId ||
    row.compoundOrder === null || row.action !== 'create' ||
    row.expectedVersion !== null)) {
    throw new Error('provisional_compound_identity_mismatch')
  }
  const ordered = [...rows].sort((left, right) =>
    left.compoundOrder! - right.compoundOrder!)
  if (ordered.some((row, index) => row.compoundOrder !== index) ||
      new Set(ordered.map((row) => row.operationId)).size !== ordered.length) {
    throw new Error('provisional_compound_order_or_operation_id_invalid')
  }
  const expectedPrefix = [
    'focusSession', 'sessionTaskContext', 'sessionAttributionRevision',
  ]
  if (expectedPrefix.some((entityType, index) => ordered[index]?.entityType !== entityType) ||
      ordered.slice(3).some((row) => row.entityType !== 'sessionWorkItemPlan')) {
    throw new Error('provisional_compound_parent_before_child_order_invalid')
  }
  const planRanks = ordered.slice(3).map((row) =>
    (JSON.parse(row.payload) as CachedSessionWorkItemPlan).planRank)
  if (planRanks.some((rank, index) => index > 0 && rank < planRanks[index - 1]!)) {
    throw new Error('provisional_plan_rank_order_invalid')
  }
  return {
    batchId: compoundOperationId,
    items: ordered.map((row, requestIndex) => ({
      requestIndex,
      operationId: row.operationId,
      entityType: row.entityType as SyncEntityType,
      entityId: row.entityId,
      action: row.action,
      expectedVersion: null,
      payload: JSON.parse(row.payload),
      payloadHash: row.payloadHash,
    })),
  }
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
  token: SpaceAuthorityToken,
  entityType: SyncEntityType | TS3LocalEntityType,
  entityId: string,
  action: OutboxAction,
  payload: unknown,
  identity: OutboxIdentity,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  if (!spaceId) throw new Error('spaceId is required')
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
  const computedPayloadHash = await Dexie.waitFor(
    hashCommandPayload(identity.hashPayload ?? payload),
  )
  if (computedPayloadHash !== identity.payloadHash) {
    throw new Error('payloadHash_mismatch')
  }

  const existing = await db.outbox
    .where('spaceId').equals(spaceId)
    .and((e) => e.entityType === entityType && e.entityId === entityId && !e.synced)
    .toArray()

  // An attempted command is immutable. A newer local edit gets its own row;
  // the in-flight row is removed only after its response is acknowledged.
  const mergeable = identity.preserveExisting
    ? []
    : existing.filter((row) => row.attemptCount === 0)
  if (mergeable.length > 0) {
    const latest = mergeable.reduce((a, b) =>
      a.createdAt > b.createdAt ? a : b,
    )
    const merge = resolveOutboxMerge(latest.action, action)

    if (merge.action === 'drop_existing') {
      // 删 outbox 行 + 尝试删 Dexie 实体表对应行
      await db.outbox.bulkDelete(mergeable.map((e) => e.id!))
      const tableName = FINAL_SYNC_ENTITY_TO_TABLE[entityType]
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
      syncEngine.markDirty(entityType, entityId, action)
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
    const olderIds = mergeable
      .filter((e) => e.id !== latest.id)
      .map((e) => e.id!)
    if (olderIds.length > 0) await db.outbox.bulkDelete(olderIds)
    syncEngine.markDirty(entityType, entityId, action)
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
    ...INITIAL_S4_OUTBOX_FIELDS,
  })
  syncEngine.markDirty(entityType, entityId, action)
}

/** 未同步 outbox 行数 — 用 filter 避免 boolean 索引查询（DataError） */
export async function countUnsyncedOutbox(db: PomodoroXIDB): Promise<number> {
  return db.outbox.filter((e) => !e.synced && e.transportState === 'ready').count()
}

function clearOutboxFailure(row: OutboxEvent): void {
  row.lastError = null
  row.lastErrorCode = null
  row.failedAt = null
  row.attemptCount = 0
}
