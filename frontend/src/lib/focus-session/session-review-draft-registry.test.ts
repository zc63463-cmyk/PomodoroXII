import { afterEach, describe, expect, it } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { SessionReviewDraftController } from './session-review-draft-registry'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []

const initialDraft = {
  spaceId: 'space-a', sessionId: 'fs-1', expectedVersion: 3,
  validity: 'valid' as const, reviewState: 'completed' as const,
  reviewedAt: '2026-07-15T09:00:00Z', outcomes: [],
}

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
})

describe('SessionReviewDraftController', () => {
  it('persists a structured review draft with one fixed operation ID before transport', async () => {
    const db = await openPomodoroXIDB(`review-draft-${crypto.randomUUID()}`)
    databases.push(db)

    const first = await SessionReviewDraftController.open({
      db, spaceId: db.spaceId, sessionId: 'fs-1', initialDraft,
    })
    const operationId = first.currentDraft().operationId
    expect(operationId).toEqual(expect.any(String))
    await first.flush('before-submit')

    const persisted = await db.sessionReviewDrafts.get([db.spaceId, 'fs-1'])
    expect(persisted).toMatchObject({ spaceId: db.spaceId, sessionId: 'fs-1', operationId })
    expect(JSON.parse(String(persisted?.draftJson))).toMatchObject({
      operationId, spaceId: db.spaceId, sessionId: 'fs-1', validity: 'valid',
    })

    const restarted = await SessionReviewDraftController.open({
      db, spaceId: db.spaceId, sessionId: 'fs-1', initialDraft,
    })
    expect(restarted.currentDraft().operationId).toBe(operationId)
  })

  it('rejects changing the operation identity after the draft is opened', async () => {
    const db = await openPomodoroXIDB(`review-draft-identity-${crypto.randomUUID()}`)
    databases.push(db)
    const controller = await SessionReviewDraftController.open({
      db, spaceId: db.spaceId, sessionId: 'fs-1', initialDraft,
    })

    expect(() => controller.update({
      ...controller.currentDraft(), operationId: 'different-operation',
    })).toThrow('review_draft_identity_change_forbidden')
  })
})
