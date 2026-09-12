'use client'

import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { BlockerAckModal } from '@/components/task-space/blocker-ack-modal'
import { FocusedWorkItemNote } from '@/components/timer/focused-work-item-note'
import { SessionClock } from '@/components/timer/session-clock'
import { SessionLauncher, type LaunchSelection } from '@/components/timer/session-launcher'
import { isReviewableEndedSession, selectReviewSession, SessionReview } from '@/components/timer/session-review'
import { returnToTaskSpace, submitReviewWithCompletion } from '@/components/timer/session-review-completion'
import { SessionWorkspace } from '@/components/timer/session-workspace'
import { TodaySummary } from '@/components/timer/today-summary'
import { useActiveSessionCoordinator, useActiveSessionIdentity, useActiveSessionProvisionalLock } from '@/lib/focus-session/active-session-provider'
import { createEndAlert } from '@/lib/focus-session/end-alert'
import { deriveSessionClock } from '@/lib/focus-session/clock'
import { resolveTimerError } from '@/lib/focus-session/timer-error'
import { FocusSessionRepository, readSessionCommandReceipts, type LocalFocusSessionAggregate } from '@/lib/focus-session/focus-session-repository'
import { SessionReviewDraftController, type SessionReviewDraft } from '@/lib/focus-session/session-review-draft-registry'
import { CommandReconciliation } from '@/lib/focus-session/command-reconciliation'
import { focusSessionApi } from '@/services/focus-session-api'
import { TimerNoteComposerDraftController, type TimerNoteComposerDraftDatabase } from '@/lib/task-space/timer-note-composer-draft-registry'
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
import { evaluateSessionLaunch } from '@/lib/task-space/session-launch-guard'
import { recordBlockerAck } from '@/lib/task-space/blocker-ack-log'
import { deriveStatusCategoryById } from '@/lib/task-space/status-categories'
import { WorkItemNoteRepository } from '@/lib/task-space/work-item-note-repository'
import { canonicalNow } from '@/lib/direct-command-intents'
import { spaceDBManager } from '@/services/space-db'
import { metaDB } from '@/services/meta-database'
import type { PomodoroXIDB } from '@/services/database'
import type { NoteBlock } from '@/lib/contracts/task-space'
import type {
  CachedFocusSession,
  CachedSessionAttributionRevision,
  CachedSessionCommandEnvelope,
  CachedSessionTaskContext,
  CachedSessionWorkItemOutcome,
  CachedSessionWorkItemPlan,
  CachedWorkItemNote,
} from '@/types'
import { useSpaceStore } from '@/stores/space-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useTaskSpaceStore } from '@/stores/task-space-store'
import { useFocusSessionStore } from '@/stores/focus-session-store'
import { useTimerStore } from '@/stores/timer-store'

async function readLocalAggregate(database: PomodoroXIDB, sessionId: string): Promise<LocalFocusSessionAggregate> {
  const row = await database.focusSessions.get(sessionId) as (CachedFocusSession & { id?: string }) | undefined
  if (!row) throw new Error('focus_session_not_found')
  const { id: _id, ...session } = row
  const context = await database.sessionTaskContexts.where('sessionId').equals(sessionId).first() as CachedSessionTaskContext | undefined
  const attributions = await database.sessionAttributionRevisions.where('sessionId').equals(sessionId).toArray() as CachedSessionAttributionRevision[]
  const attribution = attributions.find((candidate) => candidate.effective) ?? attributions[0]
  if (!attribution) throw new Error('focus_session_attribution_not_found')
  return {
    session: session as CachedFocusSession,
    context: context ?? null,
    attribution,
    plan: await database.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray() as CachedSessionWorkItemPlan[],
    outcomes: await database.sessionWorkItemOutcomes.where('sessionId').equals(sessionId).toArray() as CachedSessionWorkItemOutcome[],
    commandEnvelopes: await database.sessionCommandEnvelopes.where('sessionId').equals(sessionId).toArray() as CachedSessionCommandEnvelope[],
    commandReceipts: await readSessionCommandReceipts(database, sessionId) as Array<Record<string, unknown>>,
  }
}

function sessionIdOf(session: { id?: string; sessionId?: string }): string {
  const id = session.id ?? session.sessionId
  if (!id) throw new Error('focus_session_identity_missing')
  return id
}

// 结束提醒的闩锁放在模块级单例上：跨重挂载（StrictMode dev 双挂载、热重载）
// 也不对同一会话重复响；新会话 id 自然再次触发（end-alert 的闩锁语义）。
const sessionEndAlert = createEndAlert()

export default function TimerPage() {
  const spaceId = useSpaceStore((state) => state.currentSpaceId)
  const workItems = useTaskSpaceStore((state) => state.workItems)
  const selectedWorkItemId = useTaskSpaceStore((state) => state.selectedWorkItemId)
  const selectWorkItem = useTaskSpaceStore((state) => state.selectWorkItem)
  const hydrateTaskSpace = useTaskSpaceStore((state) => state.hydrate)
  const resetTaskSpace = useTaskSpaceStore((state) => state.reset)
  const relations = useTaskSpaceStore((state) => state.relations)
  const definitions = useTaskSpaceStore((state) => state.definitions)
  const acknowledgeLaunch = useTaskSpaceStore((state) => state.acknowledgeLaunch)
  const clearLaunchAck = useTaskSpaceStore((state) => state.clearLaunchAck)
  const hasLaunchAck = useTaskSpaceStore((state) => state.hasLaunchAck)
  const createChild = useTaskSpaceStore((state) => state.createChild)
  const router = useRouter()
  const coordinator = useActiveSessionCoordinator()
  const identity = useActiveSessionIdentity()
  const provisionalLock = useActiveSessionProvisionalLock()
  const locator = useTimerStore((state) => state.locator)
  const session = useTimerStore((state) => state.session)
  const localProvisional = useTimerStore((state) => state.localProvisional)
  const ownershipMode = useTimerStore((state) => state.ownershipMode)
  const nowMs = useTimerStore((state) => state.nowMs)
  const timerError = useTimerStore((state) => state.error)
  const installLocalProvisional = useTimerStore((state) => state.installLocalProvisional)
  const updateLocalProvisionalSession = useTimerStore((state) => state.updateLocalProvisionalSession)
  const [database, setDatabase] = useState<PomodoroXIDB | null>(null)
  const [taskRepository, setTaskRepository] = useState<TaskSpaceRepository | null>(null)
  const [blockedLaunch, setBlockedLaunch] = useState<{ selection: LaunchSelection; blockerIds: string[] } | null>(null)
  const [focusRepository, setFocusRepository] = useState<FocusSessionRepository | null>(null)
  const [noteRepository, setNoteRepository] = useState<WorkItemNoteRepository | null>(null)
  const [focusedNote, setFocusedNote] = useState<CachedWorkItemNote | null>(null)
  const [draftController, setDraftController] = useState<TimerNoteComposerDraftController | null>(null)
  const [reviewController, setReviewController] = useState<SessionReviewDraftController | null>(null)
  const [endedAggregate, setEndedAggregate] = useState<LocalFocusSessionAggregate | null>(null)
  const reviewDraft = useFocusSessionStore((state) => state.reviewDraft)
  const setReviewDraft = useFocusSessionStore((state) => state.setReviewDraft)
  const [error, setError] = useState<string | null>(null)
  const setStableError = (cause: unknown) => setError(resolveTimerError(cause).message)

  useEffect(() => {
    if (!spaceId) {
      resetTaskSpace()
      setDatabase(null)
      setTaskRepository(null)
      setFocusRepository(null)
      setNoteRepository(null)
      return
    }
    let cancelled = false
    try {
      const binding = spaceDBManager.currentBinding
      const taskRepository = new TaskSpaceRepository(binding.database, spaceId)
      const notes = new WorkItemNoteRepository(binding.database, spaceId)
      const focus = new FocusSessionRepository(binding.database, metaDB, spaceId, identity, coordinator, provisionalLock)
      setDatabase(binding.database)
      setNoteRepository(notes)
      setFocusRepository(focus)
      setTaskRepository(taskRepository)
      void hydrateTaskSpace(spaceId, taskRepository)
    } catch (cause) {
      if (!cancelled) setStableError(cause)
    }
    return () => { cancelled = true }
  }, [coordinator, hydrateTaskSpace, identity, provisionalLock, resetTaskSpace, spaceId])

  // Space 作用域状态类目（与任务页共用同一份查表）—— 会话启动判定需要它。
  const categoryById = useMemo(
    () => deriveStatusCategoryById(definitions, workItems),
    [definitions, workItems],
  )
  const aggregate = localProvisional?.aggregate ?? locator?.session ?? endedAggregate
  const plans = useMemo(() => aggregate?.plan.filter((plan) => plan.removedAt === null) ?? [], [aggregate?.plan])
  const currentPlan = plans.find((plan) => plan.currentDuringSession) ?? plans[0] ?? null
  const focusedWorkItemId = currentPlan?.workItemId ?? selectedWorkItemId
  const selectedWorkItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null
  // Wave 2C fix: previously subscribed via `useTimerStore((state) =>
  // selectDerivedClock(state))`, whose selector returned a fresh object every
  // call once a session existed.  useSyncExternalStore treats that as an
  // always-changing snapshot → "getSnapshot should be cached" → infinite
  // update loop that crashed the timer page on Start.  Subscribe to the
  // primitive inputs (session reference + nowMs) and memoize the derivation:
  // the clock object is now reference-stable between ticks, and only
  // recomputes when the session or the ticking clock actually changes.
  const clock = useMemo(
    () => (session ? deriveSessionClock(session, nowMs) : null),
    [session, nowMs],
  )
  // 结束提醒（工单①）：运行中越过计划点那一刻触发一次；fail-quiet，
  // 到点只提示，不自动结束/切状态。
  const notificationEnabled = useSettingsStore((state) => state.notificationEnabled)
  const soundEnabled = useSettingsStore((state) => state.soundEnabled)
  useEffect(() => {
    if (!session || !clock) return
    sessionEndAlert.check({
      sessionId: sessionIdOf(session),
      clockState: session.clockState,
      remainingSeconds: clock.remainingSeconds,
      plannedSeconds: session.plannedSeconds,
      notificationEnabled,
      soundEnabled,
    })
  }, [clock, notificationEnabled, session, soundEnabled])
  const reviewSession = useMemo(() => {
    if (!aggregate || !spaceId || !isReviewableEndedSession(aggregate.session)) return null
    return {
      spaceId,
      sessionId: sessionIdOf(aggregate.session),
      expectedVersion: aggregate.session.version,
      validity: aggregate.session.validity === 'invalid' ? 'invalid' as const : 'valid' as const,
      reviewState: aggregate.session.reviewState === 'skipped' ? 'skipped' as const : 'completed' as const,
    }
  }, [aggregate, spaceId])
  const reviewPlanDrafts = useMemo(() => plans.map((plan) => ({
    workItemId: plan.workItemId,
    touched: plan.completionDraft,
    result: plan.completionDraft ? 'completed' as const : 'progressed' as const,
    stateCommand: plan.completionDraft ? 'complete' as const : 'none' as const,
    expectedWorkItemVersion: plan.workItemVersionSnapshot,
  })), [plans])

  useEffect(() => {
    let cancelled = false
    if (!noteRepository || !focusedWorkItemId) {
      setFocusedNote(null)
      return
    }
    void noteRepository.read(focusedWorkItemId).then((note) => {
      if (!cancelled) setFocusedNote(note)
    }).catch((cause) => {
      if (!cancelled) setStableError(cause)
    })
    return () => { cancelled = true }
  }, [focusedWorkItemId, noteRepository])

  useEffect(() => {
    if (!database || !spaceId || !focusedWorkItemId || !noteRepository) {
      setDraftController(null)
      return
    }
    const controller = new TimerNoteComposerDraftController(
      database as unknown as TimerNoteComposerDraftDatabase,
      { spaceId, workItemId: focusedWorkItemId },
      async (workItemId, blocks, operationId) => {
        const current = await noteRepository.read(workItemId)
        if (!current) throw new Error('work_item_note_not_loaded')
        await noteRepository.appendBlocks({
          workItemId, blocks, operationId,
          expectedLocalRevision: current.localRevision,
          now: canonicalNow(),
        })
        setFocusedNote(await noteRepository.read(workItemId))
      },
      async (workItemId, blockId, operationId) => {
        const current = await noteRepository.read(workItemId)
        if (!current) return false
        const matchingOutbox = await database.outbox.where('entityId').equals(current.noteId)
          .filter((row) => row.operationId === operationId).first()
        if (matchingOutbox) return matchingOutbox.synced
        return current.syncState === 'clean' && current.document.blocks.some((block) => block.blockId === blockId)
      },
    )
    setDraftController(controller)
    void controller.hydrate().catch((cause) => setStableError(cause))
    return () => {
      controller.dispose()
      setDraftController(null)
    }
  }, [database, focusedWorkItemId, noteRepository, spaceId])

  useEffect(() => {
    if (!database || !focusRepository || locator || localProvisional) {
      setEndedAggregate(null)
      return
    }
    let cancelled = false
    void focusRepository.listCached().then(async (sessions) => {
      const ended = selectReviewSession(sessions)
      if (!ended) {
        if (!cancelled) setEndedAggregate(null)
        return
      }
      const local = await readLocalAggregate(database, ended.sessionId)
      if (!cancelled) setEndedAggregate(local)
    }).catch((cause) => {
      if (!cancelled) setStableError(cause)
    })
    return () => { cancelled = true }
  }, [database, focusRepository, localProvisional, locator])

  useEffect(() => {
    let createdController: SessionReviewDraftController | null = null
    if (!database || !reviewSession) {
      setReviewController((previous) => {
        previous?.dispose()
        return null
      })
      setReviewDraft(null)
      return
    }
    let cancelled = false
    const initialDraft = {
      spaceId: reviewSession.spaceId,
      sessionId: reviewSession.sessionId,
      expectedVersion: reviewSession.expectedVersion,
      validity: reviewSession.validity,
      reviewState: reviewSession.reviewState,
      reviewedAt: canonicalNow(),
      outcomes: reviewPlanDrafts,
    }
    void SessionReviewDraftController.open({
      db: database, spaceId: reviewSession.spaceId, sessionId: reviewSession.sessionId, initialDraft,
    }).then((controller) => {
      createdController = controller
      if (cancelled) {
        controller.dispose()
        return
      }
      setReviewController((previous) => {
        previous?.dispose()
        return controller
      })
      setReviewDraft(controller.currentDraft())
    }).catch((cause) => {
      if (!cancelled) setStableError(cause)
    })
    return () => {
      cancelled = true
      createdController?.dispose()
    }
  }, [database, reviewPlanDrafts, reviewSession, setReviewDraft])

  const activePlanIds = new Set(plans.map((plan) => plan.workItemId))
  const availableLevel3 = workItems
    .filter((item) => item.depth === 3 && !activePlanIds.has(item.id) && item.parentId === aggregate?.context?.level2WorkItemId)
    .map((item) => ({ id: item.id, title: item.title }))

  const localAggregateRefresh = async () => {
    if (!database || !localProvisional) return
    const refreshed = await readLocalAggregate(database, localProvisional.aggregate.session.sessionId)
    installLocalProvisional({ ...localProvisional, aggregate: refreshed })
  }

  const start = async (selection: LaunchSelection) => {
    if (!spaceId) throw new Error('spaceId is required for global start')
    useTimerStore.getState().assertCanStart(spaceId)
    const expectedWorkItemVersions = Object.fromEntries(
      [selection.level2WorkItemId, ...selection.level3WorkItemIds].map((id) => {
        const item = workItems.find((candidate) => candidate.id === id)
        return [id, item?.version ?? 0]
      }),
    )
    const operationId = crypto.randomUUID()
    const input = {
      ...selection, spaceId, operationId, sessionId: crypto.randomUUID(),
      startedAt: canonicalNow(), expectedWorkItemVersions,
    }
    try {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        await coordinator.start(input)
      } else {
        if (!focusRepository) throw new Error('focus_session_repository_not_ready')
        const local = await focusRepository.startProvisional({
          ...input, deviceId: identity.deviceId, tabId: identity.tabId,
        })
        installLocalProvisional({
          spaceId, operationId, ownerDeviceId: identity.deviceId, ownerTabId: identity.tabId, aggregate: local,
        })
      }
      // 启动成功即消费一次性放行：下一次启动同一被阻塞项必须重新确认
      //（"never silent" 是按次成立的）。
      clearLaunchAck(selection.level2WorkItemId)
    } catch (cause) {
      setStableError(cause)
    }
  }

  /**
   * 启动前置判定 —— 与任务页按钮**同一条规则**（session-launch-guard）。
   *
   * ★ 这里是此前最危险的缺口：任务页拦、/timer 不拦，规则形同虚设。
   * ★ 任务页确认过的一次性放行（hasLaunchAck）在此生效；否则先取本地边
   *   （Dexie，离线可用；再并入 store 里可能更新的边）判定，被阻塞就弹
   *   BlockerAck，绝不静默放行。
   */
  const requestStart = async (selection: LaunchSelection) => {
    const level2Id = selection.level2WorkItemId
    if (!hasLaunchAck(level2Id)) {
      const cached = taskRepository
        ? await taskRepository.listCachedRelations(level2Id).catch(() => [])
        : []
      const storeEdges = relations.filter((edge) => (
        edge.fromWorkItemId === level2Id || edge.toWorkItemId === level2Id
      ))
      const byId = new Map<string, (typeof storeEdges)[number]>()
      for (const edge of [...cached, ...storeEdges]) byId.set(edge.id, edge)
      const decision = evaluateSessionLaunch({
        level2WorkItemId: level2Id,
        workItems,
        relations: [...byId.values()],
        statusCategoryById: categoryById,
      })
      if (decision.status === 'blocked') {
        setBlockedLaunch({ selection, blockerIds: decision.openBlockerIds })
        return
      }
    }
    await start(selection)
  }

  const handleBlockedProceed = () => {
    const pending = blockedLaunch
    if (!pending) return
    recordBlockerAck({
      workItemId: pending.selection.level2WorkItemId,
      blockerIds: pending.blockerIds,
      source: 'timer',
    })
    acknowledgeLaunch(pending.selection.level2WorkItemId)
    setBlockedLaunch(null)
    void start(pending.selection)
  }

  const handleBlockedCancel = () => {
    const first = blockedLaunch?.blockerIds[0]
    setBlockedLaunch(null)
    if (!first) return
    // 「返回处理上游」：选中上游并回到任务页 —— 与任务页弹窗的取消语义一致。
    selectWorkItem(first)
    router.push('/tasks')
  }

  // 只读原因要说人话：同设备=另一个标签页（关掉就成孤儿）；不同设备=另一台机器。
  const ownerHint = locator
    ? locator.ownerDeviceId === identity.deviceId
      ? '该会话由另一个标签页持有 —— 若那个标签页已关闭，可在此接管继续。'
      : '该会话由另一台设备持有 —— 接管后计时将在本设备继续。'
    : undefined

  /**
   * 只读 → 接管（协议早已就绪，此前缺入口）：上一个标签页关掉后会话会
   * 永久只读、既不能继续也不能结束，只能看着计时卡死。
   */
  const takeOverSession = async () => {
    try {
      await coordinator.takeover()
    } catch (cause) {
      setStableError(cause)
    }
  }

  const clockAction = async (action: 'pause' | 'resume' | 'end', occurredAt: string) => {
    try {
      if (localProvisional) {
        if (!focusRepository) throw new Error('focus_session_repository_not_ready')
        const sessionId = localProvisional.aggregate.session.sessionId
        const next = action === 'pause'
          ? await focusRepository.pauseProvisional(sessionId, occurredAt)
          : action === 'resume'
            ? await focusRepository.resumeProvisional(sessionId, occurredAt)
            : await focusRepository.endProvisional(sessionId, { occurredAt, timerCompletion: 'ended_early' })
        updateLocalProvisionalSession(next)
        return
      }
      if (action === 'pause') await coordinator.pause(occurredAt)
      else if (action === 'resume') await coordinator.resume(occurredAt)
      else await coordinator.end({ occurredAt, timerCompletion: 'ended_early', validity: 'pending', validityReason: null })
    } catch (cause) {
      setStableError(cause)
    }
  }

  const updateSessionNote = async (value: string) => {
    if (!aggregate) return
    try {
      if (localProvisional) {
        if (!focusRepository) throw new Error('focus_session_repository_not_ready')
        await focusRepository.updateSessionNote(localProvisional.aggregate.session.sessionId, value)
        await localAggregateRefresh()
      } else {
        await coordinator.updateSessionNote({ sessionId: sessionIdOf(aggregate.session), sessionNote: value })
      }
    } catch (cause) { setStableError(cause) }
  }

  const setCurrent = async (workItemId: string | null) => {
    if (!aggregate) return
    try {
      if (localProvisional) {
        if (!focusRepository) throw new Error('focus_session_repository_not_ready')
        await focusRepository.setCurrentPlanItem(localProvisional.aggregate.session.sessionId, workItemId)
        await localAggregateRefresh()
      } else await coordinator.setCurrentPlanItem({ sessionId: sessionIdOf(aggregate.session), workItemId })
    } catch (cause) {
      setStableError(cause)
      throw cause
    }
  }

  const setCompletion = async (planItemId: string, completionDraft: boolean) => {
    if (!aggregate) return
    try {
      if (localProvisional) {
        await focusRepository?.setCompletionDraft(localProvisional.aggregate.session.sessionId, planItemId, completionDraft)
        await localAggregateRefresh()
      } else await coordinator.setCompletionDraft({ sessionId: sessionIdOf(aggregate.session), planItemId, completionDraft })
    } catch (cause) { setStableError(cause) }
  }

  const addPlanItem = async (workItemId: string) => {
    if (!aggregate) return
    // ★ 工单②（运行中新建三级）：createChild 先把新项落进 store 再返回，
    //   同一异步闭包里 hook 订阅的 workItems 还是旧数组 —— 这里必须读最新
    //   store，否则"创建成功后立即加入计划"会静默丢步。
    const item = useTaskSpaceStore.getState().workItems.find((candidate) => candidate.id === workItemId)
    if (!item) return
    try {
      const planRank = plans.length
      if (localProvisional) {
        await focusRepository?.addPlanItem(localProvisional.aggregate.session.sessionId, workItemId, planRank, canonicalNow())
        await localAggregateRefresh()
      } else await coordinator.addPlanItem({ sessionId: sessionIdOf(aggregate.session), workItemId, expectedWorkItemVersion: item.version, planRank, addedAt: canonicalNow() })
    } catch (cause) { setStableError(cause) }
  }

  const removePlanItem = async (planItemId: string) => {
    if (!aggregate) return
    try {
      if (localProvisional) {
        await focusRepository?.removePlanItem(localProvisional.aggregate.session.sessionId, planItemId, canonicalNow(), 'removed from current plan')
        await localAggregateRefresh()
      } else await coordinator.removePlanItem({ sessionId: sessionIdOf(aggregate.session), planItemId, removedAt: canonicalNow(), removalReason: 'removed from current plan' })
    } catch (cause) { setStableError(cause) }
  }

  // 运行中新建三级（工单② 2026-09-13）：规格 L645-649 把它列为首版运行态
  // 必须覆盖的交互，S07 要求「创建正式 WorkItem 并加入计划」。沿用任务页
  // 创建三级同一入口（task-space-store.createChild），不新开直连 API；
  // parentId = 当前会话挂的二级项，type/status/priority 由 createChild 按
  // 任务页同一默认补齐。创建成功即加入计划，availableLevel3 由 store 的
  // workItems 派生自动刷新。失败不在此捕获 —— SessionWorkspace 以
  // role="alert" 呈现原因（创建失败必须可见），不做离线排队。
  const createPlanItem = async (title: string) => {
    if (!aggregate) throw new Error('focus_session_not_found')
    const level2WorkItemId = aggregate.context?.level2WorkItemId
    if (!level2WorkItemId) throw new Error('session_level2_missing')
    const created = await createChild(level2WorkItemId, { title })
    await addPlanItem(created.id)
  }

  const appendBlocks = async (workItemId: string, blocks: NoteBlock[], operationId: string) => {
    if (!noteRepository) throw new Error('work_item_note_not_loaded')
    const current = await noteRepository.read(workItemId)
    if (!current) throw new Error('work_item_note_not_loaded')
    await noteRepository.appendBlocks({
      workItemId, blocks, operationId,
      expectedLocalRevision: current.localRevision, now: canonicalNow(),
    })
    setFocusedNote(await noteRepository.read(workItemId))
  }

  const updateReviewDraft = async (draft: SessionReviewDraft) => {
    if (!reviewController) return
    try {
      reviewController.update(draft)
      const persisted = reviewController.currentDraft()
      setReviewDraft(persisted)
      await reviewController.flush('before-submit')
    } catch (cause) {
      setStableError(cause)
    }
  }

  const submitReview = async (draft: SessionReviewDraft) => {
    if (!reviewController || !focusRepository || !aggregate || !spaceId) return
    if (draft.spaceId !== spaceId || draft.sessionId !== sessionIdOf(aggregate.session) ||
        draft.operationId !== reviewController.currentDraft().operationId) {
      setError('review_draft_identity_mismatch')
      return
    }
    // ★ 2026-09-11：收尾动作（提交成功后刷新任务空间 + 进入完成态）抽到
    // session-review-completion，行为不变、可单测；本处只负责注入页面依赖。
    const controller = reviewController
    await submitReviewWithCompletion({
      submit: async () => {
        controller.update(draft)
        await controller.flush('before-submit')
        setReviewDraft(controller.currentDraft())
        const result = await focusRepository.submitReview(draft)
        return {
          ownershipState: result.session.ownershipState,
          reviewState: result.session.reviewState,
        }
      },
      // ⚠ 本地 provisional 未导入分支（S4 尚未导入该终态会话）：保留 durable
      // 草稿与控制器供导入后恢复提交；此分支不刷新任务空间、不提供回跳
      //（会话尚未真正落库）。
      keepProvisionalDraft: () => setReviewDraft(controller.currentDraft()),
      reloadAggregate: async () => {
        setEndedAggregate(await readLocalAggregate(database!, draft.sessionId))
      },
      releaseDraft: () => {
        controller.dispose()
        setReviewController(null)
        setReviewDraft(null)
      },
      onError: setStableError,
    })
  }

  /**
   * ★ 2026-09-11：复盘完成态的出口 —— 会话已终态、面板只读，此前只能靠浏览器
   * 后退离开。照抄 BlockerAck 取消的写法：选中会话挂的二级项 + 回任务页。
   */
  const handleReturnToTasks = () => {
    returnToTaskSpace({
      level2WorkItemId: aggregate?.context?.level2WorkItemId ?? null,
      selectWorkItem,
      navigate: (href) => router.push(href),
    })
  }

  const reconcileCommand = async (commandId: string, replaySafe: boolean): Promise<boolean> => {
    if (!database || !aggregate) return false
    try {
      const reconciliation = new CommandReconciliation(database, focusSessionApi)
      await reconciliation.reconcile(sessionIdOf(aggregate.session), commandId, replaySafe)
      setEndedAggregate(await readLocalAggregate(database, sessionIdOf(aggregate.session)))
      return true
    } catch (cause) {
      setStableError(cause)
      return false
    }
  }

  const abandonCommand = async (commandId: string) => {
    if (!database || !aggregate) return
    try {
      const reconciliation = new CommandReconciliation(database, focusSessionApi)
      await reconciliation.abandon(sessionIdOf(aggregate.session), commandId, canonicalNow())
      setEndedAggregate(await readLocalAggregate(database, sessionIdOf(aggregate.session)))
    } catch (cause) { setStableError(cause) }
  }

  const content: ReactNode = aggregate && aggregate.session.clockState === 'ended'
    ? createElement(SessionReview, {
      session: aggregate.session,
      plans,
      outcomes: aggregate.outcomes,
      envelopes: aggregate.commandEnvelopes,
      receipts: aggregate.commandReceipts as never,
      draft: reviewDraft,
      readOnly: !reviewSession,
      // ★ 2026-09-11：只在复盘完成态（readOnly = 无待复盘项）渲染出口；待复盘
      // （可写）态没有回跳入口。provisional 未导入分支结构上不会进入 readOnly
      //（早退 + 保留草稿、不重读聚合），所以那里既无刷新也无回跳。
      onReturnToTasks: reviewSession ? undefined : handleReturnToTasks,
      onDraftChange: updateReviewDraft,
      onSubmit: submitReview,
      onReconcile: reconcileCommand,
      onAbandon: abandonCommand,
    })
    : aggregate && session && clock ? createElement('div', { className: 'grid gap-6 p-6' },
    createElement(SessionClock, {
      session, nowMs, owner: ownershipMode === 'owner',
      ownerHint,
      onTakeover: ownershipMode === 'read_only' ? takeOverSession : undefined,
      onPause: (occurredAt) => clockAction('pause', occurredAt),
      onResume: (occurredAt) => clockAction('resume', occurredAt),
      onEnd: (occurredAt) => clockAction('end', occurredAt),
      onFlushNote: async () => { await draftController?.flush('before-append') },
    }),
    createElement(SessionWorkspace, {
      session, plans, availableLevel3,
      onSetCurrent: setCurrent, onSetCompletionDraft: setCompletion,
      onAddPlanItem: addPlanItem, onRemovePlanItem: removePlanItem,
      onCreatePlanItem: createPlanItem,
      onUpdateSessionNote: updateSessionNote,
      onFlushWorkItemNote: async (reason) => { await draftController?.flush(reason) },
      onSwitchWorkItemNote: async (nextWorkItemId) => {
        if (draftController && spaceId) {
          await draftController.switchTo({ spaceId, workItemId: nextWorkItemId })
          return async () => {
            if (focusedWorkItemId) {
              await draftController.switchTo({ spaceId, workItemId: focusedWorkItemId })
            }
          }
        } else {
          await draftController?.flush('current-item-change')
        }
      },
    }),
    focusedWorkItemId ? createElement(FocusedWorkItemNote, {
      note: focusedNote, spaceId: spaceId ?? '', workItemId: focusedWorkItemId,
      draftRegistry: draftController ?? undefined, onAppendBlocks: appendBlocks,
    }) : null,
    // 底部统计栏（工单③）：准备态与运行态两处布局的底部都要有（规格 L457/L505）。
    // 标签按服务端真实口径显示「近 1 天」，理由见 today-summary.tsx 的注释。
    createElement(TodaySummary),
  ) : createElement('div', { className: 'grid gap-6 p-6' },
    createElement('header', null,
      createElement('p', { className: 'text-xs text-muted-foreground' }, 'Focus session'),
      createElement('h1', { className: 'text-2xl font-semibold' }, 'Start a focused Session'),
    ),
    selectedWorkItem ? createElement('p', null, `Selected: ${selectedWorkItem.displayKey} ${selectedWorkItem.title}`) : null,
    workItems.length
      ? createElement('div', { className: 'grid gap-2', 'aria-label': 'WorkItems for focus' }, workItems.map((item) => createElement('button', { key: item.id, type: 'button', onClick: () => selectWorkItem(item.id) }, `${item.displayKey} ${item.title}`)))
      // ★ 空状态要说清「为什么空」和「去哪补」。
      //   原来只有一句 "No WorkItems are available in this Space."，
      //   用户无法区分「选错 Space / 同步没跑完 / 确实没建」三种情况，
      //   于是整体被误读成"番茄钟没开发"。走查实测（2026-09-10）。
      : createElement('div', { role: 'status', className: 'grid gap-2 text-sm text-muted-foreground' },
        createElement('p', null, '这个 Space 里还没有工作项，所以没有东西可以投入。'),
        createElement('p', null, '常见原因有三种，按顺序排查：'),
        createElement('ol', { className: 'ml-5 list-decimal' },
          createElement('li', null, '选错了 Space —— 左上角切到有数据的那个（本机内容都在名为「111」的 Space 里）。'),
          createElement('li', null, '刚进来、首轮同步还没跑完 —— 任务页会显示 Loading；等它出树再回来。'),
          createElement('li', null, '确实还没建 —— 去「任务」页新建项目与工作项。'),
        ),
        createElement('p', null, '另外：专注会话必须挂在「二级」工作项上，所以至少要有一个一级项 + 它的一个子项。'),
      ),
    workItems.length ? createElement(SessionLauncher, { items: workItems, initialWorkItemId: selectedWorkItemId, onStart: requestStart }) : null,
    // 底部统计栏（工单③）：准备态布局底部（规格 L457）。
    createElement(TodaySummary),
  )

  return createElement('main', { className: 'min-h-full' },
    error || timerError ? createElement('p', { role: 'alert', className: 'border-b bg-destructive/10 px-4 py-2 text-sm text-destructive' }, error ?? timerError) : null,
    content,
    blockedLaunch ? createElement(BlockerAckModal, {
      open: true,
      workItem: workItems.find((item) => item.id === blockedLaunch.selection.level2WorkItemId) ?? null,
      blockers: workItems.filter((item) => blockedLaunch.blockerIds.includes(item.id)),
      onProceed: handleBlockedProceed,
      onCancel: handleBlockedCancel,
    }) : null,
  )
}
