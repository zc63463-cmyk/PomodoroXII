import { focusSessionAggregateSchema, reconcileFocusSessionCommandsInputSchema, sessionReviewDraftSchema } from '@/lib/contracts/focus-session'
import { buildCommandFields } from '@/lib/contracts/payload-hash'
import { assertResponseSpace } from '@/lib/contracts/task-space'
import { spaceApi } from './api'

export interface FocusSessionReadInput { spaceId: string; sessionId: string }
export interface ReviewOutcomeInput {
  workItemId: string; touched: boolean; result: 'completed' | 'progressed' | 'stuck' | 'untouched' | 'cancelled'
  executionPersona?: 'ox' | 'pig' | 'hajimi' | 'wukong' | null
  personaSwitched?: boolean | null; personaNote?: string | null
  stateCommand: 'complete' | 'cancel' | 'none'; expectedWorkItemVersion: number
}
export interface SubmitReviewInput {
  operationId: string; spaceId: string; sessionId: string; expectedVersion: number
  validity: 'valid' | 'invalid'; reviewState: 'completed' | 'skipped'; reviewedAt: string
  outcomes: ReviewOutcomeInput[]
}
export interface ReconcileInput {
  operationId: string; spaceId: string; sessionId: string
  commandIds: string[]; replaySafe: boolean; abandonCommandIds: string[]; decisionAt: string | null
}

function headers(operationId: string) { return { headers: { 'Idempotency-Key': operationId } } }

function reviewHashPayload(input: SubmitReviewInput) {
  return {
    validity: input.validity,
    review_state: input.reviewState,
    reviewed_at: input.reviewedAt,
    outcomes: input.outcomes.map((outcome) => ({
      work_item_id: outcome.workItemId,
      touched: outcome.touched,
      result: outcome.result,
      state_command: outcome.stateCommand,
      ...(outcome.executionPersona !== undefined
        ? { execution_persona: outcome.executionPersona }
        : {}),
      ...(outcome.personaSwitched !== undefined
        ? { persona_switched: outcome.personaSwitched }
        : {}),
      ...(outcome.personaNote !== undefined
        ? { persona_note: outcome.personaNote }
        : {}),
    })),
  }
}

export const focusSessionApi = {
  async get(spaceIdOrInput: string | FocusSessionReadInput, maybeSessionId?: string) {
    const input = typeof spaceIdOrInput === 'string'
      ? { spaceId: spaceIdOrInput, sessionId: maybeSessionId ?? '' }
      : spaceIdOrInput
    const response = await spaceApi.get(`/focus-sessions/${encodeURIComponent(input.sessionId)}`)
    const aggregate = focusSessionAggregateSchema.parse(response.data)
    assertResponseSpace(aggregate.session, input.spaceId)
    if (aggregate.session.id !== input.sessionId) throw new Error('focus_session_identity_mismatch')
    return aggregate
  },
  async submitReview(input: SubmitReviewInput) {
    sessionReviewDraftSchema.parse(input)
    const payload = {
      expectedVersion: input.expectedVersion,
      validity: input.validity,
      reviewState: input.reviewState,
      reviewedAt: input.reviewedAt,
      outcomes: input.outcomes,
    }
    const fields = await buildCommandFields({
      commandId: input.operationId, spaceId: input.spaceId, targetId: input.sessionId,
      expectedVersion: input.expectedVersion, payload: reviewHashPayload(input),
    })
    const response = await spaceApi.post(`/focus-sessions/${encodeURIComponent(input.sessionId)}/review`, {
      commandId: input.operationId, spaceId: input.spaceId, sessionId: input.sessionId,
      ownershipEpoch: null, payloadHash: fields.payloadHash, payload,
    }, headers(input.operationId))
    const aggregate = focusSessionAggregateSchema.parse(response.data)
    assertResponseSpace(aggregate.session, input.spaceId)
    if (aggregate.session.id !== input.sessionId) throw new Error('focus_session_identity_mismatch')
    return aggregate
  },
  async reconcileCommands(input: ReconcileInput) {
    const parsed = reconcileFocusSessionCommandsInputSchema.parse(input)
    if (parsed.commandIds.includes(parsed.operationId)) throw new Error('reconciliation root must differ from command IDs')
    const payload = {
      commandIds: parsed.commandIds, replaySafe: parsed.replaySafe,
      abandonCommandIds: parsed.abandonCommandIds, decisionAt: parsed.decisionAt,
    }
    const fields = await buildCommandFields({
      commandId: parsed.operationId, spaceId: parsed.spaceId, targetId: parsed.sessionId,
      payload: { command_ids: parsed.commandIds, replay_safe: parsed.replaySafe, abandon_command_ids: parsed.abandonCommandIds, decision_at: parsed.decisionAt },
    })
    const response = await spaceApi.post(`/focus-sessions/${encodeURIComponent(parsed.sessionId)}/commands/reconcile`, {
      commandId: parsed.operationId, spaceId: parsed.spaceId, sessionId: parsed.sessionId,
      ownershipEpoch: null, payloadHash: fields.payloadHash, payload,
    }, headers(parsed.operationId))
    const aggregate = focusSessionAggregateSchema.parse(response.data)
    assertResponseSpace(aggregate.session, parsed.spaceId)
    if (aggregate.session.id !== parsed.sessionId) throw new Error('focus_session_identity_mismatch')
    return aggregate
  },
}
