import { acceptedMutationSchema, assertResponseSpace, definitionsSchema, labelSchema, projectSchema, relationSchema, workItemSchema, type CachedRelation, type RelationSet, type TaskSpaceDefinitions, type WorkItemPriority, type WorkItemView } from '@/lib/contracts/task-space'
import { relationId } from '@/lib/task-space/relation-id'
import type { JsonValue } from '@/lib/contracts/payload-hash'
import {
  canonicalNow,
  executeDurableDirectCommand,
  prepareDirectCommandIntent,
  resumePendingDirectCommandIntents,
  type DirectCommandResumeResult,
} from '@/lib/direct-command-intents'
// ★ 2026-09-11：depth 是读模型派生值 —— 实体契约不含它，读取边界统一派生
// （唯一实现），无法派生的行必须可见（unresolved + 日志 + 调用方重拉）。
import {
  buildWorkItemReadModel,
  projectWorkItemEntityRow,
  resolveWorkItemDepths,
  type WorkItemEntityRow,
} from '@/lib/task-space/work-item-read-model'
// ★ 2026-09-11：submit_review 绑定共享执行器 —— 请求构造/结果应用与会话侧同一份
// 实现，tasks 侧不再维护自己的（曾是可抛错桩）。
import { applyAuthoritativeReviewAndClearDraft } from '@/lib/focus-session/focus-session-repository'
import { executeSubmitReviewIntent } from '@/lib/focus-session/review-intent-executor'
import type { PomodoroXIDB } from '@/services/database'
import { taskSpaceApi } from '@/services/task-space-api'
import type { CachedProject, CachedWorkItem, CachedLabel, DirectCommandIntentRow } from '@/types'

export interface CreateRelationInput {
  fromWorkItemId: string
  toWorkItemId: string
  relationType: string
}

export interface RemoveRelationInput {
  fromWorkItemId: string
  toWorkItemId: string
  relationType: string
}

export interface CreateWorkItemInput {
  projectId: string
  title: string
  description: string | null
  parentId: string | null
  typeDefinitionId: string | null
  statusDefinitionId: string | null
  // ★ 2026-09-11：值域类型与后端 contracts / zod enum 同源，杜绝自由文本。
  priority: WorkItemPriority | null
}

export interface MoveWorkItemInput {
  projectId: string
  workItemId: string
  newParentId: string | null
}

export interface TransitionWorkItemInput {
  workItemId: string
  statusDefinitionId: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const field = (value: Record<string, unknown>, camel: string, snake = camel): unknown =>
  value[camel] ?? value[snake]

const withoutSpace = <T extends { spaceId: string }>(row: T): Omit<T, 'spaceId'> => {
  const { spaceId: _verified, ...persisted } = row
  return persisted
}

function unwrapMutation(value: unknown): Record<string, unknown> {
  if (isRecord(value) && typeof value.commandId === 'string' && 'value' in value) {
    const accepted = acceptedMutationSchema.parse(value)
    return isRecord(accepted.value) ? accepted.value : {}
  }
  return isRecord(value) ? value : {}
}

function primaryValue(value: unknown, names: readonly string[]): Record<string, unknown> {
  const unwrapped = unwrapMutation(value)
  for (const name of names) {
    const candidate = unwrapped[name]
    if (isRecord(candidate)) return candidate
  }
  return unwrapped
}

function mapProject(value: unknown, spaceId: string): CachedProject {
  const raw = primaryValue(value, ['project'])
  const parsed = projectSchema.parse({
    id: field(raw, 'id'),
    spaceId,
    name: field(raw, 'name'),
    key: field(raw, 'key'),
    description: field(raw, 'description') ?? null,
    nextWorkItemNumber: field(raw, 'nextWorkItemNumber', 'next_work_item_number'),
    rank: field(raw, 'rank'),
    archivedAt: field(raw, 'archivedAt', 'archived_at') ?? null,
    version: field(raw, 'version'),
    createdAt: field(raw, 'createdAt', 'created_at'),
    updatedAt: field(raw, 'updatedAt', 'updated_at'),
  })
  return withoutSpace(assertResponseSpace(parsed, spaceId))
}

/**
 * wire / 命令响应 → **实体行**（无 depth）。
 * ★ 2026-09-11：depth 不是实体字段，这里不再解析它；UI 所需的 depth 由读取
 * 边界 `buildWorkItemReadModel` / `resolveWorkItemDepths` 派生（唯一实现）。
 * 字段投影复用共享的 `projectWorkItemEntityRow`（camel/snake 双兼容），避免
 * 「读边界」与「映射」两份字段表漂移。
 */
function mapWorkItem(value: unknown, spaceId: string): WorkItemEntityRow {
  const raw = primaryValue(value, ['workItem', 'work_item'])
  const parsed = workItemSchema.parse({ ...projectWorkItemEntityRow(raw), spaceId })
  return withoutSpace(assertResponseSpace(parsed, spaceId))
}

function mapLabel(value: unknown): CachedLabel {
  const raw = primaryValue(value, ['label'])
  return labelSchema.parse({
    id: field(raw, 'id'),
    name: field(raw, 'name'),
    color: field(raw, 'color') ?? null,
    archivedAt: field(raw, 'archivedAt', 'archived_at') ?? null,
    version: field(raw, 'version'),
    createdAt: field(raw, 'createdAt', 'created_at'),
    updatedAt: field(raw, 'updatedAt', 'updated_at'),
  })
}

function mapDefinitions(value: unknown): TaskSpaceDefinitions {
  return definitionsSchema.parse(value)
}

/** Cached relation row: the local copy never repeats space identity. */
function mapRelation(value: unknown): CachedRelation {
  const raw = primaryValue(value, ['relation'])
  const parsed = relationSchema.parse({
    id: field(raw, 'id'),
    spaceId: field(raw, 'spaceId', 'space_id'),
    fromWorkItemId: field(raw, 'fromWorkItemId', 'from_work_item_id'),
    toWorkItemId: field(raw, 'toWorkItemId', 'to_work_item_id'),
    relationType: field(raw, 'relationType', 'relation_type'),
    // ★ 2026-09-12（D2 / ADR-0004）：服务端自持的确认两列（只读消费）。
    resolution: field(raw, 'resolution') ?? null,
    resolvedAt: field(raw, 'resolvedAt', 'resolved_at') ?? null,
    version: field(raw, 'version'),
    createdAt: field(raw, 'createdAt', 'created_at'),
    updatedAt: field(raw, 'updatedAt', 'updated_at'),
  })
  return withoutSpace(assertResponseSpace(parsed, parsed.spaceId))
}

interface WorkItemMutationResult {
  /** ★ 2026-09-11：post-image 是实体行（无 depth）；depth 由调用方在读边界派生。 */
  workItem: WorkItemEntityRow
  project: CachedProject | null
}

/**
 * ★ 2026-09-12（ADR-0003）：命令响应里的等待前态（wire 值，只在线消费）。
 * 实体行 / 本地行不设值；落库前由 applyResult 剥离，保证 Dexie 不存。
 */
function readPreWaitingFromWire(value: unknown): string | null {
  const raw = primaryValue(value, ['workItem', 'work_item'])
  const candidate = raw.preWaitingStatusDefinitionId ?? raw.pre_waiting_status_definition_id
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

/** ★ 2026-09-11：读取边界之后的行（带派生 depth），store/UI 只消费这个形状。 */
interface WorkItemMutationResultWithDepth {
  workItem: CachedWorkItem
  project: CachedProject | null
}

function mapWorkItemMutation(value: unknown, spaceId: string): WorkItemMutationResult {
  const raw = unwrapMutation(value)
  const project = isRecord(raw.project) ? mapProject(raw.project, spaceId) : null
  return { workItem: mapWorkItem(value, spaceId), project }
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

async function allPages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const result: T[] = []
  let cursor: string | undefined
  do {
    const page = await read(cursor)
    result.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return result
}

export class TaskSpaceRepository {
  constructor(
    private readonly db: PomodoroXIDB,
    private readonly spaceId: string,
    private readonly api = taskSpaceApi,
  ) {
    if (db.spaceId !== spaceId) throw new Error('task_space_repository_database_mismatch')
  }

  async readCachedOverview(): Promise<{
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions | null
    unresolvedDepthItemIds: string[]
  }> {
    const [projects, workItems, statuses, types, labels] = await Promise.all([
      this.db.projects.toArray(), this.db.workItems.toArray(),
      this.db.statusDefinitions.toArray(), this.db.typeDefinitions.toArray(),
      this.db.labels.toArray(),
    ])
    const definitions = statuses.length || types.length || labels.length
      ? mapDefinitions({ statuses, types, labels })
      : null
    // ★ 2026-09-11：本地行（含 sync pull 落下的 wire 形状行、历史无 depth 行）
    // 一律在读取边界投影 + 派生 depth；缺父链的行进 unresolved（可见 + 可重拉）。
    const readModel = buildWorkItemReadModel(workItems)
    if (readModel.unresolvedIds.length > 0) {
      console.warn(
        '[task-space] work item depth unresolved on cached read',
        readModel.unresolvedIds.length,
      )
    }
    return {
      projects: projects as CachedProject[],
      workItems: readModel.items,
      definitions,
      unresolvedDepthItemIds: readModel.unresolvedIds,
    }
  }

  async refreshOverview(): Promise<{
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions
    unresolvedDepthItemIds: string[]
  }> {
    const [projectsWire, definitionsWire] = await Promise.all([
      allPages((cursor) => this.api.listProjects(this.spaceId, cursor)),
      this.api.listDefinitions(this.spaceId),
    ])
    const projects = projectsWire.map((item) => mapProject(item, this.spaceId))
    const workItemsWire: WorkItemView[] = []
    for (const project of projectsWire) {
      const items = await allPages((cursor) => this.api.listWorkItems(this.spaceId, project.id, cursor))
      workItemsWire.push(...items)
    }
    // 落库的永远是实体行（无 depth）；返回给 UI 的是读模型行（派生 depth）。
    const entities = workItemsWire.map((item) => mapWorkItem(item, this.spaceId))
    // ★ 2026-09-12（ADR-0003）：只有 wire 读路径消费等待前态（本地行忽略）。
    const readModel = buildWorkItemReadModel(workItemsWire, {
      consumePreWaitingFromRaw: true,
    })
    const definitions = mapDefinitions(definitionsWire)
    // Scoped reconcile after a FULL successful pagination: drop cached rows the
    // server no longer returns for this space.  The Dexie database is
    // space-scoped, so this never touches another space's data; work items
    // whose project disappeared remotely are also removed (they are not part of
    // any remote project page).
    const remoteProjectIds = new Set(projects.map((project) => project.id))
    const remoteWorkItemIds = new Set(entities.map((item) => item.id))
    await this.db.transaction(
      'rw', this.db.projects, this.db.workItems,
      this.db.statusDefinitions, this.db.typeDefinitions, this.db.labels,
      async () => {
        await this.db.projects.bulkPut(projects)
        await this.db.workItems.bulkPut(entities)
        await this.db.projects
          .filter((row) => !remoteProjectIds.has(String(row.id)))
          .delete()
        await this.db.workItems
          .filter((row) => !remoteWorkItemIds.has(String(row.id)))
          .delete()
        await this.db.statusDefinitions.clear()
        await this.db.typeDefinitions.clear()
        await this.db.labels.clear()
        await this.db.statusDefinitions.bulkPut(definitions.statuses as Record<string, unknown>[])
        await this.db.typeDefinitions.bulkPut(definitions.types as Record<string, unknown>[])
        await this.db.labels.bulkPut(definitions.labels as Record<string, unknown>[])
      },
    )
    return {
      projects,
      workItems: readModel.items,
      definitions,
      unresolvedDepthItemIds: readModel.unresolvedIds,
    }
  }

  async hydrate(projectId?: string) {
    if (!projectId) return this.refreshOverview()
    const page = await allPages((cursor) => this.api.listWorkItems(this.spaceId, projectId, cursor))
    const entities = page.map((item) => mapWorkItem(item, this.spaceId))
    // ★ 2026-09-12（ADR-0003）：remote 分支是 wire 行 ⇒ 消费等待前态；
    // cached 分支（下方）不传 ⇒ 忽略本地值。
    const remoteReadModel = buildWorkItemReadModel(page, {
      consumePreWaitingFromRaw: true,
    })
    // Project-scoped reconcile: delete cached work items for THIS project that
    // the server no longer returns.  Rows of other projects/spaces are never
    // touched.
    const remoteIds = new Set(entities.map((item) => item.id))
    await this.db.transaction('rw', this.db.workItems, async () => {
      await this.db.workItems.bulkPut(entities)
      await this.db.workItems
        .filter((row) => String(row.projectId) === projectId && !remoteIds.has(String(row.id)))
        .delete()
    })
    // ★ 2026-09-11：cached 分支也走读模型（wire 形状/历史行都能投影 + 派生 depth）。
    const cachedReadModel = buildWorkItemReadModel(await this.db.workItems.toArray())
    return {
      cached: cachedReadModel.items.filter((item) => item.projectId === projectId),
      remote: remoteReadModel.items,
      unresolvedDepthItemIds: [...new Set([
        ...cachedReadModel.unresolvedIds, ...remoteReadModel.unresolvedIds,
      ])].sort(),
    }
  }

  async hydrateProjectTree(projectId: string) {
    return this.hydrate(projectId)
  }

  async loadTree(projectId: string) {
    return this.hydrate(projectId)
  }

  async createProject(input: { name: string; key: string; description: string | null }) {
    if (!online()) throw new Error('offline_formal_creation_forbidden')
    const normalized = { ...input, key: input.key.trim().toUpperCase() }
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'create_project', spaceId: this.spaceId, targetId: normalized.key,
      request: { ...normalized, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.projects],
      sendExactRequest: (request) => this.api.createProject(request as never),
      parseResult: (value) => mapProject(value, this.spaceId),
      applyResult: async (project) => { await this.db.projects.put(project) },
      now: canonicalNow,
    })
  }

  async createWorkItem(input: CreateWorkItemInput) {
    if (!online()) throw new Error('offline_formal_creation_forbidden')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'create_work_item', spaceId: this.spaceId, targetId: null,
      request: { ...input, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.createWorkItem(request as never))
      .then((result) => result.workItem)
  }

  async moveWorkItem(input: MoveWorkItemInput) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'move_work_item', spaceId: this.spaceId, targetId: input.workItemId,
      // childRank is intentionally absent: the server assigns the
      // authoritative append-only rank.
      request: { ...input, expectedVersion: (cached as CachedWorkItem).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.moveWorkItem(request as never))
      .then((result) => result.workItem)
  }

  async updateWorkItem(input: {
    workItemId: string
    title?: string
    description?: string | null
    // ★ 2026-09-11：与 create 同一受限值域。
    priority?: WorkItemPriority | null
    typeDefinitionId?: string | null
  }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'update_work_item', spaceId: this.spaceId, targetId: input.workItemId,
      request: { ...input, expectedVersion: (cached as CachedWorkItem).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.updateWorkItem(request as never))
      .then((result) => result.workItem)
  }

  async transitionWorkItem(input: TransitionWorkItemInput) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'transition_work_item', spaceId: this.spaceId, targetId: input.workItemId,
      request: { ...input, expectedVersion: (cached as CachedWorkItem).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.transitionWorkItem(request as never))
      .then((result) => result.workItem)
  }

  /** archived_at lifecycle: the server stamps the timestamp, so the request
   * carries no business value at all. */
  async trashWorkItem(input: { workItemId: string }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'trash_work_item', spaceId: this.spaceId, targetId: input.workItemId,
      request: { ...input, expectedVersion: (cached as CachedWorkItem).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.trashWorkItem(request as never))
      .then((result) => result.workItem)
  }

  async restoreWorkItem(input: { workItemId: string }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'restore_work_item', spaceId: this.spaceId, targetId: input.workItemId,
      request: { ...input, expectedVersion: (cached as CachedWorkItem).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.restoreWorkItem(request as never))
      .then((result) => result.workItem)
  }

  // ---- Dependency domain -------------------------------------------------

  async listRelations(workItemId: string): Promise<RelationSet> {
    return this.api.listRelations(this.spaceId, workItemId)
  }

  /**
   * 本地双向边（只读 Dexie，不走网络）—— 会话启动判定必须在离线时也
   * 成立，而 ``listRelations`` 是网络优先。relations 表是同步落地的本地
   * 事实；个人量级全表扫描足够，不为它新增 Dexie 索引。
   */
  async listCachedRelations(workItemId: string): Promise<CachedRelation[]> {
    const rows = await this.db.relations.toArray()
    return (rows as Array<Partial<CachedRelation>>).filter(
      (row): row is CachedRelation => (
        typeof row.fromWorkItemId === 'string'
        && typeof row.toWorkItemId === 'string'
        && typeof row.relationType === 'string'
        && (row.fromWorkItemId === workItemId || row.toWorkItemId === workItemId)
      ),
    )
  }

  async listBlockedMap(projectId?: string) {
    return this.api.listBlockedMap(this.spaceId, projectId)
  }

  async createRelation(input: CreateRelationInput) {
    if (!online()) throw new Error('offline_formal_creation_forbidden')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'create_relation', spaceId: this.spaceId, targetId: null,
      request: { ...input, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeRelationIntent(intent, (request) => this.api.createRelation(request as never))
  }

  async removeRelation(input: RemoveRelationInput) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const relationKey = await relationId(
      this.spaceId, input.fromWorkItemId, input.toWorkItemId, input.relationType,
    )
    const cached = await this.db.relations.get(relationKey)
    const expectedVersion = (cached as { version?: number } | undefined)?.version
    if (typeof expectedVersion !== 'number') throw new Error('relation_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'remove_relation', spaceId: this.spaceId, targetId: relationKey,
      request: {
        ...input, relationId: relationKey, expectedVersion, spaceId: this.spaceId,
      }, now: canonicalNow(),
    })
    return this.executeRelationIntent(intent, (request) => this.api.removeRelation(request as never))
  }

  /**
   * ★ 2026-09-12（D2 / ADR-0004）：确认「已取消的上游不再需要」。
   * online-only（relation 变更全部如此）；expectedVersion 从缓存行取；
   * 幂等 CAS —— 重复确认是零效果回执，服务端不 bump version。
   */
  async resolveRelation(input: RemoveRelationInput) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const relationKey = await relationId(
      this.spaceId, input.fromWorkItemId, input.toWorkItemId, input.relationType,
    )
    const cached = await this.db.relations.get(relationKey)
    const expectedVersion = (cached as { version?: number } | undefined)?.version
    if (typeof expectedVersion !== 'number') throw new Error('relation_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'resolve_relation', spaceId: this.spaceId, targetId: relationKey,
      request: {
        ...input, relationId: relationKey, expectedVersion, spaceId: this.spaceId,
      }, now: canonicalNow(),
    })
    return this.executeRelationIntent(intent, (request) => this.api.resolveRelation(request as never))
  }

  // D5 Y: label-set mutation — the target label_ids set is computed client
  // side as the full post-mutation union, then converged server side by
  // read-modify-write inside one CAS-guarded command.
  async addWorkItemLabels(input: { workItemId: string; labelIds: string[] }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const target = [...new Set([...(cached as CachedWorkItem).labelIds, ...input.labelIds])]
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'add_work_item_labels', spaceId: this.spaceId, targetId: input.workItemId,
      request: { workItemId: input.workItemId, expectedVersion: (cached as CachedWorkItem).version, labelIds: target, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.addWorkItemLabels(request as never))
      .then((result) => result.workItem)
  }

  async removeWorkItemLabel(input: { workItemId: string; labelId: string }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const target = (cached as CachedWorkItem).labelIds.filter((id) => id !== input.labelId)
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'remove_work_item_labels', spaceId: this.spaceId, targetId: input.workItemId,
      request: { workItemId: input.workItemId, expectedVersion: (cached as CachedWorkItem).version, labelIds: target, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.removeWorkItemLabels(request as never))
      .then((result) => result.workItem)
  }

  // D5 Y: label definition lifecycle.
  async createLabel(input: { name: string; color?: string | null }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'create_label', spaceId: this.spaceId, targetId: null,
      request: { ...input, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeLabelIntent(intent, (request) => this.api.createLabel(request as never))
  }

  async updateLabel(input: { labelId: string; name?: string; color?: string | null }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.labels.get(input.labelId)
    if (!cached) throw new Error('label_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'update_label', spaceId: this.spaceId, targetId: input.labelId,
      request: { ...input, expectedVersion: (cached as CachedLabel).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeLabelIntent(intent, (request) => this.api.updateLabel(request as never))
  }

  async archiveLabel(input: { labelId: string }) {
    if (!online()) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.labels.get(input.labelId)
    if (!cached) throw new Error('label_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'archive_label', spaceId: this.spaceId, targetId: input.labelId,
      request: { ...input, expectedVersion: (cached as CachedLabel).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeLabelIntent(intent, (request) => this.api.archiveLabel(request as never))
  }

  async resumePendingDirectCommandIntents(): Promise<DirectCommandResumeResult> {
    return resumePendingDirectCommandIntents(this.db, {
      create_project: { executeExact: (intent) => this.executeProjectIntent(intent) },
      create_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.createWorkItem(request as never)).then(() => undefined) },
      update_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.updateWorkItem(request as never)).then(() => undefined) },
      move_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.moveWorkItem(request as never)).then(() => undefined) },
      transition_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.transitionWorkItem(request as never)).then(() => undefined) },
      trash_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.trashWorkItem(request as never)).then(() => undefined) },
      restore_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.restoreWorkItem(request as never)).then(() => undefined) },
      create_relation: { executeExact: (intent) => this.executeRelationIntent(intent, (request) => this.api.createRelation(request as never)).then(() => undefined) },
      remove_relation: { executeExact: (intent) => this.executeRelationIntent(intent, (request) => this.api.removeRelation(request as never)).then(() => undefined) },
      resolve_relation: { executeExact: (intent) => this.executeRelationIntent(intent, (request) => this.api.resolveRelation(request as never)).then(() => undefined) },
      add_work_item_labels: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.addWorkItemLabels(request as never)).then(() => undefined) },
      remove_work_item_labels: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.removeWorkItemLabels(request as never)).then(() => undefined) },
      create_label: { executeExact: (intent) => this.executeLabelIntent(intent, (request) => this.api.createLabel(request as never)).then(() => undefined) },
      update_label: { executeExact: (intent) => this.executeLabelIntent(intent, (request) => this.api.updateLabel(request as never)).then(() => undefined) },
      archive_label: { executeExact: (intent) => this.executeLabelIntent(intent, (request) => this.api.archiveLabel(request as never)).then(() => undefined) },
      // ★ 2026-09-11：绑定共享执行器（此前是抛错桩，会让整批续跑在第一条
      // submit_review 上终止）。执行走 prepare/executeDurableDirectCommand，
      // 保持幂等与 durable 语义；失败由队列按 intent 记录并继续后续 intent。
      submit_review: {
        executeExact: async (intent) => {
          await executeSubmitReviewIntent({
            db: this.db,
            intent,
            applyAuthoritativeReview: applyAuthoritativeReviewAndClearDraft,
          })
        },
      },
    })
  }

  private executeProjectIntent(intent: DirectCommandIntentRow) {
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.projects],
      sendExactRequest: (request) => this.api.createProject(request as never),
      parseResult: (value) => mapProject(value, this.spaceId),
      applyResult: async (project) => { await this.db.projects.put(project) },
      now: canonicalNow,
    }).then(() => undefined)
  }

  private async executeWorkItemIntent(
    intent: DirectCommandIntentRow,
    send: (request: Record<string, JsonValue>) => Promise<unknown>,
  ) {
    // ★ 2026-09-11：命令的 post-image 不含 depth（它不是实体字段）。返回给 store
    // 的行必须在读取边界补上派生 depth —— 否则调用方（store 的 splice / 选中
    // 逻辑）拿到没有层级的行，UI 又会静默丢失它。
    const localRows = (await this.db.workItems.toArray()).map(projectWorkItemEntityRow)
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.projects, this.db.workItems],
      sendExactRequest: send,
      parseResult: (value): WorkItemMutationResultWithDepth => {
        const mapped = mapWorkItemMutation(value, this.spaceId)
        const resolution = resolveWorkItemDepths([...localRows, mapped.workItem])
        return {
          ...mapped,
          workItem: {
            ...mapped.workItem,
            // 断链/异常时按待定根（1）处理：让行可见，而不是从树里消失。
            depth: resolution.depths.get(mapped.workItem.id) ?? 1,
            // ★ 2026-09-12（ADR-0003）：等待前态从**本次 wire 响应**取值（与 depth
            // 同一处补值）；落库前被 applyResult 剥离 —— 只有 wire 路径可消费。
            preWaitingStatusDefinitionId: readPreWaitingFromWire(value),
          },
        }
      },
      applyResult: async (result) => {
        // 落库的仍是实体行（depth 与等待前态不落库：depth 是读模型派生值，
        // 等待前态是只允许 wire 消费的服务端事实）。
        const {
          depth: _derivedDepth,
          preWaitingStatusDefinitionId: _wireOnlyPriorState,
          ...entity
        } = result.workItem
        await this.db.workItems.put(entity)
        if (result.project) await this.db.projects.put(result.project)
      },
      now: canonicalNow,
    })
  }

  private executeRelationIntent(
    intent: DirectCommandIntentRow,
    send: (request: Record<string, JsonValue>) => Promise<unknown>,
  ) {
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.relations],
      sendExactRequest: send,
      parseResult: (value) => mapRelation(value),
      applyResult: async (relation) => { await this.db.relations.put(relation) },
      now: canonicalNow,
    })
  }

  private executeLabelIntent(
    intent: DirectCommandIntentRow,
    send: (request: Record<string, JsonValue>) => Promise<unknown>,
  ) {
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.labels, this.db.workItems],
      sendExactRequest: send,
      parseResult: (value) => mapLabel(value),
      applyResult: async (label) => { await this.db.labels.put(label) },
      now: canonicalNow,
    })
  }
}
