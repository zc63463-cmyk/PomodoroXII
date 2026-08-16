import {
  activateProvisionalPayloadSchema, activeSessionOperationSchema, activeSessionResponseSchema,
  endActiveSessionResponseSchema, activeSessionLocatorSchema,
} from '@/lib/contracts/focus-session'
import { buildCommandFields } from '@/lib/contracts/payload-hash'
import { metaApi } from './api'

export interface OwnerInput { sessionId: string; operationId: string; ownershipEpoch: number; ownerDeviceId: string; ownerTabId: string }

function headers(operationId: string) { return { headers: { 'Idempotency-Key': operationId } } }

function requireSpace(spaceId: string) {
  if (!spaceId.trim()) throw new Error('spaceId is required')
}

function parseOperation(value: unknown) { return activeSessionOperationSchema.parse(value) }
function parseResponse(value: unknown) { return activeSessionResponseSchema.parse(value) }

const ownedHash = (payload: Record<string, unknown>) => payload

export function activateProvisionalHashPayload(input: {
  cachedAt: string; cachedOwnershipEpoch: number | null; ownerDeviceId: string; ownerTabId: string;
  snapshot: unknown; expectedWorkItemVersions: Record<string, number>
}) {
  const mapSession = (session: Record<string, unknown>) => ({
    session_revision: session.sessionRevision,
    started_at: session.startedAt,
    pause_started_at: session.pauseStartedAt,
    planned_seconds: session.plannedSeconds,
    gross_seconds: session.grossSeconds,
    paused_seconds: session.pausedSeconds,
    break_seconds: session.breakSeconds,
    focused_seconds: session.focusedSeconds,
    validity: session.validity,
    validity_reason: session.validityReason,
    review_state: session.reviewState,
    ownership_state: session.ownershipState,
    session_note: session.sessionNote,
  })
  const mapContext = (context: Record<string, unknown>) => ({
    project_id: context.projectId,
    project_title_snapshot: context.projectTitleSnapshot,
    level2_work_item_id: context.level2WorkItemId,
    level2_title_snapshot: context.level2TitleSnapshot,
    level2_parent_id_snapshot: context.level2ParentIdSnapshot,
    level2_status_definition_id_snapshot: context.level2StatusDefinitionIdSnapshot,
    level2_version_snapshot: context.level2VersionSnapshot,
    level2_effort_lower_seconds_snapshot: context.level2EffortLowerSecondsSnapshot,
    level2_effort_upper_seconds_snapshot: context.level2EffortUpperSecondsSnapshot,
    linked_at: context.linkedAt,
    link_method: context.linkMethod,
  })
  const mapPlan = (plan: Record<string, unknown>) => ({
    id: plan.id,
    work_item_id: plan.workItemId,
    title_snapshot: plan.titleSnapshot,
    level2_work_item_id_snapshot: plan.level2WorkItemIdSnapshot,
    work_item_version_snapshot: plan.workItemVersionSnapshot,
    plan_rank: plan.planRank,
    source: plan.source,
    added_at: plan.addedAt,
    removed_at: plan.removedAt,
    removal_reason: plan.removalReason,
    current_during_session: plan.currentDuringSession,
    completion_draft: plan.completionDraft,
  })
  const snapshot = input.snapshot as Record<string, unknown>
  const snapshotSession = snapshot.session as Record<string, unknown>
  const snapshotContext = snapshot.context as Record<string, unknown>
  const snapshotPlan = Array.isArray(snapshot.plan)
    ? snapshot.plan.map((item) => mapPlan(item as Record<string, unknown>))
    : []
  return {
    cached_at: input.cachedAt,
    owner_device_id: input.ownerDeviceId,
    owner_tab_id: input.ownerTabId,
    snapshot: {
      session: mapSession(snapshotSession),
      context: mapContext(snapshotContext),
      plan: snapshotPlan,
    },
  }
}

export const activeSessionApi = {
  async locate() {
    const response = await metaApi.get('/active-session')
    return parseOperation(response.data)
  },
  async start(input: {
    spaceId: string; sessionId: string; operationId: string; level2WorkItemId: string;
    level3WorkItemIds: string[]; plannedSeconds: number; startedAt: string;
    ownerDeviceId: string; ownerTabId: string; expectedWorkItemVersions: Record<string, number>
  }) {
    requireSpace(input.spaceId)
    const payload = {
      level2WorkItemId: input.level2WorkItemId, level3WorkItemIds: input.level3WorkItemIds,
      plannedSeconds: input.plannedSeconds, startedAt: input.startedAt,
      ownerDeviceId: input.ownerDeviceId, ownerTabId: input.ownerTabId,
      expectedWorkItemVersions: input.expectedWorkItemVersions,
    }
    const fields = await buildCommandFields({ commandId: input.operationId, spaceId: input.spaceId, payload: {
      level2_work_item_id: input.level2WorkItemId, level3_work_item_ids: input.level3WorkItemIds,
      planned_seconds: input.plannedSeconds, started_at: input.startedAt,
      owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId,
    } })
    const response = await metaApi.post('/active-session/start', {
      commandId: input.operationId, spaceId: input.spaceId, sessionId: input.sessionId,
      ownershipEpoch: null, payloadHash: fields.payloadHash, payload,
    }, headers(input.operationId))
    return parseResponse(response.data)
  },
  async activateProvisional(input: { spaceId: string; sessionId: string; operationId: string; payload: {
    cachedAt: string; cachedOwnershipEpoch: number | null; ownerDeviceId: string; ownerTabId: string; snapshot: unknown; expectedWorkItemVersions: Record<string, number>
  } }) {
    requireSpace(input.spaceId)
    const payload = activateProvisionalPayloadSchema.parse(input.payload)
    const fields = await buildCommandFields({ commandId: input.operationId, spaceId: input.spaceId, payload: activateProvisionalHashPayload(payload) })
    const response = await metaApi.post('/active-session/activate-provisional', {
      commandId: input.operationId, spaceId: input.spaceId, sessionId: input.sessionId,
      ownershipEpoch: null, payloadHash: fields.payloadHash, payload,
    }, headers(input.operationId))
    return parseOperation(response.data)
  },
  async heartbeat(input: OwnerInput & { heartbeatAt: string }) {
    const fields = await buildCommandFields({ commandId: input.operationId, payload: { heartbeat_at: input.heartbeatAt, owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId } })
    const response = await metaApi.post('/active-session/heartbeat', {
      commandId: input.operationId, sessionId: input.sessionId, ownershipEpoch: input.ownershipEpoch,
      payloadHash: fields.payloadHash, payload: { heartbeatAt: input.heartbeatAt, ownerDeviceId: input.ownerDeviceId, ownerTabId: input.ownerTabId },
    }, headers(input.operationId))
    return activeSessionLocatorSchema.parse(response.data)
  },
  async pause(input: OwnerInput & { expectedVersion: number; occurredAt: string }) { return clockAction('/pause', input) },
  async resume(input: OwnerInput & { expectedVersion: number; occurredAt: string }) { return clockAction('/resume', input) },
  async end(input: OwnerInput & { expectedVersion: number; occurredAt: string; timerCompletion: 'completed' | 'ended_early' | 'interrupted'; validity: 'pending' | 'valid' | 'invalid'; validityReason: string | null }) {
    const hashPayload = { occurred_at: input.occurredAt, timer_completion: input.timerCompletion, validity: input.validity, validity_reason: input.validityReason, owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId }
    const fields = await buildCommandFields({ commandId: input.operationId, payload: hashPayload })
    const response = await metaApi.post('/active-session/end', {
      commandId: input.operationId, sessionId: input.sessionId, ownershipEpoch: input.ownershipEpoch, payloadHash: fields.payloadHash,
      payload: { expectedVersion: input.expectedVersion, occurredAt: input.occurredAt, timerCompletion: input.timerCompletion, validity: input.validity, validityReason: input.validityReason, ownerDeviceId: input.ownerDeviceId, ownerTabId: input.ownerTabId },
    }, headers(input.operationId))
    return endActiveSessionResponseSchema.parse(response.data)
  },
  async takeover(input: OwnerInput & { newOwnerDeviceId: string; newOwnerTabId: string }) {
    const fields = await buildCommandFields({ commandId: input.operationId, payload: { new_owner_device_id: input.newOwnerDeviceId, new_owner_tab_id: input.newOwnerTabId } })
    const response = await metaApi.post('/active-session/takeover', {
      commandId: input.operationId, sessionId: input.sessionId, ownershipEpoch: input.ownershipEpoch, payloadHash: fields.payloadHash,
      payload: { newOwnerDeviceId: input.newOwnerDeviceId, newOwnerTabId: input.newOwnerTabId },
    }, headers(input.operationId))
    return parseResponse(response.data)
  },
  async updateNote(input: OwnerInput & { expectedVersion: number; sessionNote: string }) {
    const fields = await buildCommandFields({ commandId: input.operationId, payload: { session_note: input.sessionNote, owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId } })
    const response = await metaApi.put('/active-session/note', {
      commandId: input.operationId, sessionId: input.sessionId, ownershipEpoch: input.ownershipEpoch, payloadHash: fields.payloadHash,
      payload: { expectedVersion: input.expectedVersion, sessionNote: input.sessionNote, ownerDeviceId: input.ownerDeviceId, ownerTabId: input.ownerTabId },
    }, headers(input.operationId))
    return parseResponse(response.data)
  },
  async setCurrentPlanItem(input: OwnerInput & { workItemId: string | null; expectedPlanVersions: Record<string, number> }) {
    return runningPlanAction('/plan/current', input, { work_item_id: input.workItemId }, { workItemId: input.workItemId, expectedPlanVersions: input.expectedPlanVersions })
  },
  async setCompletionDraft(input: OwnerInput & { planItemId: string; expectedPlanVersion: number; completionDraft: boolean }) {
    return runningPlanAction('/plan/completion-draft', input, { plan_item_id: input.planItemId, completion_draft: input.completionDraft }, { planItemId: input.planItemId, expectedPlanVersion: input.expectedPlanVersion, completionDraft: input.completionDraft })
  },
  async addPlanItem(input: OwnerInput & { workItemId: string; expectedWorkItemVersion: number; planRank: number; addedAt: string }) {
    return runningPlanAction('/plan/add', input, { work_item_id: input.workItemId, plan_rank: input.planRank, added_at: input.addedAt, owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId }, { workItemId: input.workItemId, expectedWorkItemVersion: input.expectedWorkItemVersion, planRank: input.planRank, addedAt: input.addedAt })
  },
  async removePlanItem(input: OwnerInput & { planItemId: string; expectedPlanVersion: number; removedAt: string; removalReason: string }) {
    return runningPlanAction('/plan/remove', input, { plan_item_id: input.planItemId, removed_at: input.removedAt, removal_reason: input.removalReason, owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId }, { planItemId: input.planItemId, expectedPlanVersion: input.expectedPlanVersion, removedAt: input.removedAt, removalReason: input.removalReason })
  },
  async resolveActivationConflict(input: { sessionId: string; operationId: string; ownershipEpoch: number; winnerRole: 'active' | 'candidate'; decisionAt: string; validityCorrection: { loserValidity: 'invalid'; loserValidityReason: 'activation_conflict_loser' } }) {
    const fields = await buildCommandFields({ commandId: input.operationId, payload: { winner_role: input.winnerRole, decision_at: input.decisionAt, validity_correction: { loser_validity: input.validityCorrection.loserValidity, loser_validity_reason: input.validityCorrection.loserValidityReason } } })
    const response = await metaApi.post('/active-session/resolve-activation-conflict', {
      commandId: input.operationId, sessionId: input.sessionId, ownershipEpoch: input.ownershipEpoch, payloadHash: fields.payloadHash,
      payload: { winnerRole: input.winnerRole, decisionAt: input.decisionAt, validityCorrection: input.validityCorrection },
    }, headers(input.operationId))
    return parseResponse(response.data)
  },
}

async function clockAction(path: string, input: OwnerInput & { expectedVersion: number; occurredAt: string }) {
  const fields = await buildCommandFields({ commandId: input.operationId, payload: ownedHash({ occurred_at: input.occurredAt, owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId }) })
  const response = await metaApi.post(`/active-session${path}`, {
    commandId: input.operationId, sessionId: input.sessionId, ownershipEpoch: input.ownershipEpoch, payloadHash: fields.payloadHash,
    payload: { expectedVersion: input.expectedVersion, occurredAt: input.occurredAt, ownerDeviceId: input.ownerDeviceId, ownerTabId: input.ownerTabId },
  }, headers(input.operationId))
  return parseResponse(response.data)
}

async function runningPlanAction(path: string, input: OwnerInput, hashPayload: Record<string, unknown>, payload: Record<string, unknown>) {
  const fields = await buildCommandFields({ commandId: input.operationId, payload: { ...hashPayload, owner_device_id: input.ownerDeviceId, owner_tab_id: input.ownerTabId } })
  const response = await metaApi.post(`/active-session${path}`, {
    commandId: input.operationId, sessionId: input.sessionId, ownershipEpoch: input.ownershipEpoch, payloadHash: fields.payloadHash,
    payload: { ...payload, ownerDeviceId: input.ownerDeviceId, ownerTabId: input.ownerTabId },
  }, headers(input.operationId))
  return parseResponse(response.data)
}
