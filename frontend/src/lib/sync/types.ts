/**
 * SyncEngine interface — F1 implementation, S0 stub (F0 §8.1).
 *
 * S0-3 only needs `destroy()` for logout. Full interface defined
 * for F1 to implement; stub is type-safe via Pick.
 */

/** SyncEngine 接口 — F1 实现 */
export interface SyncEngine {
  markDirty(
    entityType: string,
    entityId: string,
    op: 'create' | 'update' | 'delete',
  ): void
  sync(): Promise<void>
  getStatus(): 'idle' | 'syncing' | 'error' | 'conflict' | 'infra-error'
  getLastSyncedAt(): string | null
  getPendingCount(): number
  destroy(): void
}

/** S0 stub — destroy 为 no-op，F1 替换为真实实现 */
export const syncEngineStub: Pick<SyncEngine, 'destroy'> = {
  destroy() {},
}

// ===== S1-1 Sync 基础层类型 =====

/** 14 个 sync-enabled 实体类型（F1 §3.3 / 附录 C） */
export type SyncEntityType =
  | 'task' | 'session' | 'note' | 'folder' | 'quickNote'
  | 'reflection' | 'habit' | 'habitCheckIn' | 'schedule' | 'timeBlock'
  | 'memoComment' | 'sessionQuickNote' | 'scheduleQuickNote' | 'taskQuickNote'

/** outbox 动作（与 OutboxEvent.action 一致） */
export type OutboxAction = 'create' | 'update' | 'delete'

/** entityType(camelCase 单数) → Dexie 表名(plural) — drop_existing 删本地实体用 */
export const ENTITY_TYPE_TO_TABLE: Record<SyncEntityType, string> = {
  task: 'tasks',
  session: 'sessions',
  note: 'notes',
  folder: 'folders',
  quickNote: 'quickNotes',
  reflection: 'reflections',
  habit: 'habits',
  habitCheckIn: 'habitCheckIns',
  schedule: 'schedules',
  timeBlock: 'timeBlocks',
  memoComment: 'memoComments',
  sessionQuickNote: 'sessionQuickNotes',
  scheduleQuickNote: 'scheduleQuickNotes',
  taskQuickNote: 'taskQuickNotes',
}

/** pull_key(plural) → Dexie 表名(plural) — 14 组全等映射（供 S1-2 merge 使用） */
export const PULL_KEY_TO_TABLE: Record<string, string> = {
  tasks: 'tasks',
  sessions: 'sessions',
  notes: 'notes',
  folders: 'folders',
  quickNotes: 'quickNotes',
  reflections: 'reflections',
  habits: 'habits',
  habitCheckIns: 'habitCheckIns',
  schedules: 'schedules',
  timeBlocks: 'timeBlocks',
  memoComments: 'memoComments',
  sessionQuickNotes: 'sessionQuickNotes',
  scheduleQuickNotes: 'scheduleQuickNotes',
  taskQuickNotes: 'taskQuickNotes',
}

/** syncMeta 键名（F1 §2.1，F1-D2 锁定） — 值为 Dexie syncMeta 表的 key */
export const SYNC_META_KEYS = {
  SINCE: 'since',
  SINCE_ID: 'since_id',
  TOMBSTONE_SINCE_ID: 'tombstone_since_id',
  SERVER_TIME: 'server_time',
  LAST_FULL_SYNC: 'last_full_sync',
  LAST_SYNC_AT: 'last_sync_at',
} as const

/** syncMeta 快照（camelCase 字段名，与 SYNC_META_KEYS 的 snake_case 值有映射关系） */
export interface SyncMetaSnapshot {
  since: string
  sinceId: string
  tombstoneSinceId: string
  serverTime: string
  lastFullSync: string
  lastSyncAt: string
}

/** outbox merge 矩阵动作 */
export type OutboxMergeAction = 'drop_existing' | 'keep_existing' | 'replace'

/** outbox merge 矩阵结果 */
export interface OutboxMergeResult {
  action: OutboxMergeAction
  /** replace 时可能改写目标行 action（如 delete→create 改为 update） */
  newAction?: OutboxAction
}
