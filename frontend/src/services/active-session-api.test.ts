import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { metaApi } from './api'
import { activeSessionApi, activateProvisionalHashPayload } from './active-session-api'

vi.mock('./api', () => ({
  metaApi: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  spaceApi: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}))

const aggregate = (spaceId = 'space-a', sessionId = 'fs-1') => ({
  session: {
    id: sessionId, spaceId, sessionRevision: 1, startedAt: '2026-07-15T08:00:00Z', endedAt: null,
    pauseStartedAt: null, plannedSeconds: 1500, grossSeconds: 0, pausedSeconds: 0, breakSeconds: 0,
    focusedSeconds: 0, clockState: 'running', timerCompletion: null, validity: 'pending', validityReason: null,
    overallProgress: null, mood: null, reviewState: 'not_required', ownershipState: 'authoritative',
    sessionNote: '', version: 1, createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  }, context: null,
  attribution: { id: 'a', spaceId, sessionId, revision: 1, projectId: 'p', level2WorkItemId: 'l2', reason: null, correctedFromRevision: null, effective: true, createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z', version: 1 },
  plan: [], outcomes: [], commandEnvelopes: [], commandReceipts: [],
})

const activeResponse = () => ({
  spaceId: 'space-a', sessionId: 'fs-1', operationId: 'start-1', state: 'active',
  ownerDeviceId: 'device-a', ownerTabId: 'tab-a', ownershipEpoch: 1,
  leaseExpiresAt: '2026-07-15T08:02:00Z', updatedAt: '2026-07-15T08:01:00Z',
  session: aggregate(),
})

describe('activeSessionApi', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes global start through metaApi and excludes version guards from the hash', async () => {
    vi.mocked(metaApi.post).mockResolvedValue({ data: activeResponse() })
    await activeSessionApi.start({
      spaceId: 'space-a', sessionId: 'fs-1', operationId: 'start-1', level2WorkItemId: 'l2',
      level3WorkItemIds: ['l3'], plannedSeconds: 1500, startedAt: '2026-07-15T08:00:00Z',
      ownerDeviceId: 'device-a', ownerTabId: 'tab-a', expectedWorkItemVersions: { l2: 3, l3: 2 },
    })
    const body = vi.mocked(metaApi.post).mock.calls[0]![1] as Record<string, unknown>
    expect(body.payloadHash).toBe(await hashCommandPayload({
      level2_work_item_id: 'l2', level3_work_item_ids: ['l3'], planned_seconds: 1500,
      started_at: '2026-07-15T08:00:00Z', owner_device_id: 'device-a', owner_tab_id: 'tab-a',
    }))
  })

  it('excludes only provisional guards while recursively hashing frozen snapshot facts', async () => {
    const base = {
      cachedAt: '2026-07-15T08:05:00Z', cachedOwnershipEpoch: null as number | null, ownerDeviceId: 'd', ownerTabId: 't',
      snapshot: { session: { sessionRevision: 0, startedAt: '2026-07-15T08:00:00Z', pauseStartedAt: null, plannedSeconds: 100, grossSeconds: 0, pausedSeconds: 0, breakSeconds: 0, focusedSeconds: 0, validity: 'pending', validityReason: null, reviewState: 'not_required', ownershipState: 'local_provisional', sessionNote: '' }, context: { projectId: 'p', projectTitleSnapshot: 'P', level2WorkItemId: 'l2', level2TitleSnapshot: 'L2', level2ParentIdSnapshot: null, level2StatusDefinitionIdSnapshot: 's', level2VersionSnapshot: 1, level2EffortLowerSecondsSnapshot: null, level2EffortUpperSecondsSnapshot: null, linkedAt: '2026-07-15T08:00:00Z', linkMethod: 'explicit' }, plan: [] },
      expectedWorkItemVersions: { l2: 1 },
    }
    const guards = structuredClone(base)
    guards.cachedOwnershipEpoch = 9
    guards.expectedWorkItemVersions = { l2: 99 }
    expect(await hashCommandPayload(activateProvisionalHashPayload(base))).toBe(await hashCommandPayload(activateProvisionalHashPayload(guards)))
    const fact = structuredClone(base)
    fact.snapshot.context.level2VersionSnapshot = 2
    expect(await hashCommandPayload(activateProvisionalHashPayload(base))).not.toBe(await hashCommandPayload(activateProvisionalHashPayload(fact)))
  })
})
