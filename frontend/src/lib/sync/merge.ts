/**
 * Pull 合并矩阵（F1 §4.1 + §4.1b + §4.2，DR-2 _dirty 守卫）。
 *
 * applyMerge 将一页 pull 响应的 14 实体组 + tombstones 合并到 Dexie：
 * - 遍历 Object.entries(ENTITY_TYPE_TO_TABLE) 得 (entityType 单数, tableName 复数)
 * - 远端行写入时 _dirty=false（已同步）；version/content_hash 用远端值
 * - _dirty 守卫：本地 dirty=true 时无论远端新旧都不覆盖；仅 remoteTs>localTs 进 dirtyConflicts
 * - tombstone：update(id,{deletion_state:'deleted',_dirty:false})，不物理删
 */

import type { PomodoroXIDB } from '@/services/database'
import { normalizeTs } from './normalize-ts'
import { ENTITY_TYPE_TO_TABLE, type ApiSyncPullResponse, type SyncConflict } from './types'

/** 构建 pre-push dirty 冲突（F1 §4.1b，outboxId = -1 表示尚未 push） */
export function buildPrePushConflict(
  localRow: Record<string, unknown>,
  remoteRow: Record<string, unknown>,
  entityType: string,
): SyncConflict {
  return {
    outboxId: -1,
    entityType,
    entityId: String(remoteRow.id ?? ''),
    localVersion: localRow,
    remoteVersion: remoteRow,
    conflictType: 'version',
  }
}

/** 将一页 pull 响应 merge 到 Dexie（F1 §4.1 + DR-2） */
export async function applyMerge(
  db: PomodoroXIDB,
  response: ApiSyncPullResponse,
  dirtyConflicts: SyncConflict[],
): Promise<void> {
  // 1. 遍历 14 实体组（单数 entityType → 复数 tableName；pull_key === tableName）
  for (const [entityType, tableName] of Object.entries(ENTITY_TYPE_TO_TABLE)) {
    const rows = response[tableName] as Array<Record<string, unknown>> | undefined
    if (!rows || rows.length === 0) continue

    const table = (
      db as unknown as Record<
        string,
        {
          get: (id: string) => Promise<Record<string, unknown> | undefined>
          put: (row: Record<string, unknown>) => Promise<unknown>
        }
      >
    )[tableName]
    if (!table) continue

    for (const remoteRow of rows) {
      const localRow = await table.get(String(remoteRow.id))
      if (localRow) {
        const remoteTs = normalizeTs(remoteRow.updated_at as string)
        const localTs = normalizeTs(localRow.updated_at as string)

        // DR-2: _dirty 守卫 — 本地有未同步编辑
        if (localRow._dirty === true) {
          if (remoteTs > localTs) {
            dirtyConflicts.push(buildPrePushConflict(localRow, remoteRow, entityType))
          }
          // 无论远端是否更新，本地 dirty 时都不覆盖
          continue
        }

        // LWW: 远端 updated_at > 本地 → 覆盖；<= → 跳过（本地较新或相同）
        if (remoteTs <= localTs) continue
      }

      // 覆盖 / 新增：写入远端行 + _dirty=false（保留远端 version/content_hash/id/created_at）
      await table.put({ ...remoteRow, _dirty: false })
    }
  }

  // 2. 应用 tombstones（顺序依赖后端 deleted_at 升序；不物理删）
  const tombstones = response.tombstones ?? []
  for (const tomb of tombstones) {
    const tombEntityType = String(tomb.entity_type)
    const tableName =
      ENTITY_TYPE_TO_TABLE[tombEntityType as keyof typeof ENTITY_TYPE_TO_TABLE]
    if (!tableName) continue
    const table = (
      db as unknown as Record<
        string,
        {
          get: (id: string) => Promise<Record<string, unknown> | undefined>
          update: (id: string, changes: Record<string, unknown>) => Promise<unknown>
        }
      >
    )[tableName]
    if (!table) continue
    const entityId = String(tomb.entity_id)
    const localRow = await table.get(entityId)
    if (!localRow) continue
    const pendingOutbox = await db.outbox
      .where('entityId')
      .equals(entityId)
      .and((event) => event.entityType === tombEntityType && !event.synced)
      .first()
    if (localRow._dirty === true || pendingOutbox) {
      dirtyConflicts.push(buildPrePushConflict(
        localRow,
        {
          ...localRow,
          id: entityId,
          deletion_state: 'deleted',
          updated_at: tomb.deleted_at,
          _dirty: false,
        },
        tombEntityType,
      ))
      continue
    }
    await table.update(entityId, {
      deletion_state: 'deleted',
      _dirty: false,
    })
  }
}
