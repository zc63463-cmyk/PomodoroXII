/**
 * SyncEngine interface — F0 §8.1 全 12 方法（S1-3 扩充）。
 *
 * S1-3：RealSyncEngine 实现全接口；syncEngineStub 扩为全 no-op
 * （S1-4 前 logout/on-space-switch 仍 import 它，仅调 destroy）。
 */

/** outbox 动作类型（与 OutboxEvent.action 一致） */
export type SyncOp = 'create' | 'update' | 'delete'

/** SyncEngine 状态（F0 §8.1 / DR-8） */
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict' | 'infra-error'

/** SyncEngine 接口 — F0 §8.1 全 12 方法 */
export interface SyncEngine {
  markDirty(entityType: string, entityId: string, op: SyncOp): void
  sync(): Promise<void>
  getStatus(): SyncStatus
  getLastSyncedAt(): string | null
  getPendingCount(): number
  getConflicts(): SyncConflict[]
  resolveConflict(
    outboxId: number,
    resolution: 'accept-remote' | 'keep-local',
    target?: { entityType: string; entityId: string },
  ): Promise<void>
  fullSync(): Promise<void>
  destroy(): void
  onPullComplete?(cb: () => void): () => void
  onPushComplete?(cb: () => void): () => void
  onConflict?(cb: (conflicts: SyncConflict[]) => void): () => void
  /** S1-4.1：sync 周期终态（success | error | conflict），每周期恰好 1 次 */
  onSyncComplete?(cb: () => void): () => void
}

/** S1-4 前 no-op stub（logout/on-space-switch 仅调 destroy） */
export const syncEngineStub: SyncEngine = {
  markDirty() {},
  async sync() {},
  getStatus() {
    return 'idle'
  },
  getLastSyncedAt() {
    return null
  },
  getPendingCount() {
    return 0
  },
  getConflicts() {
    return []
  },
  async resolveConflict() {},
  async fullSync() {},
  destroy() {},
  onPullComplete() {
    return () => {}
  },
  onPushComplete() {
    return () => {}
  },
  onConflict() {
    return () => {}
  },
  onSyncComplete() {
    return () => {}
  },
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

/** syncMeta 键名（F1 §2.1，F1-D2 锁定，H2-D 新增 cursor/cursor_version） — 值为 Dexie syncMeta 表的 key */
export const SYNC_META_KEYS = {
  SINCE: 'since',
  SINCE_ID: 'since_id',
  TOMBSTONE_SINCE_ID: 'tombstone_since_id',
  SERVER_TIME: 'server_time',
  LAST_FULL_SYNC: 'last_full_sync',
  LAST_SYNC_AT: 'last_sync_at',
  CURSOR: 'cursor',
  CURSOR_VERSION: 'cursor_version',
} as const

/** syncMeta 快照（camelCase 字段名，与 SYNC_META_KEYS 的 snake_case 值有映射关系） */
export interface SyncMetaSnapshot {
  since: string
  sinceId: string
  tombstoneSinceId: string
  serverTime: string
  lastFullSync: string
  lastSyncAt: string
  /** H2-D: 全局事件账本 cursor（null = 未启用/回退旧协议） */
  cursor: number | null
  /** H2-D: cursor 协议版本（2 = 事件账本） */
  cursorVersion: number | null
}

/** outbox merge 矩阵动作 */
export type OutboxMergeAction = 'drop_existing' | 'keep_existing' | 'replace'

/** outbox merge 矩阵结果 */
export interface OutboxMergeResult {
  action: OutboxMergeAction
  /** replace 时可能改写目标行 action（如 delete→create 改为 update） */
  newAction?: OutboxAction
}

// ===== S1-2 Sync 协议层类型 =====

import type { components } from '@/types/api-generated'

/** F1-D17: 引擎 HTTP 类型用 api-generated（禁用 legacy @/types 的 SyncPull/PushResponse） */
export type ApiSyncPullResponse = components['schemas']['SyncPullResponse']
export type ApiSyncPushResponse = components['schemas']['SyncPushResponse']
export type ApiSyncEvent = components['schemas']['SyncEvent']

/** 14 个 pull_key（复数，与 PULL_KEY_TO_TABLE 键的并集子集） */
export const SYNC_PULL_KEYS = [
  'tasks', 'sessions', 'notes', 'folders', 'quickNotes', 'reflections',
  'habits', 'habitCheckIns', 'schedules', 'timeBlocks', 'memoComments',
  'sessionQuickNotes', 'scheduleQuickNotes', 'taskQuickNotes',
] as const
export type SyncPullKey = (typeof SYNC_PULL_KEYS)[number]

/** F1-D16 权威 SyncConflict（pre-push dirty 冲突 outboxId = -1，表示尚未 push） */
export interface SyncConflict {
  outboxId: number
  entityType: string        // camelCase 单数
  entityId: string
  localVersion: unknown
  remoteVersion: unknown
  conflictType: 'version' | 'content_hash'
}

/** push-batch 单批处理结果 */
export interface HandlePushResult {
  clearedOutboxIds: number[]
  conflicts: SyncConflict[]
  remoteWinCount: number
  circularRefCount: number
  retriableErrorCount: number
}

/** pull-loop 处理结果 */
export interface PullLoopResult {
  pages: number
  dirtyConflicts: SyncConflict[]
}
