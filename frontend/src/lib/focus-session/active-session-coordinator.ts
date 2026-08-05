import { isAxiosError } from 'axios'
import {
  activeSessionSchema,
  type ActiveSessionLocator,
  type ActiveSessionView,
  type FocusSessionAggregateView,
  type FocusSessionView,
  type ReconcileFocusSessionCommandsInput,
} from '@/lib/contracts/focus-session'
import {
  buildActivateProvisionalPayload,
  cacheAuthoritativeActivation,
  cacheFocusSession,
  readSessionCommandReceipts,
  type LocalFocusSessionAggregate,
} from './focus-session-repository'
import { BrowserProvisionalOperationLock, type ProvisionalOperationLock } from './provisional-operation-lock'
import { withDetachedSpaceDatabase } from '@/services/space-db'
import { activeSessionApi, type OwnerInput } from '@/services/active-session-api'
import { MetaDB, type ActiveSessionLocatorMirror } from '@/services/meta-database'
import type { PomodoroXIDB } from '@/services/database'
import { useTimerStore } from '@/stores/timer-store'
import { touchTabIdentity, type TabIdentity } from './tab-identity'

export type LocatedActiveSessionResponse = ActiveSessionView | {
  kind: 'activation_conflict'
  active: ActiveSessionView
  candidate: { spaceId: string; sessionId: string; session: FocusSessionAggregateView }
}

export type TerminalActiveSessionResponse = {
  session: FocusSessionAggregateView & { session: FocusSessionView & { clockState: 'ended' } }
  locator: null
}

export interface GlobalStartActiveSessionInput {
  spaceId: string
  sessionId: string
  operationId: string
  level2WorkItemId: string
  level3WorkItemIds: string[]
  plannedSeconds: number
  startedAt: string
  expectedWorkItemVersions: Record<string, number>
}

export interface ActiveSessionApiLike {
  locate(): Promise<LocatedActiveSessionResponse | null>
  start(input: GlobalStartActiveSessionInput & Pick<OwnerInput, 'ownerDeviceId' | 'ownerTabId'>): Promise<ActiveSessionView>
  heartbeat(input: OwnerInput & { heartbeatAt: string }): Promise<ActiveSessionLocator>
  takeover(input: OwnerInput & { newOwnerDeviceId: string; newOwnerTabId: string }): Promise<ActiveSessionView>
  pause(input: OwnerInput & { expectedVersion: number; occurredAt: string }): Promise<ActiveSessionView>
  resume(input: OwnerInput & { expectedVersion: number; occurredAt: string }): Promise<ActiveSessionView>
  end(input: OwnerInput & {
    expectedVersion: number; occurredAt: string; timerCompletion: TimerCompletion;
    validity: 'pending' | 'valid' | 'invalid'; validityReason: string | null
  }): Promise<TerminalActiveSessionResponse>
  updateNote(input: OwnerInput & { expectedVersion: number; sessionNote: string }): Promise<ActiveSessionView>
  setCurrentPlanItem(input: OwnerInput & { workItemId: string | null; expectedPlanVersions: Record<string, number> }): Promise<ActiveSessionView>
  setCompletionDraft(input: OwnerInput & { planItemId: string; expectedPlanVersion: number; completionDraft: boolean }): Promise<ActiveSessionView>
  addPlanItem(input: OwnerInput & { workItemId: string; expectedWorkItemVersion: number; planRank: number; addedAt: string }): Promise<ActiveSessionView>
  removePlanItem(input: OwnerInput & { planItemId: string; expectedPlanVersion: number; removedAt: string; removalReason: string }): Promise<ActiveSessionView>
  activateProvisional?(input: { spaceId: string; sessionId: string; operationId: string; payload: unknown }): Promise<LocatedActiveSessionResponse>
  reconcileCommands?(input: ReconcileFocusSessionCommandsInput): Promise<unknown>
}

export type TimerCompletion = 'completed' | 'ended_early' | 'interrupted'

interface IssuedLocatorWrite {
  sequence: number
  operationId: string
  spaceId: string
  sessionId: string
  ownershipEpoch: number
  ownerDeviceId: string
  ownerTabId: string
}

interface IssuedStartWrite {
  sequence: number
  operationId: string
  spaceId: string
  sessionId: string
  ownerDeviceId: string
  ownerTabId: string
}

const activeFromLocated = (
  response: LocatedActiveSessionResponse | null,
): ActiveSessionView | null => response?.kind === 'activation_conflict' ? response.active : response

const toMirror = (locator: ActiveSessionView | ActiveSessionLocator): ActiveSessionLocatorMirror => ({
  key: 'active',
  spaceId: locator.spaceId,
  sessionId: locator.sessionId,
  operationId: locator.operationId,
  state: locator.state,
  ownerDeviceId: locator.ownerDeviceId,
  ownerTabId: locator.ownerTabId,
  ownershipEpoch: locator.ownershipEpoch,
  leaseExpiresAt: locator.leaseExpiresAt,
  updatedAt: locator.updatedAt,
})

const errorCode = (error: unknown): string | null => {
  if (isAxiosError(error)) {
    const data = error.response?.data as Record<string, unknown> | undefined
    const detail = data?.detail
    if (typeof data?.code === 'string') return data.code
    if (detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).code === 'string') {
      return (detail as Record<string, unknown>).code as string
    }
  }
  const candidate = error as { code?: unknown; response?: { data?: unknown } } | null
  if (typeof candidate?.code === 'string') return candidate.code
  const data = candidate?.response?.data
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).code === 'string') {
    return (data as Record<string, unknown>).code as string
  }
  if (data && typeof data === 'object') {
    const detail = (data as Record<string, unknown>).detail
    if (typeof detail === 'string') return detail
    if (detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).code === 'string') {
      return (detail as Record<string, unknown>).code as string
    }
  }
  return null
}

const compareTime = (left: string, right: string): number => {
  const a = Date.parse(left)
  const b = Date.parse(right)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return a - b
}

async function loadProvisionalAggregate(
  database: PomodoroXIDB,
  sessionId: string,
): Promise<LocalFocusSessionAggregate> {
  const stored = await database.focusSessions.get(sessionId) as (Record<string, unknown> & { id?: string }) | undefined
  if (!stored) throw new Error('focus_session_not_found')
  const { id: _id, ...session } = stored
  const context = await database.sessionTaskContexts.where('sessionId').equals(sessionId).first()
  const attributions = await database.sessionAttributionRevisions.where('sessionId').equals(sessionId).toArray()
  const attribution = attributions.find((row) => row.effective) ?? attributions[0]
  if (!context || !attribution) throw new Error('provisional_session_children_missing')
  return {
    session: session as LocalFocusSessionAggregate['session'],
    context: context as LocalFocusSessionAggregate['context'],
    attribution: attribution as LocalFocusSessionAggregate['attribution'],
    plan: await database.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray() as LocalFocusSessionAggregate['plan'],
    outcomes: await database.sessionWorkItemOutcomes.where('sessionId').equals(sessionId).toArray() as LocalFocusSessionAggregate['outcomes'],
    commandEnvelopes: await database.sessionCommandEnvelopes.where('sessionId').equals(sessionId).toArray() as LocalFocusSessionAggregate['commandEnvelopes'],
    commandReceipts: await readSessionCommandReceipts(database, sessionId) as LocalFocusSessionAggregate['commandReceipts'],
  }
}

export class ActiveSessionCoordinatorClient {
  private readonly channel: BroadcastChannel | null
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null
  private pendingHeartbeat: {
    operationId: string
    heartbeatAt: string
    issued: IssuedLocatorWrite
  } | null = null
  private nextWriteSequence = 0
  private latestAppliedSequence = 0
  private nextRefreshSequence = 0
  private latestInstalledRefresh = 0
  private installGeneration = 0
  private destroyed = false
  private readonly provisionalLock: ProvisionalOperationLock
  private readonly timer: typeof useTimerStore

  constructor(
    private readonly api: ActiveSessionApiLike = activeSessionApi,
    private readonly meta: MetaDB,
    private readonly identity: TabIdentity,
    provisionalLockOrTimer: ProvisionalOperationLock | typeof useTimerStore = new BrowserProvisionalOperationLock(),
    timer: typeof useTimerStore = useTimerStore,
  ) {
    if ('run' in provisionalLockOrTimer) {
      this.provisionalLock = provisionalLockOrTimer
      this.timer = timer
    } else {
      this.provisionalLock = new BrowserProvisionalOperationLock()
      this.timer = provisionalLockOrTimer
    }
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('pxii:active-session')
    if (this.channel) this.channel.onmessage = () => { void this.refresh(false) }
  }

  async bootstrap(): Promise<void> {
    await this.installLocated(await this.locate(), false)
    this.startHeartbeatIfOwner()
  }

  destroy(): void {
    this.destroyed = true
    if (this.heartbeatHandle !== null) clearInterval(this.heartbeatHandle)
    this.heartbeatHandle = null
    this.channel?.close()
  }

  async refresh(notifyPeers = false): Promise<void> {
    if (this.destroyed) return
    const sequence = ++this.nextRefreshSequence
    const appliedAtIssue = this.latestAppliedSequence
    const located = await this.locate()
    if (this.destroyed) return
    const response = activeFromLocated(located)
    if (sequence < this.latestInstalledRefresh || appliedAtIssue < this.latestAppliedSequence) return
    const live = this.timer.getState().locator
    if (response && live && (
      compareTime(response.updatedAt, live.updatedAt) < 0 ||
      (response.spaceId === live.spaceId && response.sessionId === live.sessionId && (
        response.ownershipEpoch < live.ownershipEpoch ||
        !this.aggregateIsNotOlder(response.session, live.session)
      ))
    )) return
    // A delayed locate-null is allowed to clear only an actually empty live projection.
    if (!response && live && appliedAtIssue < this.latestAppliedSequence) return
    this.latestInstalledRefresh = sequence
    await this.installLocated(located, notifyPeers)
    this.startHeartbeatIfOwner()
  }

  async start(input: GlobalStartActiveSessionInput): Promise<ActiveSessionView> {
    if (!input.spaceId.trim()) throw new Error('spaceId is required for global start')
    this.timer.getState().assertCanStart(input.spaceId)
    const issued: IssuedStartWrite = {
      sequence: ++this.nextWriteSequence,
      operationId: input.operationId,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      ownerDeviceId: this.identity.deviceId,
      ownerTabId: this.identity.tabId,
    }
    const response = await this.guarded(() => this.api.start({
      ...input, ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installStartResponse(response, issued, true)
    return response
  }

  async takeover(): Promise<void> {
    const locator = this.requireLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.takeover({
      sessionId: locator.sessionId, operationId,
      ownershipEpoch: locator.ownershipEpoch,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      newOwnerDeviceId: this.identity.deviceId, newOwnerTabId: this.identity.tabId,
    }))
    await this.installTakeoverResponse(response, issued, true)
  }

  async pause(occurredAt: string): Promise<void> {
    const locator = this.requireOwnedLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.pause({
      sessionId: locator.sessionId, operationId, ownershipEpoch: locator.ownershipEpoch,
      expectedVersion: locator.session.session.version, occurredAt,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installOwnedResponse(response, issued, true)
  }

  async resume(occurredAt: string): Promise<void> {
    const locator = this.requireOwnedLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.resume({
      sessionId: locator.sessionId, operationId, ownershipEpoch: locator.ownershipEpoch,
      expectedVersion: locator.session.session.version, occurredAt,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installOwnedResponse(response, issued, true)
  }

  async heartbeat(): Promise<void> {
    const current = this.requireOwnedLocator()
    const pending = this.pendingHeartbeat ?? (() => {
      const operationId = crypto.randomUUID()
      return {
        operationId,
        heartbeatAt: new Date().toISOString(),
        issued: this.captureWrite(current, operationId),
      }
    })()
    this.pendingHeartbeat = pending
    await touchTabIdentity(this.meta, this.identity)
    try {
      const response = await this.guarded(() => this.api.heartbeat({
        sessionId: current.sessionId, operationId: pending.operationId,
        ownershipEpoch: current.ownershipEpoch,
        ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
        heartbeatAt: pending.heartbeatAt,
      }))
      await this.installHeartbeat(response, pending.issued, true)
      this.pendingHeartbeat = null
    } catch (error) {
      // A response-bearing error is terminal for this intent; transport failures retain it for retry.
      if (isAxiosError(error) ? error.response !== undefined : Boolean((error as { response?: unknown }).response)) {
        this.pendingHeartbeat = null
      }
      throw error
    }
  }

  async updateSessionNote(input: { sessionId: string; sessionNote: string }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.updateNote({
      sessionId: locator.sessionId, operationId, ownershipEpoch: locator.ownershipEpoch,
      expectedVersion: locator.session.session.version, sessionNote: input.sessionNote,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installOwnedResponse(response, issued, true)
    return response.session
  }

  async setCurrentPlanItem(input: { sessionId: string; workItemId: string | null }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.setCurrentPlanItem({
      sessionId: locator.sessionId, operationId, ownershipEpoch: locator.ownershipEpoch,
      workItemId: input.workItemId,
      expectedPlanVersions: Object.fromEntries(locator.session.plan.map((row) => [row.id, row.version])),
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installOwnedResponse(response, issued, true)
    return response.session
  }

  async setCompletionDraft(input: { sessionId: string; planItemId: string; completionDraft: boolean }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const plan = locator.session.plan.find((row) => row.id === input.planItemId)
    if (!plan) throw new Error('session_plan_item_not_found')
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.setCompletionDraft({
      sessionId: locator.sessionId, operationId, ownershipEpoch: locator.ownershipEpoch,
      planItemId: input.planItemId, expectedPlanVersion: plan.version,
      completionDraft: input.completionDraft,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installOwnedResponse(response, issued, true)
    return response.session
  }

  async addPlanItem(input: { sessionId: string; workItemId: string; expectedWorkItemVersion: number; planRank: number; addedAt: string }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.addPlanItem({
      ...input, operationId, ownershipEpoch: locator.ownershipEpoch,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installOwnedResponse(response, issued, true)
    return response.session
  }

  async removePlanItem(input: { sessionId: string; planItemId: string; removedAt: string; removalReason: string }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const plan = locator.session.plan.find((row) => row.id === input.planItemId)
    if (!plan) throw new Error('session_plan_item_not_found')
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.removePlanItem({
      ...input, operationId, ownershipEpoch: locator.ownershipEpoch,
      expectedPlanVersion: plan.version,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installOwnedResponse(response, issued, true)
    return response.session
  }

  async end(input: { occurredAt: string; timerCompletion: TimerCompletion; validity: 'pending' | 'valid' | 'invalid'; validityReason: string | null }): Promise<FocusSessionView> {
    const locator = this.requireOwnedLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const response = await this.guarded(() => this.api.end({
      sessionId: locator.sessionId, operationId, ownershipEpoch: locator.ownershipEpoch,
      expectedVersion: locator.session.session.version,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId, ...input,
    }))
    await this.installEndResponse(response, issued, true)
    return response.session.session
  }

  async reconcileProvisional(operationId: string): Promise<void> {
    return this.provisionalLock.run(operationId, async () => {
      const operation = await this.meta.provisionalOperations.get(operationId)
      if (!operation || operation.state === 'resolved' || operation.state === 'awaiting_s4' || operation.state === 'conflict') return
      const activateProvisional = this.api.activateProvisional
      if (!activateProvisional) throw new Error('active_session_activation_unavailable')
      if (operation.deviceId !== this.identity.deviceId || operation.tabId !== this.identity.tabId) {
        throw new Error('active_session_not_owned')
      }
      await withDetachedSpaceDatabase(operation.spaceId, async (database) => {
        const aggregate = await loadProvisionalAggregate(database, operation.sessionId)
        if (aggregate.session.endedAt !== null || aggregate.session.clockState === 'ended') {
          await this.meta.provisionalOperations.update(operationId, {
            state: 'awaiting_s4', updatedAt: new Date().toISOString(),
          })
          return
        }
        await this.meta.provisionalOperations.update(operationId, {
          state: 'activating', updatedAt: new Date().toISOString(),
        })
        try {
          const response = await activateProvisional({
            spaceId: operation.spaceId,
            sessionId: operation.sessionId,
            operationId,
            payload: buildActivateProvisionalPayload(aggregate, operation),
          })
          const active = activeFromLocated(response)
          if (!active) throw new Error('active_session_activation_empty')
          if (response.kind !== 'activation_conflict') {
            await cacheAuthoritativeActivation(database, operation, response, aggregate)
            await this.meta.provisionalOperations.update(operationId, {
              state: 'resolved', updatedAt: new Date().toISOString(),
            })
          } else {
            await this.meta.provisionalOperations.update(operationId, {
              state: 'conflict', updatedAt: new Date().toISOString(),
            })
          }
          await this.install(active, true)
        } catch (error) {
          const current = await this.meta.provisionalOperations.get(operationId)
          if (current?.state === 'activating') {
            await this.meta.provisionalOperations.update(operationId, {
              state: 'pending', updatedAt: new Date().toISOString(),
            })
          }
          throw error
        }
      })
    })
  }

  private requireLocator(): ActiveSessionView {
    const locator = this.timer.getState().locator
    if (!locator) throw new Error('active_session_not_found')
    return locator
  }

  private requireOwnedLocator(): ActiveSessionView {
    const locator = this.requireLocator()
    if (this.timer.getState().ownershipMode !== 'owner' ||
        locator.ownerDeviceId !== this.identity.deviceId || locator.ownerTabId !== this.identity.tabId) {
      throw new Error('active_session_not_owned')
    }
    return locator
  }

  private requireOwnedSession(sessionId: string): ActiveSessionView {
    const locator = this.requireOwnedLocator()
    if (locator.sessionId !== sessionId) throw new Error('active_session_identity_mismatch')
    return locator
  }

  private captureWrite(locator: ActiveSessionView, operationId: string): IssuedLocatorWrite {
    return {
      sequence: ++this.nextWriteSequence, operationId, spaceId: locator.spaceId,
      sessionId: locator.sessionId, ownershipEpoch: locator.ownershipEpoch,
      ownerDeviceId: locator.ownerDeviceId, ownerTabId: locator.ownerTabId,
    }
  }

  private aggregateIsNotOlder(candidate: FocusSessionAggregateView, live: FocusSessionAggregateView): boolean {
    if (candidate.session.id !== live.session.id || candidate.session.spaceId !== live.session.spaceId ||
        candidate.session.version < live.session.version) return false
    const candidatePlans = new Map(candidate.plan.map((row) => [row.id, row.version]))
    return live.plan.every((row) => candidatePlans.has(row.id) && candidatePlans.get(row.id)! >= row.version)
  }

  private async requireLiveFence(issued: IssuedLocatorWrite): Promise<ActiveSessionView> {
    const live = this.timer.getState().locator
    if (!live || issued.sequence < this.latestAppliedSequence ||
        live.spaceId !== issued.spaceId || live.sessionId !== issued.sessionId ||
        live.ownershipEpoch !== issued.ownershipEpoch ||
        live.ownerDeviceId !== issued.ownerDeviceId || live.ownerTabId !== issued.ownerTabId) {
      return this.rejectStaleResponse()
    }
    return live
  }

  private activeRootMatches(response: ActiveSessionView, issued: IssuedLocatorWrite, live: ActiveSessionView): boolean {
    return response.operationId === issued.operationId && response.spaceId === issued.spaceId &&
      response.sessionId === issued.sessionId && response.ownershipEpoch === issued.ownershipEpoch &&
      response.ownerDeviceId === issued.ownerDeviceId && response.ownerTabId === issued.ownerTabId &&
      compareTime(response.updatedAt, live.updatedAt) >= 0 && this.aggregateIsNotOlder(response.session, live.session)
  }

  private async installStartResponse(response: ActiveSessionView, issued: IssuedStartWrite, notifyPeers: boolean): Promise<void> {
    const live = this.timer.getState().locator
    if (issued.sequence < this.latestAppliedSequence || live !== null ||
        response.operationId !== issued.operationId || response.spaceId !== issued.spaceId ||
        response.sessionId !== issued.sessionId || response.ownerDeviceId !== issued.ownerDeviceId ||
        response.ownerTabId !== issued.ownerTabId) return this.rejectStaleResponse()
    this.latestAppliedSequence = issued.sequence
    await this.install(response, notifyPeers)
  }

  private async installOwnedResponse(response: ActiveSessionView, issued: IssuedLocatorWrite, notifyPeers: boolean): Promise<void> {
    const live = await this.requireLiveFence(issued)
    if (!this.activeRootMatches(response, issued, live)) return this.rejectStaleResponse()
    this.latestAppliedSequence = issued.sequence
    await this.install(response, notifyPeers)
  }

  private async installTakeoverResponse(response: ActiveSessionView, issued: IssuedLocatorWrite, notifyPeers: boolean): Promise<void> {
    const live = await this.requireLiveFence(issued)
    if (response.operationId !== issued.operationId || response.spaceId !== issued.spaceId ||
        response.sessionId !== issued.sessionId || response.ownershipEpoch !== issued.ownershipEpoch + 1 ||
        response.ownerDeviceId !== this.identity.deviceId || response.ownerTabId !== this.identity.tabId ||
        compareTime(response.updatedAt, live.updatedAt) < 0 || !this.aggregateIsNotOlder(response.session, live.session)) {
      return this.rejectStaleResponse()
    }
    this.latestAppliedSequence = issued.sequence
    await this.install(response, notifyPeers)
  }

  private async installHeartbeat(response: ActiveSessionLocator, issued: IssuedLocatorWrite, notifyPeers: boolean): Promise<void> {
    const live = await this.requireLiveFence(issued)
    if (response.operationId !== issued.operationId || response.spaceId !== issued.spaceId ||
        response.sessionId !== issued.sessionId || response.ownershipEpoch !== issued.ownershipEpoch ||
        response.ownerDeviceId !== issued.ownerDeviceId || response.ownerTabId !== issued.ownerTabId ||
        compareTime(response.updatedAt, live.updatedAt) < 0) return this.rejectStaleResponse()
    this.latestAppliedSequence = issued.sequence
    const merged = activeSessionSchema.parse({ ...response, session: live.session })
    await this.install(merged, notifyPeers)
  }

  private async installEndResponse(response: TerminalActiveSessionResponse, issued: IssuedLocatorWrite, notifyPeers: boolean): Promise<void> {
    let live = await this.requireLiveFence(issued)
    if (response.locator !== null || !this.aggregateIsNotOlder(response.session, live.session)) return this.rejectStaleResponse()
    await withDetachedSpaceDatabase(issued.spaceId, (database) => cacheFocusSession(database, issued.spaceId, response.session))
    live = await this.requireLiveFence(issued)
    if (response.session.session.id !== live.sessionId || response.session.session.version < live.session.session.version) {
      return this.rejectStaleResponse()
    }
    this.latestAppliedSequence = issued.sequence
    await this.install(null, notifyPeers)
  }

  private async rejectStaleResponse(): Promise<never> {
    this.timer.getState().fence('stale_active_session_response')
    try { await this.refresh(false) } catch { /* preserve the local fence when locate also fails */ }
    throw new Error('stale_active_session_response')
  }

  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (errorCode(error) === 'stale_session_owner') {
        this.timer.getState().fence('stale_session_owner')
        await this.refresh(false)
      }
      throw error
    }
  }

  private async install(locator: ActiveSessionView | null, notifyPeers: boolean): Promise<void> {
    const generation = ++this.installGeneration
    this.timer.getState().installLocator(locator, this.identity)
    if (locator) await this.meta.activeSessionLocator.put(toMirror(locator))
    else await this.meta.activeSessionLocator.delete('active')
    if (generation !== this.installGeneration) {
      const latest = this.timer.getState().locator
      if (latest) await this.meta.activeSessionLocator.put(toMirror(latest))
      else await this.meta.activeSessionLocator.delete('active')
      return
    }
    if (notifyPeers) this.channel?.postMessage({ type: 'locator-changed', epoch: locator?.ownershipEpoch ?? null })
  }

  private async installLocated(response: LocatedActiveSessionResponse | null, notifyPeers: boolean): Promise<void> {
    await this.install(activeFromLocated(response), notifyPeers)
  }

  private async locate(): Promise<LocatedActiveSessionResponse | null> {
    try {
      return await this.api.locate()
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return null
      const candidate = error as { response?: { status?: unknown } } | null
      if (candidate?.response?.status === 404) return null
      throw error
    }
  }

  private startHeartbeatIfOwner(): void {
    if (this.heartbeatHandle !== null || this.timer.getState().ownershipMode !== 'owner') return
    this.heartbeatHandle = setInterval(() => {
      void this.heartbeat().catch(() => undefined)
    }, 30_000)
  }
}
