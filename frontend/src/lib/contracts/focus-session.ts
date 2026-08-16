import { z } from 'zod'
import type { JsonValue } from './payload-hash'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'

const id = z.string().min(1).max(64)
const utc = z.string().datetime({ offset: true })
const canonicalUtc = utc.refine((value) => value.endsWith('Z'), {
  message: 'timestamp must be canonical UTC with Z suffix',
})
const operationId = z.string().min(1).max(128)
const payloadHash = z.string().regex(/^[0-9a-f]{64}$/)
const nonnegativeVersion = z.number().int().nonnegative()
const positiveEpoch = z.number().int().positive()

export const clockStateSchema = z.enum(['running', 'paused', 'ended'])
export const timerCompletionSchema = z.enum(['completed', 'ended_early', 'interrupted'])
export const validitySchema = z.enum(['pending', 'valid', 'invalid'])
export const reviewStateSchema = z.enum(['not_required', 'pending', 'completed', 'skipped'])
export const ownershipStateSchema = z.enum(['authoritative', 'local_provisional', 'activation_conflict'])
export const receiptStateSchema = z.enum(['not_needed', 'pending', 'succeeded', 'failed', 'conflict', 'unknown', 'abandoned'])
export const executionPersonaSchema = z.enum(['ox', 'pig', 'hajimi', 'wukong'])
export const overallProgressSchema = z.enum(['smooth', 'progressed', 'stuck', 'interrupted'])
export const sessionMoodSchema = z.enum(['great', 'good', 'normal', 'bad'])

const syncWireSystem = {
  id,
  spaceId: id,
  createdAt: utc,
  updatedAt: utc,
  version: nonnegativeVersion,
} as const

const syncCommandSystem = {
  id,
  createdAt: utc,
  updatedAt: utc,
  version: nonnegativeVersion,
} as const

const sessionCommandEnvelopeSchema = z.object({
  commandId: operationId,
  spaceId: id,
  sessionId: id,
  sessionRevision: nonnegativeVersion,
  workItemId: id,
  expectedVersion: nonnegativeVersion,
  targetTransition: z.string().min(1),
  replaySafe: z.boolean(),
  payloadHash,
  createdAt: utc,
}).strict()

const sessionCommandReceiptBackendSchema = z.object({
  commandId: operationId,
  state: receiptStateSchema,
  errorCode: z.string().nullable(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).nullable(),
  result: z.unknown().nullable(),
  updatedAt: utc,
}).strict()

export const sessionCommandReceiptSchema = z.object({
  commandId: operationId,
  attempt: nonnegativeVersion,
  state: receiptStateSchema,
  errorCode: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  recordedAt: utc,
  retryable: z.boolean().optional(),
  result: z.unknown().nullable().optional(),
}).strict()

export const sessionCommandReceiptWireSchema = z.union([
  sessionCommandReceiptBackendSchema,
  sessionCommandReceiptSchema,
])

const sessionTaskContextBusiness = {
  sessionId: id,
  projectId: id,
  level2WorkItemId: id,
  projectTitleSnapshot: z.string().min(1),
  level2TitleSnapshot: z.string().min(1),
  level2ParentIdSnapshot: id.nullable(),
  level2StatusDefinitionIdSnapshot: id,
  level2VersionSnapshot: nonnegativeVersion,
  level2EffortLowerSecondsSnapshot: z.number().int().nonnegative().nullable(),
  level2EffortUpperSecondsSnapshot: z.number().int().nonnegative().nullable(),
  linkedAt: utc,
  linkMethod: z.enum(['explicit', 'contextual_confirmed']),
} as const

export const sessionTaskContextRecoveryWireSchema = z.object({ ...syncWireSystem, ...sessionTaskContextBusiness }).strict()
export const sessionTaskContextCommandPostImageSchema = z.object({ ...syncCommandSystem, ...sessionTaskContextBusiness }).strict()
export const sessionTaskContextSchema = sessionTaskContextRecoveryWireSchema

const sessionAttributionBusiness = {
  sessionId: id,
  revision: z.number().int().positive(),
  projectId: id,
  level2WorkItemId: id,
  reason: z.string().nullable(),
  correctedFromRevision: z.number().int().positive().nullable(),
  effective: z.boolean(),
} as const

export const sessionAttributionRevisionRecoveryWireSchema = z.object({ ...syncWireSystem, ...sessionAttributionBusiness }).strict()
export const sessionAttributionRevisionCommandPostImageSchema = z.object({ ...syncCommandSystem, ...sessionAttributionBusiness }).strict()
export const sessionAttributionRevisionSchema = sessionAttributionRevisionRecoveryWireSchema

const sessionWorkItemPlanBusiness = {
  sessionId: id,
  workItemId: id,
  titleSnapshot: z.string().min(1),
  level2WorkItemIdSnapshot: id,
  workItemVersionSnapshot: nonnegativeVersion,
  planRank: nonnegativeVersion,
  source: z.enum(['before_start', 'during_session', 'review_materialized']),
  addedAt: utc,
  removedAt: utc.nullable(),
  removalReason: z.string().nullable(),
  currentDuringSession: z.boolean(),
  completionDraft: z.boolean(),
} as const

export const sessionWorkItemPlanRecoveryWireSchema = z.object({ ...syncWireSystem, ...sessionWorkItemPlanBusiness }).strict()
export const sessionWorkItemPlanCommandPostImageSchema = z.object({ ...syncCommandSystem, ...sessionWorkItemPlanBusiness }).strict()
export const sessionWorkItemPlanSchema = sessionWorkItemPlanRecoveryWireSchema

const sessionWorkItemOutcomeBusiness = {
  sessionId: id,
  sessionRevision: nonnegativeVersion,
  revision: z.number().int().positive(),
  correctedFromRevision: z.number().int().positive().nullable(),
  effective: z.boolean(),
  workItemId: id,
  touched: z.boolean(),
  result: z.enum(['completed', 'progressed', 'stuck', 'untouched', 'cancelled']),
  executionPersona: executionPersonaSchema.nullable(),
  personaSwitched: z.boolean().nullable(),
  personaNote: z.string().max(2_000).nullable(),
  stateCommand: z.enum(['complete', 'cancel', 'none']),
  commandId: operationId.nullable(),
  reviewedAt: utc.nullable(),
} as const

export const sessionWorkItemOutcomeRecoveryWireSchema = z.object({ ...syncWireSystem, ...sessionWorkItemOutcomeBusiness }).strict()
export const sessionWorkItemOutcomeCommandPostImageSchema = z.object({ ...syncCommandSystem, ...sessionWorkItemOutcomeBusiness }).strict()
export const sessionWorkItemOutcomeSchema = sessionWorkItemOutcomeRecoveryWireSchema

export const sessionReviewDraftSchema = z.object({
  operationId,
  spaceId: id,
  sessionId: id,
  expectedVersion: nonnegativeVersion,
  validity: z.enum(['valid', 'invalid']),
  reviewState: z.enum(['completed', 'skipped']),
  reviewedAt: utc,
  outcomes: z.array(z.object({
    workItemId: id,
    touched: z.boolean(),
    result: z.enum(['completed', 'progressed', 'stuck', 'untouched', 'cancelled']),
    stateCommand: z.enum(['complete', 'cancel', 'none']),
    expectedWorkItemVersion: nonnegativeVersion,
    executionPersona: executionPersonaSchema.nullable().optional(),
    personaSwitched: z.boolean().nullable().optional(),
    personaNote: z.string().max(2_000).nullable().optional(),
  }).strict()),
}).strict().superRefine((value, ctx) => {
  const ids = value.outcomes.map((outcome) => outcome.workItemId)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'review Outcome WorkItem IDs must be unique' })
  if (value.reviewState === 'skipped' && value.outcomes.length > 0) ctx.addIssue({ code: 'custom', message: 'a skipped review cannot contain outcomes' })
})

const focusSessionBusiness = {
  sessionRevision: nonnegativeVersion,
  startedAt: utc,
  endedAt: utc.nullable(),
  pauseStartedAt: utc.nullable(),
  plannedSeconds: z.number().int().positive(),
  grossSeconds: z.number().int().nonnegative(),
  pausedSeconds: z.number().int().nonnegative(),
  breakSeconds: z.number().int().nonnegative(),
  focusedSeconds: z.number().int().nonnegative(),
  timerCompletion: timerCompletionSchema.nullable(),
  validity: validitySchema,
  validityReason: z.string().nullable(),
  overallProgress: overallProgressSchema.nullable(),
  mood: sessionMoodSchema.nullable(),
  reviewState: reviewStateSchema,
  ownershipState: ownershipStateSchema,
  sessionNote: z.string().max(20_000),
} as const

export const focusSessionRecoveryWireSchema = z.object({ ...syncWireSystem, ...focusSessionBusiness }).strict()
export const focusSessionCommandPostImageSchema = z.object({ ...syncCommandSystem, ...focusSessionBusiness }).strict()
export const focusSessionSchema = z.object({ ...syncWireSystem, ...focusSessionBusiness, clockState: clockStateSchema }).strict()

type FocusSessionSyncEntityType = Extract<SyncEntityType,
  'focusSession' | 'sessionTaskContext' | 'sessionAttributionRevision' |
  'sessionWorkItemPlan' | 'sessionWorkItemOutcome'>

const focusDeleteSchema = z.strictObject({ id })

export const focusSessionBusinessPostImage = (
  row: z.infer<typeof focusSessionCommandPostImageSchema>,
): JsonValue => ({
  session_revision: row.sessionRevision, started_at: row.startedAt,
  ended_at: row.endedAt, pause_started_at: row.pauseStartedAt,
  planned_seconds: row.plannedSeconds, gross_seconds: row.grossSeconds,
  paused_seconds: row.pausedSeconds, break_seconds: row.breakSeconds,
  focused_seconds: row.focusedSeconds, timer_completion: row.timerCompletion,
  validity: row.validity, validity_reason: row.validityReason,
  overall_progress: row.overallProgress, mood: row.mood,
  review_state: row.reviewState, ownership_state: row.ownershipState,
  session_note: row.sessionNote,
})

export const sessionTaskContextBusinessPostImage = (
  row: z.infer<typeof sessionTaskContextCommandPostImageSchema>,
): JsonValue => ({
  session_id: row.sessionId, project_id: row.projectId,
  level2_work_item_id: row.level2WorkItemId,
  project_title_snapshot: row.projectTitleSnapshot,
  level2_title_snapshot: row.level2TitleSnapshot,
  level2_parent_id_snapshot: row.level2ParentIdSnapshot,
  level2_status_definition_id_snapshot: row.level2StatusDefinitionIdSnapshot,
  level2_version_snapshot: row.level2VersionSnapshot,
  level2_effort_lower_seconds_snapshot: row.level2EffortLowerSecondsSnapshot,
  level2_effort_upper_seconds_snapshot: row.level2EffortUpperSecondsSnapshot,
  linked_at: row.linkedAt, link_method: row.linkMethod,
})

export const sessionAttributionBusinessPostImage = (
  row: z.infer<typeof sessionAttributionRevisionCommandPostImageSchema>,
): JsonValue => ({
  session_id: row.sessionId, revision: row.revision, project_id: row.projectId,
  level2_work_item_id: row.level2WorkItemId, reason: row.reason,
  corrected_from_revision: row.correctedFromRevision,
  effective: row.effective, created_at: row.createdAt,
})

export const sessionPlanBusinessPostImage = (
  row: z.infer<typeof sessionWorkItemPlanCommandPostImageSchema>,
): JsonValue => ({
  session_id: row.sessionId, work_item_id: row.workItemId,
  title_snapshot: row.titleSnapshot,
  level2_work_item_id_snapshot: row.level2WorkItemIdSnapshot,
  work_item_version_snapshot: row.workItemVersionSnapshot,
  plan_rank: row.planRank, source: row.source, added_at: row.addedAt,
  removed_at: row.removedAt, removal_reason: row.removalReason,
  current_during_session: row.currentDuringSession,
  completion_draft: row.completionDraft,
})

export const sessionOutcomeBusinessPostImage = (
  row: z.infer<typeof sessionWorkItemOutcomeCommandPostImageSchema>,
): JsonValue => ({
  session_id: row.sessionId, session_revision: row.sessionRevision,
  revision: row.revision, corrected_from_revision: row.correctedFromRevision,
  effective: row.effective, work_item_id: row.workItemId, touched: row.touched,
  result: row.result, execution_persona: row.executionPersona,
  persona_switched: row.personaSwitched, persona_note: row.personaNote,
  state_command: row.stateCommand, command_id: row.commandId,
  reviewed_at: row.reviewedAt,
})

export function focusSessionEntityBusinessPayloadForHash(
  entityType: FocusSessionSyncEntityType,
  action: OutboxAction,
  postImage: JsonValue,
): JsonValue {
  if (action === 'delete') return focusDeleteSchema.parse(postImage)
  switch (entityType) {
    case 'focusSession':
      return focusSessionBusinessPostImage(
        focusSessionCommandPostImageSchema.parse(postImage))
    case 'sessionTaskContext':
      return sessionTaskContextBusinessPostImage(
        sessionTaskContextCommandPostImageSchema.parse(postImage))
    case 'sessionAttributionRevision':
      return sessionAttributionBusinessPostImage(
        sessionAttributionRevisionCommandPostImageSchema.parse(postImage))
    case 'sessionWorkItemPlan':
      return sessionPlanBusinessPostImage(
        sessionWorkItemPlanCommandPostImageSchema.parse(postImage))
    case 'sessionWorkItemOutcome':
      return sessionOutcomeBusinessPostImage(
        sessionWorkItemOutcomeCommandPostImageSchema.parse(postImage))
    default: {
      const exhaustive: never = entityType
      throw new Error(`missing FocusSession hash builder: ${String(exhaustive)}`)
    }
  }
}

export const focusSessionAggregateSchema = z.object({
  session: focusSessionSchema,
  context: sessionTaskContextSchema.nullable(),
  attribution: sessionAttributionRevisionSchema,
  plan: z.array(sessionWorkItemPlanSchema),
  outcomes: z.array(sessionWorkItemOutcomeSchema),
  commandEnvelopes: z.array(sessionCommandEnvelopeSchema),
  commandReceipts: z.array(sessionCommandReceiptWireSchema),
}).strict()

export function deriveClockStateFromPersistedFacts(row: Pick<z.infer<typeof focusSessionRecoveryWireSchema>, 'endedAt' | 'pauseStartedAt'>) {
  return row.endedAt !== null ? 'ended' as const : row.pauseStartedAt !== null ? 'paused' as const : 'running' as const
}

export function projectFocusSessionRecoveryWireToCache(raw: unknown) {
  const wire = focusSessionRecoveryWireSchema.parse(raw)
  const { id: sessionId, spaceId: _spaceId, ...facts } = wire
  return { sessionId, ...facts, clockState: deriveClockStateFromPersistedFacts(wire) }
}

const provisionalSessionSnapshotSchema = z.object({
  sessionRevision: nonnegativeVersion,
  startedAt: canonicalUtc,
  pauseStartedAt: canonicalUtc.nullable(),
  plannedSeconds: z.number().int().positive(),
  grossSeconds: z.number().int().nonnegative(),
  pausedSeconds: z.number().int().nonnegative(),
  breakSeconds: z.number().int().nonnegative(),
  focusedSeconds: z.number().int().nonnegative(),
  validity: z.literal('pending'),
  validityReason: z.string().max(500).nullable(),
  reviewState: z.literal('not_required'),
  ownershipState: z.literal('local_provisional'),
  sessionNote: z.string().max(20_000),
}).strict()

const provisionalTaskContextSnapshotSchema = z.object({
  projectId: id,
  projectTitleSnapshot: z.string().min(1).max(500),
  level2WorkItemId: id,
  level2TitleSnapshot: z.string().min(1).max(500),
  level2ParentIdSnapshot: id.nullable(),
  level2StatusDefinitionIdSnapshot: id,
  level2VersionSnapshot: nonnegativeVersion,
  level2EffortLowerSecondsSnapshot: z.number().int().nonnegative().nullable(),
  level2EffortUpperSecondsSnapshot: z.number().int().nonnegative().nullable(),
  linkedAt: canonicalUtc,
  linkMethod: z.enum(['explicit', 'contextual_confirmed']),
}).strict()

const provisionalPlanItemSnapshotSchema = z.object({
  id,
  workItemId: id,
  titleSnapshot: z.string().min(1).max(500),
  level2WorkItemIdSnapshot: id,
  workItemVersionSnapshot: nonnegativeVersion,
  planRank: nonnegativeVersion,
  source: z.enum(['before_start', 'during_session']),
  addedAt: canonicalUtc,
  removedAt: canonicalUtc.nullable(),
  removalReason: z.string().max(500).nullable(),
  currentDuringSession: z.boolean(),
  completionDraft: z.boolean(),
}).strict()

const provisionalFocusSessionSnapshotSchema = z.object({
  session: provisionalSessionSnapshotSchema,
  context: provisionalTaskContextSnapshotSchema,
  plan: z.array(provisionalPlanItemSnapshotSchema),
}).strict()

export const activateProvisionalPayloadSchema = z.object({
  cachedAt: canonicalUtc,
  cachedOwnershipEpoch: positiveEpoch.nullable(),
  ownerDeviceId: id,
  ownerTabId: id,
  snapshot: provisionalFocusSessionSnapshotSchema,
  expectedWorkItemVersions: z.record(id, nonnegativeVersion),
}).strict().superRefine((payload, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  const { session, context, plan } = payload.snapshot
  const startedAt = Date.parse(session.startedAt)
  const cachedAt = Date.parse(payload.cachedAt)
  if (startedAt > cachedAt) issue('startedAt must not exceed cachedAt')
  if (session.pauseStartedAt) {
    const pauseAt = Date.parse(session.pauseStartedAt)
    if (pauseAt < startedAt || pauseAt > cachedAt) issue('pauseStartedAt must be between startedAt and cachedAt')
  }
  if (context.level2EffortLowerSecondsSnapshot !== null && context.level2EffortUpperSecondsSnapshot !== null &&
      context.level2EffortLowerSecondsSnapshot > context.level2EffortUpperSecondsSnapshot) issue('effort lower snapshot must not exceed upper snapshot')
  const expected = new Map<string, number>([[context.level2WorkItemId, context.level2VersionSnapshot]])
  const planIds = new Set<string>()
  const workItemIds = new Set<string>()
  const ranks = new Set<number>()
  let currentCount = 0
  for (const item of plan) {
    if (planIds.has(item.id)) issue('provisional plan IDs must be unique')
    if (workItemIds.has(item.workItemId)) issue('provisional WorkItem IDs must be unique')
    if (ranks.has(item.planRank)) issue('provisional plan ranks must be unique')
    planIds.add(item.id); workItemIds.add(item.workItemId); ranks.add(item.planRank)
    if (item.level2WorkItemIdSnapshot !== context.level2WorkItemId) issue('plan level2 snapshot must match Context')
    const removed = item.removedAt !== null
    const hasReason = item.removalReason !== null && item.removalReason.trim().length > 0
    if (removed !== hasReason) issue('removed plan item requires removedAt and nonblank reason')
    if (!removed && item.currentDuringSession) currentCount += 1
    expected.set(item.workItemId, item.workItemVersionSnapshot)
  }
  if (currentCount > 1) issue('at most one active plan item may be current')
  const actualKeys = Object.keys(payload.expectedWorkItemVersions).sort()
  const expectedKeys = [...expected.keys()].sort()
  if (actualKeys.join('\0') !== expectedKeys.join('\0')) issue('expectedWorkItemVersions must exactly cover Context and Plan')
  for (const [workItemId, version] of expected) {
    if (payload.expectedWorkItemVersions[workItemId] !== version) issue('expectedWorkItemVersions must equal frozen snapshot versions')
  }
})

export const activationConflictValidityCorrectionSchema = z.object({
  loserValidity: z.literal('invalid'),
  loserValidityReason: z.literal('activation_conflict_loser'),
}).strict()
export const activationConflictRoleSchema = z.enum(['active', 'candidate'])
export const resolveActivationConflictPayloadSchema = z.object({
  winnerRole: activationConflictRoleSchema,
  decisionAt: canonicalUtc,
  validityCorrection: activationConflictValidityCorrectionSchema,
}).strict()

const ownerProof = z.object({ ownerDeviceId: id, ownerTabId: id }).strict()
const root = z.object({ commandId: operationId, sessionId: id, ownershipEpoch: positiveEpoch, payloadHash }).strict()
const target = <T extends z.ZodTypeAny>(payload: T) => z.object({ commandId: operationId, spaceId: id, sessionId: id, ownershipEpoch: z.null(), payloadHash, payload }).strict()
const locator = <T extends z.ZodTypeAny>(payload: T) => root.extend({ payload })

export const startActiveSessionPayloadSchema = z.object({
  level2WorkItemId: id, level3WorkItemIds: z.array(id), plannedSeconds: z.number().int().positive(),
  startedAt: canonicalUtc, ownerDeviceId: id, ownerTabId: id,
  expectedWorkItemVersions: z.record(id, nonnegativeVersion),
}).strict()
export const startActiveSessionRequestSchema = target(startActiveSessionPayloadSchema)
export const heartbeatPayloadSchema = ownerProof.extend({ heartbeatAt: canonicalUtc }).strict()
export const heartbeatRequestSchema = locator(heartbeatPayloadSchema)
export const ownedClockPayloadSchema = ownerProof.extend({ expectedVersion: nonnegativeVersion, occurredAt: canonicalUtc }).strict()
export const pauseActiveSessionRequestSchema = locator(ownedClockPayloadSchema)
export const resumeActiveSessionRequestSchema = locator(ownedClockPayloadSchema)
export const endActiveSessionPayloadSchema = ownedClockPayloadSchema.extend({ timerCompletion: timerCompletionSchema, validity: validitySchema, validityReason: z.string().max(500).nullable() }).strict()
export const endActiveSessionRequestSchema = locator(endActiveSessionPayloadSchema)
export const takeoverPayloadSchema = z.object({ newOwnerDeviceId: id, newOwnerTabId: id }).strict()
export const takeoverRequestSchema = locator(takeoverPayloadSchema)
export const updateActiveSessionNotePayloadSchema = ownerProof.extend({ expectedVersion: nonnegativeVersion, sessionNote: z.string().max(20_000) }).strict()
export const updateActiveSessionNoteRequestSchema = locator(updateActiveSessionNotePayloadSchema)
export const setCurrentPlanItemPayloadSchema = ownerProof.extend({ workItemId: id.nullable(), expectedPlanVersions: z.record(id, nonnegativeVersion) }).strict()
export const setCurrentPlanItemRequestSchema = locator(setCurrentPlanItemPayloadSchema)
export const setCompletionDraftPayloadSchema = ownerProof.extend({ planItemId: id, expectedPlanVersion: nonnegativeVersion, completionDraft: z.boolean() }).strict()
export const setCompletionDraftRequestSchema = locator(setCompletionDraftPayloadSchema)
export const addPlanItemPayloadSchema = ownerProof.extend({ workItemId: id, expectedWorkItemVersion: nonnegativeVersion, planRank: nonnegativeVersion, addedAt: canonicalUtc }).strict()
export const addPlanItemRequestSchema = locator(addPlanItemPayloadSchema)
export const removePlanItemPayloadSchema = ownerProof.extend({ planItemId: id, expectedPlanVersion: nonnegativeVersion, removedAt: canonicalUtc, removalReason: z.string().min(1).max(500).refine((value) => value.trim().length > 0) }).strict()
export const removePlanItemRequestSchema = locator(removePlanItemPayloadSchema)
export const activateProvisionalRequestSchema = target(activateProvisionalPayloadSchema)
export const resolveActivationConflictRequestSchema = locator(resolveActivationConflictPayloadSchema)

export const reconcileFocusSessionCommandsPayloadSchema = z.object({
  commandIds: z.array(operationId).min(1), replaySafe: z.boolean(), abandonCommandIds: z.array(operationId), decisionAt: canonicalUtc.nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.commandIds).size !== value.commandIds.length) ctx.addIssue({ code: 'custom', message: 'commandIds must be unique' })
  if (new Set(value.abandonCommandIds).size !== value.abandonCommandIds.length) ctx.addIssue({ code: 'custom', message: 'abandonCommandIds must be unique' })
  if (!value.abandonCommandIds.every((item) => value.commandIds.includes(item))) ctx.addIssue({ code: 'custom', message: 'abandonCommandIds must be a subset of commandIds' })
  if ((value.abandonCommandIds.length === 0) !== (value.decisionAt === null)) ctx.addIssue({ code: 'custom', message: 'decisionAt is required exactly when commands are abandoned' })
})
export const reconcileFocusSessionCommandsRequestSchema = target(reconcileFocusSessionCommandsPayloadSchema)
export const reconcileFocusSessionCommandsInputSchema = z.object({ operationId, spaceId: id, sessionId: id, commandIds: z.array(operationId).min(1), replaySafe: z.boolean(), abandonCommandIds: z.array(operationId), decisionAt: canonicalUtc.nullable() }).strict().superRefine((input, ctx) => {
  const parsed = reconcileFocusSessionCommandsPayloadSchema.safeParse({
    commandIds: input.commandIds, replaySafe: input.replaySafe,
    abandonCommandIds: input.abandonCommandIds, decisionAt: input.decisionAt,
  })
  if (!parsed.success) for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  }
})

export const activeSessionLocatorSchema = z.object({
  spaceId: id, sessionId: id, operationId, state: z.enum(['claiming', 'active', 'releasing']),
  ownerDeviceId: id, ownerTabId: id, ownershipEpoch: positiveEpoch,
  leaseExpiresAt: utc, updatedAt: utc,
}).strict()
export const heartbeatResponseSchema = activeSessionLocatorSchema.extend({ state: z.literal('active') }).strict()
export const activeSessionSchema = activeSessionLocatorSchema.extend({ kind: z.enum(['authoritative', 'resumed']).nullable().optional(), session: focusSessionAggregateSchema }).strict()
export const activationConflictSchema = z.object({ kind: z.literal('activation_conflict'), active: activeSessionSchema, candidate: z.object({ spaceId: id, sessionId: id, session: focusSessionAggregateSchema }).strict() }).strict()
export const activeSessionOperationSchema = activeSessionSchema.or(activationConflictSchema)
export const locatedActiveSessionSchema = activeSessionOperationSchema
export const terminalActiveSessionResponseSchema = z.object({ session: focusSessionAggregateSchema.extend({ session: focusSessionSchema.extend({ clockState: z.literal('ended') }) }), locator: z.null() }).strict()

export type FocusSessionAggregate = z.infer<typeof focusSessionAggregateSchema>
export type FocusSessionAggregateView = FocusSessionAggregate
export type FocusSessionRecoveryWire = z.infer<typeof focusSessionRecoveryWireSchema>
export type FocusSessionCommandPostImage = z.infer<typeof focusSessionCommandPostImageSchema>
export type SessionTaskContextView = z.infer<typeof sessionTaskContextSchema>
export type SessionAttributionRevisionView = z.infer<typeof sessionAttributionRevisionSchema>
export type SessionWorkItemPlanView = z.infer<typeof sessionWorkItemPlanSchema>
export type SessionWorkItemOutcomeView = z.infer<typeof sessionWorkItemOutcomeSchema>
export type SessionCommandEnvelopeView = z.infer<typeof sessionCommandEnvelopeSchema>
export type SessionCommandReceiptView = z.infer<typeof sessionCommandReceiptSchema>
export type SessionCommandReceiptWireView = z.infer<typeof sessionCommandReceiptWireSchema>
export type ProvisionalActivationPayload = z.infer<typeof activateProvisionalPayloadSchema>
export type ReconcileFocusSessionCommandsInput = z.infer<typeof reconcileFocusSessionCommandsInputSchema>
export type ActiveSessionLocator = z.infer<typeof activeSessionLocatorSchema>
export type ActiveSessionView = z.infer<typeof activeSessionSchema>
export type FocusSessionView = z.infer<typeof focusSessionSchema>

// Compatibility names retained only for Task 1 Adapter imports.
export const activeSessionResponseSchema = activeSessionSchema
export const endActiveSessionResponseSchema = terminalActiveSessionResponseSchema
