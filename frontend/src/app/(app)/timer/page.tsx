'use client'

import { createElement, useEffect, useState, type ReactNode } from 'react'
import { FocusedWorkItemNote } from '@/components/timer/focused-work-item-note'
import { SessionClock } from '@/components/timer/session-clock'
import { SessionLauncher, type LaunchSelection } from '@/components/timer/session-launcher'
import { SessionWorkspace } from '@/components/timer/session-workspace'
import { useActiveSessionCoordinator, useActiveSessionIdentity, useActiveSessionProvisionalLock } from '@/lib/focus-session/active-session-provider'
import { FocusSessionRepository, type LocalFocusSessionAggregate } from '@/lib/focus-session/focus-session-repository'
import { TimerNoteComposerDraftController, type TimerNoteComposerDraftDatabase } from '@/lib/task-space/timer-note-composer-draft-registry'
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
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
import { useTaskSpaceStore } from '@/stores/task-space-store'
import { selectDerivedClock, useTimerStore } from '@/stores/timer-store'

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
    commandReceipts: await database.sessionCommandReceipts.where('sessionId').equals(sessionId).toArray() as Array<Record<string, unknown>>,
  }
}

function sessionIdOf(session: { id?: string; sessionId?: string }): string {
  const id = session.id ?? session.sessionId
  if (!id) throw new Error('focus_session_identity_missing')
  return id
}

export default function TimerPage() {
  const spaceId = useSpaceStore((state) => state.currentSpaceId)
  const workItems = useTaskSpaceStore((state) => state.workItems)
  const selectedWorkItemId = useTaskSpaceStore((state) => state.selectedWorkItemId)
  const selectWorkItem = useTaskSpaceStore((state) => state.selectWorkItem)
  const hydrateTaskSpace = useTaskSpaceStore((state) => state.hydrate)
  const resetTaskSpace = useTaskSpaceStore((state) => state.reset)
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
  const [focusRepository, setFocusRepository] = useState<FocusSessionRepository | null>(null)
  const [noteRepository, setNoteRepository] = useState<WorkItemNoteRepository | null>(null)
  const [focusedNote, setFocusedNote] = useState<CachedWorkItemNote | null>(null)
  const [draftController, setDraftController] = useState<TimerNoteComposerDraftController | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!spaceId) {
      resetTaskSpace()
      setDatabase(null)
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
      void hydrateTaskSpace(spaceId, taskRepository)
    } catch (cause) {
      if (!cancelled) setError((cause as Error).message)
    }
    return () => { cancelled = true }
  }, [coordinator, hydrateTaskSpace, identity, provisionalLock, resetTaskSpace, spaceId])

  const aggregate = localProvisional?.aggregate ?? locator?.session ?? null
  const plans = aggregate?.plan.filter((plan) => plan.removedAt === null) ?? []
  const currentPlan = plans.find((plan) => plan.currentDuringSession) ?? plans[0] ?? null
  const focusedWorkItemId = currentPlan?.workItemId ?? selectedWorkItemId
  const selectedWorkItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null
  const clock = useTimerStore((state) => selectDerivedClock(state))

  useEffect(() => {
    let cancelled = false
    if (!noteRepository || !focusedWorkItemId) {
      setFocusedNote(null)
      return
    }
    void noteRepository.read(focusedWorkItemId).then((note) => {
      if (!cancelled) setFocusedNote(note)
    }).catch((cause) => {
      if (!cancelled) setError((cause as Error).message)
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
    void controller.hydrate().catch((cause) => setError((cause as Error).message))
    return () => {
      controller.dispose()
      setDraftController(null)
    }
  }, [database, focusedWorkItemId, noteRepository, spaceId])

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
    } catch (cause) {
      setError((cause as Error).message)
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
      setError((cause as Error).message)
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
    } catch (cause) { setError((cause as Error).message) }
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
      setError((cause as Error).message)
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
    } catch (cause) { setError((cause as Error).message) }
  }

  const addPlanItem = async (workItemId: string) => {
    if (!aggregate) return
    const item = workItems.find((candidate) => candidate.id === workItemId)
    if (!item) return
    try {
      const planRank = plans.length
      if (localProvisional) {
        await focusRepository?.addPlanItem(localProvisional.aggregate.session.sessionId, workItemId, planRank, canonicalNow())
        await localAggregateRefresh()
      } else await coordinator.addPlanItem({ sessionId: sessionIdOf(aggregate.session), workItemId, expectedWorkItemVersion: item.version, planRank, addedAt: canonicalNow() })
    } catch (cause) { setError((cause as Error).message) }
  }

  const removePlanItem = async (planItemId: string) => {
    if (!aggregate) return
    try {
      if (localProvisional) {
        await focusRepository?.removePlanItem(localProvisional.aggregate.session.sessionId, planItemId, canonicalNow(), 'removed from current plan')
        await localAggregateRefresh()
      } else await coordinator.removePlanItem({ sessionId: sessionIdOf(aggregate.session), planItemId, removedAt: canonicalNow(), removalReason: 'removed from current plan' })
    } catch (cause) { setError((cause as Error).message) }
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

  const content: ReactNode = aggregate && session && clock ? createElement('div', { className: 'grid gap-6 p-6' },
    createElement(SessionClock, {
      session, nowMs, owner: ownershipMode === 'owner',
      onPause: (occurredAt) => clockAction('pause', occurredAt),
      onResume: (occurredAt) => clockAction('resume', occurredAt),
      onEnd: (occurredAt) => clockAction('end', occurredAt),
      onFlushNote: async () => { await draftController?.flush('before-append') },
    }),
    createElement(SessionWorkspace, {
      session, plans, availableLevel3,
      onSetCurrent: setCurrent, onSetCompletionDraft: setCompletion,
      onAddPlanItem: addPlanItem, onRemovePlanItem: removePlanItem,
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
  ) : createElement('div', { className: 'grid gap-6 p-6' },
    createElement('header', null,
      createElement('p', { className: 'text-xs text-muted-foreground' }, 'Focus session'),
      createElement('h1', { className: 'text-2xl font-semibold' }, 'Start a focused Session'),
    ),
    selectedWorkItem ? createElement('p', null, `Selected: ${selectedWorkItem.displayKey} ${selectedWorkItem.title}`) : null,
    workItems.length
      ? createElement('div', { className: 'grid gap-2', 'aria-label': 'WorkItems for focus' }, workItems.map((item) => createElement('button', { key: item.id, type: 'button', onClick: () => selectWorkItem(item.id) }, `${item.displayKey} ${item.title}`)))
      : createElement('p', null, 'No WorkItems are available in this Space.'),
    workItems.length ? createElement(SessionLauncher, { items: workItems, initialWorkItemId: selectedWorkItemId, onStart: start }) : null,
  )

  return createElement('main', { className: 'min-h-full' },
    error || timerError ? createElement('p', { role: 'alert', className: 'border-b bg-destructive/10 px-4 py-2 text-sm text-destructive' }, error ?? timerError) : null,
    content,
  )
}
