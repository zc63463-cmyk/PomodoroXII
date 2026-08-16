import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { spaceApi } from './api'
import { focusSessionApi } from './focus-session-api'

vi.mock('./api', () => ({ spaceApi: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }))

const aggregate = (spaceId = 'space-a', sessionId = 'fs-1') => ({
  session: {
    id: sessionId, spaceId, sessionRevision: 1, startedAt: '2026-07-15T08:00:00Z', endedAt: null,
    pauseStartedAt: null, plannedSeconds: 1500, grossSeconds: 0, pausedSeconds: 0, breakSeconds: 0,
    focusedSeconds: 0, clockState: 'running', timerCompletion: null, validity: 'pending',
    validityReason: null, overallProgress: null, mood: null, reviewState: 'not_required',
    ownershipState: 'authoritative', sessionNote: '', version: 1, createdAt: '2026-07-15T08:00:00Z',
    updatedAt: '2026-07-15T08:00:00Z',
  },
  context: null,
  attribution: { id: 'a', spaceId, sessionId, revision: 1, projectId: 'p', level2WorkItemId: 'l2', reason: null, correctedFromRevision: null, effective: true, createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z', version: 1 },
  plan: [], outcomes: [], commandEnvelopes: [], commandReceipts: [],
})

describe('focusSessionApi', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hashes review business fields without Session CAS or optional null injection', async () => {
    vi.mocked(spaceApi.post).mockResolvedValue({ data: aggregate() })
    await focusSessionApi.submitReview({
      operationId: 'review-1', spaceId: 'space-a', sessionId: 'fs-1', expectedVersion: 3,
      validity: 'valid', reviewState: 'completed', reviewedAt: '2026-07-15T09:00:00Z',
      outcomes: [{ workItemId: 'l3-1', touched: true, result: 'completed', stateCommand: 'complete', expectedWorkItemVersion: 7 }],
    })
    const body = vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>
    expect(body.payloadHash).toBe(await hashCommandPayload({
      validity: 'valid', review_state: 'completed', reviewed_at: '2026-07-15T09:00:00Z',
      outcomes: [{ work_item_id: 'l3-1', touched: true, result: 'completed', state_command: 'complete' }],
    }))
  })

  it('rejects unknown reconciliation fields before transport', async () => {
    await expect(focusSessionApi.reconcileCommands({
      operationId: 'root', spaceId: 'space-a', sessionId: 'fs-1', commandIds: ['cmd'],
      replaySafe: false, abandonCommandIds: [], decisionAt: null, expectedVersion: 3,
    } as never)).rejects.toThrow()
    expect(spaceApi.post).not.toHaveBeenCalled()
  })

  it('does not allow a reconciliation root to reuse an envelope command ID', async () => {
    await expect(focusSessionApi.reconcileCommands({
      operationId: 'cmd', spaceId: 'space-a', sessionId: 'fs-1', commandIds: ['cmd'],
      replaySafe: false, abandonCommandIds: [], decisionAt: null,
    })).rejects.toThrow(/root/i)
  })
})
