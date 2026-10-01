'use client'

import { createElement, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { BlockerAckModal } from '@/components/task-space/blocker-ack-modal'
import { FocusedWorkItemNote } from '@/components/timer/focused-work-item-note'
import { RestCyclePanel } from '@/components/timer/rest-cycle-panel'
import { SessionClock } from '@/components/timer/session-clock'
import { SessionLauncher, deriveLaunchSelection, type LaunchSelection } from '@/components/timer/session-launcher'
import { TaskPickerModal } from '@/components/timer/task-picker-modal'
import { isReviewableEndedSession, selectReviewSession, SessionReview } from '@/components/timer/session-review'
import { returnToTaskSpace, submitReviewWithCompletion } from '@/components/timer/session-review-completion'
import { SessionWorkspace } from '@/components/timer/session-workspace'
import { ContinuePrevious } from '@/components/timer/continue-previous'
import { TimerFrame } from '@/components/timer/timer-frame'
import { TimerMapEditor } from '@/components/timer/timer-map-editor'
import { TimerMapOverview } from '@/components/timer/timer-map-overview'
import { TimerMapPort } from '@/components/timer/timer-map-port'
import { WorkMapPreviewOverlay } from '@/components/timer/work-map-preview-overlay'
import { TimerSideToday, type RecentSessionRow } from '@/components/timer/timer-side-today'
import { TodaySummary } from '@/components/timer/today-summary'
import { Button } from '@/components/ui/button'
import { useActiveSessionCoordinator, useActiveSessionIdentity, useActiveSessionProvisionalLock } from '@/lib/focus-session/active-session-provider'
import { createEndAlert } from '@/lib/focus-session/end-alert'
import { deriveSessionClock } from '@/lib/focus-session/clock'
import {
  countCompletedWorkSessions,
  defaultMinutesForMode,
  isBreakMode,
  modeLabel,
  planRestCycle,
  type SessionMode,
} from '@/lib/focus-session/session-mode'
import { resolveTimerError } from '@/lib/focus-session/timer-error'
import { FocusSessionRepository, readSessionCommandReceipts, type LocalFocusSessionAggregate } from '@/lib/focus-session/focus-session-repository'
import { SessionReviewDraftController, type SessionReviewDraft } from '@/lib/focus-session/session-review-draft-registry'
import { CommandReconciliation } from '@/lib/focus-session/command-reconciliation'
import { focusSessionApi } from '@/services/focus-session-api'
import { TimerNoteComposerDraftController, type TimerNoteComposerDraftDatabase } from '@/lib/task-space/timer-note-composer-draft-registry'
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
import { evaluateSessionLaunch } from '@/lib/task-space/session-launch-guard'
import {
  formatSessionTime as formatWorkMapSessionTime,
  readContinuePrevious,
  type ContinuePreviousBuckets,
} from '@/lib/task-space/continue-previous'
import { recordBlockerAck } from '@/lib/task-space/blocker-ack-log'
import { deriveStatusCategoryById } from '@/lib/task-space/status-categories'
import { buildHierarchyCodes } from '@/lib/task-space/hierarchy-code'
import { readWorkMap, writeWorkMap } from '@/lib/work-map/work-map-api'
import { appendThoughtNode } from '@/lib/work-map/thought-nodes'
import { applyMapNodeEdit, normalizeNodeTitle, type MapNodeEditOp } from '@/lib/work-map/node-edits'
import type { MapTreeNode } from '@/lib/work-map/island-layout'
import type { ThoughtType } from '@/lib/work-map/thought-types'
import { WorkItemNoteRepository } from '@/lib/task-space/work-item-note-repository'
import { buildSessionIsland } from '@/lib/work-map/session-island'
import { createLaunchSessionIslands, formatSessionIslandTitle } from '@/lib/work-map/session-island-launch'
import { canonicalNow } from '@/lib/direct-command-intents'
import { spaceDBManager } from '@/services/space-db'
import { metaDB } from '@/services/meta-database'
import type { PomodoroXIDB } from '@/services/database'
import type { NoteBlock, TaskSpaceDefinitions } from '@/lib/contracts/task-space'
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

/** 数据层条目 join 工作项缓存行：给三栏快捷入口补 displayKey / title / priority。
 *  参数用结构化最小类型（Dexie 的 CachedWorkItem 满足），不耦合完整 View。 */
function joinWithWorkItems<T extends { workItemId: string }>(
  entries: readonly T[],
  workItems: readonly { id: string; displayKey: string; title: string; priority?: string | null }[],
): Array<T & { displayKey: string; title: string; priority: string | null }> {
  return entries.flatMap((entry) => {
    const item = workItems.find((w) => w.id === entry.workItemId)
    if (!item) return []
    return [{ ...entry, displayKey: item.displayKey, title: item.title, priority: item.priority ?? null }]
  })
}

/** Space 作用域定义的**首个** id（与 task-space-store 的 definitionId 同一语义）：
 *  升格创建不新发明默认值 —— 类型/状态沿用任务页 createChild 的同款取法。 */
function firstDefinitionId(
  definitions: TaskSpaceDefinitions | null,
  group: 'statuses' | 'types',
): string | null {
  const first = definitions?.[group][0]
  if (!first || typeof first !== 'object' || first === null) return null
  const id = (first as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export default function TimerPage() {
  const spaceId = useSpaceStore((state) => state.currentSpaceId)
  // 准备态顶部的「空间」面包屑（设计稿 `.crumb`）。`spaces` 可能尚未加载
  //（页面测试只塞 currentSpaceId），因此全程按可空处理，查不到就不编造名字。
  const spaces = useSpaceStore((state) => state.spaces)
  const spaceName = useMemo(
    () => (spaces ?? []).find((space) => space.id === spaceId)?.name ?? null,
    [spaceId, spaces],
  )
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
  // ── 休息节奏（双体系兼容 2026-09-16）────────────────────────────────────
  // 已完成番茄数（含刚结束那一轮）：长休间隔的判据，本地缓存行口径。
  const [completedWorkSessions, setCompletedWorkSessions] = useState(0)
  // 准备态右栏「最近会话」的数据源：与上面同一批本地缓存行（不为展示再读一次库）。
  const [recentSessions, setRecentSessions] = useState<RecentSessionRow[]>([])
  // 自动开始只对每个结束会话触发一次（闩锁按 sessionId）。
  const restAutoStartedFor = useRef<string | null>(null)
  const [restCycleStarting, setRestCycleStarting] = useState(false)
  const [restCycleBlockedReason, setRestCycleBlockedReason] = useState<string | null>(null)
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
  // 「继续上次」三栏快捷入口（ADR-0008 S2 / 用户 2026-09-30 确认口径）：
  // 按工作项判定（有会话历史 且 未完成/未取消），按本地日界分三层。
  // 日界复用 habits 域单一事实源（经 settings.dayBoundaryHour），不另写算法。
  const dayBoundaryHour = useSettingsStore((state) => state.dayBoundaryHour)
  const [continueBuckets, setContinueBuckets] = useState<ContinuePreviousBuckets | null>(null)
  useEffect(() => {
    if (!database || !spaceId || workItems.length === 0) {
      setContinueBuckets(null)
      return
    }
    let cancelled = false
    void readContinuePrevious({
      database,
      workItems,
      categoryById,
      dayBoundaryHour,
    })
      .then((result) => { if (!cancelled) setContinueBuckets(result) })
      .catch(() => { if (!cancelled) setContinueBuckets(null) })
    return () => { cancelled = true }
    // workItems 引用来自 zustand store（稳定），categoryById 是 useMemo —— 均可入依赖
  }, [database, spaceId, workItems, categoryById, dayBoundaryHour])
  // 注意：这里**不再**派生 continueTotal 去 gate 渲染 —— 三栏恒显（见下方 950 行注释）。
  const aggregate = localProvisional?.aggregate ?? locator?.session ?? endedAggregate
  const plans = useMemo(() => aggregate?.plan.filter((plan) => plan.removedAt === null) ?? [], [aggregate?.plan])
  const currentPlan = plans.find((plan) => plan.currentDuringSession) ?? plans[0] ?? null
  const focusedWorkItemId = currentPlan?.workItemId ?? selectedWorkItemId
  const selectedWorkItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null
  // ── ② 任务选择 Modal（2026-10-02）：归属/三级计划的状态源 ────────────────────
  // 原启动器内部状态上移到页面：Modal 与启动器共享**同一份**（不新增第二状态源，
  // 派生仍走 deriveLaunchSelection）。store 选中项变化（三栏/主图提示/阻塞取消）
  // 时按派生覆写 —— 与原启动器的 useEffect [initial] 同步语义逐字等价。
  const [pickerOpen, setPickerOpen] = useState(false)
  const derivedLaunch = useMemo(
    () => deriveLaunchSelection(workItems, selectedWorkItemId),
    [workItems, selectedWorkItemId],
  )
  const [launchLevel2Id, setLaunchLevel2Id] = useState<string | null>(derivedLaunch.level2Id)
  const [launchLevel3Ids, setLaunchLevel3Ids] = useState<string[]>(derivedLaunch.level3Ids)
  // 同步条件 = 派生**结果**（语义键），不是 workItems 引用：后台同步/建子落库会让
  // store 数组换引用、派生重算出"值相同的新对象"—— 若按引用覆写，用户在 Modal 里
  // 改到一半的归属/计划会被静默清空（真机验收实测复现，2026-10-02）。旧启动器把
  // 状态放内部时同样暴露于此（initial 按引用 memo），随承载迁移一并收口。
  const derivedLevel3Key = derivedLaunch.level3Ids.join(',')
  useEffect(() => {
    setLaunchLevel2Id(derivedLaunch.level2Id)
    setLaunchLevel3Ids(derivedLaunch.level3Ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkItemId, derivedLaunch.level2Id, derivedLevel3Key])
  // 层级编码（1 / 1.2 / 1.2.3）：Modal 关键字筛选按编号命中（任务页同款口径）。
  const hierarchyCodes = useMemo(() => buildHierarchyCodes(workItems), [workItems])
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
      // 双体系兼容：休息到点的提示文案不同（「休息结束」），闩锁语义不变。
      mode: ((session as { sessionType?: SessionMode }).sessionType ?? 'work') as SessionMode,
    })
  }, [clock, notificationEnabled, session, soundEnabled])

  // ── 沉浸模式（工单 B 2026-09-14）────────────────────────────────────────
  // 运行态专用：只渐隐次级内容区（Workspace / Note / 统计栏），环与退出按钮常驻。
  // 会话切换时重置 —— 上一个会话的"沉浸"不应预支到下一个会话。
  const [immersive, setImmersive] = useState(false)
  const activeSessionId = session ? sessionIdOf(session) : null
  useEffect(() => {
    setImmersive(false)
  }, [activeSessionId])

  // 二级归属（工单 B 可选步）：本会话挂在哪条二级工作项上 —— 沉浸模式下
  // Workspace/Note 都渐隐，这行是"我在投入什么"的唯一常驻提示。
  // 查不到就渲染空（不猜、不编造）。
  const level2WorkItemId = aggregate?.context?.level2WorkItemId ?? null
  const level2WorkItem = level2WorkItemId
    ? workItems.find((item) => item.id === level2WorkItemId) ?? null
    : null
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

  // ── 休息节奏（双体系兼容 2026-09-16）────────────────────────────────────
  // 设置订阅 + 纯函数判定：页面不重新发明节奏，只把设置喂给 planRestCycle。
  const pomodoroMinutes = useSettingsStore((state) => state.pomodoroDuration)
  const shortBreakMinutes = useSettingsStore((state) => state.shortBreakDuration)
  const longBreakMinutes = useSettingsStore((state) => state.longBreakDuration)
  const longBreakInterval = useSettingsStore((state) => state.longBreakInterval)
  const autoStartBreaks = useSettingsStore((state) => state.autoStartBreaks)
  const autoStartPomodoros = useSettingsStore((state) => state.autoStartPomodoros)
  const activeSessionMode = ((session as { sessionType?: SessionMode } | null)?.sessionType ?? 'work') as SessionMode
  const endedSessionMode = ((aggregate?.session as { sessionType?: SessionMode } | undefined)?.sessionType ?? activeSessionMode) as SessionMode
  const runningBreak = isBreakMode(activeSessionMode)

  // ── 导图端口「当前会话岛」（ADR-0008 D13 步 1）────────────────────────────
  // 数据 = 当前投入 L3 的 `.mm.md` 原文。刷新时机有两条，缺一不可：
  //   ① 会话 / 当前 L3 / 休息态变化 → 重读；
  //   ② **建岛完成（launch promise 落定）→ mapRefreshSeq++ → 重读**。
  //   ② 是 2026-09-30 真机验收抓到的竞态修复：建岛是 start 之后 fire-and-forget 的
  //   另一次网络往返，端口首读可能落在"图在但本次会话岛还没写进去"的中间态。
  // 失败一律 fail-quiet：端口退化占位文案，不阻断计时（不变量 4）。
  //
  // ★ 2026-10-01（拆解自动切换）：缓存**必须带键**。运行中新建三级会把当前项
  //   自动切到新 L3，而重读是一次网络往返 —— 切换后、重读落地前，旧 L3 的原文
  //   仍留在 state 里；若下游（quickRecord / editMap）把它当作新 L3 的 base 写回，
  //   上一个 L3 的正文会被整份写进新 L3 的文件。键不匹配即视为"无缓存"。
  const [sessionMap, setSessionMap] = useState<{ workItemId: string; text: string | null } | null>(null)
  // 对外仍以"当前键的文本（或 null）"呈现 —— 下游（编辑区 / 小视图 / 快速记录）
  // 的既有契约不变；变的只是"键不匹配时不认这份缓存"。
  const sessionMapText = sessionMap !== null && sessionMap.workItemId === focusedWorkItemId
    ? sessionMap.text
    : null
  const [focusCid, setFocusCid] = useState<string | null>(null)
  const [mapRefreshSeq, setMapRefreshSeq] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (activeSessionId === null || focusedWorkItemId === null || runningBreak) {
      setSessionMap(null)
      setFocusCid(null)
      return
    }
    void readWorkMap(focusedWorkItemId)
      .then((text) => { if (!cancelled) setSessionMap({ workItemId: focusedWorkItemId, text }) })
      .catch((cause) => {
        if (cancelled) return
        setSessionMap(null)
        console.warn(
          `[timer-map-port] 导图读取失败（fail-soft，端口退化为占位）: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
    return () => { cancelled = true }
  }, [activeSessionId, focusedWorkItemId, mapRefreshSeq, runningBreak])

  // ── 结束态「岛总览」数据（ADR-0008 D13 步 3-4b）────────────────────────────
  // 键 = 结束会话的 **focused plan item** 的 L3。页面 `plans` 派生自 `aggregate.plan`
  // （过滤 removedAt），`currentPlan` 即"本会话聚焦项"、无标记时回退 plans[0] ——
  // 单 L3 场景与外派单 §2.3 的 `plans[0]` 口径完全等价。`endedAggregate` 非空时
  // `aggregate === endedAggregate`（见上面 endedAggregate 的 effect 早退条件）。
  // 与运行态端口同款 fail-quiet：读不到就退化为占位，不阻断复盘。
  const endedMapWorkItemId = endedAggregate === null ? null : (currentPlan?.workItemId ?? null)
  const [endedMapText, setEndedMapText] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (endedMapWorkItemId === null) {
      setEndedMapText(null)
      return
    }
    void readWorkMap(endedMapWorkItemId)
      .then((text) => { if (!cancelled) setEndedMapText(text) })
      .catch((cause) => {
        if (cancelled) return
        setEndedMapText(null)
        console.warn(
          `[timer-map-overview] 结束态导图读取失败（fail-soft，总览退化为占位）: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
    return () => { cancelled = true }
  }, [endedMapWorkItemId])

  // ── 准备态「主图」弹层数据（ADR-0008 D18 / D13 步 3-4a，方案 C）─────────────
  // **懒读**：只有弹层**打开时**才读该三级项的导图（准备态不做无谓请求）；
  // 打开过一次即缓存（`previewFor` 记住已加载/已尝试的 L3），**切换三级项时清空重读**。
  // 主图 = `<L3 id>.mm.md`（按 L3 归档）→ 只有选中**三级项**才可点。fail-soft：读不到 → null → 弹层占位。
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewMapText, setPreviewMapText] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // 已加载/已发起过的 L3（缓存标记）+ 请求代次（切 L3 后丢弃旧响应）。
  // ★ 用 ref 而不是 state：若把"已加载标记"放进 deps，effect 自己触发的状态更新会
  //   导致 deps 变化 → 清理函数把**正在飞的读**取消掉（实测踩到过）。
  const previewLoadedFor = useRef<string | null>(null)
  const previewRequestSeq = useRef(0)
  const previewWorkItem = selectedWorkItem !== null && selectedWorkItem.depth === 3
    ? selectedWorkItem
    : null
  const previewWorkItemId = previewWorkItem?.id ?? null
  useEffect(() => {
    if (!previewOpen || previewWorkItemId === null) return
    if (previewLoadedFor.current === previewWorkItemId) return // 打开过一次即缓存
    const requestId = previewRequestSeq.current + 1
    previewRequestSeq.current = requestId
    previewLoadedFor.current = previewWorkItemId
    setPreviewLoading(true)
    setPreviewMapText(null) // 换三级项先清空，避免短暂显示上一张图
    void readWorkMap(previewWorkItemId)
      .then((text) => {
        if (previewRequestSeq.current !== requestId) return
        setPreviewMapText(text)
        setPreviewLoading(false)
      })
      .catch((cause) => {
        if (previewRequestSeq.current !== requestId) return
        setPreviewMapText(null)
        setPreviewLoading(false)
        console.warn(
          `[work-map-preview] 主图读取失败（fail-soft，弹层退化为占位）: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
  }, [previewOpen, previewWorkItemId])

  /**
   * 快速记录（ADR-0008 D13 步 2）：把一条思路按类型追加为会话节点子节点。
   *
   * 读-改-写三步；D6「先单机」前提下不做并发合并（窗口内他端改写会被覆盖，
   * 跨设备同步是独立议题）。失败抛出 → 端口卡内展示（不弹全局错误、不阻断计时）。
   */
  const quickRecord = async (type: ThoughtType, title: string): Promise<void> => {
    if (focusedWorkItemId === null || activeSessionId === null) {
      throw new Error('当前没有进行中的会话')
    }
    // sessionMapText 只在键匹配时非空（见上面的带键缓存）：键已切换但重读未落地
    // 时这里会回落到一次真实读取，绝不把上一个 L3 的原文写进当前 L3。
    const base = sessionMapText ?? (await readWorkMap(focusedWorkItemId)) ?? ''
    const result = appendThoughtNode(base, { sessionId: activeSessionId, type, title })
    if (!result.changed) throw new Error(result.reason ?? '未产生变更')
    await writeWorkMap(focusedWorkItemId, result.text)
    // 立即反映（不等下一次读）；服务端已是同一份内容，无需额外对齐往返
    setSessionMap({ workItemId: focusedWorkItemId, text: result.text })
    setFocusCid(null)
  }

  /**
   * 拆解后的导图生长（2026-10-01）：为新 L3 的 `.mm.md` 建**本次会话的岛**，
   * 并把新项写成岛内的一个 `todo` 节点。
   *
   * 写侧只用两个既有原语 —— `buildSessionIsland`（建岛）与 `appendThoughtNode`
   * （落节点），页面层不做任何 Markdown 解析/字符串拼接（D11/D16-b 的写入纪律）。
   * 岛标题必须与启动路径**同源**（`formatSessionIslandTitle` + 会话 `startedAt`）：
   * 同一次会话在它出现过的每张图上都得叫同一个名字，否则同一个 session_id
   * 在不同 L3 的图上会有两个岛标题。
   *
   * 失败策略（ADR-0008 不变量 4）：整段 fail-soft —— 读 / 建 / 写任何一步失败都只
   * `console.warn` 并返回 null，绝不抛回调用方。拆解创建的是**正式 WorkItem**，
   * 导图只是辅助能力，不能反过来阻断创建、切换与计时。
   *
   * @returns 本次写盘的导图原文；未产生变更或失败时 null（调用方据此决定是否刷新端口）
   */
  const growMapForNewLevel3 = async (
    workItemId: string,
    workItemTitle: string,
    todoTitle: string,
  ): Promise<string | null> => {
    if (activeSessionId === null) return null
    try {
      // null = 尚无导图 → 空串走 buildSessionIsland 的新建文档分支
      const existing = (await readWorkMap(workItemId)) ?? ''
      // ① 建岛。**必须无条件调用**（幂等键 = sessionId，已有岛时返回
      //    session_island_exists 且不变更）：新 L3 的图可能存在但没有**本次会话**的
      //    岛（L3 早于本会话存在），此时 appendThoughtNode 会以
      //    `session_node_not_found` 拒绝 —— 先补齐岛才谈得上往里落节点。
      //
      //    level3Titles 只列**本次已有的其它**计划项：岛上的裸 `### 标题` 是"这次
      //    会话投入过哪些项"的清单，而新项由下面的 appendThoughtNode 以带
      //    thought_type 的 todo 节点写入。若这里也带上新项标题，同一个标题会在
      //    岛上落两个节点（一个裸标题、一个带类型的），是明确的重复。
      const siblingTitles = plans
        .map((plan) => plan.titleSnapshot)
        .filter((title) => title.trim() !== '' && title !== todoTitle)
      const startedAt = new Date(aggregate?.session.startedAt ?? '')
      const island = buildSessionIsland(existing, {
        sessionId: activeSessionId,
        workItemTitle,
        sessionTitle: formatSessionIslandTitle(
          Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        ),
        level3Titles: siblingTitles,
        dir: 'right',
      })
      // 无 H1 / 建岛自身失败等结构性问题：不猜测、不写盘（appendThoughtNode 同样会拒）
      if (!island.changed && island.reason !== 'session_island_exists') {
        console.warn(
          `[timer-map-grow] 新 L3 ${workItemId} 建岛未产生变更（${island.reason ?? 'unchanged'}），跳过节点追加`,
        )
        return null
      }

      // ② 落节点：本次拆解出来的子行动 = 本次会话岛下的一个 todo。
      const appended = appendThoughtNode(island.text, {
        sessionId: activeSessionId,
        type: 'todo',
        title: todoTitle,
      })
      if (!appended.changed) {
        // 岛建好了但节点没落上：把岛本身写回仍有价值（本次会话在该 L3 图上留下
        // 痕迹），原因如实记录，不升级为失败。
        console.warn(
          `[timer-map-grow] 新 L3 ${workItemId} 的 todo 节点未写入（${appended.reason ?? 'unchanged'}）`,
        )
        if (!island.changed) return null
        await writeWorkMap(workItemId, island.text)
        setSessionMap({ workItemId, text: island.text })
        return island.text
      }

      await writeWorkMap(workItemId, appended.text)
      // 立即反映：拆解后 setCurrent 会把当前项切到新 L3，带键缓存让编辑区/小视图
      // 直接拿到最终文本，不必等下一次读回（键不匹配时 getter 不会取用它）。
      setSessionMap({ workItemId, text: appended.text })
      return appended.text
    } catch (cause) {
      console.warn(
        `[timer-map-grow] 新 L3 ${workItemId} 的导图生长失败（fail-soft，不阻断拆解）: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return null
    }
  }

  /**
   * 节点编辑（ADR-0008 D16 / D13 步 3-2）：改名 / 加子 / 类型 / 注释 / 删除。
   *
   * 与快速记录同一条**读-改-写**纪律：基于 `sessionMapText`（空则先 `readWorkMap`）
   * → 对应原语 → `writeWorkMap` → 立即反映。读-改-写窗口**不做并发合并**
   * （D14 已知边界：跨设备同步是独立议题）。失败抛出 → 编辑区卡内展示
   * （`map-edit-error`，模式同 `map-quick-error`），不弹全局错误、不阻断计时。
   * 编辑目标恒为「当前会话岛内带 cid 的节点」——由编辑区只给这些节点挂入口保证（D16-a）。
   */
  const editMap = async (op: MapNodeEditOp): Promise<void> => {
    if (focusedWorkItemId === null || activeSessionId === null) {
      throw new Error('当前没有进行中的会话')
    }
    const base = sessionMapText ?? (await readWorkMap(focusedWorkItemId)) ?? ''
    const result = applyMapNodeEdit(base, op)
    if (!result.changed) throw new Error(result.reason ?? '未产生变更')
    await writeWorkMap(focusedWorkItemId, result.text)
    setSessionMap({ workItemId: focusedWorkItemId, text: result.text })
    setFocusCid(null)
  }

  /**
   * 节点升格为任务（PXII-FEAT-TASK-SPACE-P0 P0-1）：把会话岛内的思考节点沉淀为
   * 正式 WorkItem，并在导图上回写任务编号。
   *
   * ## 层级深度防线（WORK_ITEM_MAX_DEPTH = 3，红线 2）
   * 走 `TaskSpaceRepository.createWorkItem` 直连通道，**不经** store 的 createChild
   * —— 那边会改写 selectedWorkItemId（focusedWorkItemId 的回退键），升格会静默
   * 劫持当前专注项；且 selectedProjectId 在计时页不保证已选。目标父级按当前项
   * 层级推导：L3 → 挂回同一 L2 父级（同级 L3，绝不 createChild 于 L3 之下）；
   * L2 → 挂其下（新 L3）；其余层级 fail-loud（不猜父级）。
   *
   * ## 导图回写纪律（红线 4）
   * 只用 `applyMapNodeEdit` 的 rename **定向改目标 heading 行**，其余正文逐字节
   * 保留（D16-b）—— 严禁整文重新序列化。回写失败不回滚已创建的任务（实体已成
   * 立，回写只是导图上的编号标注），把原因抛给编辑区卡内展示。
   */
  const handlePromoteNode = async (cid: string, node: MapTreeNode): Promise<void> => {
    if (focusedWorkItemId === null || activeSessionId === null) {
      throw new Error('当前没有进行中的会话')
    }
    if (!taskRepository) throw new Error('task_space_repository_not_ready')
    // createWorkItem 落库后 store 的 workItems 不会自动追加，读最新快照防旧数组
    const current = useTaskSpaceStore.getState().workItems.find((item) => item.id === focusedWorkItemId)
    if (current === undefined) throw new Error('work_item_not_loaded')
    const parentId = current.depth === 3
      ? current.parentId
      : current.depth === 2
        ? current.id
        : null
    if (parentId === null || parentId === '') throw new Error('升格目标父级无法确定（当前项层级非 L2/L3）')
    const title = normalizeNodeTitle(node.text)
    if (title === '') throw new Error('promote_title_empty')
    const description = node.comment !== null && node.comment.length > 0 ? node.comment.join('\n') : null
    const created = await taskRepository.createWorkItem({
      projectId: current.projectId,
      parentId,
      title,
      description,
      typeDefinitionId: firstDefinitionId(definitions, 'types'),
      statusDefinitionId: firstDefinitionId(definitions, 'statuses'),
      priority: null,
    })
    // 导图回写：`[PXII-102] 标题`。base 用带键缓存，键已切换则回落真实读取
    //（与 quickRecord / editMap 同一条防串写纪律）。
    const mapWorkItemId = focusedWorkItemId
    const base = sessionMapText ?? (await readWorkMap(mapWorkItemId)) ?? ''
    const renamed = applyMapNodeEdit(base, { kind: 'rename', cid, title: `[${created.displayKey}] ${title}` })
    if (!renamed.changed) throw new Error(renamed.reason ?? '导图回写未产生变更')
    await writeWorkMap(mapWorkItemId, renamed.text)
    setSessionMap({ workItemId: mapWorkItemId, text: renamed.text })
  }

  /**
   * 节奏面板只在「已结束 且 不需要复盘」时出现：
   * - 休息型结束（免复盘）→ 立即出现；
   * - 投入型 → 先走完复盘（reviewSession 非空时不出现），复盘提交后
   *   reviewState 落 completed，面板才出现 —— 顺序即"先交结果，再休息"。
   */
  const restCycle = useMemo(() => (
    endedAggregate && endedAggregate.session.clockState === 'ended' && !reviewSession
      ? planRestCycle({
          endedMode: endedSessionMode,
          timerCompletion: endedAggregate.session.timerCompletion ?? null,
          completedWorkSessions,
          settings: {
            pomodoroDuration: pomodoroMinutes,
            shortBreakDuration: shortBreakMinutes,
            longBreakDuration: longBreakMinutes,
            longBreakInterval,
            autoStartBreaks,
            autoStartPomodoros,
          },
        })
      : null
  ), [
    autoStartBreaks, autoStartPomodoros, completedWorkSessions, endedAggregate,
    endedSessionMode, longBreakInterval, longBreakMinutes, pomodoroMinutes,
    reviewSession, shortBreakMinutes,
  ])

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
      if (!cancelled) {
        setCompletedWorkSessions(countCompletedWorkSessions(sessions))
        // 「最近会话」卡片消费同一批行（组件侧只取今日前 3 条，见 timer-side-today）。
        setRecentSessions(sessions as unknown as RecentSessionRow[])
      }
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
        // ADR-0008 S2 收口（D4）：会话已在服务端真实成立 → 为其选中的 L3 建岛。
        // fire-and-forget + 内部 fail-soft：建岛绝不阻断/回滚会话（不变量 4）。
        // 离线临时会话（下面的 startProvisional 分支）没有后端可写，不建岛 ——
        // 这是 S2 的已知限制（导图不进同步账本，见 ADR-0008 D2/D6）。
        void createLaunchSessionIslands({
          sessionId: input.sessionId,
          startedAt: input.startedAt,
          level3WorkItemIds: selection.level3WorkItemIds,
          workItems,
        }).finally(() => {
          // ★ 写驱动刷新（2026-09-30 真机验收抓到的竞态）：端口若在岛写入完成前
          //   读了导图，会拿到"有图但还没有本次会话岛"的中间态 → 落在占位文案上。
          //   建岛 promise 落定即触发端口重读，天然消除该竞态（不轮询、不猜测）。
          setMapRefreshSeq((seq) => seq + 1)
        })
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
    // ★ 双体系兼容（2026-09-16）：依赖域的「被阻塞」约束的是"要不要开始投入
    //   这条工作项"，休息不产生投入/成果 —— 休息前不弹阻塞确认（否则每轮
    //   休息都要为一个与休息无关的上游确认一次，节奏会被打断）。
    if (isBreakMode(selection.sessionType)) {
      await start(selection)
      return
    }
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
      // ── 双体系兼容（2026-09-16）：结束口径按模式分流 ──────────────────────
      // 1) timerCompletion 如实反映"这一轮有没有走到计划点"：到点后手动结束
      //    = completed（番茄计数与休息节奏都依赖它；旧实现恒发 ended_early，
      //    导致「每 4 个番茄长休」永远接不上）。提前结束 = ended_early。
      // 2) 休息型：validity 直接 valid（免复盘）—— review_state 由仓储
      //    （离线）与服务端（在线）保持 not_required，绝不进复盘流。
      const currentSession = aggregate?.session ?? null
      const mode = ((currentSession as { sessionType?: SessionMode } | null)?.sessionType ?? 'work') as SessionMode
      const breakSession = isBreakMode(mode)
      const reachedPlan = clock !== null && clock.remainingSeconds === 0
      const timerCompletion: 'completed' | 'ended_early' = reachedPlan ? 'completed' : 'ended_early'
      const validity: 'valid' | 'pending' = breakSession ? 'valid' : 'pending'
      if (localProvisional) {
        if (!focusRepository) throw new Error('focus_session_repository_not_ready')
        const sessionId = localProvisional.aggregate.session.sessionId
        const next = action === 'pause'
          ? await focusRepository.pauseProvisional(sessionId, occurredAt)
          : action === 'resume'
            ? await focusRepository.resumeProvisional(sessionId, occurredAt)
            : await focusRepository.endProvisional(sessionId, { occurredAt, timerCompletion })
        updateLocalProvisionalSession(next)
        return
      }
      if (action === 'pause') await coordinator.pause(occurredAt)
      else if (action === 'resume') await coordinator.resume(occurredAt)
      else await coordinator.end({ occurredAt, timerCompletion, validity, validityReason: null })
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
    // ★ 顺序硬约束：加入计划必须**早于** setCurrent —— 本地仓储与后端都要求
    //   切换目标已在计划内（focus-session-repository.ts:1331 `session_plan_item_not_found`；
    //   后端 policy 同款 not_found 校验），反序必被拒。
    await addPlanItem(created.id)
    // 导图生长（fail-soft，见 growMapForNewLevel3）必须在 setCurrent **之前**完成：
    //   切换后读图 effect 会立刻为新 L3 拉一次导图，若那次读落在写入之前，用户会先
    //   看到一次「还没有导图记录」再跳成有岛 —— 顺序对了就只有最终态这一帧。
    const grown = await growMapForNewLevel3(created.id, created.title, created.title)
    try {
      // 自动切为当前专注项：拆解出的子行动就是下一步要投入的东西。
      // 失败**不 rethrow** —— setCurrent 内部已 setStableError（全局 error 由页面
      // 顶部 role=alert 呈现），再往上抛会让 SessionWorkspace 把"已创建成功"谎报成
      // 创建失败，用户重试就会多出一个重复的 L3。
      await setCurrent(created.id)
    } catch {
      // 已由 setCurrent 上报（全局 error 呈现）；此处只吞掉，避免误报创建失败。
    }
    // 端口刷新自增是**必需项**：空计划场景下 focusedWorkItemId 在 setCurrent 之前
    // 就已经指向新 L3（createChild 会改写 selectedWorkItemId），键没变则读图 effect
    // 不会重跑，不 bump 就永远停在占位文案上。
    if (grown !== null) setMapRefreshSeq((seq) => seq + 1)
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

  /**
   * 从节奏面板（或自动开始）发起下一步。
   *
   * 归属沿用刚结束那一轮的二级工作项；时长按**目标模式**的设置值推导
   * （备选模式因此不会错用建议模式的分钟数）。休息型不带三级计划。
   */
  const startFromRestCycle = async (nextMode: SessionMode) => {
    const level2WorkItemId = endedAggregate?.context?.level2WorkItemId ?? null
    if (!level2WorkItemId) {
      setRestCycleBlockedReason('上一轮没有可用的二级归属，无法自动接续 —— 请在准备态手动启动。')
      return
    }
    setRestCycleStarting(true)
    setRestCycleBlockedReason(null)
    try {
      await requestStart({
        level2WorkItemId,
        // 节奏接续不替用户勾三级计划（工作会话可在运行中加项）。
        level3WorkItemIds: [],
        plannedSeconds: Math.max(1, defaultMinutesForMode(nextMode, {
          pomodoroDuration: pomodoroMinutes,
          shortBreakDuration: shortBreakMinutes,
          longBreakDuration: longBreakMinutes,
        })) * 60,
        sessionType: nextMode,
      })
    } catch (cause) {
      // requestStart 内部（start 之外的守卫）会在这里抛出：已有活动会话 /
      // spaceId 缺失 —— 原因必须可见，否则用户只看到按钮没反应。
      setRestCycleBlockedReason(resolveTimerError(cause).message)
    } finally {
      setRestCycleStarting(false)
    }
  }

  // 自动开始（autoStartBreaks / autoStartPomodoros）：每个"刚结束的会话"
  // 只触发一次 —— 闩锁按 sessionId，重挂载/重渲染都不会连开两轮。
  //
  // ★ 刻意不把 startFromRestCycle 收进依赖：它内部引用 requestStart（每次渲染
  //   都是新函数），useCallback 链会一路传染，而 effect 重跑本身无害（闩锁
  //   在入口处短路）。这里的 exhaustive-deps 提示是这条设计选择的已知代价。
  useEffect(() => {
    if (!restCycle || !restCycle.autoStart || !endedAggregate) return
    const endedId = sessionIdOf(endedAggregate.session)
    if (restAutoStartedFor.current === endedId) return
    restAutoStartedFor.current = endedId
    void startFromRestCycle(restCycle.nextMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：闩锁保证幂等
  }, [endedAggregate, restCycle])

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
    // 结束态分两支（双体系兼容 2026-09-16）：
    // ① 待复盘（投入型）→ 既有复盘面板，行为逐字不变；
    // ② 不需复盘（休息型结束 / 投入型复盘已完成）→ 休息节奏面板：
    //    建议下一步（短休/长休/下一个番茄），可自动开始，出口仍可回任务页。
    ? (reviewSession
      // 焦点区 = 复盘面板 + **下方**「岛总览」（D12 裁决 3 / D13 步 3-4b）；
      // 总览**只读**：不传 onEdit/onQuickRecord（编辑入口仅运行态有，D16-a）。
      ? createElement(TimerFrame, { focus: createElement(Fragment, null,
        createElement(SessionReview, {
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
        }),
        createElement(TimerMapOverview, {
          mapText: endedMapText,
          sessionId: reviewSession.sessionId,
        }),
      ) })
      : createElement(TimerFrame, {
        // 不需复盘的结束态（休息型结束 / 投入型复盘已完成）：焦点区 = 节奏面板。
        focus: createElement('div', { className: 'grid gap-6' },
        createElement('p', { className: 'text-xs text-muted-foreground' }, 'Focus session'),
        restCycle
          ? createElement(RestCyclePanel, {
            endedMode: endedSessionMode,
            focusedSeconds: aggregate.session.focusedSeconds,
            breakSeconds: aggregate.session.breakSeconds,
            cycle: restCycle,
            blockedReason: restCycleBlockedReason,
            starting: restCycleStarting,
            onStart: (nextMode: SessionMode) => { void startFromRestCycle(nextMode) },
            onReturnToTasks: handleReturnToTasks,
          })
          : createElement('div', { className: 'grid gap-3 justify-items-start' },
            createElement('p', { role: 'status' }, `${modeLabel(endedSessionMode)}已结束，这一轮不需要复盘。`),
            createElement(Button, {
              type: 'button', variant: 'outline', onClick: handleReturnToTasks,
            }, '回任务页'),
          ),
        ),
        side: createElement(TodaySummary),
      }))
    : aggregate && session && clock ? createElement(TimerFrame, {
      immersive,
      // 顶栏：二级归属（左）+ 沉浸开关（右）。
      // 开关由骨架结构保证不在渐隐区内 —— 「退出沉浸」绝不能被自己的渐隐规则吃掉。
      breadcrumb: level2WorkItem
        ? createElement('p', {
            className: 'text-sm',
            'data-testid': 'focus-context',
          }, `${level2WorkItem.displayKey} ${level2WorkItem.title}`)
        : null,
      actions: createElement(Button, {
        type: 'button', variant: 'ghost', size: 'sm',
        'aria-pressed': immersive,
        onClick: () => setImmersive((value) => !value),
      }, immersive ? '退出沉浸' : '沉浸模式'),
      // 焦点区 = 环（上）+ **导图编辑区**（下，占了原本的空白大块；ADR-0008 D15）。
      // 编辑区常驻（不随沉浸渐隐）—— 沉浸时右栏伴奏渐隐而这里仍可看全、记录。
      focus: createElement(Fragment, null,
        createElement(SessionClock, {
          session, nowMs, owner: ownershipMode === 'owner',
          ownerHint,
          onTakeover: ownershipMode === 'read_only' ? takeOverSession : undefined,
          onPause: (occurredAt) => clockAction('pause', occurredAt),
          onResume: (occurredAt) => clockAction('resume', occurredAt),
          onEnd: (occurredAt) => clockAction('end', occurredAt),
          onFlushNote: async () => { await draftController?.flush('before-append') },
        }),
        runningBreak
          ? null
          : createElement(TimerMapEditor, {
              mapText: sessionMapText,
              sessionId: activeSessionId,
              focusCid,
              onQuickRecord: quickRecord,
              onEdit: editMap,
              onPromoteNode: handlePromoteNode,
            }),
      ),
      // 伴奏区：骨架带 .timer-immersive-region（结构标记 + testid）。
      // 沉浸渐隐对象 = **显式标记 .timer-immersive-fade 的伴奏卡**（ADR-0008 D12）：
      // 导图端口卡不标记 → 沉浸时仍常驻可交互（极简岛呈态）。
      side: createElement(Fragment, null,
      // 双体系兼容（2026-09-16）：休息型运行态不渲染成果清单 / 当前项 / Note ——
      // 休息不承接三级计划、不产生投入（服务端对 plan 行 fail-closed），
      // 这里用一句说明代替，避免出现"点了必被拒"的控件。
      runningBreak
        ? createElement('div', { className: 'timer-immersive-fade' },
          createElement('p', {
            className: 'text-sm text-muted-foreground',
            'data-testid': 'break-session-note',
          }, `${modeLabel(activeSessionMode)}不记录三级成果与投入 —— 只保留休息时长；结束后直接进入下一轮节奏。`))
        : createElement('div', { className: 'timer-immersive-fade' },
          createElement(SessionWorkspace, {
            session, plans, availableLevel3,
            onSetCurrent: setCurrent, onSetCompletionDraft: setCompletion,
            onAddPlanItem: addPlanItem, onRemovePlanItem: removePlanItem,
            onCreatePlanItem: createPlanItem,
            // 拆解出的新项挂在**会话的二级归属**下（见 createPlanItem 的 parentId 来源）——
            // 轻提示如实说明归属，避免用户以为它挂在当前专注的三级项下。
            parentTitle: level2WorkItem?.title ?? null,
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
          })),
      // ── 导图小视图（ADR-0008 D15：端口职责拆分的"缩略 + 定位"一半）──────────
      // ★ 刻意**不加** .timer-immersive-fade：用户 2026-10-01 确认「极简岛 = 小视图
      //   在沉浸时的呈现」（保留轮廓/点阵/当前高亮；同一 DOM 上 data-minimal 派生）。
      //   休息型会话不建岛，故不渲染。
      !runningBreak
        ? createElement(TimerMapPort, {
            mapText: sessionMapText,
            sessionId: activeSessionId,
            minimal: immersive,
            onFocusNode: (cid) => setFocusCid(cid),
          })
        : null,
      !runningBreak && focusedWorkItemId
        ? createElement('div', { className: 'timer-immersive-fade' },
          createElement(FocusedWorkItemNote, {
            note: focusedNote, spaceId: spaceId ?? '', workItemId: focusedWorkItemId,
            draftRegistry: draftController ?? undefined, onAppendBlocks: appendBlocks,
          }))
        : null,
      // 底部统计栏（工单③→工单 A 2026-09-14）：准备态与运行态两处布局的底部都要有（规格 L457/L505）。
      // 标签「今日」= 本地日界显式窗口（服务端 start，本单 A1/A2），理由见 today-summary.tsx 的注释。
      createElement('div', { className: 'timer-immersive-fade' }, createElement(TodaySummary)),
      ),
    })
  : createElement(TimerFrame, {
    // 准备态（设计稿 `① 准备态`）：左栏 = 继续上次三栏 + 浏览全部 + 本次时长 + 开始专注；
    // 右栏 = 「今日」卡组。右栏标题栏走 sideHeader（全宽 + 下边框），正文自滚动。
    sideHeader: '今日',
    side: createElement(TimerSideToday, { recentSessions }),
    focus: createElement('div', { className: 'grid gap-4' },
    // 设计稿 `.crumb`：空间面包屑（查不到名字就不编造）
    createElement('div', { className: 'ios-crumb' },
      createElement('span', { className: 'ios-crumb-k' }, '空间'),
      createElement('span', null, spaceName ?? '—'),
    ),
    createElement('header', null,
      createElement('h1', { className: 'text-[19px] font-medium leading-tight' }, '继续上次'),
      createElement('p', { className: 'ios-tiny', style: { marginTop: 4 } },
        '按时间分层：最近打开 → 昨日未完成 → 七天内堆积。同一个工作项只出现在最贴近它的那一层。'),
    ),
    // ── 三栏分层快捷入口（设计稿 `.groups`：固定三列并排）──────────────────
    // ★ 恒渲染三列。此前是 `continueTotal > 0 &&` 才渲染，结果本机账号近 7 天
    //   零会话时**一栏都不显示** —— 用户看不到结构本身，误判成"三列布局没做"
    //   （2026-09-30 连续两次反馈）。空层现在在卡内显示「暂无」占位；
    //   分桶/排序/去重仍在 lib/task-space/continue-previous.ts（纯函数，已单测）。
    createElement(ContinuePrevious, {
      buckets: {
        today: joinWithWorkItems(continueBuckets?.today ?? [], workItems),
        yesterday: joinWithWorkItems(continueBuckets?.yesterday ?? [], workItems),
        withinWeek: joinWithWorkItems(continueBuckets?.withinWeek ?? [], workItems),
      },
      selectedWorkItemId,
      onSelect: (id) => selectWorkItem(id),
      formatSessionTime: (iso) => formatWorkMapSessionTime(iso, { now: new Date(), dayBoundaryHour }),
    }),
    // ── 「查看主图」（ADR-0008 D18 / D13 步 3-4a，方案 C：弹层）──────────────
    // 仅当选中**三级项**时可点（主图 = `<L3 id>.mm.md`，按 L3 归档）。
    // ★ 刻意插在「浏览全部任务…」**之前**：那个入口预留给设计稿 ② 任务选择 Modal，本单不碰。
    createElement('div', { className: 'wm-preview-row' },
      createElement('span', { className: 'ios-tiny', 'data-testid': 'launcher-selected-title' },
        // 显示**当前选中项**的标题（不限层级）—— 非三级时按钮另给提示说明为何不可点
        `已选：${selectedWorkItem?.title ?? '—'}`),
      createElement('button', {
        type: 'button',
        className: 'wm-preview-open',
        'data-testid': 'launcher-view-map',
        onClick: () => setPreviewOpen(true),
        ...(previewWorkItem === null ? { disabled: true, 'aria-disabled': true } : {}),
      }, '查看主图'),
    ),
    previewWorkItem === null
      ? createElement('p', { className: 'ios-tiny', 'data-testid': 'launcher-view-map-hint' },
          '选择三级项后可查看主图')
      : null,
    // ── 「浏览全部任务…」（设计稿：整宽按钮，打开 ② 任务选择 Modal）──────────
    // 2026-10-02 落地：原 <details> 可展开列表退役 —— 归属/三级计划/筛选全部
    // 迁入 TaskPickerModal（页面根部挂载）。列表不再占据启动路径，此前
    // 「自动展开列表把 CTA 推到 900px 折线以下（实测 y≈1218）」的回归根因
    // 就此消除；空 Space 的说明也移进 Modal（打开按钮即达）。
    createElement('div', { className: 'ios-quick' },
      createElement('button', {
        type: 'button',
        className: 'ios-qrow',
        'data-tappable': 'true',
        'data-testid': 'launcher-browse-all',
        style: { cursor: 'pointer', alignItems: 'center', width: '100%' },
        onClick: () => setPickerOpen(true),
      },
        createElement('span', { className: 'ios-tiny' }, '⌕'),
        createElement('span', { className: 'qbody', style: { flexDirection: 'row', alignItems: 'center' } },
          createElement('span', { className: 'qt' }, '浏览全部任务…')),
        createElement('span', { className: 'ios-tail' }, '筛选 / 搜索'),
      ),
    ),
    // ── 启动器（已选摘要 / 本次时长 / 开始专注）────────────────────────────
    // ② Modal 落地后：归属/三级计划控件在 TaskPickerModal 里，启动器只读同一份
    // 页面状态源（launchLevel2Id / launchLevel3Ids）呈现摘要并提交 CTA。
    workItems.length ? createElement(SessionLauncher, {
      items: workItems,
      level2Id: launchLevel2Id,
      level3Ids: launchLevel3Ids,
      onLevel3IdsChange: setLaunchLevel3Ids,
      onStart: requestStart,
    }) : null,
      ),
  })

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
    // 准备态「主图」弹层（D18）：与 BlockerAckModal 同层，挂在页面根部
    previewOpen ? createElement(WorkMapPreviewOverlay, {
      open: true,
      loading: previewLoading,
      mapText: previewMapText,
      onClose: () => setPreviewOpen(false),
    }) : null,
    // ② 任务选择 Modal（2026-10-02）：与 BlockerAckModal / 主图弹层同层，挂在页面根部。
    // 归属/三级计划的唯一状态源在上方（launchLevel2Id / launchLevel3Ids）；
    // 改归属即清空三级计划 —— 与原启动器 select onChange 的联动逐字一致。
    // 内联新建三级（工单③）随三级计划组迁入 Modal：走任务页同一 store 入口
    //（createChild），直接用返回值 id，不读异步闭包里的 workItems 旧快照
    //（createChild 先落 store 再返回，结构性避开该陷阱）；
    // 失败不吞：Modal 以 role="alert" 呈现（离线创建禁令必须可见）。
    createElement(TaskPickerModal, {
      open: pickerOpen,
      onOpenChange: setPickerOpen,
      items: workItems,
      level2Id: launchLevel2Id,
      level3Ids: launchLevel3Ids,
      frozenLevel3Ids: derivedLaunch.level3Ids,
      categoryById,
      codeById: hierarchyCodes,
      onAttributionChange: (nextLevel2Id: string | null) => {
        setLaunchLevel2Id(nextLevel2Id)
        setLaunchLevel3Ids([])
      },
      onLevel3IdsChange: setLaunchLevel3Ids,
      onCreateLevel3: async (level2Id: string, title: string) => (await createChild(level2Id, { title })).id,
    }),
  )
}
