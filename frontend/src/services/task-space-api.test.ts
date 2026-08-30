import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { spaceApi } from './api'
import { taskSpaceApi } from './task-space-api'

vi.mock('./api', () => ({
  spaceApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() },
}))

const accepted = { commandId: 'op-1', entityType: 'project', entityId: 'p-1', version: 1, value: {} }
const timestamp = '2026-01-01T00:00:00Z'

const projectWire = {
  id: 'p-1', spaceId: 'space-a', key: 'RM', name: 'Roadmap', description: null,
  nextWorkItemNumber: 2, rank: 0, archivedAt: null, version: 1,
  createdAt: timestamp, updatedAt: timestamp,
}

const workItemWire = {
  id: 'w-1', spaceId: 'space-a', projectId: 'p-1', displayKey: 'RM-1',
  title: 'First task', description: null, typeDefinitionId: 'type-1',
  statusDefinitionId: 'status-1', priority: 'high', parentId: null,
  childRank: 0, depth: 1, completionWindowStart: null,
  completionWindowEnd: null, reviewPoint: null, hardDeadline: null,
  effortEstimateLowerSeconds: null, effortEstimateUpperSeconds: null,
  effortActualSeconds: 0, confidence: 'medium', completedAt: null,
  cancelledAt: null, archivedAt: null, markedAsAttention: false, version: 1,
  createdAt: timestamp, updatedAt: timestamp,
}

const noteWire = {
  spaceId: 'space-a', noteId: 'n-1', workItemId: 'w-1',
  document: { contentVersion: 1, blocks: [] }, version: 1,
  createdAt: timestamp, updatedAt: timestamp,
}

describe('taskSpaceApi', () => {
  beforeEach(() => vi.clearAllMocks())

  it('normalizes project key once for wire and hash', async () => {
    vi.mocked(spaceApi.post).mockResolvedValue({ data: accepted })
    await taskSpaceApi.createProject({
      operationId: 'op-1', spaceId: 'space-a', name: 'Roadmap', key: ' rm ', description: null,
    })
    const body = vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>
    expect(body.key).toBe('RM')
    expect(body.payloadHash).toBe(await hashCommandPayload({ name: 'Roadmap', key: 'RM', description: null }))
  })

  it('hashes omitted and explicit-null descriptions identically (description: null kept)', async () => {
    // Frozen canonical contract: omitted === null, and the field is KEPT as
    // null in the hashed payload. The backend must canonicalize with the same
    // field set (see backend/app/routes/v1/projects.py create_project).
    vi.mocked(spaceApi.post).mockResolvedValue({ data: accepted })
    await taskSpaceApi.createProject({
      operationId: 'op-null-desc', spaceId: 'space-a', name: 'R', key: 'R', description: null,
    })
    const nullHash = (vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>).payloadHash
    vi.mocked(spaceApi.post).mockClear()
    await taskSpaceApi.createProject({
      operationId: 'op-omitted-desc', spaceId: 'space-a', name: 'R', key: 'R',
    })
    const omittedHash = (vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>).payloadHash
    expect(omittedHash).toBe(nullHash)
    expect(omittedHash).toBe(await hashCommandPayload({ name: 'R', key: 'R', description: null }))
  })

  it('keeps project identity on the wire but excludes it from Move business hash', async () => {
    vi.mocked(spaceApi.post).mockResolvedValue({ data: accepted })
    await taskSpaceApi.moveWorkItem({
      projectId: 'project-a', workItemId: 'wi-a', operationId: 'move-a', spaceId: 'space-a',
      expectedVersion: 4, newParentId: 'l2',
    })
    const body = vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>
    expect(body.projectId).toBe('project-a')
    // child_rank is server-assigned only; the wire body and canonical hash
    // carry only the new parent.
    expect('childRank' in body).toBe(false)
    expect(body.payloadHash).toBe(await hashCommandPayload({ new_parent_id: 'l2' }))
  })

  it('uses only the three locked WorkItemNote write paths', async () => {
    vi.mocked(spaceApi.put).mockResolvedValue({ data: accepted })
    vi.mocked(spaceApi.post).mockResolvedValue({ data: accepted })
    const document = { contentVersion: 1 as const, blocks: [] }
    await taskSpaceApi.replaceNote({ operationId: 'replace', spaceId: 'space-a', workItemId: 'wi-1', expectedVersion: 1, document })
    await taskSpaceApi.appendBlocks({ operationId: 'append', spaceId: 'space-a', workItemId: 'wi-1', expectedVersion: 1, blocks: [] })
    await taskSpaceApi.toggleChecklistItem({ operationId: 'toggle', spaceId: 'space-a', workItemId: 'wi-1', expectedVersion: 1, blockId: 'b', itemId: 'i', checked: true })
    expect(vi.mocked(spaceApi.put).mock.calls[0]![0]).toBe('/work-items/wi-1/note')
    expect(vi.mocked(spaceApi.post).mock.calls.map(([path]) => path)).toEqual([
      '/work-items/wi-1/note/append-blocks', '/work-items/wi-1/note/toggle-checklist-item',
    ])
  })

  it('parses complete camelCase REST read responses at the frontend boundary', async () => {
    vi.mocked(spaceApi.get)
      .mockResolvedValueOnce({ data: { items: [projectWire], nextCursor: null } })
      .mockResolvedValueOnce({ data: projectWire })
      .mockResolvedValueOnce({ data: { items: [workItemWire], nextCursor: null } })
      .mockResolvedValueOnce({ data: workItemWire })
      .mockResolvedValueOnce({ data: noteWire })

    const projects = await taskSpaceApi.listProjects('space-a')
    expect(projects.items[0]?.nextWorkItemNumber).toBe(2)
    expect((await taskSpaceApi.getProject('space-a', 'p-1')).spaceId).toBe('space-a')

    const workItems = await taskSpaceApi.listWorkItems('space-a', 'p-1')
    expect(workItems.items[0]?.displayKey).toBe('RM-1')
    expect((await taskSpaceApi.getWorkItem('space-a', 'w-1')).depth).toBe(1)

    const note = await taskSpaceApi.getNote('space-a', 'w-1')
    expect(note.noteId).toBe('n-1')
    expect(note.document.contentVersion).toBe(1)
  })

  it('hashes updateWorkItem as {patch} including priority/null description and binds Idempotency-Key', async () => {
    vi.mocked(spaceApi.patch).mockResolvedValue({ data: accepted })
    await taskSpaceApi.updateWorkItem({
      operationId: 'update-1', spaceId: 'space-a', workItemId: 'wi-1', expectedVersion: 4,
      title: 'Edited', description: null, priority: 'low',
    })
    const [path, body, options] = vi.mocked(spaceApi.patch).mock.calls[0]!
    expect(path).toBe('/work-items/wi-1')
    expect(body).toMatchObject({
      commandId: 'update-1',
      spaceId: 'space-a',
      expectedVersion: 4,
      title: 'Edited',
      description: null,
      priority: 'low',
    })
    expect(options?.headers?.['Idempotency-Key']).toBe('update-1')
    expect((body as Record<string, unknown>).payloadHash).toBe(
      await hashCommandPayload({ patch: { title: 'Edited', description: null, priority: 'low' } }),
    )
  })

  it('binds Idempotency-Key and camelCase wire fields for create/move/transition', async () => {
    vi.mocked(spaceApi.post).mockResolvedValue({ data: accepted })

    await taskSpaceApi.moveWorkItem({
      projectId: 'p-1', workItemId: 'wi-1', operationId: 'move-1', spaceId: 'space-a',
      expectedVersion: 3, newParentId: 'p2',
    })
    const move = vi.mocked(spaceApi.post).mock.calls[0]!
    expect(move[0]).toBe('/work-items/wi-1/move')
    const moveBody = move[1] as Record<string, unknown>
    expect(moveBody).toMatchObject({ projectId: 'p-1', parentId: 'p2', expectedVersion: 3 })
    expect('childRank' in moveBody).toBe(false)
    expect(move[2]?.headers?.['Idempotency-Key']).toBe('move-1')
    expect(moveBody.payloadHash).toBe(
      await hashCommandPayload({ new_parent_id: 'p2' }),
    )

    vi.mocked(spaceApi.post).mockClear()
    await taskSpaceApi.transitionWorkItem({
      workItemId: 'wi-1', operationId: 'tr-1', spaceId: 'space-a',
      expectedVersion: 3, statusDefinitionId: 's-1',
    })
    const transition = vi.mocked(spaceApi.post).mock.calls[0]!
    expect(transition[0]).toBe('/work-items/wi-1/transition')
    expect(transition[1]).toMatchObject({ statusDefinitionId: 's-1', expectedVersion: 3 })
    expect(transition[2]?.headers?.['Idempotency-Key']).toBe('tr-1')
    expect((transition[1] as Record<string, unknown>).payloadHash).toBe(
      await hashCommandPayload({ status_definition_id: 's-1' }),
    )

    vi.mocked(spaceApi.post).mockClear()
    await taskSpaceApi.createWorkItem({
      operationId: 'cr-1', spaceId: 'space-a', projectId: 'p-1', title: 'T', description: null,
      parentId: null, typeDefinitionId: null, statusDefinitionId: null, priority: null,
    })
    const create = vi.mocked(spaceApi.post).mock.calls[0]!
    expect(create[2]?.headers?.['Idempotency-Key']).toBe('cr-1')
    expect(create[1]).toMatchObject({ projectId: 'p-1', title: 'T', description: null })
  })
})
