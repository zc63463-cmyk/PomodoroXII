import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { spaceApi } from './api'
import { taskSpaceApi } from './task-space-api'

vi.mock('./api', () => ({
  spaceApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() },
}))

const accepted = { commandId: 'op-1', entityType: 'project', entityId: 'p-1', version: 1, value: {} }

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

  it('keeps project identity on the wire but excludes it from Move business hash', async () => {
    vi.mocked(spaceApi.post).mockResolvedValue({ data: accepted })
    await taskSpaceApi.moveWorkItem({
      projectId: 'project-a', workItemId: 'wi-a', operationId: 'move-a', spaceId: 'space-a',
      expectedVersion: 4, newParentId: 'l2', childRank: 7,
    })
    const body = vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>
    expect(body.projectId).toBe('project-a')
    expect(body.payloadHash).toBe(await hashCommandPayload({ new_parent_id: 'l2', child_rank: 7 }))
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
})
