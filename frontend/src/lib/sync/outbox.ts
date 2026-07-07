/**
 * Outbox 入队 + merge 矩阵（F1 §3.1 + F1-D6 + F1-D12）。
 *
 * enqueueOutbox 设计为在 db.transaction('rw', db.<entity>, db.outbox, ...) 内调用，
 * 确保实体写入与 outbox 入队在同一事务内（F1-D12 方案 A）。
 *
 * 所有函数首参 db: PomodoroXIDB（HC-6 per-space db 注入）。
 */

import type { PomodoroXIDB } from '@/services/database'
import type { OutboxEvent } from '@/types'
import {
  ENTITY_TYPE_TO_TABLE,
  type OutboxAction,
  type OutboxMergeResult,
  type SyncEntityType,
} from './types'

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
  entityType: SyncEntityType,
  entityId: string,
  action: OutboxAction,
  payload: unknown,
): Promise<void> {
  // 运行时校验 entityType（编译期 SyncEntityType 已收口，此处额外防御）
  if (!(entityType in ENTITY_TYPE_TO_TABLE)) {
    throw new Error(`Invalid sync entity type: ${entityType}`)
  }
  // entityId 空串守卫
  if (!entityId || !entityId.trim()) {
    throw new Error('entityId must not be empty')
  }
  // payload undefined 守卫（JSON.stringify(undefined) 返回 undefined 非 string）
  if (payload === undefined) {
    throw new Error('payload must not be undefined')
  }

  const payloadStr = JSON.stringify(payload)
  const now = Date.now()

  // 查找同实体的未同步行（entityId 字符串索引 + and 过滤 synced）
  const existing = await db.outbox
    .where('entityId')
    .equals(entityId)
    .and((e) => e.entityType === entityType && !e.synced)
    .toArray()

  if (existing.length > 0) {
    const latest = existing.reduce((a, b) =>
      a.createdAt > b.createdAt ? a : b,
    )
    const merge = resolveOutboxMerge(latest.action, action)

    if (merge.action === 'drop_existing') {
      // 删 outbox 行 + 尝试删 Dexie 实体表对应行
      await db.outbox.bulkDelete(existing.map((e) => e.id!))
      const tableName = ENTITY_TYPE_TO_TABLE[entityType]
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

    if (merge.action === 'keep_existing') return

    // replace：合并到 latest 行
    latest.payload = payloadStr
    latest.createdAt = now
    if (merge.newAction) latest.action = merge.newAction
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
    entityType,
    entityId,
    action,
    payload: payloadStr,
    createdAt: now,
    synced: false,
  })
}

/** 未同步 outbox 行数 — 用 filter 避免 boolean 索引查询（DataError） */
export async function countUnsyncedOutbox(db: PomodoroXIDB): Promise<number> {
  return db.outbox.filter((e) => !e.synced).count()
}

/** 未同步 outbox 行列表（按 createdAt 升序，供 S1-2 push-batch 使用，F1 §5.1） */
export async function listUnsyncedOutbox(db: PomodoroXIDB): Promise<OutboxEvent[]> {
  return db.outbox.filter((e) => !e.synced).sortBy('createdAt')
}

/** 按主键列表批量删除 outbox 行（push 成功后清行用） */
export async function deleteOutboxByIds(
  db: PomodoroXIDB,
  ids: number[],
): Promise<void> {
  if (ids.length > 0) await db.outbox.bulkDelete(ids)
}
