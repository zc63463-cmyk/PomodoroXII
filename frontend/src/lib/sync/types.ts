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

export const RETAINED_LWW_SYNC_ENTITY_TYPES = [
  'note', 'folder', 'quickNote', 'reflection', 'habit', 'habitCheckIn',
  'schedule', 'timeBlock', 'memoComment', 'scheduleQuickNote',
] as const
export type RetainedLwwSyncEntityType =
  typeof RETAINED_LWW_SYNC_ENTITY_TYPES[number]

export const FINAL_SYNC_ENTITY_TYPES = [
  ...RETAINED_LWW_SYNC_ENTITY_TYPES,
  'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
  'workItem', 'workItemNote', 'focusSession', 'sessionTaskContext',
  'sessionAttributionRevision', 'sessionWorkItemPlan', 'sessionWorkItemOutcome',
] as const
export type SyncEntityType = typeof FINAL_SYNC_ENTITY_TYPES[number]
export const FINAL_SYNC_ENTITY_TYPE_SET = new Set<string>(FINAL_SYNC_ENTITY_TYPES)

/** outbox 动作（与 OutboxEvent.action 一致） */
export type OutboxAction = 'create' | 'update' | 'delete'

/** entityType(camelCase 单数) → Dexie 表名(plural) — drop_existing 删本地实体用 */
export const ENTITY_TYPE_TO_TABLE: Record<RetainedLwwSyncEntityType, string> = {
  note: 'notes',
  folder: 'folders',
  quickNote: 'quickNotes',
  reflection: 'reflections',
  habit: 'habits',
  habitCheckIn: 'habitCheckIns',
  schedule: 'schedules',
  timeBlock: 'timeBlocks',
  memoComment: 'memoComments',
  scheduleQuickNote: 'scheduleQuickNotes',
}

/** pull_key(plural) → Dexie 表名(plural) — 14 组全等映射（供 S1-2 merge 使用） */
export const PULL_KEY_TO_TABLE: Record<string, string> = {
  notes: 'notes',
  folders: 'folders',
  quickNotes: 'quickNotes',
  reflections: 'reflections',
  habits: 'habits',
  habitCheckIns: 'habitCheckIns',
  schedules: 'schedules',
  timeBlocks: 'timeBlocks',
  memoComments: 'memoComments',
  scheduleQuickNotes: 'scheduleQuickNotes',
}

export const TS3_LOCAL_ENTITY_TO_TABLE = {
  project: 'projects',
  statusDefinition: 'statusDefinitions',
  typeDefinition: 'typeDefinitions',
  label: 'labels',
  workItemLabel: 'workItemLabels',
  workItem: 'workItems',
  workItemNote: 'workItemNotes',
  focusSession: 'focusSessions',
  sessionTaskContext: 'sessionTaskContexts',
  sessionAttributionRevision: 'sessionAttributionRevisions',
  sessionWorkItemPlan: 'sessionWorkItemPlans',
  sessionWorkItemOutcome: 'sessionWorkItemOutcomes',
} as const

export type TS3LocalEntityType = keyof typeof TS3_LOCAL_ENTITY_TO_TABLE
export const TS3_AWAITING_S4_ENTITY_TYPES = new Set<TS3LocalEntityType>(
  Object.keys(TS3_LOCAL_ENTITY_TO_TABLE) as TS3LocalEntityType[],
)

export const FINAL_SYNC_ENTITY_TO_TABLE = {
  ...ENTITY_TYPE_TO_TABLE,
  ...TS3_LOCAL_ENTITY_TO_TABLE,
} as const satisfies Record<SyncEntityType, string>

type MissingFinalSyncType = Exclude<
  SyncEntityType, keyof typeof FINAL_SYNC_ENTITY_TO_TABLE
>
type ExtraFinalSyncType = Exclude<
  keyof typeof FINAL_SYNC_ENTITY_TO_TABLE, SyncEntityType
>
export const FINAL_SYNC_ENTITY_MAP_IS_EXACT:
  MissingFinalSyncType extends never
    ? (ExtraFinalSyncType extends never ? true : never)
    : never = true

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
/** outbox merge 矩阵动作 */
export type OutboxMergeAction = 'drop_existing' | 'keep_existing' | 'replace'

/** outbox merge 矩阵结果 */
export interface OutboxMergeResult {
  action: OutboxMergeAction
  /** replace 时可能改写目标行 action（如 delete→create 改为 update） */
  newAction?: OutboxAction
}

// ===== S1-2 Sync 协议层类型 =====

import type { components, operations } from '@/types/api-generated'

export type ApiSyncV2Event =
  operations['push_v2_api_v1_sync_v2_push_post']['requestBody']['content']['application/json']['events'][number]

export interface ApiSyncV2PushApplied {
  operation_id: string
  entity_type: string
  entity_id: string
  version: number
  resolution: 'remote' | null
}

export interface ApiSyncV2PushConflict {
  operation_id: string
  entity_type: string
  entity_id: string
  code: 'version_conflict' | 'tombstone_conflict' | 'cycle_detected'
  resolution: 'local' | 'tombstone' | 'circular_ref' | 'manual'
  details: Record<string, unknown>
}

export interface ApiSyncV2PushError {
  operation_id: string
  entity_type: string
  entity_id: string
  code: string
  retryable: boolean
  details: Record<string, unknown>
}

export type ApiSyncV2PushResponse = components['schemas']['SyncV2PushResponse']

export interface ApiSyncV2OperationQueryItem {
  operation_id: string
  state: 'unknown' | 'pending' | 'terminal' | 'recovery_required'
  batch_id: string | null
  result: ApiSyncV2PushResponse | null
}

export type ApiSyncV2OperationQueryResponse =
  components['schemas']['SyncV2OperationQueryResponse']

export type ApiSyncV2EventRecord = components['schemas']['SyncV2EventRecord']

export type ApiSyncV2PullResponse = components['schemas']['SyncV2PullResponse']

export type ApiSyncV2RecoveryResponse = components['schemas']['SyncV2RecoveryResponse']

export interface SnapshotEntityRecord {
  kind: 'entity'
  entity_type: SyncEntityType
  entity_id: string
  version: number
  updated_at: string
  payload: Record<string, unknown>
}

export type ApiSyncV2AckResponse = components['schemas']['SyncV2AckResponse']

export interface ApiSyncV2StatusResponse {
  catalog_hash: string
  client_id: string | null
  registered: boolean
  requires_recovery: boolean | null
  recovery_action: 'full_recovery' | null
  visible_event_count: number
  active_client_count: number
  recovery_client_count: number
}

/** F1-D16 权威 SyncConflict（pre-push dirty 冲突 outboxId = -1，表示尚未 push） */
export interface SyncConflict {
  outboxId: number
  entityType: string        // camelCase 单数
  entityId: string
  localVersion: unknown
  remoteVersion: unknown
  conflictType: 'version' | 'content_hash'
}

/** pull-loop 处理结果 */
export interface PullLoopResult {
  pages: number
  dirtyConflicts: SyncConflict[]
}
