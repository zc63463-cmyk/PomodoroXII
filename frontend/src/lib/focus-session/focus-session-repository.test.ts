import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { focusSessionApi } from '@/services/focus-session-api'
import {
  buildProvisionalOperationRow,
  MetaDB,
  type ProvisionalOperationRow,
} from '@/services/meta-database'
import {
  FocusSessionRepository,
  buildActivateProvisionalPayload,
  cacheAuthoritativeActivation,
  cacheFocusSession,
} from './focus-session-repository'
import { SessionReviewDraftController } from './session-review-draft-registry'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>> | MetaDB> = []

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
})

const aggregateFixture = (
  spaceId: string,
  ownershipState: 'authoritative' | 'local_provisional' | 'activation_conflict' = 'authoritative',
) => ({
  session: {
    id: 'fs-1', spaceId, sessionRevision: 1,
    startedAt: '2026-07-15T08:00:00Z', endedAt: null, pauseStartedAt: null,
    plannedSeconds: 1500, grossSeconds: 600, pausedSeconds: 0,
    breakSeconds: 0, focusedSeconds: 600, timerCompletion: null,
    validity: ownershipState === 'local_provisional' ? 'pending' : 'valid',
    validityReason: null, overallProgress: null, mood: null,
    reviewState: 'not_required', ownershipState, sessionNote: '',
    version: ownershipState === 'local_provisional' ? 0 : 3,
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:10:00Z',
    clockState: 'running',
  },
  context: {
    id: 'ctx-1', spaceId, sessionId: 'fs-1', projectId: 'project-1',
    level2WorkItemId: 'l2', projectTitleSnapshot: 'Project',
    level2TitleSnapshot: 'Parent', level2ParentIdSnapshot: null,
    level2StatusDefinitionIdSnapshot: 'status-open', level2VersionSnapshot: 4,
    level2EffortLowerSecondsSnapshot: 1200, level2EffortUpperSecondsSnapshot: 1800,
    linkedAt: '2026-07-15T08:00:00Z', linkMethod: 'explicit',
    version: ownershipState === 'local_provisional' ? 0 : 2,
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  },
  attribution: {
    id: 'attr-1', spaceId, sessionId: 'fs-1', revision: 1,
    projectId: 'project-1', level2WorkItemId: 'l2', reason: null,
    correctedFromRevision: null, effective: true,
    version: ownershipState === 'local_provisional' ? 0 : 1,
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  },
  plan: [{
    id: 'plan-1', spaceId, sessionId: 'fs-1', workItemId: 'l3',
    titleSnapshot: 'Child', level2WorkItemIdSnapshot: 'l2',
    workItemVersionSnapshot: 2, planRank: 0, source: 'before_start',
    addedAt: '2026-07-15T08:00:00Z', removedAt: null, removalReason: null,
    currentDuringSession: true, completionDraft: false,
    version: ownershipState === 'local_provisional' ? 0 : 1,
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  }],
  outcomes: [], commandEnvelopes: [], commandReceipts: [],
})

const provisionalOperationFixture = (spaceId: string): ProvisionalOperationRow => ({
  operationId: 'offline-op-1', deviceId: 'device-a', tabId: 'tab-a',
  spaceId, sessionId: 'fs-1', cachedOwnershipEpoch: null,
  intentJson: '{}', payloadHash: 'a'.repeat(64), state: 'pending',
  createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
})

describe('FocusSession aggregate persistence', () => {
  it('stores the parsed aggregate rows in one Space database', async () => {
    const db = await openPomodoroXIDB(`focus-${crypto.randomUUID()}`)
    databases.push(db)

    const session = await cacheFocusSession(db, db.spaceId, aggregateFixture(db.spaceId))

    expect(session).toMatchObject({ sessionId: 'fs-1', ownershipState: 'authoritative' })
    expect(await db.focusSessions.get('fs-1')).toMatchObject({ sessionId: 'fs-1' })
    expect(await db.sessionTaskContexts.get('ctx-1')).toMatchObject({ sessionId: 'fs-1' })
    expect(await db.sessionAttributionRevisions.get('attr-1')).toBeDefined()
    expect(await db.sessionWorkItemPlans.get('plan-1')).toMatchObject({ workItemId: 'l3' })
  })

  it('rejects an aggregate whose response Space differs from the opened database', async () => {
    const db = await openPomodoroXIDB(`focus-mismatch-${crypto.randomUUID()}`)
    databases.push(db)
    await expect(cacheFocusSession(db, db.spaceId, aggregateFixture('other-space')))
      .rejects.toThrow(/space/i)
    expect(await db.focusSessions.count()).toBe(0)
  })

  it('builds a nonterminal provisional activation payload from cached rows', async () => {
    const db = await openPomodoroXIDB(`focus-provisional-${crypto.randomUUID()}`)
    databases.push(db)
    const cached = await cacheFocusSession(
      db, db.spaceId, aggregateFixture(db.spaceId, 'local_provisional'),
    )
    const context = await db.sessionTaskContexts.get('ctx-1')
    const attribution = await db.sessionAttributionRevisions.get('attr-1')
    const plan = await db.sessionWorkItemPlans.get('plan-1')
    const aggregate = {
      session: cached, context, attribution, plan: plan ? [plan] : [],
    } as never

    const payload = buildActivateProvisionalPayload(
      aggregate,
      provisionalOperationFixture(db.spaceId),
    )
    expect(payload.snapshot.session.ownershipState).toBe('local_provisional')
    expect(payload.expectedWorkItemVersions).toEqual({ l2: 4, l3: 2 })
  })

  it('creates a local provisional aggregate and ordered held outbox compound', async () => {
    const db = await openPomodoroXIDB(`focus-start-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-start-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    await meta.sessionTabs.put({
      tabId: 'tab-a', deviceId: 'device-a', openedAt: '2026-07-15T08:00:00.000Z',
      lastSeenAt: '2026-07-15T08:00:00.000Z', closedAt: null,
    })
    await db.projects.put({ id: 'project-1', name: 'Project', version: 1 })
    await db.workItems.bulkPut([
      { id: 'l2', projectId: 'project-1', title: 'Parent', depth: 2, parentId: null, statusDefinitionId: 'status-open', version: 4 },
      { id: 'l3', projectId: 'project-1', title: 'Child', depth: 3, parentId: 'l2', statusDefinitionId: 'status-open', version: 2 },
    ])
    const lock = { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() }
    const active = {
      updateSessionNote: async () => { throw new Error('unexpected coordinator call') },
      setCurrentPlanItem: async () => { throw new Error('unexpected coordinator call') },
      setCompletionDraft: async () => { throw new Error('unexpected coordinator call') },
      addPlanItem: async () => { throw new Error('unexpected coordinator call') },
      removePlanItem: async () => { throw new Error('unexpected coordinator call') },
    }
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, active, lock,
    )

    const result = await repository.startProvisional({
      operationId: 'offline-op-1', spaceId: db.spaceId, sessionId: 'offline-1',
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3'], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00.000Z', deviceId: 'device-a', tabId: 'tab-a',
      expectedWorkItemVersions: { l2: 4, l3: 2 },
    })

    expect(result.session).toMatchObject({
      sessionId: 'offline-1', ownershipState: 'local_provisional', version: 0,
    })
    expect(await meta.provisionalOperations.get('offline-op-1'))
      .toMatchObject({ state: 'pending', spaceId: db.spaceId, sessionId: 'offline-1' })
    const rows = (await db.outbox.toArray())
      .filter((row) => row.compoundOperationId === 'offline-op-1')
      .sort((left, right) => (left.compoundOrder ?? 0) - (right.compoundOrder ?? 0))
    expect(rows.map((row) => row.entityType)).toEqual([
      'focusSession', 'sessionTaskContext', 'sessionAttributionRevision', 'sessionWorkItemPlan',
    ])
    expect(rows.map((row) => row.compoundOrder)).toEqual([0, 1, 2, 3])
    expect(rows.every((row) => row.transportState === 'awaiting_s4')).toBe(true)
    expect(new Set(rows.map((row) => row.operationId)).size).toBe(rows.length)
  })

  it('does not reactivate a terminal awaiting_s4 provisional Session', async () => {
    const db = await openPomodoroXIDB(`focus-terminal-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-terminal-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    const intent = await buildProvisionalOperationRow({
      operationId: 'offline-op-1', spaceId: db.spaceId, sessionId: 'fs-1',
      deviceId: 'device-a', tabId: 'tab-a', level2WorkItemId: 'l2',
      level3WorkItemIds: [], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00.000Z', expectedWorkItemVersions: { l2: 4 },
    }, null)
    await meta.provisionalOperations.put({ ...intent, state: 'awaiting_s4' })
    await db.focusSessions.put({
      id: 'fs-1', sessionId: 'fs-1', ownershipState: 'local_provisional',
      clockState: 'ended', endedAt: '2026-07-15T08:10:00.000Z', version: 0,
    })
    const lock = { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() }
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never, lock,
    )

    await expect(repository.startProvisional({
      operationId: 'offline-op-1', spaceId: db.spaceId, sessionId: 'fs-1',
      level2WorkItemId: 'l2', level3WorkItemIds: [], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00.000Z', deviceId: 'device-a', tabId: 'tab-a',
      expectedWorkItemVersions: { l2: 4 },
    })).rejects.toThrow('terminal_provisional_requires_s4_import')
  })

  it('validates cached snapshots before creating a new Meta provisional claim', async () => {
    const db = await openPomodoroXIDB(`focus-snapshot-order-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-snapshot-order-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )

    await expect(repository.startProvisional({
      operationId: 'offline-snapshot-order', spaceId: db.spaceId, sessionId: 'fs-missing',
      level2WorkItemId: 'missing-level2', level3WorkItemIds: [], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00.000Z', deviceId: 'device-a', tabId: 'tab-a',
      expectedWorkItemVersions: { 'missing-level2': 1 },
    })).rejects.toThrow('provisional_start_snapshot_missing')
    expect(await meta.provisionalOperations.count()).toBe(0)
  })

  it('persists provisional pause, resume, and end as one held focus-session post-image', async () => {
    const db = await openPomodoroXIDB(`focus-clock-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-clock-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    await meta.sessionTabs.put({
      tabId: 'tab-a', deviceId: 'device-a', openedAt: '2026-07-15T08:00:00.000Z',
      lastSeenAt: '2026-07-15T08:00:00.000Z', closedAt: null,
    })
    await db.projects.put({ id: 'project-1', name: 'Project', version: 1 })
    await db.workItems.bulkPut([
      { id: 'l2', projectId: 'project-1', title: 'Parent', depth: 2, parentId: null, statusDefinitionId: 'status-open', version: 4 },
      { id: 'l3', projectId: 'project-1', title: 'Child', depth: 3, parentId: 'l2', statusDefinitionId: 'status-open', version: 2 },
    ])
    const active = {
      updateSessionNote: vi.fn(), setCurrentPlanItem: vi.fn(), setCompletionDraft: vi.fn(),
      addPlanItem: vi.fn(), removePlanItem: vi.fn(),
    }
    const lock = { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() }
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, active as never, lock,
    )

    await repository.startProvisional({
      operationId: 'offline-clock-1', spaceId: db.spaceId, sessionId: 'offline-clock-1',
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3'], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00.000Z', deviceId: 'device-a', tabId: 'tab-a',
      expectedWorkItemVersions: { l2: 4, l3: 2 },
    })
    await repository.pauseProvisional('offline-clock-1', '2026-07-15T08:05:00.000Z')
    await repository.resumeProvisional('offline-clock-1', '2026-07-15T08:06:00.000Z')
    await repository.endProvisional('offline-clock-1', {
      occurredAt: '2026-07-15T08:10:00.000Z', timerCompletion: 'ended_early',
    })

    expect(await db.focusSessions.get('offline-clock-1')).toMatchObject({
      endedAt: '2026-07-15T08:10:00.000Z', pauseStartedAt: null,
      grossSeconds: 600, pausedSeconds: 60, focusedSeconds: 540,
      clockState: 'ended', timerCompletion: 'ended_early', validity: 'pending',
    })
    expect(await meta.provisionalOperations.get('offline-clock-1'))
      .toMatchObject({ state: 'awaiting_s4' })
    const held = await db.outbox.where('entityType').equals('focusSession').toArray()
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      entityId: 'offline-clock-1', action: 'create', expectedVersion: null,
      transportState: 'awaiting_s4',
    })
    expect(JSON.parse(held[0]!.payload)).toMatchObject({
      id: 'offline-clock-1', endedAt: '2026-07-15T08:10:00.000Z',
      grossSeconds: 600, pausedSeconds: 60, focusedSeconds: 540,
    })
  })

  it('routes authoritative content mutations through the injected Coordinator', async () => {
    const db = await openPomodoroXIDB(`focus-authoritative-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-authoritative-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    const active = {
      updateSessionNote: vi.fn().mockResolvedValue(aggregateFixture(db.spaceId)),
      setCurrentPlanItem: vi.fn(), setCompletionDraft: vi.fn(),
      addPlanItem: vi.fn(), removePlanItem: vi.fn(),
    }
    await cacheFocusSession(db, db.spaceId, aggregateFixture(db.spaceId))
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, active as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )

    await repository.updateSessionNote('fs-1', 'Coordinator note')

    expect(active.updateSessionNote).toHaveBeenCalledOnce()
    expect(active.updateSessionNote).toHaveBeenCalledWith({
      sessionId: 'fs-1', sessionNote: 'Coordinator note',
    })
    expect(await db.outbox.count()).toBe(0)
  })

  it('rejects activation-conflict writes without changing business rows or outbox', async () => {
    const db = await openPomodoroXIDB(`focus-conflict-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-conflict-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    await cacheFocusSession(db, db.spaceId, aggregateFixture(db.spaceId, 'activation_conflict'))
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )
    const before = {
      session: await db.focusSessions.get('fs-1'),
      plans: await db.sessionWorkItemPlans.toArray(),
      outbox: await db.outbox.toArray(),
    }

    await expect(repository.updateSessionNote('fs-1', 'blocked')).rejects.toThrow('blocked_conflict')
    await expect(repository.pauseProvisional('fs-1', '2026-07-15T08:05:00.000Z'))
      .rejects.toThrow('blocked_conflict')
    expect(await db.focusSessions.get('fs-1')).toEqual(before.session)
    expect(await db.sessionWorkItemPlans.toArray()).toEqual(before.plans)
    expect(await db.outbox.toArray()).toEqual(before.outbox)
  })

  it('rejects observer and activating-flight provisional writes before any local effect', async () => {
    const makeRepository = async (state: 'pending' | 'activating', tabId: string) => {
      const spaceId = state === 'pending' ? 'space-observer' : 'space-flight'
      const db = await openPomodoroXIDB(spaceId)
      const meta = new MetaDB(`meta-focus-owner-${state}-${tabId}-${crypto.randomUUID()}`)
      databases.push(db, meta)
      await meta.open()
      await cacheFocusSession(db, db.spaceId, aggregateFixture(db.spaceId, 'local_provisional'))
      const operation = provisionalOperationFixture(db.spaceId)
      await meta.provisionalOperations.put({ ...operation, state, tabId: 'tab-owner' })
      await meta.sessionTabs.put({
        tabId: 'tab-owner', deviceId: 'device-a', openedAt: operation.createdAt,
        lastSeenAt: operation.updatedAt, closedAt: null,
      })
      const repository = new FocusSessionRepository(
        db, meta, db.spaceId, { deviceId: 'device-a', tabId }, {} as never,
        { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
      )
      return { db, repository }
    }

    const observer = await makeRepository('pending', 'tab-observer')
    const observerBefore = await observer.db.focusSessions.get('fs-1')
    await expect(observer.repository.updateSessionNote('fs-1', 'observer')).rejects.toThrow('active_session_not_owned')
    expect(await observer.db.focusSessions.get('fs-1')).toEqual(observerBefore)
    expect(await observer.db.outbox.count()).toBe(0)

    const flight = await makeRepository('activating', 'tab-owner')
    const flightBefore = await flight.db.focusSessions.get('fs-1')
    await expect(flight.repository.updateSessionNote('fs-1', 'late')).rejects.toThrow('active_session_not_owned')
    expect(await flight.db.focusSessions.get('fs-1')).toEqual(flightBefore)
    expect(await flight.db.outbox.count()).toBe(0)
  })

  it('does not authorize a same-session-id provisional operation from another Space', async () => {
    const db = await openPomodoroXIDB(`focus-space-owner-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-space-owner-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    await cacheFocusSession(db, db.spaceId, aggregateFixture(db.spaceId, 'local_provisional'))
    await meta.provisionalOperations.put({
      ...provisionalOperationFixture('space-b'), spaceId: 'space-b', tabId: 'tab-a',
    })
    await meta.sessionTabs.put({
      tabId: 'tab-a', deviceId: 'device-a', openedAt: '2026-07-15T08:00:00.000Z',
      lastSeenAt: '2026-07-15T08:00:00.000Z', closedAt: null,
    })
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )

    await expect(repository.updateSessionNote('fs-1', 'wrong space'))
      .rejects.toThrow('active_session_not_owned')
    expect(await db.outbox.count()).toBe(0)
  })

  it('keeps review cache writes Space-scoped and uses the composite Dexie key', async () => {
    const db = await openPomodoroXIDB(`focus-review-cache-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-review-cache-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )
    const row = {
      spaceId: db.spaceId, sessionId: 'fs-1', operationId: 'review-1',
      draftJson: '{}', updatedAt: '2026-07-15T08:00:00.000Z',
    }
    await repository.saveReviewCache(row)
    expect(await db.sessionReviewDrafts.get([db.spaceId, 'fs-1']))
      .toMatchObject(row)
    await expect(repository.saveReviewCache({ ...row, spaceId: 'space-b' }))
      .rejects.toThrow('focus_session_space_mismatch')
  })

  it('persists the exact review intent before transport and atomically clears it after response', async () => {
    const db = await openPomodoroXIDB(`focus-review-submit-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-review-submit-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    const response = aggregateFixture(db.spaceId) as {
      session: Record<string, unknown>
      commandEnvelopes: Array<Record<string, unknown>>
      commandReceipts: Array<Record<string, unknown>>
      outcomes: Array<Record<string, unknown>>
    }
    response.session.endedAt = '2026-07-15T08:25:00Z'
    response.session.clockState = 'ended'
    response.session.reviewState = 'completed'
    response.session.validity = 'valid'
    response.session.version = 4
    response.commandEnvelopes = [{
      commandId: 'cmd-review-1', spaceId: db.spaceId, sessionId: 'fs-1', sessionRevision: 1,
      workItemId: 'l3', expectedVersion: 2, targetTransition: 'complete', replaySafe: true,
      payloadHash: 'a'.repeat(64), createdAt: '2026-07-15T08:20:00Z',
    }]
    response.commandReceipts = [{
      commandId: 'cmd-review-1', attempt: 1, state: 'succeeded', errorCode: null, detail: null,
      recordedAt: '2026-07-15T08:25:00Z',
    }]
    response.outcomes = [{
      id: 'outcome-1', spaceId: db.spaceId, sessionId: 'fs-1', sessionRevision: 1,
      revision: 1, correctedFromRevision: null, effective: true, workItemId: 'l3', touched: true,
      result: 'completed', executionPersona: null, personaSwitched: null, personaNote: null,
      stateCommand: 'complete', commandId: 'cmd-review-1', reviewedAt: '2026-07-15T08:25:00Z',
      version: 1, createdAt: '2026-07-15T08:25:00Z', updatedAt: '2026-07-15T08:25:00Z',
    }]
    await cacheFocusSession(db, db.spaceId, aggregateFixture(db.spaceId))
    const controller = await SessionReviewDraftController.open({
      db, spaceId: db.spaceId, sessionId: 'fs-1', initialDraft: {
        spaceId: db.spaceId, sessionId: 'fs-1', expectedVersion: 3,
        validity: 'valid', reviewState: 'completed', reviewedAt: '2026-07-15T08:25:00Z', outcomes: [],
      },
    })
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )
    const submit = vi.spyOn(focusSessionApi, 'submitReview')
      .mockRejectedValueOnce(new Error('transport_response_lost'))
      .mockResolvedValueOnce(response as never)
    await expect(repository.submitReview(controller.currentDraft())).rejects.toThrow('transport_response_lost')
    expect(await db.directCommandIntents.get(controller.currentDraft().operationId)).toMatchObject({ state: 'in_flight' })
    await repository.submitReview(controller.currentDraft())

    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0])
    expect(await db.sessionReviewDrafts.get([db.spaceId, 'fs-1'])).toBeUndefined()
    expect(await db.directCommandIntents.get(controller.currentDraft().operationId)).toMatchObject({ state: 'terminal' })
    expect(await db.sessionCommandQueue.get('cmd-review-1')).toMatchObject({ state: 'terminal', lastReceiptState: 'succeeded' })
    expect(await db.sessionWorkItemOutcomes.get('outcome-1')).toMatchObject({ result: 'completed' })
    submit.mockRestore()
    controller.dispose()
  })

  it('holds an ended provisional review without creating an intent, outcome, or review outbox row', async () => {
    const db = await openPomodoroXIDB(`focus-review-provisional-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-review-provisional-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    await meta.sessionTabs.put({
      tabId: 'tab-a', deviceId: 'device-a', openedAt: '2026-07-15T08:00:00Z',
      lastSeenAt: '2026-07-15T08:00:00Z', closedAt: null,
    })
    await db.projects.put({ id: 'project-1', name: 'Project', version: 1 })
    await db.workItems.bulkPut([
      { id: 'l2', projectId: 'project-1', title: 'Parent', depth: 2, parentId: null, statusDefinitionId: 'status-open', version: 4 },
      { id: 'l3', projectId: 'project-1', title: 'Child', depth: 3, parentId: 'l2', statusDefinitionId: 'status-open', version: 2 },
    ])
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )
    await repository.startProvisional({
      operationId: 'offline-review-1', spaceId: db.spaceId, sessionId: 'offline-review-1',
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3'], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00.000Z', deviceId: 'device-a', tabId: 'tab-a',
      expectedWorkItemVersions: { l2: 4, l3: 2 },
    })
    await repository.endProvisional('offline-review-1', {
      occurredAt: '2026-07-15T08:10:00.000Z', timerCompletion: 'ended_early',
    })
    const controller = await SessionReviewDraftController.open({
      db, spaceId: db.spaceId, sessionId: 'offline-review-1', initialDraft: {
        spaceId: db.spaceId, sessionId: 'offline-review-1', expectedVersion: 0,
        validity: 'valid', reviewState: 'completed', reviewedAt: '2026-07-15T08:10:00.000Z', outcomes: [],
      },
    })
    const outboxBefore = await db.outbox.toArray()
    const result = await repository.submitReview(controller.currentDraft())

    expect(result.session).toMatchObject({ sessionId: 'offline-review-1', ownershipState: 'local_provisional', validity: 'pending', reviewState: 'pending' })
    expect(await db.outbox.toArray()).toEqual(outboxBefore)
    expect(await db.sessionWorkItemOutcomes.where('sessionId').equals('offline-review-1').count()).toBe(0)
    expect(await db.directCommandIntents.get(controller.currentDraft().operationId)).toBeUndefined()
    expect(await db.sessionReviewDrafts.get([db.spaceId, 'offline-review-1'])).toBeDefined()
    expect(await meta.provisionalOperations.get('offline-review-1')).toMatchObject({ state: 'awaiting_s4' })
    controller.dispose()
  })

  it('absorbs exactly the provisional activation outbox and removes replaced child rows', async () => {
    const db = await openPomodoroXIDB(`focus-activation-cleanup-${crypto.randomUUID()}`)
    const meta = new MetaDB(`meta-focus-activation-cleanup-${crypto.randomUUID()}`)
    databases.push(db, meta)
    await meta.open()
    await meta.sessionTabs.put({
      tabId: 'tab-a', deviceId: 'device-a', openedAt: '2026-07-15T08:00:00.000Z',
      lastSeenAt: '2026-07-15T08:00:00.000Z', closedAt: null,
    })
    await db.projects.put({ id: 'project-1', name: 'Project', version: 1 })
    await db.workItems.bulkPut([
      { id: 'l2', projectId: 'project-1', title: 'Parent', depth: 2, parentId: null, statusDefinitionId: 'status-open', version: 4 },
      { id: 'l3', projectId: 'project-1', title: 'Child', depth: 3, parentId: 'l2', statusDefinitionId: 'status-open', version: 2 },
    ])
    const repository = new FocusSessionRepository(
      db, meta, db.spaceId, { deviceId: 'device-a', tabId: 'tab-a' }, {} as never,
      { run: async <T>(_operationId: string, effect: () => Promise<T>) => effect() },
    )
    const provisional = await repository.startProvisional({
      operationId: 'offline-activation-1', spaceId: db.spaceId, sessionId: 'fs-1',
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3'], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00.000Z', deviceId: 'device-a', tabId: 'tab-a',
      expectedWorkItemVersions: { l2: 4, l3: 2 },
    })
    const operation = await meta.provisionalOperations.get('offline-activation-1')
    if (!operation) throw new Error('test operation missing')
    const provisionalPlanId = provisional.plan[0]!.id
    const authoritative = aggregateFixture(db.spaceId, 'authoritative')
    const result = {
      spaceId: db.spaceId, sessionId: 'fs-1', operationId: 'offline-activation-1',
      state: 'active' as const, ownerDeviceId: 'device-a', ownerTabId: 'tab-a',
      ownershipEpoch: 1, leaseExpiresAt: '2026-07-15T08:30:00Z',
      updatedAt: '2026-07-15T08:10:00Z', kind: 'authoritative' as const,
      session: authoritative,
    }

    await cacheAuthoritativeActivation(db, operation, result, provisional)

    expect(await db.outbox.toArray()).toEqual([])
    expect(await db.sessionActivationApplications.get('offline-activation-1'))
      .toMatchObject({ operationId: 'offline-activation-1', resultKind: 'authoritative' })
    expect(await db.sessionWorkItemPlans.get(provisionalPlanId)).toBeUndefined()
    expect(await db.sessionWorkItemPlans.get('plan-1')).toBeDefined()
  })
})
