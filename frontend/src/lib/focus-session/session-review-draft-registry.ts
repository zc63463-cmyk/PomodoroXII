import { canonicalize } from 'json-canonicalize'
import { z } from 'zod'
import { sessionReviewDraftSchema } from '@/lib/contracts/focus-session'
import { createCriticalDraftRegistry, type DraftFlushReason } from '@/lib/critical-draft-registry'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { JsonValue } from '@/lib/contracts/payload-hash'
import type { PomodoroXIDB } from '@/services/database'

export type SessionReviewDraft = z.infer<typeof sessionReviewDraftSchema>

export class SessionReviewDraftController {
  private readonly unregister: () => void
  private disposed = false
  private disposing = false
  private disposePromise: Promise<void> | null = null
  private flushQueue: Promise<void> = Promise.resolve()

  private constructor(
    readonly database: PomodoroXIDB,
    readonly spaceId: string,
    readonly sessionId: string,
    private draft: SessionReviewDraft,
  ) {
    this.unregister = sessionReviewDraftRegistry.register(this)
  }

  static async open(input: {
    db: PomodoroXIDB
    spaceId: string
    sessionId: string
    initialDraft: JsonValue
  }): Promise<SessionReviewDraftController> {
    if (input.db.spaceId !== input.spaceId) throw new Error('review_draft_space_mismatch')
    const existing = await input.db.sessionReviewDrafts.get([input.spaceId, input.sessionId]) as Record<string, unknown> | undefined
    let draft: SessionReviewDraft
    if (existing) {
      if (existing.spaceId !== input.spaceId || existing.sessionId !== input.sessionId || typeof existing.draftJson !== 'string') {
        throw new Error('review_draft_identity_mismatch')
      }
      draft = sessionReviewDraftSchema.parse(JSON.parse(existing.draftJson))
      if (draft.operationId !== existing.operationId) throw new Error('review_draft_operation_mismatch')
    } else {
      const source = (input.initialDraft && typeof input.initialDraft === 'object' && !Array.isArray(input.initialDraft))
        ? input.initialDraft as Record<string, JsonValue>
        : {}
      draft = sessionReviewDraftSchema.parse({
        ...source,
        operationId: typeof source.operationId === 'string' && source.operationId.length > 0
          ? source.operationId : crypto.randomUUID(),
        spaceId: input.spaceId,
        sessionId: input.sessionId,
      })
    }
    const controller = new SessionReviewDraftController(input.db, input.spaceId, input.sessionId, draft)
    if (!existing) await controller.flush('before-submit')
    return controller
  }

  currentDraft(): SessionReviewDraft {
    return structuredClone(this.draft)
  }

  update(next: SessionReviewDraft): void {
    if (this.disposed || this.disposing) throw new Error('review_draft_controller_disposed')
    if (next.spaceId !== this.spaceId || next.sessionId !== this.sessionId ||
        next.operationId !== this.draft.operationId) {
      throw new Error('review_draft_identity_change_forbidden')
    }
    this.draft = sessionReviewDraftSchema.parse(next)
  }

  async flush(_reason: DraftFlushReason): Promise<void> {
    if (this.disposed || this.disposing) {
      await this.flushQueue
      return
    }
    const draftJson = canonicalize(this.draft)
    if (draftJson === undefined) throw new Error('review_draft_not_canonical')
    const row = {
      spaceId: this.spaceId,
      sessionId: this.sessionId,
      draftJson,
      operationId: this.draft.operationId,
      updatedAt: canonicalNow(),
    }
    const write = this.flushQueue.then(async () => {
      if (!this.disposed) await this.database.sessionReviewDrafts.put(row)
    })
    this.flushQueue = write.catch(() => undefined)
    await write
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposing = true
    this.disposePromise = this.flushQueue.finally(() => {
      this.disposed = true
      this.unregister()
    })
    return this.disposePromise
  }
}

export async function createOrHydrateSessionReviewDraft(input: {
  db: PomodoroXIDB
  spaceId: string
  sessionId: string
  initialDraft: JsonValue
}): Promise<SessionReviewDraft> {
  return (await SessionReviewDraftController.open(input)).currentDraft()
}

export const sessionReviewDraftRegistry =
  createCriticalDraftRegistry<SessionReviewDraftController>()

export async function requirePersistedExactSessionReviewDraft(
  db: PomodoroXIDB,
  input: SessionReviewDraft,
): Promise<void> {
  if (db.spaceId !== input.spaceId) throw new Error('review_draft_space_mismatch')
  const row = await db.sessionReviewDrafts.get([input.spaceId, input.sessionId]) as Record<string, unknown> | undefined
  const exact = canonicalize(sessionReviewDraftSchema.parse(input))
  if (!row || exact === undefined || row.operationId !== input.operationId || row.draftJson !== exact) {
    throw new Error('review_draft_not_durably_bound')
  }
}
