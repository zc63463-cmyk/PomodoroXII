import { acceptedMutationSchema, assertResponseSpace, definitionsSchema, projectSchema, workItemSchema, type TaskSpaceDefinitions, type WorkItem } from '@/lib/contracts/task-space'
import type { JsonValue } from '@/lib/contracts/payload-hash'
import {
  canonicalNow,
  executeDurableDirectCommand,
  prepareDirectCommandIntent,
  resumePendingDirectCommandIntents,
} from '@/lib/direct-command-intents'
import type { PomodoroXIDB } from '@/services/database'
import { taskSpaceApi } from '@/services/task-space-api'
import type { CachedProject, CachedWorkItem, DirectCommandIntentRow } from '@/types'

export interface CreateWorkItemInput {
  projectId: string
  title: string
  description: string | null
  parentId: string | null
  typeDefinitionId: string | null
  statusDefinitionId: string | null
  priority: string | null
}

export interface MoveWorkItemInput {
  projectId: string
  workItemId: string
  newParentId: string | null
  childRank: number
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

function mapWorkItem(value: unknown, spaceId: string): CachedWorkItem {
  const raw = primaryValue(value, ['workItem', 'work_item'])
  const parsed = workItemSchema.parse({
    id: field(raw, 'id'),
    spaceId,
    projectId: field(raw, 'projectId', 'project_id'),
    displayKey: field(raw, 'displayKey', 'display_key'),
    title: field(raw, 'title'),
    description: field(raw, 'description') ?? null,
    typeDefinitionId: field(raw, 'typeDefinitionId', 'type_definition_id'),
    statusDefinitionId: field(raw, 'statusDefinitionId', 'status_definition_id'),
    priority: field(raw, 'priority') as number | null,
    parentId: (field(raw, 'parentId', 'parent_id') as string | null | undefined) ?? null,
    childRank: field(raw, 'childRank', 'child_rank'),
    depth: field(raw, 'depth'),
    completionWindowStart: field(raw, 'completionWindowStart', 'completion_window_start') ?? null,
    completionWindowEnd: field(raw, 'completionWindowEnd', 'completion_window_end') ?? null,
    reviewPoint: field(raw, 'reviewPoint', 'review_point') ?? null,
    hardDeadline: field(raw, 'hardDeadline', 'hard_deadline') ?? null,
    effortEstimateLowerSeconds: field(raw, 'effortEstimateLowerSeconds', 'effort_estimate_lower_seconds') ?? null,
    effortEstimateUpperSeconds: field(raw, 'effortEstimateUpperSeconds', 'effort_estimate_upper_seconds') ?? null,
    effortActualSeconds: field(raw, 'effortActualSeconds', 'effort_actual_seconds'),
    confidence: field(raw, 'confidence') ?? null,
    completedAt: field(raw, 'completedAt', 'completed_at') ?? null,
    cancelledAt: field(raw, 'cancelledAt', 'cancelled_at') ?? null,
    archivedAt: field(raw, 'archivedAt', 'archived_at') ?? null,
    markedAsAttention: field(raw, 'markedAsAttention', 'marked_as_attention'),
    version: field(raw, 'version'),
    createdAt: field(raw, 'createdAt', 'created_at'),
    updatedAt: field(raw, 'updatedAt', 'updated_at'),
  })
  return withoutSpace(assertResponseSpace(parsed, spaceId))
}

function mapDefinitions(value: unknown): TaskSpaceDefinitions {
  return definitionsSchema.parse(value)
}

interface WorkItemMutationResult {
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
  }> {
    const [projects, workItems, statuses, types, labels] = await Promise.all([
      this.db.projects.toArray(), this.db.workItems.toArray(),
      this.db.statusDefinitions.toArray(), this.db.typeDefinitions.toArray(),
      this.db.labels.toArray(),
    ])
    const definitions = statuses.length || types.length || labels.length
      ? mapDefinitions({ statuses, types, labels })
      : null
    return {
      projects: projects as CachedProject[],
      workItems: workItems as CachedWorkItem[],
      definitions,
    }
  }

  async refreshOverview(): Promise<{
    projects: CachedProject[]
    workItems: CachedWorkItem[]
    definitions: TaskSpaceDefinitions
  }> {
    const [projectsWire, definitionsWire] = await Promise.all([
      allPages((cursor) => this.api.listProjects(this.spaceId, cursor)),
      this.api.listDefinitions(this.spaceId),
    ])
    const projects = projectsWire.map((item) => mapProject(item, this.spaceId))
    const workItemsWire: WorkItem[] = []
    for (const project of projectsWire) {
      const items = await allPages((cursor) => this.api.listWorkItems(this.spaceId, project.id, cursor))
      workItemsWire.push(...items)
    }
    const workItems = workItemsWire.map((item) => mapWorkItem(item, this.spaceId))
    const definitions = mapDefinitions(definitionsWire)
    await this.db.transaction(
      'rw', this.db.projects, this.db.workItems,
      this.db.statusDefinitions, this.db.typeDefinitions, this.db.labels,
      async () => {
        await this.db.projects.bulkPut(projects)
        await this.db.workItems.bulkPut(workItems)
        await this.db.statusDefinitions.clear()
        await this.db.typeDefinitions.clear()
        await this.db.labels.clear()
        await this.db.statusDefinitions.bulkPut(definitions.statuses as Record<string, unknown>[])
        await this.db.typeDefinitions.bulkPut(definitions.types as Record<string, unknown>[])
        await this.db.labels.bulkPut(definitions.labels as Record<string, unknown>[])
      },
    )
    return { projects, workItems, definitions }
  }

  async hydrate(projectId?: string) {
    if (!projectId) return this.refreshOverview()
    const page = await allPages((cursor) => this.api.listWorkItems(this.spaceId, projectId, cursor))
    const workItems = page.map((item) => mapWorkItem(item, this.spaceId))
    await this.db.workItems.bulkPut(workItems)
    return { cached: await this.db.workItems.where('projectId').equals(projectId).toArray(), remote: workItems }
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
      request: { ...input, expectedVersion: (cached as CachedWorkItem).version, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, (request) => this.api.moveWorkItem(request as never))
      .then((result) => result.workItem)
  }

  async updateWorkItem(input: {
    workItemId: string
    title?: string
    description?: string | null
    priority?: string | null
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

  async resumePendingDirectCommandIntents(): Promise<void> {
    await resumePendingDirectCommandIntents(this.db, {
      create_project: { executeExact: (intent) => this.executeProjectIntent(intent) },
      create_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.createWorkItem(request as never)).then(() => undefined) },
      update_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.updateWorkItem(request as never)).then(() => undefined) },
      move_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.moveWorkItem(request as never)).then(() => undefined) },
      transition_work_item: { executeExact: (intent) => this.executeWorkItemIntent(intent, (request) => this.api.transitionWorkItem(request as never)).then(() => undefined) },
      submit_review: { executeExact: async () => { throw new Error('submit_review_handler_not_bound') } },
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

  private executeWorkItemIntent(
    intent: DirectCommandIntentRow,
    send: (request: Record<string, JsonValue>) => Promise<unknown>,
  ) {
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.projects, this.db.workItems],
      sendExactRequest: send,
      parseResult: (value) => mapWorkItemMutation(value, this.spaceId),
      applyResult: async (result) => {
        await this.db.workItems.put(result.workItem)
        if (result.project) await this.db.projects.put(result.project)
      },
      now: canonicalNow,
    })
  }
}
