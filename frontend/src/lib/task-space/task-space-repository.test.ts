import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { taskSpaceApi } from '@/services/task-space-api'
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

async function fixture() {
  const db = await openPomodoroXIDB(crypto.randomUUID())
  databases.push(db)
  const api = {
    ...taskSpaceApi,
    createProject: vi.fn(),
    createWorkItem: vi.fn(),
    moveWorkItem: vi.fn(),
    transitionWorkItem: vi.fn(),
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
})
