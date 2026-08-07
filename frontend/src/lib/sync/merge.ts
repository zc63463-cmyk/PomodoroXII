import type { PomodoroXIDB } from '@/services/database'
import type { SpaceAuthorityToken } from './space-authority-fence'
import { FINAL_SYNC_ENTITY_TO_TABLE, type ApiSyncV2EventRecord, type SyncConflict } from './types'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
} from './space-authority-fence'

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

export async function applySyncEventRecord(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  record: ApiSyncV2EventRecord,
  dirtyConflicts: SyncConflict[],
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const tableName = FINAL_SYNC_ENTITY_TO_TABLE[record.entity_type as keyof typeof FINAL_SYNC_ENTITY_TO_TABLE]
  if (!tableName) throw new Error(`unknown sync v2 entity type ${record.entity_type}`)
  const table = (db as unknown as Record<string, {
    get: (key: string) => Promise<Record<string, unknown> | undefined>
    put: (row: Record<string, unknown>) => Promise<unknown>
    delete: (key: string) => Promise<unknown>
  }>)[tableName]
  if (!table) throw new Error(`sync v2 table is unavailable ${tableName}`)
  const local = await table.get(record.entity_id)
  const protectedByOutbox = await db.outbox
    .where('entityId').equals(record.entity_id)
    .and((row) => row.spaceId === spaceId && row.entityType === record.entity_type && !row.synced)
    .count() > 0
  const dirty = local?._dirty === true ||
    (record.entity_type === 'workItemNote' && local?.syncState !== 'clean')
  if (dirty || protectedByOutbox) {
    if (local) dirtyConflicts.push(buildPrePushConflict(local, record.payload, record.entity_type))
    return
  }
  if (record.action === 'delete') {
    await table.delete(record.entity_id)
    return
  }
  await table.put({
    ...record.payload,
    id: (record.payload.id as string | undefined) ?? record.entity_id,
    version: record.version,
    updated_at: record.created_at,
    _dirty: false,
    ...(record.entity_type === 'workItemNote' ? { syncState: 'clean', localRevision: 0 } : {}),
  })
}
