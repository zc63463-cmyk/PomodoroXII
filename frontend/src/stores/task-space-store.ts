import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { NoteAutosaveController, type FlushReason } from '@/lib/task-space/note-autosave-controller'
import { summarizeIntentFailures } from '@/lib/task-space/intent-failure-summary'
import {
  ACTIVE_CHILD_CONFLICT_CODE,
  ActiveChildConflictError,
  extractActiveChildConflictIds,
} from '@/lib/task-space/active-child-conflict'
import {
  deriveBlockedSignals,
  selectRelationCandidates,
  type BlockedSignals,
} from '@/lib/task-space/relation-selectors'
// ★ 2026-09-12（ADR-0003）：等待前态由服务端记录（work_items 列 + 读投影），
//   store 不再持有任何本地"进入 Waiting 前态"的记忆 —— 本函数只做一次 CAS
//   transition，恢复目标由页面从 wire 读投影消费。

// Re-exported so callers keep importing the conflict signal from the store
// while the class identity stays owned by the leaf module (no import cycle).
export { ACTIVE_CHILD_CONFLICT_CODE, ActiveChildConflictError, extractActiveChildConflictIds }
import type { CachedProject, CachedWorkItem, CachedWorkItemNote, WorkItemNoteConflictRow, CachedLabel } from '@/types'
import type { BlockedMap, CachedRelation, RelationSet, WorkItemPriority } from '@/lib/contracts/task-space'

export interface CreateChildInput {
  title?: string
  description?: string | null
  typeDefinitionId?: string | null
  statusDefinitionId?: string | null
  // ★ 2026-09-11：与后端 contracts 同源的受限值域（不再是 string）。
  priority?: WorkItemPriority | null
}

export interface TaskSpaceRepositoryLike {
  /**
   * ★ 2026-09-11：`unresolvedDepthItemIds` = 读边界无法从 parent 链派生层级
   * 的 WorkItem（depth 是读模型派生值，不是实体字段）。它必须可见：
   * store 会据此提示用户并触发一次重拉（恢复路径），绝不静默丢弃这些行。
   */
  readCachedOverview: () => Promise<{
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions | null
    unresolvedDepthItemIds?: string[]
  }>
  refreshOverview: () => Promise<{
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions
    unresolvedDepthItemIds?: string[]
  }>
  loadTree: (projectId: string) => Promise<{
    cached: unknown[]
    remote: CachedWorkItem[]
    unresolvedDepthItemIds?: string[]
  } | {
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions
    unresolvedDepthItemIds?: string[]
  }>
  createProject: (input: { name: string; key: string; description: string | null }) => Promise<CachedProject>
  createWorkItem: (input: {
    projectId: string
    title: string
    description: string | null
    parentId: string | null
    typeDefinitionId: string | null
    statusDefinitionId: string | null
    priority: WorkItemPriority | null
  }) => Promise<CachedWorkItem>
  updateWorkItem: (input: {
    workItemId: string
    title?: string
    description?: string | null
    priority?: WorkItemPriority | null
    typeDefinitionId?: string | null
  }) => Promise<CachedWorkItem>
  moveWorkItem: (input: {
    projectId: string
    workItemId: string
    newParentId: string | null
  }) => Promise<CachedWorkItem>
  transitionWorkItem: (input: {
    workItemId: string
    statusDefinitionId: string
  }) => Promise<CachedWorkItem>
  trashWorkItem: (input: { workItemId: string }) => Promise<CachedWorkItem>
  restoreWorkItem: (input: { workItemId: string }) => Promise<CachedWorkItem>
  // Dependency domain.
  listRelations: (workItemId: string) => Promise<RelationSet>
  listBlockedMap: (projectId?: string) => Promise<BlockedMap>
  createRelation: (input: { fromWorkItemId: string; toWorkItemId: string; relationType: string }) => Promise<CachedRelation>
  removeRelation: (input: { fromWorkItemId: string; toWorkItemId: string; relationType: string }) => Promise<CachedRelation>
  // ★ 2026-09-12（D2 / ADR-0004）：解除确认（幂等 CAS，online-only）。
  resolveRelation: (input: { fromWorkItemId: string; toWorkItemId: string; relationType: string }) => Promise<CachedRelation>
  // D5 Y: label-set mutations (idempotent set semantics + server CAS).
  addWorkItemLabels: (input: { workItemId: string; labelIds: string[] }) => Promise<CachedWorkItem>
  removeWorkItemLabel: (input: { workItemId: string; labelId: string }) => Promise<CachedWorkItem>
  createLabel: (input: { name: string; color?: string | null }) => Promise<CachedLabel>
  updateLabel: (input: { labelId: string; name?: string; color?: string | null }) => Promise<CachedLabel>
  archiveLabel: (input: { labelId: string }) => Promise<CachedLabel>
  resumePendingDirectCommandIntents: () => Promise<{ failed: Array<{ operationId: string; code: string }> }>
}

export interface TaskSpaceNoteRepositoryLike {
  read: (workItemId: string) => Promise<CachedWorkItemNote | null>
  saveLocal: (input: {
    workItemId: string
    expectedLocalRevision: number
    document: WorkItemNoteDocument
    operationId: string
    now: string
  }) => Promise<CachedWorkItemNote>
  dispatchReplace: (workItemId: string) => Promise<void>
  resolveReloadRemote: (workItemId: string) => Promise<void>
  resolveOverwriteLocal: (workItemId: string) => Promise<void>
  readConflict: (workItemId: string) => Promise<WorkItemNoteConflictRow | null>
  /** Re-apply a durable failed-flush draft; returns the saved note or null. */
  retryDraft: (workItemId: string) => Promise<CachedWorkItemNote | null>
  /**
   * Synchronously persist a durable draft for an edit, BEFORE the debounced
   * flush.  This closes the hard-reload-during-debounce gap without touching
   * the note row or outbox semantics (separate draft collection).
   */
  persistDraft: (input: {
    workItemId: string
    expectedLocalRevision: number
    document: WorkItemNoteDocument
    operationId: string
    now: string
  }) => void
}

export interface TaskSpaceState {
  spaceId: string | null
  projects: CachedProject[]
  definitions: TaskSpaceDefinitions | null
  workItems: CachedWorkItem[]
  selectedProjectId: string | null
  selectedWorkItemId: string | null
  selectedLevel2WorkItemId: string | null
  selectedNote: CachedWorkItemNote | null
  noteConflict: WorkItemNoteConflictRow | null
  isLoading: boolean
  error: string | null
  repository: TaskSpaceRepositoryLike | null
  noteRepository: TaskSpaceNoteRepositoryLike | null
  /** Work item ids (or parent ids for child creation) with an in-flight mutation. */
  pendingMutations: Record<string, boolean>
  /** Stable, user-safe code of the last failed mutation (never raw Axios text). */
  mutationError: { targetId: string; code: string } | null
  // Dependency domain.  ``relations`` is the synced fact table; ``blockedMap``
  // is the derived projection (never persisted locally either — it is always
  // recomputed from relations + work items).
  relations: CachedRelation[]
  relationsForWorkItemId: string | null
  blockedMap: Record<string, BlockedSignals>
  /**
   * 一次性放行：任务页确认 BlockerAck 后写入，/timer 的启动判定消费。
   * 纯内存态、绝不落库；每次启动只放行一次（"never silent" 是按次成立的）。
   */
  pendingLaunchAckId: string | null
}

export interface TaskSpaceActions {
  hydrate: (spaceId: string, repository: TaskSpaceRepositoryLike) => Promise<void>
  /**
   * 同步周期末从本地缓存（Dexie）重读概览。
   *
   * 远端变更（另一台设备、服务端派生如「投入物化」）由 sync pull 写进本地
   * 表，但 store 里的 projects/workItems 还是同步前的快照 —— 不重读就永远
   * 显示旧值（实测：复盘后 52 分钟已进库，任务空间「投入」仍为 0）。
   * 只读缓存、不走网络、保持选中项；hydrate 不能用于此处（它会重置选中并
   * 触发 refreshOverview 网络刷新）。
   */
  refreshCachedOverview: () => Promise<void>
  attachNoteRepository: (repository: TaskSpaceNoteRepositoryLike | null) => void
  loadNote: (workItemId: string) => Promise<void>
  updateNoteDocument: (document: WorkItemNoteDocument) => void
  flushNote: (reason: FlushReason) => Promise<void>
  dispatchNote: (workItemId: string) => Promise<void>
  resolveReloadRemoteNote: (workItemId: string) => Promise<void>
  resolveOverwriteLocalNote: (workItemId: string) => Promise<void>
  loadTree: (projectId: string) => Promise<void>
  selectProject: (projectId: string) => Promise<void>
  selectWorkItem: (workItemId: string) => void
  createProject: (input: { name: string; key: string; description: string | null }) => Promise<CachedProject>
  createChild: (parentId: string, input?: CreateChildInput) => Promise<CachedWorkItem>
  /** Root-item creation entry for an empty project (parentId=null). */
  createRoot: (input?: CreateChildInput) => Promise<CachedWorkItem>
  updateWorkItem: (workItemId: string, input: {
    title?: string
    description?: string | null
    priority?: WorkItemPriority | null
    typeDefinitionId?: string | null
  }) => Promise<CachedWorkItem>
  moveWorkItem: (workItemId: string, newParentId: string | null) => Promise<CachedWorkItem>
  transitionWorkItem: (workItemId: string, statusDefinitionId: string) => Promise<CachedWorkItem>
  /** Soft-delete / undo.  Both are idempotent server side. */
  trashWorkItem: (workItemId: string) => Promise<CachedWorkItem>
  restoreWorkItem: (workItemId: string) => Promise<CachedWorkItem>
  // Dependency domain.
  loadRelations: (workItemId: string) => Promise<void>
  loadBlockedMap: (projectId?: string) => Promise<void>
  /** BlockerAck 一次性放行（内存态；会话成功启动即清除）。 */
  acknowledgeLaunch: (workItemId: string) => void
  clearLaunchAck: (workItemId?: string) => void
  hasLaunchAck: (workItemId: string) => boolean
  createRelation: (input: {
    fromWorkItemId: string
    toWorkItemId: string
    relationType: string
  }) => Promise<CachedRelation>
  removeRelation: (input: {
    fromWorkItemId: string
    toWorkItemId: string
    relationType: string
  }) => Promise<CachedRelation>
  /** ★ D2（ADR-0004）：确认「已取消的上游不再需要」—— 幂等 CAS。 */
  resolveRelation: (input: {
    fromWorkItemId: string
    toWorkItemId: string
    relationType: string
  }) => Promise<CachedRelation>
  // D5 Y: converge the work item label set (add=true union, false removal).
  toggleWorkItemLabel: (workItemId: string, labelId: string, add: boolean) => Promise<CachedWorkItem>
  reset: () => void
}

const initialState = (): TaskSpaceState => ({
  spaceId: null,
  projects: [],
  definitions: null,
  workItems: [],
  relations: [],
  relationsForWorkItemId: null,
  blockedMap: {},
  pendingLaunchAckId: null,
  selectedProjectId: null,
  selectedWorkItemId: null,
  selectedLevel2WorkItemId: null,
  selectedNote: null,
  noteConflict: null,
  isLoading: false,
  error: null,
  repository: null,
  noteRepository: null,
  pendingMutations: {},
  mutationError: null,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Closed, user-safe messages for server rejection codes.  Must stay in sync
 * with the backend closed code set (app/errors.py::MUTATION_REJECTION_SPECS)
 * plus the generic AppError subclasses a Space call can still meet.
 */
const MUTATION_ERROR_MESSAGES: Record<string, string> = {
  // --- work item / project structure ---
  version_conflict: '该项目项已被其他操作更新，请刷新后重试。',
  idempotency_conflict: '该操作已被使用，请重试或刷新。',
  invalid_work_item_tree: '当前树结构不允许该操作。',
  active_child_conflict: '存在进行中的子项，无法完成该操作。',
  not_found: '项目项不存在或已被删除。',
  invalid_payload_hash: '请求校验失败，请刷新后重试。',
  cycle_detected: '该操作会造成循环依赖，无法完成。',
  archived_work_item_immutable: '已归档的工作项不能再建立或解除依赖关系。',
  relation_not_loaded: '依赖关系数据未加载，请刷新后重试。',
  work_item_structure_changed: '项目项结构已变更，请刷新后重试。',
  invalid_project_key: '项目标识格式不合法，请仅使用字母与数字。',
  project_key_conflict: '项目标识已存在，请更换。',
  // --- labels (D5) ---
  label_name_conflict: '标签名称已存在，请更换。',
  // --- notes ---
  invalid_note_document: '笔记内容格式不合法，请检查后重试。',
  unsupported_content_version: '内容版本不受支持，请更新后重试。',
  // --- focus-session coupling ---
  active_session_exists: '已有进行中的专注会话，请先结束后再操作。',
  stale_session_owner: '专注会话归属已失效，请刷新后重试。',
  session_activation_conflict: '专注会话启动冲突，请刷新后重试。',
  active_session_recovery_required: '专注会话需要恢复，请刷新页面。',
  // --- space / sync / transport ---
  space_scope_mismatch: '该操作不属于当前空间，请刷新后重试。',
  offline_formal_creation_forbidden: '离线状态下无法执行该操作，请联网后重试。',
  command_result_unknown: '操作结果未知，请刷新页面确认。',
  tombstone_conflict: '该项目项已被删除，无法恢复。',
  relation_endpoint_missing: '关联的目标不存在，无法完成。',
  entity_id_mismatch: '数据标识不一致，请刷新后重试。',
  delete_payload_not_empty: '删除请求格式有误，请刷新后重试。',
  entity_not_sync_enabled: '该类型数据不支持同步。',
  payload_field_not_allowed: '请求包含不允许的字段，请刷新后重试。',
  // ★ 2026-09-12（D2 / ADR-0004）：relation 的 resolution / resolved_at 是
  //   服务端自持列 —— 客户端（含同步重放）不得创建或变更它们。
  server_managed_field_changed: '该字段由服务端维护，客户端不能修改。',
  // --- generic AppError subclasses a Space call can still meet ---
  auth_required: '登录状态已失效，请重新登录。',
  forbidden: '当前账号没有执行该操作的权限。',
  conflict: '数据存在冲突，请刷新后重试。',
  validation_error: '请求数据校验失败，请检查后重试。',
  space_not_found: '空间不存在或未注册。',
  space_recovery_required: '空间需要恢复，请稍后重试。',
  space_storage_missing: '空间存储不可用，请检查配置。',
  cursor_expired: '同步游标已过期，请执行完整同步。',
}

/**
 * Client-local guard codes.  These never reach the network — they are thrown
 * by the single-flight guard and by pre-flight validation — so they must be
 * resolved BEFORE the HTTP-shape extraction runs.  Otherwise they were
 * reported as a service-connection failure.
 */
const LOCAL_MUTATION_ERROR_MESSAGES: Record<string, string> = {
  work_item_mutation_in_flight: '该操作正在进行中，请稍候。',
  work_item_child_creation_in_flight: '子项正在创建中，请稍候。',
  work_item_root_creation_in_flight: '项目项正在创建中，请稍候。',
  work_item_child_depth_exceeded: '项目项最多支持三层，无法继续添加子项。',
  work_item_not_loaded: '项目项数据未加载，请刷新后重试。',
  task_space_repository_not_ready: '任务空间尚未就绪，请稍候再试。',
  task_space_project_not_selected: '请先选择一个项目。',
}

/**
 * Two distinct fallbacks.  A request that never produced an HTTP response is a
 * connectivity failure; a response whose code is absent from the closed map is
 * a server-side failure that "checking the connection" will not fix.  Using a
 * single message for both told users to debug their network for business
 * rejections.
 */
const GENERIC_MUTATION_ERROR = '操作失败，请稍后重试。'
const NETWORK_MUTATION_ERROR = '网络异常，请检查服务连接后重试。'

/** Axios transport codes that mean "no response ever arrived". */
const NETWORK_ERROR_CODES = new Set([
  'ERR_NETWORK',
  'ERR_INTERNET_DISCONNECTED',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
])

/**
 * Read a response header case-insensitively.
 *
 * Axios normalises header names onto an AxiosHeaders instance
 * (``X-PomodoroXII-Error-Code``), so a lower-case index is always undefined.
 * Prefer the typed accessor, then fall back to a case-insensitive scan.
 */
const readErrorHeader = (headers: Record<string, unknown>, name: string): string | null => {
  const getter = (headers as { get?: (key: string) => unknown }).get
  if (typeof getter === 'function') {
    const value = getter.call(headers, name)
    if (typeof value === 'string' && value.length > 0) return value
  }
  const direct = headers[name]
  if (typeof direct === 'string' && direct.length > 0) return direct
  const lowered = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lowered) continue
    const value = headers[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * Map a failed mutation to a stable error code and a closed, user-safe
 * message. Never surfaces raw Axios text, exception messages, response
 * objects, tokens, or paths.
 *
 * Resolution order: client-local guard codes, then canonical body
 * ({code, ...}), legacy object body ({detail: {code, ...}}), then the
 * canonical error-code response header.
 */
export function resolveTaskSpaceMutationError(error: unknown): { code: string; message: string } {
  // 1. Client-local guards and pre-flight validation: plain Errors carrying a
  //    stable code as their message, with no HTTP envelope at all.
  if (error instanceof Error && LOCAL_MUTATION_ERROR_MESSAGES[error.message]) {
    const localCode = error.message
    return { code: localCode, message: LOCAL_MUTATION_ERROR_MESSAGES[localCode] }
  }

  const response = isRecord(error) ? error.response : undefined

  // 2. No HTTP response.  A transport failure is a connectivity problem; a
  //    local Dexie/validation throw is not, and must not claim to be one.
  if (!isRecord(response)) {
    const transportCode = isRecord(error) && typeof error.code === 'string' ? error.code : ''
    const isAxios = isRecord(error) && error.isAxiosError === true
    const isNetwork = isAxios || NETWORK_ERROR_CODES.has(transportCode)
    return isNetwork
      ? { code: 'network_unreachable', message: NETWORK_MUTATION_ERROR }
      : { code: 'unknown', message: GENERIC_MUTATION_ERROR }
  }

  // 3. HTTP response: canonical body, legacy object body, then the header.
  //    A legacy body carries {"detail": string}, which has no code, so the
  //    header is the only recovery path when canonical negotiation is absent.
  const data = isRecord(response) ? response.data : undefined
  const headers = isRecord(response.headers) ? response.headers : undefined

  let code: unknown = isRecord(data) ? data.code : undefined
  if (!code && isRecord(data) && isRecord(data.detail)) code = data.detail.code
  if (code === undefined && headers) code = readErrorHeader(headers, 'X-PomodoroXII-Error-Code')

  const stableCode = typeof code === 'string' && code.length > 0 ? code : 'unknown'
  return {
    code: stableCode,
    message: MUTATION_ERROR_MESSAGES[stableCode] ?? GENERIC_MUTATION_ERROR,
  }
}

// Closed, user-safe messages for Note autosave failures.  These deliberately
// never surface raw exception text (Dexie quota errors, Axios bodies, ...).
const NOTE_ERROR_MESSAGES: Record<string, string> = {
  version_conflict: '该笔记已被其他设备更新，请刷新后重试。',
  local_version_conflict: '本地编辑版本冲突，请刷新后重试。',
  work_item_note_not_loaded: '笔记尚未加载，无法保存。',
  work_item_note_not_found: '该笔记不存在或已被删除。',
  task_space_note_repository_not_ready: '笔记存储尚未就绪，无法保存。',
}
const GENERIC_NOTE_ERROR = '笔记保存失败，请检查服务连接后重试。'

/**
 * Map a Note-autosave failure to a stable code + closed message.  Uses the
 * same canonical-wire extraction as mutations but with note-specific wording.
 */
export function resolveTaskSpaceNoteError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = error.message
    if (NOTE_ERROR_MESSAGES[code]) return { code, message: NOTE_ERROR_MESSAGES[code] }
  }
  const mapped = resolveTaskSpaceMutationError(error)
  if (mapped.code !== 'unknown') {
    return { code: mapped.code, message: NOTE_ERROR_MESSAGES[mapped.code] ?? GENERIC_NOTE_ERROR }
  }
  return { code: 'unknown', message: GENERIC_NOTE_ERROR }
}

const isCurrent = (state: TaskSpaceState, spaceId: string): boolean => state.spaceId === spaceId

const mergeProjectWorkItems = (
  current: CachedWorkItem[],
  projectId: string,
  replacement: CachedWorkItem[],
): CachedWorkItem[] => [
  ...current.filter((item) => item.projectId !== projectId),
  ...replacement,
]

const definitionId = (definitions: TaskSpaceDefinitions | null, group: 'statuses' | 'types'): string | null => {
  const first = definitions?.[group][0]
  if (!first || typeof first !== 'object' || first === null) return null
  const id = (first as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * ★ 2026-09-11 WorkItem depth 不可派生时的用户可见提示（fail-loud）。
 *
 * depth 是读模型派生值（实体契约 / 业务哈希 / post-image 都不含它，见
 * `lib/task-space/work-item-read-model`）。读取边界派生不出完整 parent 链时，
 * 必须让用户看见并触发恢复（重拉），绝不允许这些行从树里静默消失。
 */
const DEPTH_UNRESOLVED_MESSAGE = '部分任务的层级信息不完整，已触发重新同步；若仍缺失请刷新页面。'

const hasUnresolvedDepth = (overview: { unresolvedDepthItemIds?: string[] }): boolean => (
  (overview.unresolvedDepthItemIds?.length ?? 0) > 0
)

const warnUnresolvedDepth = (source: string, ids: string[] | undefined): void => {
  // 稳定前缀便于诊断：日志 + UI 提示双通道，避免「数据在但看不见」。
  console.warn(`[task-space] work item depth unresolved (${source})`, ids ?? [])
}

export function selectProjectTree(items: CachedWorkItem[], projectId: string | null): CachedWorkItem[] {
  if (!projectId) return []
  return items
    .filter((item) => item.projectId === projectId && item.depth >= 1 && item.depth <= 3)
    .sort((left, right) => (
      left.depth - right.depth ||
      left.childRank - right.childRank ||
      left.id.localeCompare(right.id)
    ))
}

/**
 * Same-project nodes that may become the new parent of ``selectedWorkItemId``.
 * A candidate must never be the item itself or one of its descendants, and the
 * whole selected subtree must still fit within the 3-level ceiling:
 *
 *   candidate.depth + 1 + (subtreeMaxDepth - selected.depth) <= 3
 *
 * where subtreeMaxDepth is the deepest node in the selected subtree (including
 * the selected item itself).  This mirrors the backend MoveWorkItem guard
 * ``new_parent_depth + _subtree_relative_depth(item) > 3`` exactly, so the UI
 * never offers a parent the server would reject.
 */
export function selectMoveCandidates(items: CachedWorkItem[], selectedWorkItemId: string | null): CachedWorkItem[] {
  if (!selectedWorkItemId) return []
  const selected = items.find((item) => item.id === selectedWorkItemId)
  if (!selected) return []
  const children = new Map<string | null, CachedWorkItem[]>()
  for (const item of items) {
    const group = children.get(item.parentId) ?? []
    group.push(item)
    children.set(item.parentId, group)
  }
  const descendants = new Set<string>()
  let subtreeMaxDepth: number = selected.depth
  const frontier = [selectedWorkItemId]
  while (frontier.length > 0) {
    const id = frontier.pop()!
    for (const child of children.get(id) ?? []) {
      if (descendants.has(child.id)) continue
      descendants.add(child.id)
      subtreeMaxDepth = Math.max(subtreeMaxDepth, child.depth)
      frontier.push(child.id)
    }
  }
  return items.filter((item) => (
    item.id !== selectedWorkItemId
    && !descendants.has(item.id)
    && item.depth + 1 + (subtreeMaxDepth - selected.depth) <= 3
  ))
}

/**
 * Candidate level-2 destinations for the "move the active children elsewhere"
 * resolution of an active-child conflict.
 *
 * A candidate must be a sibling-level container in the SAME project, must not
 * be the blocked parent itself, must not be archived, and must not already be
 * completed (moving work onto a finished item would immediately re-block it).
 * Depth is capped at 2 because the children being relocated are level 3.
 */
export function selectLevel2RelocationTargets(
  items: CachedWorkItem[],
  blockedParentId: string | null,
  completedStatusIds: ReadonlySet<string>,
): CachedWorkItem[] {
  if (!blockedParentId) return []
  const blocked = items.find((item) => item.id === blockedParentId)
  if (!blocked) return []
  return items
    .filter((item) => (
      item.projectId === blocked.projectId
      && item.depth === 2
      && item.id !== blockedParentId
      && item.archivedAt === null
      && !completedStatusIds.has(item.statusDefinitionId)
    ))
    .sort((left, right) => (
      left.childRank - right.childRank || left.displayKey.localeCompare(right.displayKey)
    ))
}

/**
 * Locally derived blocking projection for the tree.
 *
 * The server also exposes ``/relations/blocked-map``, but the client must be
 * able to recompute it from its own rows: an edge that arrives before its work
 * item (network reordering) must still show as blocking, and an offline client
 * has no server to ask.  Orphan edges are treated as OPEN — never as resolved.
 */
export function selectBlockedMap(
  workItems: CachedWorkItem[],
  relations: CachedRelation[],
  statusCategoryById: Record<string, string | undefined>,
): Record<string, BlockedSignals> {
  const depthById: Record<string, number | undefined> = {}
  for (const item of workItems) depthById[item.id] = item.depth
  return deriveBlockedSignals(relations, statusCategoryById, depthById)
}

export { selectRelationCandidates }

export const useTaskSpaceStore = create<TaskSpaceState & TaskSpaceActions>()(
  devtools((set, get) => {
    let hydrationSequence = 0
    type PendingNoteEdit = {
      revision: number
      workItemId: string
      expectedLocalRevision: number
      document: WorkItemNoteDocument
      operationId: string
      now: string
      /** The note repository captured at schedule time.  A debounced edit is
       *  flushed against this exact repository even if the store later detaches
       *  it (item/space switch, unmount, logout), so a pending edit is never
       *  dropped by a controlled unbind. */
      repository: TaskSpaceNoteRepositoryLike
    }
    let noteAutosave: NoteAutosaveController<PendingNoteEdit> | null = null
    // Synchronous per-target single-flight guard: state updates are async, so
    // a second mutation in the same tick would still see stale state. The Set
    // is written synchronously before any await and cleared in finally.
    const mutationGuards = new Set<string>()

    const beginMutation = (targetId: string, inFlightCode: string): void => {
      if (mutationGuards.has(targetId)) throw new Error(inFlightCode)
      mutationGuards.add(targetId)
      set((state) => ({ pendingMutations: { ...state.pendingMutations, [targetId]: true } }))
    }

    const endMutation = (targetId: string): void => {
      mutationGuards.delete(targetId)
      set((state) => {
        const next = { ...state.pendingMutations }
        delete next[targetId]
        return { pendingMutations: next }
      })
    }

    const ensureNoteAutosave = (): NoteAutosaveController<PendingNoteEdit> => {
      if (noteAutosave) return noteAutosave
      noteAutosave = new NoteAutosaveController<PendingNoteEdit>(
        async (edit) => {
          // Always persist against the repository that captured the edit, so
          // a controlled unbind can flush without reading detached state.
          const saved = await edit.repository.saveLocal(edit)
          const current = get().selectedNote
          if (!current || current.noteId !== saved.noteId) return
          if (current.localRevision <= saved.localRevision) {
            set({ selectedNote: saved })
          } else {
            set({ selectedNote: {
              ...current,
              version: saved.version,
              createdAt: saved.createdAt,
            } })
          }
        },
        800,
        (error) => set({ error: resolveTaskSpaceNoteError(error).message }),
      )
      return noteAutosave
    }

    /**
     * Best-effort flush of any pending debounced edit against its captured
     * repository.  Returns true when a dirty flush was started; the caller must
     * then NOT discard the controller, because on failure the controller
     * re-pends the edit and keeps it as a retryable draft.
     */
    const flushPendingNoteBestEffort = (
      reason: 'unmount' | 'space-switch' | 'logout',
    ): boolean => {
      const previous = noteAutosave
      if (!previous?.isDirty()) return false
      void previous.flush(reason).then(
        () => {
          // Success: the pending edit was persisted; safe to discard.
          if (noteAutosave === previous) noteAutosave = null
        },
        () => {
          // Failure: the controller re-pended the edit.  Keep it attached so
          // a later flush can retry it instead of dropping the draft.
          if (noteAutosave === previous) noteAutosave = previous
        },
      )
      return true
    }

    return {
      ...initialState(),

      async hydrate(spaceId, repository) {
        const sequence = ++hydrationSequence
        set({
          spaceId,
          repository,
          isLoading: true,
          error: null,
          mutationError: null,
          selectedProjectId: null,
          selectedWorkItemId: null,
          selectedLevel2WorkItemId: null,
          selectedNote: null,
          noteConflict: null,
        })

        try {
          const cached = await repository.readCachedOverview()
          if (sequence !== hydrationSequence || !isCurrent(get(), spaceId)) return
          const cachedProjectId = cached.projects[0]?.id ?? null
          set({
            projects: cached.projects,
            workItems: cached.workItems,
            definitions: cached.definitions,
            selectedProjectId: cachedProjectId,
          })

          // Reconcile pending intents, but a rejected intent (e.g. a replayed
          // duplicate-key create) must not break the workbench: record a
          // stable recovery message and let the refresh below still rebuild
          // the view from authoritative server rows.
          //
          // ★ 2026-09-11：两类失败分开报 ——
          //   ① 抛错（传输类/可重试类）：本轮中止，intent 仍 pending，下次
          //      hydrate 会再试 ⇒「请刷新页面重试」是对的；
          //   ② 返回的 failed 列表是**永久终态**（resume 只扫 prepared/in_flight），
          //      刷新救不回来 ⇒ 必须说清「哪类操作没提交、去原位置重新执行」。
          let resumeFailed = false
          let failedIntents: Array<{ code: string }> = []
          try {
            failedIntents = (await repository.resumePendingDirectCommandIntents()).failed
          } catch {
            resumeFailed = true
          }
          const remote = await repository.refreshOverview()
          if (sequence !== hydrationSequence || !isCurrent(get(), spaceId)) return
          const selectedProjectId = get().selectedProjectId && remote.projects.some(
            (project) => project.id === get().selectedProjectId,
          )
            ? get().selectedProjectId
            : remote.projects[0]?.id ?? null
          // ★ 2026-09-11：权威刷新后仍有无法派生层级的行 → 明确提示（fail-loud），
          // 而不是让它们在 tree 里静默消失。
          const depthUnresolved = hasUnresolvedDepth(remote)
          if (depthUnresolved) warnUnresolvedDepth('hydrate', remote.unresolvedDepthItemIds)
          set({
            projects: remote.projects,
            workItems: remote.workItems,
            definitions: remote.definitions,
            selectedProjectId,
            isLoading: false,
            error: resumeFailed
              // 传输类/可重试类：intent 仍 pending，下次 hydrate 会再试 —— 刷新有效。
              ? '部分本地操作未能同步，请刷新页面重试。'
              // 永久判死：说清哪类操作没提交（刷新救不回来）。
              : summarizeIntentFailures(failedIntents)
                ?? (depthUnresolved ? DEPTH_UNRESOLVED_MESSAGE : null),
          })
        } catch (error) {
          if (sequence !== hydrationSequence || !isCurrent(get(), spaceId)) return
          // A failed reconciliation (e.g. replaying a rejected intent) must
          // surface a stable message, never raw Axios text.
          set({ isLoading: false, error: resolveTaskSpaceMutationError(error).message })
        }
      },

      async refreshCachedOverview() {
        const { repository, spaceId: currentSpaceId } = get()
        if (!repository || !currentSpaceId) return
        // 不递增 hydrate 序号（那是「重新初始化」的令牌）；只记录当前值：
        // 期间若真的跑了一次 hydrate，本次结果作废，交给 hydrate 写入。
        const sequence = hydrationSequence
        const cached = await repository.readCachedOverview()
        if (sequence !== hydrationSequence || !isCurrent(get(), currentSpaceId)) return
        // ★ 2026-09-11 恢复路径：本地缓存里有无法派生层级的行（历史 wire 形状行 /
        // 缺父行）时，主动做一次权威重拉 —— 重拉后的行带服务端读投影 depth，
        // 能自愈的当场自愈；仍不行则给出可见提示，绝不静默丢弃。
        if (hasUnresolvedDepth(cached)) {
          warnUnresolvedDepth('cached-overview', cached.unresolvedDepthItemIds)
          const remote = await repository.refreshOverview()
          if (sequence !== hydrationSequence || !isCurrent(get(), currentSpaceId)) return
          const stillUnresolved = hasUnresolvedDepth(remote)
          if (stillUnresolved) warnUnresolvedDepth('refresh-recovery', remote.unresolvedDepthItemIds)
          set((state) => ({
            projects: remote.projects,
            workItems: remote.workItems,
            definitions: remote.definitions,
            selectedProjectId: state.selectedProjectId && remote.projects.some(
              (project) => project.id === state.selectedProjectId,
            )
              ? state.selectedProjectId
              : remote.projects[0]?.id ?? null,
            error: state.error ?? (stillUnresolved ? DEPTH_UNRESOLVED_MESSAGE : null),
          }))
          return
        }
        set((state) => ({
          projects: cached.projects,
          workItems: cached.workItems,
          definitions: cached.definitions,
          // 选中项能保持就保持（远端刷新不该把人从详情面板里踢出来）。
          selectedProjectId: state.selectedProjectId && cached.projects.some(
            (project) => project.id === state.selectedProjectId,
          )
            ? state.selectedProjectId
            : cached.projects[0]?.id ?? null,
        }))
      },

      attachNoteRepository(repository) {
        if (repository === null) {
          // Controlled unbind: before detaching, flush any debounced edit to
          // local persistence/outbox against the repository that captured it,
          // so switching items/spaces or unmounting never drops a dirty Note.
          // On failure the controller keeps the re-pended edit as a retryable
          // draft instead of being discarded.
          const flushing = flushPendingNoteBestEffort('unmount')
          if (!flushing) noteAutosave = null
        } else {
          noteAutosave = null
        }
        set({ noteRepository: repository, selectedNote: null, noteConflict: null })
      },

      async loadNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) return
        try {
          const [selectedNote, noteConflict] = await Promise.all([
            repository.read(workItemId),
            repository.readConflict(workItemId),
          ])
          if (get().selectedWorkItemId !== workItemId) return
          // Recover a durable failed-flush draft (survived reload / space
          // rebinding / logout).  retryDraft re-applies it through the NEW
          // repository and clears it on success; on failure it stays durable.
          const recovered = await repository.retryDraft(workItemId)
          if (get().selectedWorkItemId !== workItemId) return
          set({
            selectedNote: recovered ?? selectedNote,
            noteConflict: recovered ? null : noteConflict,
            error: null,
          })
        } catch (error) {
          set({ error: resolveTaskSpaceNoteError(error).message })
        }
      },

      updateNoteDocument(document) {
        const current = get().selectedNote
        if (!current) throw new Error('work_item_note_not_loaded')
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        const now = canonicalNow()
        const nextRevision = current.localRevision + 1
        const operationId = crypto.randomUUID()
        // Synchronously persist a lightweight durable draft BEFORE the debounce
        // flush, so a hard reload inside the 800ms window still recovers the
        // edit on the next load (see note-draft-store).  This is best-effort
        // and never touches the note row or outbox semantics; a successful
        // saveLocal clears the draft.
        try {
          repository.persistDraft({
            workItemId: current.workItemId,
            expectedLocalRevision: current.localRevision,
            document,
            operationId,
            now,
          })
        } catch {
          // draft persistence is best-effort; the in-memory autosave remains
        }
        set({
          selectedNote: {
            ...current,
            document,
            localRevision: nextRevision,
            syncState: 'dirty',
            updatedAt: now,
          },
        })
        ensureNoteAutosave().schedule({
          revision: nextRevision,
          workItemId: current.workItemId,
          expectedLocalRevision: current.localRevision,
          document,
          operationId,
          now,
          repository,
        })
      },

      async flushNote(reason) {
        try {
          await noteAutosave?.flush(reason)
        } catch (error) {
          set({ error: resolveTaskSpaceNoteError(error).message })
          throw error
        }
      },

      async dispatchNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        try {
          await get().flushNote('current-item-change')
          await repository.dispatchReplace(workItemId)
          await get().loadNote(workItemId)
        } catch (error) {
          set({ error: resolveTaskSpaceNoteError(error).message })
          throw error
        }
      },

      async resolveReloadRemoteNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        try {
          await repository.resolveReloadRemote(workItemId)
          await get().loadNote(workItemId)
        } catch (error) {
          set({ error: resolveTaskSpaceNoteError(error).message })
          throw error
        }
      },

      async resolveOverwriteLocalNote(workItemId) {
        const repository = get().noteRepository
        if (!repository) throw new Error('task_space_note_repository_not_ready')
        try {
          await repository.resolveOverwriteLocal(workItemId)
          await get().loadNote(workItemId)
        } catch (error) {
          set({ error: resolveTaskSpaceNoteError(error).message })
          throw error
        }
      },

      async loadTree(projectId) {
        const repository = get().repository
        if (!repository) return
        try {
          const result = await repository.loadTree(projectId)
          if (get().selectedProjectId !== projectId) return
          const remote = 'remote' in result
            ? result.remote
            : result.workItems.filter((item) => item.projectId === projectId)
          // ★ 2026-09-11：读边界报出无法派生层级的行 → 可见提示（fail-loud）。
          const unresolved = hasUnresolvedDepth(result)
          if (unresolved) warnUnresolvedDepth('load-tree', result.unresolvedDepthItemIds)
          set((state) => ({
            workItems: mergeProjectWorkItems(state.workItems, projectId, remote),
            error: unresolved ? DEPTH_UNRESOLVED_MESSAGE : null,
          }))
        } catch (error) {
          set({ error: resolveTaskSpaceMutationError(error).message })
        }
      },

      async selectProject(projectId) {
        set({
          selectedProjectId: projectId,
          selectedWorkItemId: null,
          selectedLevel2WorkItemId: null,
          error: null,
          mutationError: null,
        })
        await get().loadTree(projectId)
      },

      selectWorkItem(workItemId) {
        const itemsById = new Map(get().workItems.map((item) => [item.id, item]))
        const item = itemsById.get(workItemId)
        let level2Id: string | null = null
        let cursor = item
        while (cursor) {
          if (cursor.depth === 2) {
            level2Id = cursor.id
            break
          }
          cursor = cursor.parentId ? itemsById.get(cursor.parentId) : undefined
        }
        set({ selectedWorkItemId: workItemId, selectedLevel2WorkItemId: level2Id })
      },

      async createProject(input) {
        const repository = get().repository
        if (!repository) throw new Error('task_space_repository_not_ready')
        try {
          const created = await repository.createProject(input)
          set((state) => ({
            projects: [...state.projects, created].sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id)),
            selectedProjectId: created.id,
            selectedWorkItemId: null,
            selectedLevel2WorkItemId: null,
            error: null,
          }))
          return created
        } catch (error) {
          // Closed message, like every other mutation: never surface raw
          // exception text (Axios bodies, tokens, paths).
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: '__project__', code: mapped.code } })
          throw error
        }
      },

      async createChild(parentId, input = {}) {
        beginMutation(parentId, 'work_item_child_creation_in_flight')
        const repository = get().repository
        const state = get()
        const parent = state.workItems.find((item) => item.id === parentId)
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!state.selectedProjectId) throw new Error('task_space_project_not_selected')
          if (!parent || parent.depth >= 3) throw new Error('work_item_child_depth_exceeded')
          const created = await repository.createWorkItem({
            projectId: state.selectedProjectId,
            title: input.title?.trim() || 'New work item',
            description: input.description ?? null,
            parentId,
            typeDefinitionId: input.typeDefinitionId ?? definitionId(state.definitions, 'types'),
            statusDefinitionId: input.statusDefinitionId ?? definitionId(state.definitions, 'statuses'),
            priority: input.priority ?? null,
          })
          set((current) => ({
            workItems: [...current.workItems, created],
            selectedWorkItemId: created.id,
            selectedLevel2WorkItemId: created.depth === 2 ? created.id : parent.depth === 2 ? parent.id : current.selectedLevel2WorkItemId,
            error: null,
            mutationError: null,
          }))
          return created
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: parentId, code: mapped.code } })
          throw error
        } finally {
          endMutation(parentId)
        }
      },

      async createRoot(input = {}) {
        beginMutation('__root__', 'work_item_root_creation_in_flight')
        const repository = get().repository
        const state = get()
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!state.selectedProjectId) throw new Error('task_space_project_not_selected')
          // The repository already supports parentId=null; this is the explicit
          // root-item entry for an empty project.
          const created = await repository.createWorkItem({
            projectId: state.selectedProjectId,
            title: input.title?.trim() || 'New work item',
            description: input.description ?? null,
            parentId: null,
            typeDefinitionId: input.typeDefinitionId ?? definitionId(state.definitions, 'types'),
            statusDefinitionId: input.statusDefinitionId ?? definitionId(state.definitions, 'statuses'),
            priority: input.priority ?? null,
          })
          set((current) => ({
            workItems: [...current.workItems, created],
            selectedWorkItemId: created.id,
            selectedLevel2WorkItemId: created.depth === 2 ? created.id : current.selectedLevel2WorkItemId,
            error: null,
            mutationError: null,
          }))
          return created
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: '__root__', code: mapped.code } })
          throw error
        } finally {
          endMutation('__root__')
        }
      },

      async updateWorkItem(workItemId, input) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        const state = get()
        const item = state.workItems.find((candidate) => candidate.id === workItemId)
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!item) throw new Error('work_item_not_loaded')
          const updated = await repository.updateWorkItem({ workItemId, ...input })
          set((current) => ({
            workItems: current.workItems.map((candidate) => candidate.id === updated.id ? updated : candidate),
            error: null,
            mutationError: null,
          }))
          return updated
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      async moveWorkItem(workItemId, newParentId) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        const state = get()
        const item = state.workItems.find((candidate) => candidate.id === workItemId)
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          if (!item) throw new Error('work_item_not_loaded')
          // child_rank is never client-supplied online: the server assigns the
          // authoritative append-only rank for the target parent.
          const moved = await repository.moveWorkItem({
            projectId: item.projectId,
            workItemId,
            newParentId,
          })
          set((current) => ({
            workItems: current.workItems.map((candidate) => candidate.id === moved.id ? moved : candidate),
            error: null,
            mutationError: null,
          }))
          return moved
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      async transitionWorkItem(workItemId, statusDefinitionId) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const transitioned = await repository.transitionWorkItem({ workItemId, statusDefinitionId })
          set((state) => ({
            workItems: state.workItems.map((item) => item.id === transitioned.id ? transitioned : item),
            error: null,
            mutationError: null,
          }))
          return transitioned
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          // An active-child block is not a toast: the UI must offer the four
          // resolution paths, so rethrow a structured error carrying the
          // conflicting child ids and leave the generic banner untouched.
          if (mapped.code === ACTIVE_CHILD_CONFLICT_CODE) {
            set({ error: null, mutationError: null })
            throw new ActiveChildConflictError(workItemId, extractActiveChildConflictIds(error))
          }
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      async trashWorkItem(workItemId) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const trashed = await repository.trashWorkItem({ workItemId })
          set((state) => ({
            workItems: state.workItems.map((item) => item.id === trashed.id ? trashed : item),
            error: null,
            mutationError: null,
          }))
          return trashed
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      async restoreWorkItem(workItemId) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const restored = await repository.restoreWorkItem({ workItemId })
          set((state) => ({
            workItems: state.workItems.map((item) => item.id === restored.id ? restored : item),
            error: null,
            mutationError: null,
          }))
          return restored
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      async loadRelations(workItemId) {
        const repository = get().repository
        if (!repository) return
        try {
          // NOTE: never name this ``set`` — it shadows Zustand's setter.
          const relationSet = await repository.listRelations(workItemId)
          if (get().selectedWorkItemId !== workItemId) return
          set((state) => ({
            // Replace only this item's edges; other items' rows stay cached.
            relations: [
              ...state.relations.filter((edge) => (
                edge.fromWorkItemId !== workItemId && edge.toWorkItemId !== workItemId
              )),
              ...relationSet.blockers.map((entry) => entry.relation),
              ...relationSet.blocking.map((entry) => entry.relation),
            ],
            relationsForWorkItemId: workItemId,
          }))
        } catch (error) {
          set({ error: resolveTaskSpaceMutationError(error).message })
        }
      },

      async loadBlockedMap(projectId) {
        const repository = get().repository
        if (!repository) return
        try {
          const map = await repository.listBlockedMap(projectId)
          set({ blockedMap: map.items })
        } catch (error) {
          set({ error: resolveTaskSpaceMutationError(error).message })
        }
      },

      acknowledgeLaunch(workItemId) {
        set({ pendingLaunchAckId: workItemId })
      },

      clearLaunchAck(workItemId) {
        const current = get().pendingLaunchAckId
        if (current === null) return
        if (workItemId !== undefined && current !== workItemId) return
        set({ pendingLaunchAckId: null })
      },

      hasLaunchAck(workItemId) {
        return get().pendingLaunchAckId === workItemId
      },

      async createRelation(input) {
        const targetId = input.fromWorkItemId
        beginMutation(targetId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const created = await repository.createRelation(input)
          set((state) => ({
            relations: [
              ...state.relations.filter((edge) => edge.id !== created.id),
              created,
            ],
            error: null,
            mutationError: null,
          }))
          return created
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId, code: mapped.code } })
          throw error
        } finally {
          endMutation(targetId)
        }
      },

      async removeRelation(input) {
        const targetId = input.fromWorkItemId
        beginMutation(targetId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const removed = await repository.removeRelation(input)
          set((state) => ({
            relations: state.relations.filter((edge) => edge.id !== removed.id),
            error: null,
            mutationError: null,
          }))
          return removed
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId, code: mapped.code } })
          throw error
        } finally {
          endMutation(targetId)
        }
      },

      // ★ 2026-09-12（D2 / ADR-0004）：解除确认。确认后仅替换该行 —— 阻塞 /
      //   恢复提示等派生信号由 store 重算（本地重算是渲染真值），不做"乐观猜测"。
      async resolveRelation(input) {
        const targetId = input.fromWorkItemId
        beginMutation(targetId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const resolved = await repository.resolveRelation(input)
          set((state) => ({
            relations: [
              ...state.relations.filter((edge) => edge.id !== resolved.id),
              resolved,
            ],
            error: null,
            mutationError: null,
          }))
          return resolved
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId, code: mapped.code } })
          throw error
        } finally {
          endMutation(targetId)
        }
      },

      // D5 Y: converge the label set idempotently; stale CAS surfaces a
      // stable version_conflict for manual retry (never a silent merge).
      async toggleWorkItemLabel(workItemId: string, labelId: string, add: boolean) {
        beginMutation(workItemId, 'work_item_mutation_in_flight')
        const repository = get().repository
        try {
          if (!repository) throw new Error('task_space_repository_not_ready')
          const updated = add
            ? await repository.addWorkItemLabels({ workItemId, labelIds: [labelId] })
            : await repository.removeWorkItemLabel({ workItemId, labelId })
          set((state) => ({
            workItems: state.workItems.map((item) => item.id === updated.id ? updated : item),
            error: null,
            mutationError: null,
          }))
          return updated
        } catch (error) {
          const mapped = resolveTaskSpaceMutationError(error)
          set({ error: mapped.message, mutationError: { targetId: workItemId, code: mapped.code } })
          throw error
        } finally {
          endMutation(workItemId)
        }
      },

      reset() {
        hydrationSequence += 1
        mutationGuards.clear()
        // Flush any debounced edit before clearing so logout/reset never drops
        // a dirty Note.  The page-level before-switch listener already flushed
        // this while the space DB was still open; on failure the controller
        // keeps the re-pended edit as a retryable draft.
        const flushing = flushPendingNoteBestEffort('logout')
        if (!flushing) noteAutosave = null
        set(initialState())
      },
    }
  }, { name: 'task-space-store' }),
)
