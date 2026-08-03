import { describe, expect, it } from 'vitest'
import {
  activateProvisionalPayloadSchema, activeSessionLocatorSchema,
  focusSessionAggregateSchema, focusSessionCommandPostImageSchema,
  focusSessionRecoveryWireSchema, projectFocusSessionRecoveryWireToCache,
  reconcileFocusSessionCommandsPayloadSchema,
} from './focus-session'

const aggregate = (spaceId: string, sessionId: string) => ({
  session: {
    id: sessionId, spaceId, sessionRevision: 3,
    startedAt: '2026-07-15T08:00:00Z', endedAt: null, pauseStartedAt: null,
    plannedSeconds: 1500, grossSeconds: 600, pausedSeconds: 0,
    breakSeconds: 0, focusedSeconds: 600, clockState: 'running',
    timerCompletion: null, validity: 'pending', validityReason: null,
    overallProgress: null, mood: null, reviewState: 'not_required',
    ownershipState: 'local_provisional', sessionNote: '', version: 2,
    createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:10:00Z',
  },
  context: null,
  attribution: {
    id: 'attr-1', spaceId, sessionId, revision: 1, projectId: 'project-1',
    level2WorkItemId: 'l2', reason: null, correctedFromRevision: null,
    effective: true, createdAt: '2026-07-15T08:00:00Z',
    updatedAt: '2026-07-15T08:00:00Z', version: 1,
  },
  plan: [], outcomes: [], commandEnvelopes: [], commandReceipts: [],
})

const provisional = () => ({
  cachedAt: '2026-07-15T08:05:00Z', cachedOwnershipEpoch: null,
  ownerDeviceId: 'device-a', ownerTabId: 'tab-a',
  snapshot: {
    session: {
      sessionRevision: 0, startedAt: '2026-07-15T08:00:00Z', pauseStartedAt: null,
      plannedSeconds: 1500, grossSeconds: 300, pausedSeconds: 0, breakSeconds: 0,
      focusedSeconds: 300, validity: 'pending', validityReason: null,
      reviewState: 'not_required', ownershipState: 'local_provisional', sessionNote: '',
    },
    context: {
      projectId: 'project-a', projectTitleSnapshot: 'Project A', level2WorkItemId: 'l2-a',
      level2TitleSnapshot: 'Deliver A', level2ParentIdSnapshot: 'l1-a',
      level2StatusDefinitionIdSnapshot: 'status-progress', level2VersionSnapshot: 4,
      level2EffortLowerSecondsSnapshot: 1200, level2EffortUpperSecondsSnapshot: 2400,
      linkedAt: '2026-07-15T08:00:00Z', linkMethod: 'explicit',
    },
    plan: [],
  },
  expectedWorkItemVersions: { 'l2-a': 4 },
})

describe('FocusSession contract boundaries', () => {
  it('keeps cache clockState separate from command and recovery shapes', () => {
    const view = focusSessionAggregateSchema.parse(aggregate('space-a', 'fs-a')).session
    const { spaceId: _space, clockState: _clock, ...postImage } = view
    expect(focusSessionCommandPostImageSchema.parse(postImage)).not.toHaveProperty('clockState')
    const { clockState: _derived, ...wire } = view
    expect(focusSessionRecoveryWireSchema.parse(wire).id).toBe('fs-a')
    expect(projectFocusSessionRecoveryWireToCache(wire)).toMatchObject({ sessionId: 'fs-a', clockState: 'running' })
  })

  it.each([0, true, 1.5])('rejects invalid ownership epochs (%p)', (epoch) => {
    const body = {
      spaceId: 'space-a', sessionId: 'fs-a', operationId: 'op-a', state: 'active',
      ownerDeviceId: 'device-a', ownerTabId: 'tab-a', ownershipEpoch: epoch,
      leaseExpiresAt: '2026-07-15T08:02:00Z', updatedAt: '2026-07-15T08:01:00Z',
    }
    expect(activeSessionLocatorSchema.safeParse(body).success).toBe(false)
  })

  it.each([0, true, 1.5])('rejects invalid cached provisional epochs (%p)', (epoch) => {
    expect(activateProvisionalPayloadSchema.safeParse({ ...provisional(), cachedOwnershipEpoch: epoch }).success).toBe(false)
  })

  it('rejects malformed abandonment subsets and timestamp pairings', () => {
    for (const payload of [
      { commandIds: ['a'], replaySafe: false, abandonCommandIds: ['b'], decisionAt: '2026-07-15T08:00:00Z' },
      { commandIds: ['a'], replaySafe: false, abandonCommandIds: ['a'], decisionAt: null },
      { commandIds: ['a'], replaySafe: false, abandonCommandIds: [], decisionAt: '2026-07-15T08:00:00Z' },
    ]) expect(reconcileFocusSessionCommandsPayloadSchema.safeParse(payload).success).toBe(false)
  })
})
