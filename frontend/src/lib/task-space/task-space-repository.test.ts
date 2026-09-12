import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalize } from 'json-canonicalize'
import { spaceApi } from '@/services/api'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { taskSpaceApi } from '@/services/task-space-api'
import { canonicalNow, prepareDirectCommandIntent } from '@/lib/direct-command-intents'
import { relationId } from './relation-id'
import { TaskSpaceRepository } from './task-space-repository'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []
afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
})

const projectWire = (id: string) => ({
  id,
  key: 'RM',
  name: 'Roadmap',
  description: null,
  rank: 0,
  next_work_item_number: 2,
  default_status_definition_id: 'status-not-started',
  default_type_definition_id: 'type-task',
  archived_at: null,
  version: 2,
  created_at: '2026-07-15T08:00:00.000Z',
  updated_at: '2026-07-15T08:01:00.000Z',
})

const workItemWire = (id: string, projectId: string) => ({
  id,
  project_id: projectId,
  display_key: 'RM-1',
  title: 'First item',
  description: null,
  type_definition_id: 'type-task',
  status_definition_id: 'status-not-started',
  priority: null,
  parent_id: null,
  child_rank: 0,
  depth: 1,
  completion_window_start: null,
  completion_window_end: null,
  review_point: null,
  hard_deadline: null,
  effort_estimate_lower_seconds: null,
  effort_estimate_upper_seconds: null,
  effort_actual_seconds: 0,
  confidence: null,
  completed_at: null,
  cancelled_at: null,
  archived_at: null,
  marked_as_attention: false,
  version: 1,
  created_at: '2026-07-15T08:00:00.000Z',
  updated_at: '2026-07-15T08:00:00.000Z',
})

/**
 * ★ 2026-09-11 权威 review 聚合响应夹具（形状与 focus-session-repository.test.ts
 * 中已验证过的 aggregateFixture 一致，只是把会话置为 ended + review completed）。
 */
const reviewAggregateFixture = (spaceId: string) => ({
  session: {
    id: 'fs-1', spaceId, sessionRevision: 1,
    startedAt: '2026-07-15T08:00:00Z', endedAt: '2026-07-15T08:25:00Z', pauseStartedAt: null,
    plannedSeconds: 1500, grossSeconds: 1500, pausedSeconds: 0,
    breakSeconds: 0, focusedSeconds: 1500, timerCompletion: 'completed',
    validity: 'valid', validityReason: null, overallProgress: null, mood: null,
    reviewState: 'completed', ownershipState: 'authoritative', sessionNote: '',
    version: 4, createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:25:00Z',
    clockState: 'ended',
  },
  context: null,
  attribution: {
    id: 'attr-1', spaceId, sessionId: 'fs-1', revision: 1,
    projectId: 'project-1', level2WorkItemId: 'l2', reason: null,
    correctedFromRevision: null, effective: true,
    version: 1, createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  },
  plan: [],
  outcomes: [],
  commandEnvelopes: [],
  commandReceipts: [],
})

async function fixture() {
  const db = await openPomodoroXIDB(crypto.randomUUID())
  databases.push(db)
  const api = {
    ...taskSpaceApi,
    createProject: vi.fn(),
    createWorkItem: vi.fn(),
    moveWorkItem: vi.fn(),
    transitionWorkItem: vi.fn(),
    trashWorkItem: vi.fn(),
    restoreWorkItem: vi.fn(),
    listProjects: vi.fn(),
    listWorkItems: vi.fn(),
    listDefinitions: vi.fn(),
    // ★ D2 / ADR-0004：解除确认（online-only 命令）。
    resolveRelation: vi.fn(),
  }
  return { db, api, spaceId: db.spaceId }
}

describe('TaskSpaceRepository', () => {
  it('normalizes and durably caches a project command result', async () => {
    const { db, api, spaceId } = await fixture()
    api.createProject.mockResolvedValue({
      commandId: 'project-op', entityType: 'project', entityId: 'project-1', version: 2,
      value: projectWire('project-1'),
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)
    const project = await repository.createProject({ name: 'Roadmap', key: ' rm ', description: null })
    expect(project).toMatchObject({ id: 'project-1', key: 'RM', name: 'Roadmap' })
    expect(project).not.toHaveProperty('spaceId')
    expect(await db.projects.get('project-1')).toMatchObject({ id: 'project-1', key: 'RM' })
    expect((await db.directCommandIntents.toArray())[0]).toMatchObject({ state: 'terminal' })
    expect(api.createProject).toHaveBeenCalledWith(expect.objectContaining({ key: 'RM', operationId: expect.any(String) }))
  })

  it('caches both WorkItem and Project post-images from one accepted command', async () => {
    const { db, api, spaceId } = await fixture()
    api.createWorkItem.mockResolvedValue({
      commandId: 'work-op', entityType: 'work_item', entityId: 'work-1', version: 1,
      value: { project: projectWire('project-1'), work_item: workItemWire('work-1', 'project-1') },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)
    const item = await repository.createWorkItem({
      projectId: 'project-1', title: 'First item', description: null,
      parentId: null, typeDefinitionId: null, statusDefinitionId: null, priority: null,
    })
    expect(item).toMatchObject({ id: 'work-1', projectId: 'project-1', version: 1 })
    expect(await db.workItems.get('work-1')).toMatchObject({ id: 'work-1' })
    expect(await db.projects.get('project-1')).toMatchObject({ nextWorkItemNumber: 2 })
  })

  it('refuses formal mutations while offline and captures CAS from the cached version', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 7 })
    const repository = new TaskSpaceRepository(db, spaceId, api)
    const original = navigator.onLine
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await expect(repository.transitionWorkItem({
      workItemId: 'work-1', statusDefinitionId: 'status-done',
    })).rejects.toThrow('offline_formal_mutation_forbidden')
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: original })
  })

  it('caches a Move post-image and marks the intent terminal', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1 })
    api.moveWorkItem.mockResolvedValue({
      commandId: 'move-op', entityType: 'work_item', entityId: 'work-1', version: 2,
      value: {
        project: projectWire('project-1'),
        work_item: { ...workItemWire('work-1', 'project-1'), parent_id: 'l2', child_rank: 3, version: 2 },
      },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)
    const moved = await repository.moveWorkItem({
      projectId: 'project-1', workItemId: 'work-1', newParentId: 'l2',
    })
    expect(moved).toMatchObject({ id: 'work-1', parentId: 'l2', childRank: 3, version: 2 })
    expect(await db.workItems.get('work-1')).toMatchObject({ id: 'work-1', parentId: 'l2', childRank: 3, version: 2 })
    expect((await db.directCommandIntents.toArray())[0]).toMatchObject({ state: 'terminal' })
    expect(api.moveWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', workItemId: 'work-1', newParentId: 'l2',
      expectedVersion: 1, operationId: expect.any(String),
    }))
  })

  it('caches a Transition post-image', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1 })
    api.transitionWorkItem.mockResolvedValue({
      commandId: 'transition-op', entityType: 'work_item', entityId: 'work-1', version: 2,
      value: {
        project: projectWire('project-1'),
        work_item: { ...workItemWire('work-1', 'project-1'), status_definition_id: 'status-done', version: 2 },
      },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)
    const transitioned = await repository.transitionWorkItem({
      workItemId: 'work-1', statusDefinitionId: 'status-done',
    })
    expect(transitioned).toMatchObject({ id: 'work-1', statusDefinitionId: 'status-done', version: 2 })
    expect(await db.workItems.get('work-1')).toMatchObject({ statusDefinitionId: 'status-done', version: 2 })
  })

  it('a failed mutation preserves the previous cached item and never marks the intent terminal', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1, parentId: null })
    const conflict = Object.assign(new Error('Request failed with status code 409'), {
      response: { status: 409, data: { detail: { code: 'version_conflict', retryable: false, details: {} } } },
    })
    api.moveWorkItem.mockRejectedValue(conflict)
    const repository = new TaskSpaceRepository(db, spaceId, api)
    await expect(repository.moveWorkItem({
      projectId: 'project-1', workItemId: 'work-1', newParentId: 'l2',
    })).rejects.toThrow()
    const cached = await db.workItems.get('work-1')
    expect(cached).toMatchObject({ version: 1, parentId: null })
    const intents = await db.directCommandIntents.toArray()
    expect(intents[0]?.state).not.toBe('terminal')
  })

  it('resume reconciliation applies a pending intent exactly once', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1 })
    await prepareDirectCommandIntent(db, {
      kind: 'move_work_item', spaceId, targetId: 'work-1',
      request: {
        projectId: 'project-1', workItemId: 'work-1', expectedVersion: 1,
        newParentId: 'l2', spaceId,
      },
      now: canonicalNow(),
    }, 'fixed-recon-op')
    api.moveWorkItem.mockResolvedValue({
      commandId: 'fixed-recon-op', entityType: 'work_item', entityId: 'work-1', version: 2,
      value: {
        project: projectWire('project-1'),
        work_item: { ...workItemWire('work-1', 'project-1'), parent_id: 'l2', child_rank: 3, version: 2 },
      },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    await repository.resumePendingDirectCommandIntents()
    expect(api.moveWorkItem).toHaveBeenCalledTimes(1)
    expect(await db.workItems.get('work-1')).toMatchObject({ version: 2, parentId: 'l2', childRank: 3 })

    // A second resume must not re-dispatch a terminal intent.
    await repository.resumePendingDirectCommandIntents()
    expect(api.moveWorkItem).toHaveBeenCalledTimes(1)
  })

  it('keeps work items of two spaces with the same id isolated', async () => {
    const { db: dbA, spaceId: spaceA } = await fixture()
    const { db: dbB, spaceId: spaceB } = await fixture()
    expect(spaceA).not.toBe(spaceB)
    const { api } = { api: { ...taskSpaceApi, moveWorkItem: vi.fn(), createWorkItem: vi.fn(), transitionWorkItem: vi.fn() } }

    await dbA.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1, parentId: null })
    await dbB.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1, parentId: null })

    api.moveWorkItem.mockResolvedValue({
      commandId: 'move-op', entityType: 'work_item', entityId: 'work-1', version: 2,
      value: { project: projectWire('project-1'), work_item: { ...workItemWire('work-1', 'project-1'), parent_id: 'l2', version: 2 } },
    })
    const repositoryA = new TaskSpaceRepository(dbA, spaceA, api)
    new TaskSpaceRepository(dbB, spaceB, api)
    await repositoryA.moveWorkItem({ projectId: 'project-1', workItemId: 'work-1', newParentId: 'l2' })

    expect(await dbA.workItems.get('work-1')).toMatchObject({ parentId: 'l2', version: 2 })
    expect(await dbB.workItems.get('work-1')).toMatchObject({ parentId: null, version: 1 })
  })

  it('deletes stale cached Project/WorkItem rows after a full remote pagination', async () => {
    const { db, api, spaceId } = await fixture()
    // Seed stale cache (camelCase cached shape): a project that no longer
    // exists remotely and stale work items (one in a gone project, one in a
    // kept project).
    await db.projects.bulkPut([
      { id: 'project-a', key: 'A', name: 'A', rank: 0, version: 1, createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z' },
      { id: 'project-gone', key: 'GONE', name: 'Gone', rank: 1, version: 1, createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z' },
    ] as never)
    await db.workItems.bulkPut([
      { id: 'work-kept', projectId: 'project-a', version: 1 },
      { id: 'work-gone', projectId: 'project-gone', version: 1 },
      { id: 'work-stale', projectId: 'project-a', version: 1 },
    ] as never)
    api.listProjects.mockResolvedValue({ items: [projectWire('project-a')], nextCursor: null })
    api.listWorkItems.mockResolvedValue({ items: [workItemWire('work-kept', 'project-a')], nextCursor: null })
    api.listDefinitions.mockResolvedValue({ statuses: [], types: [], labels: [] })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const overview = await repository.refreshOverview()

    expect(overview.projects.map((project) => project.id)).toEqual(['project-a'])
    expect(overview.workItems.map((item) => item.id)).toEqual(['work-kept'])
    expect(await db.projects.get('project-gone')).toBeUndefined()
    expect(await db.workItems.get('work-gone')).toBeUndefined()
    expect(await db.workItems.get('work-stale')).toBeUndefined()
    expect(await db.workItems.get('work-kept')).toMatchObject({ id: 'work-kept' })
  })

  it('never deletes rows of another space during a project-scoped reconcile', async () => {
    const { db: dbA, api: apiA, spaceId: spaceA } = await fixture()
    const { db: dbB, spaceId: spaceB } = await fixture()
    expect(spaceA).not.toBe(spaceB)
    // Both DBs carry a work item with the same id for the same project.
    await dbA.workItems.put({ id: 'work-x', projectId: 'project-a', version: 1 } as never)
    await dbB.workItems.put({ id: 'work-x', projectId: 'project-a', version: 1 } as never)
    // Remote no longer returns work-x in space A.
    apiA.listWorkItems.mockResolvedValue({ items: [], nextCursor: null })
    const repositoryA = new TaskSpaceRepository(dbA, spaceA, apiA)

    await repositoryA.hydrate('project-a')

    expect(await dbA.workItems.get('work-x')).toBeUndefined()
    // Space B's copy is untouched.
    expect(await dbB.workItems.get('work-x')).toMatchObject({ id: 'work-x' })
  })

  it('trash: sends the empty business payload and caches the archived post-image', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1 } as never)
    api.trashWorkItem.mockResolvedValue({
      commandId: 'trash-op', entityType: 'work_item', entityId: 'work-1', version: 2,
      value: { ...workItemWire('work-1', 'project-1'), archived_at: '2026-07-15T09:00:00.000Z', version: 2 },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const trashed = await repository.trashWorkItem({ workItemId: 'work-1' })

    expect(trashed).toMatchObject({ id: 'work-1', archivedAt: '2026-07-15T09:00:00.000Z', version: 2 })
    expect(await db.workItems.get('work-1')).toMatchObject({ archivedAt: '2026-07-15T09:00:00.000Z' })
    expect((await db.directCommandIntents.toArray())[0]).toMatchObject({ state: 'terminal', kind: 'trash_work_item' })
    // archived_at is server-owned: no timestamp travels in the request.
    expect(api.trashWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'work-1', expectedVersion: 1, operationId: expect.any(String),
    }))
    expect(api.trashWorkItem.mock.calls[0][0]).not.toHaveProperty('archivedAt')
  })

  it('restore: clears archived_at and marks the intent terminal', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 2 } as never)
    api.restoreWorkItem.mockResolvedValue({
      commandId: 'restore-op', entityType: 'work_item', entityId: 'work-1', version: 3,
      value: { ...workItemWire('work-1', 'project-1'), version: 3 },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const restored = await repository.restoreWorkItem({ workItemId: 'work-1' })

    expect(restored).toMatchObject({ id: 'work-1', archivedAt: null, version: 3 })
    expect(await db.workItems.get('work-1')).toMatchObject({ archivedAt: null })
    expect((await db.directCommandIntents.toArray())[0]).toMatchObject({ state: 'terminal', kind: 'restore_work_item' })
  })

  it('rejects trash/restore for an unloaded work item', async () => {
    const { db, api, spaceId } = await fixture()
    const repository = new TaskSpaceRepository(db, spaceId, api)
    await expect(repository.trashWorkItem({ workItemId: 'missing' })).rejects.toThrow('work_item_not_loaded')
    await expect(repository.restoreWorkItem({ workItemId: 'missing' })).rejects.toThrow('work_item_not_loaded')
  })

  // ------------------------------------------------------------------------- #
  // ★ 2026-09-12（ADR-0003）等待前态：只在 wire 读路径消费。
  //   本地 Dexie 行（sync merge 原样落库的陈旧值）一律忽略 —— 恢复动作离线
  //   必败（offline_formal_mutation_forbidden），消费本地值只会让提示时有时无。
  // ------------------------------------------------------------------------- #

  it('consumes the pre-waiting value from wire reads and never persists it', async () => {
    const { db, api, spaceId } = await fixture()
    api.listProjects.mockResolvedValue({ items: [projectWire('project-1')], nextCursor: null })
    api.listWorkItems.mockResolvedValue({
      items: [{
        ...workItemWire('work-1', 'project-1'),
        pre_waiting_status_definition_id: 'status-paused',
      }],
      nextCursor: null,
    })
    api.listDefinitions.mockResolvedValue({ statuses: [], types: [], labels: [] })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const overview = await repository.refreshOverview()

    expect(overview.workItems[0]).toMatchObject({ preWaitingStatusDefinitionId: 'status-paused' })
    // 落库的是实体行：本地不存该值（离线消费无从谈起）。
    expect(await db.workItems.get('work-1')).not.toHaveProperty('preWaitingStatusDefinitionId')
  })

  it('ignores a stale pre-waiting value already on a local Dexie row', async () => {
    const { db, api, spaceId } = await fixture()
    // 陈旧本地值：模拟历史 sync merge 原样落库 / 上一会话残留。
    await db.workItems.put({
      ...workItemWire('work-1', 'project-1'),
      preWaitingStatusDefinitionId: 'status-stale-paused',
    } as never)
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const cached = await repository.readCachedOverview()

    expect(cached.workItems[0]).not.toHaveProperty('preWaitingStatusDefinitionId')
  })

  it('hydrate exposes the value on remote rows but never on cached rows', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({
      ...workItemWire('work-1', 'project-1'),
      preWaitingStatusDefinitionId: 'status-stale-paused',
    } as never)
    api.listWorkItems.mockResolvedValue({
      items: [{
        ...workItemWire('work-1', 'project-1'),
        pre_waiting_status_definition_id: 'status-fresh-paused',
      }],
      nextCursor: null,
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const result = await repository.hydrate('project-1')
    if (!('remote' in result)) throw new Error('expected the project-scoped hydrate shape')

    expect(result.remote[0]).toMatchObject({ preWaitingStatusDefinitionId: 'status-fresh-paused' })
    expect(result.cached[0]).not.toHaveProperty('preWaitingStatusDefinitionId')
  })

  it('exposes a command-response pre-waiting value to callers but strips it before caching', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1 } as never)
    api.transitionWorkItem.mockResolvedValue({
      commandId: 'transition-op', entityType: 'work_item', entityId: 'work-1', version: 2,
      value: {
        project: projectWire('project-1'),
        work_item: {
          ...workItemWire('work-1', 'project-1'),
          status_definition_id: 'status-waiting',
          pre_waiting_status_definition_id: 'status-paused',
          version: 2,
        },
      },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const transitioned = await repository.transitionWorkItem({
      workItemId: 'work-1', statusDefinitionId: 'status-waiting',
    })

    expect(transitioned).toMatchObject({
      statusDefinitionId: 'status-waiting',
      preWaitingStatusDefinitionId: 'status-paused',
    })
    expect(await db.workItems.get('work-1')).not.toHaveProperty('preWaitingStatusDefinitionId')
  })
})

// --------------------------------------------------------------------------- #
// ★ 2026-09-11 submit_review intent：真实执行器 + 续跑队列加固
//   原因：tasks 侧曾把 submit_review 绑成抛错桩，且续跑循环只把「带 response
//   的规范化不可重试错误」标记 failed —— 桩抛出的普通 Error 会重新抛出并
//   终止整个循环，其后所有 pending intent 永不恢复（刷新也修不好）。
// --------------------------------------------------------------------------- #

const reviewDraftRequest = (
  spaceId: string,
  sessionId = 'fs-1',
  operationId = 'op-review',
) => ({
  operationId,
  spaceId,
  sessionId,
  expectedVersion: 3,
  validity: 'valid' as const,
  reviewState: 'completed' as const,
  reviewedAt: '2026-07-15T08:25:00Z',
  outcomes: [],
})

async function seedReviewDraft(
  db: Awaited<ReturnType<typeof openPomodoroXIDB>>,
  draft: ReturnType<typeof reviewDraftRequest>,
): Promise<void> {
  await db.sessionReviewDrafts.put({
    spaceId: draft.spaceId,
    sessionId: draft.sessionId,
    operationId: draft.operationId,
    draftJson: canonicalize(draft)!,
    updatedAt: '2026-07-15T08:24:00.000Z',
  })
}

describe('resumePendingDirectCommandIntents queue hardening', () => {
  it('processes later intents even when a submit_review intent cannot be executed', async () => {
    const { db, api, spaceId } = await fixture()
    // 会话侧写入的 submit_review intent（没有可绑定的草稿 → 执行器必须失败）
    await prepareDirectCommandIntent(db, {
      kind: 'submit_review', spaceId, targetId: 'fs-1',
      request: reviewDraftRequest(spaceId, 'fs-1', 'op-review-first'),
      now: '2026-07-15T08:00:00.000Z',
    }, 'op-review-first')
    await prepareDirectCommandIntent(db, {
      kind: 'create_project', spaceId, targetId: 'RM',
      request: { spaceId, name: 'Roadmap', key: 'RM', description: null },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-after-review')
    api.createProject.mockResolvedValue({
      commandId: 'op-after-review', entityType: 'project', entityId: 'project-1', version: 1,
      value: projectWire('project-1'),
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const result = await repository.resumePendingDirectCommandIntents()

    // 旧代码：submit_review 桩抛错被重新抛出 → 循环终止 → 这里永远不会被调用。
    expect(api.createProject).toHaveBeenCalledTimes(1)
    expect(await db.projects.get('project-1')).toMatchObject({ id: 'project-1' })
    expect(result.failed).toEqual([
      { operationId: 'op-review-first', code: 'handler_error:submit_review' },
    ])
    expect(await db.directCommandIntents.get('op-review-first')).toMatchObject({
      state: 'failed', failureCode: 'handler_error:submit_review',
    })
  })

  it('records a programmatic handler error and keeps processing the queue', async () => {
    const { db, api, spaceId } = await fixture()
    await db.workItems.put({ id: 'work-1', projectId: 'project-1', version: 1 } as never)
    await prepareDirectCommandIntent(db, {
      kind: 'move_work_item', spaceId, targetId: 'work-1',
      request: {
        projectId: 'project-1', workItemId: 'work-1', expectedVersion: 1,
        newParentId: 'l2', spaceId,
      },
      now: '2026-07-15T08:00:00.000Z',
    }, 'op-handler-boom')
    await prepareDirectCommandIntent(db, {
      kind: 'create_project', spaceId, targetId: 'NEXT',
      request: { spaceId, name: 'Next', key: 'NEXT', description: null },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-next-project')
    api.moveWorkItem.mockRejectedValue(new Error('handler_internal_boom'))
    api.createProject.mockResolvedValue({
      commandId: 'op-next-project', entityType: 'project', entityId: 'project-next', version: 1,
      value: { ...projectWire('project-next'), key: 'NEXT' },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const result = await repository.resumePendingDirectCommandIntents()

    expect(result.failed).toEqual([
      { operationId: 'op-handler-boom', code: 'handler_error:move_work_item' },
    ])
    expect(await db.directCommandIntents.get('op-handler-boom')).toMatchObject({
      state: 'failed', failureCode: 'handler_error:move_work_item',
    })
    // 队列继续：后续 intent 仍被真正执行。
    expect(api.createProject).toHaveBeenCalledTimes(1)
    expect(await db.projects.get('project-next')).toMatchObject({ id: 'project-next' })
  })

  it('keeps a transport failure pending and stops the ordered queue for the next round', async () => {
    const { db, api, spaceId } = await fixture()
    await prepareDirectCommandIntent(db, {
      kind: 'create_project', spaceId, targetId: 'OFFLINE',
      request: { spaceId, name: 'Offline', key: 'OFFLINE', description: null },
      now: '2026-07-15T08:00:00.000Z',
    }, 'op-transport')
    await prepareDirectCommandIntent(db, {
      kind: 'create_work_item', spaceId, targetId: 'unreached',
      request: {
        projectId: 'project-1', title: 'Unreached', description: null,
        parentId: null, typeDefinitionId: null, statusDefinitionId: null, priority: null,
        spaceId,
      },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-unreached')
    // 无 response 的连接类错误：下轮重试，绝不能被标记 failed。
    api.createProject.mockRejectedValue(Object.assign(new Error('Network Error'), {
      isAxiosError: true, code: 'ERR_NETWORK', response: undefined,
    }))
    const repository = new TaskSpaceRepository(db, spaceId, api)

    await expect(repository.resumePendingDirectCommandIntents()).rejects.toThrow('Network Error')

    // in_flight = 「已发出、等结果」，与 prepared 一样属于下一轮重试集合；
    // 绝不能被写成 failed（否则一条网络抖动就会永久判死该 intent）。
    expect(await db.directCommandIntents.get('op-transport')).toMatchObject({
      state: 'in_flight', failureCode: null,
    })
    expect(await db.directCommandIntents.get('op-unreached')).toMatchObject({ state: 'prepared' })
    expect(api.createWorkItem).not.toHaveBeenCalled()
  })

  it('executes a submit_review intent through the real HTTP contract and applies the result', async () => {
    const { db, api, spaceId } = await fixture()
    const draft = reviewDraftRequest(spaceId, 'fs-1', 'op-review-real')
    await seedReviewDraft(db, draft)
    await prepareDirectCommandIntent(db, {
      kind: 'submit_review', spaceId, targetId: 'fs-1',
      request: draft, now: '2026-07-15T08:24:01.000Z',
    }, draft.operationId)
    const post = vi.spyOn(spaceApi, 'post').mockResolvedValue({
      data: reviewAggregateFixture(spaceId),
    } as never)
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const result = await repository.resumePendingDirectCommandIntents()

    expect(result.failed).toEqual([])
    expect(post).toHaveBeenCalledTimes(1)
    const [path, body, config] = post.mock.calls[0]!
    expect(path).toBe('/focus-sessions/fs-1/review')
    expect(config).toMatchObject({ headers: { 'Idempotency-Key': 'op-review-real' } })
    expect(body).toMatchObject({
      commandId: 'op-review-real', spaceId, sessionId: 'fs-1', ownershipEpoch: null,
      payload: {
        expectedVersion: 3, validity: 'valid', reviewState: 'completed',
        reviewedAt: '2026-07-15T08:25:00Z', outcomes: [],
      },
    })
    expect(await db.directCommandIntents.get('op-review-real')).toMatchObject({ state: 'terminal' })
    expect(await db.sessionReviewDrafts.get([spaceId, 'fs-1'])).toBeUndefined()
    expect(await db.focusSessions.get('fs-1')).toMatchObject({
      sessionId: 'fs-1', reviewState: 'completed', version: 4,
    })
    post.mockRestore()
  })

  // ---- ★ D2 / ADR-0004：解除确认（relation 变更全部 online-only） ----------

  it('resolves a relation online-only and adopts the confirmed post-image', async () => {
    const { db, api, spaceId } = await fixture()
    const key = await relationId(spaceId, 'work-1', 'work-2', 'depends_on')
    await db.relations.put({
      id: key, fromWorkItemId: 'work-1', toWorkItemId: 'work-2',
      relationType: 'depends_on', resolution: null, resolvedAt: null,
      version: 3, createdAt: '2026-07-15T08:00:00.000Z', updatedAt: '2026-07-15T08:00:00.000Z',
    })
    api.resolveRelation.mockResolvedValue({
      commandId: 'resolve-op', entityType: 'relation', entityId: key, version: 4,
      value: {
        id: key, space_id: spaceId,
        from_work_item_id: 'work-1', to_work_item_id: 'work-2',
        relation_type: 'depends_on',
        resolution: 'confirmed_not_required',
        resolved_at: '2026-07-15T09:00:00.000Z',
        version: 4,
        created_at: '2026-07-15T08:00:00.000Z',
        updated_at: '2026-07-15T09:00:00.000Z',
      },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const resolved = await repository.resolveRelation({
      fromWorkItemId: 'work-1', toWorkItemId: 'work-2', relationType: 'depends_on',
    })

    // CAS 从缓存行取，命令携带派生 relationId 与 expectedVersion。
    expect(api.resolveRelation).toHaveBeenCalledWith(expect.objectContaining({
      relationId: key, expectedVersion: 3, operationId: expect.any(String),
    }))
    expect(resolved).toMatchObject({
      id: key, resolution: 'confirmed_not_required',
      resolvedAt: '2026-07-15T09:00:00.000Z', version: 4,
    })
    expect(await db.relations.get(key)).toMatchObject({
      resolution: 'confirmed_not_required', version: 4,
    })
    expect((await db.directCommandIntents.toArray())[0]).toMatchObject({ state: 'terminal' })
  })

  it('refuses a resolve while offline（online-only，与其余 relation 变更同款）', async () => {
    const { db, api, spaceId } = await fixture()
    const repository = new TaskSpaceRepository(db, spaceId, api)
    const original = navigator.onLine
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await expect(repository.resolveRelation({
      fromWorkItemId: 'work-1', toWorkItemId: 'work-2', relationType: 'depends_on',
    })).rejects.toThrow('offline_formal_mutation_forbidden')
    expect(api.resolveRelation).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: original })
  })
})
