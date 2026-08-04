import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSessionView, FocusSessionAggregateView } from '@/lib/contracts/focus-session'
import { MetaDB } from '@/services/meta-database'
import { useTimerStore } from '@/stores/timer-store'
import { ActiveSessionCoordinatorClient, type ActiveSessionApiLike } from './active-session-coordinator'
import type { TabIdentity } from './tab-identity'

const aggregate = (sessionId = 'fs-1', sessionVersion = 1, planVersion = 1): FocusSessionAggregateView => ({
  session: {
    id: sessionId, spaceId: 'space-a', sessionRevision: sessionVersion,
    startedAt: '2026-07-15T08:00:00Z', endedAt: null, pauseStartedAt: null,
    plannedSeconds: 1500, grossSeconds: 0, pausedSeconds: 0, breakSeconds: 0,
    focusedSeconds: 0, clockState: 'running', timerCompletion: null,
    validity: 'pending', validityReason: null, overallProgress: null, mood: null,
    reviewState: 'not_required', ownershipState: 'authoritative', sessionNote: '',
    version: sessionVersion, createdAt: '2026-07-15T08:00:00Z',
    updatedAt: '2026-07-15T08:00:00Z',
  },
  context: null,
  attribution: {
    id: 'attr-1', spaceId: 'space-a', sessionId, revision: 1,
    projectId: 'project-1', level2WorkItemId: 'level2-1', reason: null,
    correctedFromRevision: null, effective: true, version: 1,
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  },
  plan: [{
    id: 'plan-1', spaceId: 'space-a', sessionId, workItemId: 'level3-1',
    titleSnapshot: 'Work', level2WorkItemIdSnapshot: 'level2-1',
    workItemVersionSnapshot: 1, planRank: 0, source: 'before_start',
    addedAt: '2026-07-15T08:00:00Z', removedAt: null, removalReason: null,
    currentDuringSession: true, completionDraft: false, version: planVersion,
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  }],
  outcomes: [], commandEnvelopes: [], commandReceipts: [],
})

const locator = (overrides: Partial<ActiveSessionView> = {}): ActiveSessionView => ({
  spaceId: 'space-a', sessionId: 'fs-1', operationId: 'op-1', state: 'active',
  ownerDeviceId: 'device-local', ownerTabId: 'tab-local', ownershipEpoch: 4,
  leaseExpiresAt: '2026-07-15T08:03:00Z', updatedAt: '2026-07-15T08:01:00Z',
  session: aggregate(),
  ...overrides,
})

class FakeChannel {
  static instances: FakeChannel[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly postMessage = vi.fn()
  constructor() { FakeChannel.instances.push(this) }
  close() {}
  deliver(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}

const apiFixture = (initial: ActiveSessionView | null): ActiveSessionApiLike => ({
  locate: vi.fn().mockResolvedValue(initial),
  start: vi.fn(), heartbeat: vi.fn(), takeover: vi.fn(),
  pause: vi.fn().mockResolvedValue(initial), resume: vi.fn().mockResolvedValue(initial),
  end: vi.fn(), updateNote: vi.fn().mockResolvedValue(initial),
  setCurrentPlanItem: vi.fn().mockResolvedValue(initial),
  setCompletionDraft: vi.fn().mockResolvedValue(initial),
  addPlanItem: vi.fn().mockResolvedValue(initial),
  removePlanItem: vi.fn().mockResolvedValue(initial),
})

const identity: TabIdentity = { deviceId: 'device-local', tabId: 'tab-local' }
const metas: MetaDB[] = []

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  FakeChannel.instances = []
  useTimerStore.getState().reset()
})

afterEach(async () => {
  useTimerStore.getState().reset()
  await Promise.all(metas.splice(0).map((database) => database.delete()))
  vi.unstubAllGlobals()
})

async function fixture(initial: ActiveSessionView | null, local = identity) {
  const meta = new MetaDB(`coordinator-${crypto.randomUUID()}`)
  metas.push(meta)
  await meta.open()
  const api = apiFixture(initial)
  const coordinator = new ActiveSessionCoordinatorClient(api, meta, local)
  return { api, meta, coordinator }
}

describe('ActiveSessionCoordinatorClient', () => {
  it('keeps a foreign Tab read-only until explicit takeover', async () => {
    const current = locator({ ownerTabId: 'tab-owner' })
    const value = await fixture(current, { deviceId: 'device-local', tabId: 'tab-observer' })
    vi.mocked(value.api.takeover).mockImplementation(async (input) => locator({
      ownerDeviceId: input.newOwnerDeviceId, ownerTabId: input.newOwnerTabId,
      ownershipEpoch: 5, operationId: input.operationId, updatedAt: '2026-07-15T08:02:00Z',
    }))

    await value.coordinator.bootstrap()
    expect(useTimerStore.getState().ownershipMode).toBe('read_only')
    await expect(value.coordinator.updateSessionNote({
      sessionId: 'fs-1', sessionNote: 'observer write',
    })).rejects.toThrow('active_session_not_owned')
    expect(value.api.updateNote).not.toHaveBeenCalled()

    await value.coordinator.takeover()
    expect(value.api.takeover).toHaveBeenCalledWith(expect.objectContaining({
      ownershipEpoch: 4, newOwnerTabId: 'tab-observer',
    }))
    expect(useTimerStore.getState()).toMatchObject({
      ownershipMode: 'owner', ownershipEpoch: 5,
    })
  })

  it('fences and refreshes when the server rejects a stale owner epoch', async () => {
    const value = await fixture(locator())
    vi.mocked(value.api.pause).mockRejectedValue(Object.assign(new Error('stale'), {
      response: { data: { code: 'stale_session_owner' } },
    }))
    vi.mocked(value.api.locate)
      .mockResolvedValueOnce(locator())
      .mockResolvedValue(locator({
        ownerDeviceId: 'device-other', ownerTabId: 'tab-other', ownershipEpoch: 5,
      }))
    await value.coordinator.bootstrap()
    await expect(value.coordinator.pause('2026-07-15T08:10:00Z')).rejects.toThrow('stale')
    expect(useTimerStore.getState().ownershipMode).toBe('read_only')
    expect(value.api.locate).toHaveBeenCalledTimes(2)
  })

  it('includes the active owner proof and expected version on clock writes', async () => {
    const value = await fixture(locator())
    vi.mocked(value.api.pause).mockImplementation(async (input) => locator({
      updatedAt: '2026-07-15T08:02:00Z', operationId: input.operationId,
      session: aggregate('fs-1', 2, 1),
    }))
    await value.coordinator.bootstrap()
    await value.coordinator.pause('2026-07-15T08:10:00Z')
    expect(value.api.pause).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'fs-1', ownershipEpoch: 4, expectedVersion: 1,
      ownerDeviceId: 'device-local', ownerTabId: 'tab-local',
    }))
  })

  it('uses BroadcastChannel only as a locator refresh signal', async () => {
    const value = await fixture(locator({ ownerTabId: 'tab-owner' }), {
      deviceId: 'device-local', tabId: 'tab-observer',
    })
    await value.coordinator.bootstrap()
    FakeChannel.instances[0]!.deliver({ type: 'locator-changed', epoch: 4 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(value.api.locate).toHaveBeenCalledTimes(2)
    expect(value.api.pause).not.toHaveBeenCalled()
    expect(value.api.heartbeat).not.toHaveBeenCalled()
  })

  it('retries a transport-failed heartbeat with the same operation and timestamp', async () => {
    const value = await fixture(locator())
    vi.mocked(value.api.heartbeat)
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockImplementationOnce(async (input) => ({
        ...locator(), operationId: input.operationId, updatedAt: '2026-07-15T08:02:00Z',
      }))
    await value.coordinator.bootstrap()
    await expect(value.coordinator.heartbeat()).rejects.toThrow('network timeout')
    await value.coordinator.heartbeat()
    const first = vi.mocked(value.api.heartbeat).mock.calls[0]![0]
    const retry = vi.mocked(value.api.heartbeat).mock.calls[1]![0]
    expect(retry).toMatchObject({ operationId: first.operationId, heartbeatAt: first.heartbeatAt })
  })

  it('does not install a delayed locate-null after a newer start', async () => {
    const delayedLocate = deferred<null>()
    const value = await fixture(null)
    vi.mocked(value.api.locate).mockReturnValueOnce(delayedLocate.promise)
    const refresh = value.coordinator.refresh()
    vi.mocked(value.api.start).mockImplementation(async (input) => locator({
      sessionId: input.sessionId, spaceId: input.spaceId, operationId: input.operationId,
      ownerDeviceId: input.ownerDeviceId, ownerTabId: input.ownerTabId,
    }))
    await value.coordinator.start({
      spaceId: 'space-a', sessionId: 'fs-new', operationId: 'start-new',
      level2WorkItemId: 'level2-1', level3WorkItemIds: [], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00Z', expectedWorkItemVersions: {},
    })
    delayedLocate.resolve(null)
    await refresh
    expect(useTimerStore.getState().locator).toMatchObject({ sessionId: 'fs-new' })
  })

  it('rejects a same-epoch response with an older Session or Plan version', async () => {
    const value = await fixture(locator({
      session: aggregate('fs-1', 5, 7),
    }))
    vi.mocked(value.api.updateNote).mockImplementation(async (input) => locator({
      operationId: input.operationId, session: aggregate('fs-1', 4, 6),
    }))
    vi.mocked(value.api.locate).mockResolvedValue(locator({ session: aggregate('fs-1', 5, 7) }))
    await value.coordinator.bootstrap()
    await expect(value.coordinator.updateSessionNote({
      sessionId: 'fs-1', sessionNote: 'old',
    })).rejects.toThrow('stale_active_session_response')
    expect(useTimerStore.getState().session?.version).toBe(5)
  })
})
