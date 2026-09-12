'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProjectRail } from '@/components/task-space/project-rail'
import { LaunchSessionButton } from '@/components/task-space/launch-session-button'
import { WorkItemDetail } from '@/components/task-space/work-item-detail'
import { ActiveChildConflictDialog } from '@/components/task-space/active-child-conflict-dialog'
import { WorkItemRelationsCard } from '@/components/task-space/work-item-relations-card'
import { BlockerAckModal } from '@/components/task-space/blocker-ack-modal'
import {
  WaitingResumeHint,
  type WaitingResumeTarget,
} from '@/components/task-space/waiting-resume-hint'
import { WorkItemTree } from '@/components/task-space/work-item-tree'
import { WorkItemNoteEditor } from '@/components/task-space/work-item-note-editor'
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
import { WorkItemNoteRepository } from '@/lib/task-space/work-item-note-repository'
import { syncEngine } from '@/lib/sync'
import { useTaskSpaceShortcuts } from '@/hooks/use-task-space-shortcuts'
import {
  ActiveChildConflictError,
  selectBlockedMap,
  selectLevel2RelocationTargets,
  selectMoveCandidates,
  selectProjectTree,
  selectRelationCandidates,
  resolveTaskSpaceMutationError,
  useTaskSpaceStore,
} from '@/stores/task-space-store'
import { buildHierarchyCodes } from '@/lib/task-space/hierarchy-code'
import {
  countOpenBlockers,
  selectOpenBlockers,
  selectWaitingResumeSuggestion,
} from '@/lib/task-space/relation-selectors'
import { evaluateSessionLaunch } from '@/lib/task-space/session-launch-guard'
import { recordBlockerAck } from '@/lib/task-space/blocker-ack-log'
import { deriveStatusCategoryById } from '@/lib/task-space/status-categories'
import {
  countOpenChildren,
  EMPTY_TREE_FILTER,
  filterWorkItemTree,
  isTreeFilterActive,
  type WorkItemTreeFilter,
} from '@/lib/task-space/tree-filter'
import { useSpaceStore } from '@/stores/space-store'
import { spaceDBManager } from '@/services/space-db'
import { PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'
import type { CachedWorkItem, WorkItemNoteConflictRow } from '@/types'
import type { CachedRelation } from '@/lib/contracts/task-space'

type NoteRepositoryWithConflict = {
  conflict: (workItemId: string) => Promise<WorkItemNoteConflictRow | undefined>
}

export default function TasksPage() {
  const spaceId = useSpaceStore((state) => state.currentSpaceId)
  const router = useRouter()
  const projects = useTaskSpaceStore((state) => state.projects)
  const workItems = useTaskSpaceStore((state) => state.workItems)
  const definitions = useTaskSpaceStore((state) => state.definitions)
  const selectedProjectId = useTaskSpaceStore((state) => state.selectedProjectId)
  const selectedWorkItemId = useTaskSpaceStore((state) => state.selectedWorkItemId)
  const selectedNote = useTaskSpaceStore((state) => state.selectedNote)
  const noteConflict = useTaskSpaceStore((state) => state.noteConflict)
  const noteRepositoryReady = useTaskSpaceStore((state) => state.noteRepository !== null)
  const isLoading = useTaskSpaceStore((state) => state.isLoading)
  const error = useTaskSpaceStore((state) => state.error)
  const hydrate = useTaskSpaceStore((state) => state.hydrate)
  const reset = useTaskSpaceStore((state) => state.reset)
  const selectProject = useTaskSpaceStore((state) => state.selectProject)
  const selectWorkItem = useTaskSpaceStore((state) => state.selectWorkItem)
  const attachNoteRepository = useTaskSpaceStore((state) => state.attachNoteRepository)
  const loadNote = useTaskSpaceStore((state) => state.loadNote)
  const updateNoteDocument = useTaskSpaceStore((state) => state.updateNoteDocument)
  const flushNote = useTaskSpaceStore((state) => state.flushNote)
  const dispatchNote = useTaskSpaceStore((state) => state.dispatchNote)
  const resolveReloadRemoteNote = useTaskSpaceStore((state) => state.resolveReloadRemoteNote)
  const resolveOverwriteLocalNote = useTaskSpaceStore((state) => state.resolveOverwriteLocalNote)
  const createProject = useTaskSpaceStore((state) => state.createProject)
  const createChild = useTaskSpaceStore((state) => state.createChild)
  const createRoot = useTaskSpaceStore((state) => state.createRoot)
  const updateWorkItem = useTaskSpaceStore((state) => state.updateWorkItem)
  const moveWorkItem = useTaskSpaceStore((state) => state.moveWorkItem)
  const transitionWorkItem = useTaskSpaceStore((state) => state.transitionWorkItem)
  const toggleWorkItemLabel = useTaskSpaceStore((state) => state.toggleWorkItemLabel)
  const trashWorkItem = useTaskSpaceStore((state) => state.trashWorkItem)
  const restoreWorkItem = useTaskSpaceStore((state) => state.restoreWorkItem)
  const pendingMutations = useTaskSpaceStore((state) => state.pendingMutations)
  const mutationError = useTaskSpaceStore((state) => state.mutationError)
  const [createTarget, setCreateTarget] = useState<{ kind: 'child'; parentId: string } | { kind: 'root' } | null>(null)
  const [childTitle, setChildTitle] = useState('')
  const [collapseSignal, setCollapseSignal] = useState<{ seq: number; mode: 'collapse' | 'expand' }>({ seq: 0, mode: 'expand' })
  const relations = useTaskSpaceStore((state) => state.relations)
  const loadRelations = useTaskSpaceStore((state) => state.loadRelations)
  const loadBlockedMap = useTaskSpaceStore((state) => state.loadBlockedMap)
  const createRelation = useTaskSpaceStore((state) => state.createRelation)
  const removeRelation = useTaskSpaceStore((state) => state.removeRelation)
  const resolveRelation = useTaskSpaceStore((state) => state.resolveRelation)
  const acknowledgeLaunch = useTaskSpaceStore((state) => state.acknowledgeLaunch)
  const [conflict, setConflict] = useState<{ parentId: string; childIds: string[] } | null>(null)
  const [resolvingConflict, setResolvingConflict] = useState(false)
  const [blockedLaunch, setBlockedLaunch] = useState<CachedWorkItem | null>(null)
  const [treeFilter, setTreeFilter] = useState<WorkItemTreeFilter>(EMPTY_TREE_FILTER)

  // Status ids are Space-scoped definitions, never hardcoded: the backend
  // owns the status machine and a Space may rename or re-categorise entries.
  const statusIdByCategory = (category: string): string | null => {
    for (const status of definitions?.statuses ?? []) {
      const record = status as Record<string, unknown>
      if (record.category === category && typeof record.id === 'string') return record.id
    }
    return null
  }
  const completedStatusIds = new Set(
    (definitions?.statuses ?? [])
      .filter((status) => (status as Record<string, unknown>).category === 'completed')
      .map((status) => String((status as Record<string, unknown>).id)),
  )

  // ★ 2026-09-11：缺 cancelled / completed 类目是**合法的空间状态**（空间自定义
  //   status_definitions），不是异常数据。此前两个主按钮的 handler 直接
  //   `if (!statusId) return` —— 点了没反应、无任何反馈。现在把原因提前算出
  //   交给弹窗：按钮禁用 + 中文说明，绝不伪造默认状态 ID。
  const cancelledStatusId = statusIdByCategory('cancelled')
  const completedStatusId = statusIdByCategory('completed')
  const cancelChildrenUnavailableReason = !cancelledStatusId
    ? (completedStatusId
        ? '当前空间缺少「已取消」类目的状态，无法执行此操作。'
        : '当前空间缺少「已取消」与「已完成」类目的状态，无法执行此操作。')
    : (completedStatusId ? null : '当前空间缺少「已完成」类目的状态，无法执行此操作。')
  const moveChildrenUnavailableReason = completedStatusId
    ? null
    : '当前空间缺少「已完成」类目的状态，无法执行此操作。'

  const blockedParent = conflict
    ? (workItems.find((item) => item.id === conflict.parentId) ?? null)
    : null
  const relocationTargets = selectLevel2RelocationTargets(
    workItems,
    conflict?.parentId ?? null,
    completedStatusIds,
  )

  // Status categories come from Space-scoped definitions, never hardcoded.
  // ★ 与 /timer 共用同一份查表 —— 会话启动判定在两处必须看到同一事实。
  const categoryById = useMemo(
    () => deriveStatusCategoryById(definitions, workItems),
    [workItems, definitions],
  )

  // Derived blocking signal: recomputed locally so an edge that arrived before
  // its work item (network reordering) still blocks instead of silently
  // clearing.  Falls back to the server projection when present.
  const blockedSignals = useMemo(() => {
    const derived = selectBlockedMap(workItems, relations, categoryById)
    const withCounts: Record<string, { isBlocked: boolean; openBlockerCount: number }> = {}
    for (const item of workItems) {
      const signal = derived[item.id]
      if (!signal) continue
      withCounts[item.id] = {
        isBlocked: signal.isBlocked,
        openBlockerCount: countOpenBlockers(relations, item.id, categoryById),
      }
    }
    return withCounts
  }, [workItems, relations, categoryById])

  // NOTE: resolved here rather than reusing ``selectedWorkItem`` below — that
  // const is declared further down, and this block feeds hooks that run first.
  const selectedItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null
  // ★ 会话启动判定收口到唯一入口（/timer 用同一函数）——按钮拦截与计时页
  //   判定从此不可能漂移；孤儿上游按未完成算（与派生信号同源）。
  const selectedIsBlocked = selectedItem
    ? evaluateSessionLaunch({
        level2WorkItemId: selectedItem.id,
        workItems,
        relations,
        statusCategoryById: categoryById,
      }).status === 'blocked'
    : false
  // 与启动判定同源：只列真正的阻塞型边、上游去重、取消 / 完成的上游不列。
  const selectedBlockers = useMemo(() => {
    if (!selectedItem) return []
    const openIds = new Set(selectOpenBlockers(relations, selectedItem.id, categoryById))
    return relations.filter((edge) => (
      edge.fromWorkItemId === selectedItem.id && openIds.has(edge.toWorkItemId)
    ))
  }, [selectedItem, relations, categoryById])
  // 依赖解除 → 建议恢复（依赖域合同 §10 验收 9：提示但不自动切状态）。
  // ★ 2026-09-12（ADR-0003）：恢复目标是**服务端读投影的等待前态事实**
  //   （preWaitingStatusDefinitionId，wire 读路径才携带；本地 Dexie 行一律
  //   忽略 —— 见 task-space-repository 的读取边界）。未命中一律降级为
  //   「用户显式选择」：无记录 / 目标不在本空间定义中（已归档或不存在）/
  //   目标类目不可恢复（waiting 或终态）。绝不猜、绝不自动切状态。
  const waitingResumeSuggestion = selectedItem
    ? selectWaitingResumeSuggestion({
        workItemId: selectedItem.id,
        depth: selectedItem.depth,
        statusCategory: categoryById[selectedItem.id],
        relations,
        statusCategoryById: categoryById,
      })
    : null
  const selectedPriorStateId = selectedItem?.preWaitingStatusDefinitionId ?? null
  const waitingResume = useMemo<{
    target: WaitingResumeTarget | null
    unresolvedReason?: string
  }>(() => {
    const unrecoverable = (unresolvedReason: string) => ({ target: null, unresolvedReason })
    if (!selectedPriorStateId) {
      return unrecoverable(
        '没有记录到进入「等待」前的状态，请在本页「状态」中自行选择要恢复到的状态。',
      )
    }
    const status = (definitions?.statuses ?? []).find(
      (candidate) => String((candidate as Record<string, unknown>).id) === selectedPriorStateId,
    ) as Record<string, unknown> | undefined
    // 目标已归档 / 不存在：不可恢复（已归档行在定义表里仍会返回，必须显式排除）。
    const archivedAt = status ? (status.archived_at ?? status.archivedAt ?? null) : null
    if (!status || archivedAt !== null && archivedAt !== undefined) {
      return unrecoverable(
        '记录的前态在当前空间中不可用（可能已归档或不存在），请在本页「状态」中自行选择要恢复到的状态。',
      )
    }
    // 目标类目不可恢复：waiting 本身或终态（重启终态项是危险动作，不给一键）。
    const category = typeof status.category === 'string' ? status.category : null
    if (category === 'waiting' || category === 'completed' || category === 'cancelled') {
      return unrecoverable(
        '记录的前态不可恢复（进入「等待」前已是终态或等待类目），请在本页「状态」中自行选择要恢复到的状态。',
      )
    }
    const name = typeof status.name === 'string' && status.name.length > 0 ? status.name : null
    if (!name) {
      return unrecoverable(
        '记录的前态在当前空间中不可用（可能已归档或不存在），请在本页「状态」中自行选择要恢复到的状态。',
      )
    }
    return { target: { statusDefinitionId: selectedPriorStateId, name } }
  }, [selectedPriorStateId, definitions])
  const waitingResumeTargetId = waitingResume.target?.statusDefinitionId ?? null

  useEffect(() => {
    if (!selectedWorkItemId) return
    void loadRelations(selectedWorkItemId)
  }, [loadRelations, selectedWorkItemId])

  useEffect(() => {
    if (!selectedProjectId) return
    void loadBlockedMap(selectedProjectId)
  }, [loadBlockedMap, selectedProjectId])

  // 候选默认只列**同项目**：跨项目任务与本项几乎不可同债，全量罗列只会让
  // 选择器变成大海捞针。依赖域合同允许跨项目边（服务端 5 字段投影防泄露），
  // 所以跨项目候选单独成组，由用户在面板里显式展开。
  const candidateIds = selectedItem
    ? selectRelationCandidates(workItems, selectedItem.id, relations, { projectId: selectedItem.projectId })
    : []
  const crossProjectCandidateIds = selectedItem
    ? selectRelationCandidates(workItems, selectedItem.id, relations, {
        projectId: selectedItem.projectId,
        includeCrossProject: true,
      }).filter((id) => !candidateIds.includes(id))
    : []
  const candidateItems = workItems.filter((item) => candidateIds.includes(item.id))
  const crossProjectCandidateItems = workItems.filter((item) => crossProjectCandidateIds.includes(item.id))

  const handleAddRelation = async (input: { toWorkItemId: string; relationType: string }) => {
    if (!selectedWorkItemId) return
    await createRelation({
      fromWorkItemId: selectedWorkItemId,
      toWorkItemId: input.toWorkItemId,
      relationType: input.relationType,
    })
  }

  const handleRemoveRelation = async (input: {
    fromWorkItemId: string
    toWorkItemId: string
    relationType: string
  }) => {
    await removeRelation(input)
  }

  // ★ 2026-09-12（D2 / ADR-0004）：「需要解决」区块的确认 —— 幂等 CAS；
  //   成功后 store 重算（阻塞 / 恢复提示）立即反映。
  const handleResolveRelation = async (edge: CachedRelation) => {
    await resolveRelation({
      fromWorkItemId: edge.fromWorkItemId,
      toWorkItemId: edge.toWorkItemId,
      relationType: edge.relationType,
    })
  }

  const handleTransition = async (statusDefinitionId: string) => {
    if (!selectedWorkItemId) return
    try {
      await transitionWorkItem(selectedWorkItemId, statusDefinitionId)
    } catch (error) {
      // A blocked completion is not a dead end: open the four-way resolution
      // panel so the user can unblock it in one flow.
      if (error instanceof ActiveChildConflictError) {
        setConflict({ parentId: error.workItemId, childIds: error.conflictChildIds })
      }
    }
  }

  const closeConflict = () => {
    setConflict(null)
    setResolvingConflict(false)
  }

  const cancelChildrenAndComplete = async () => {
    if (!conflict) return
    // 不可用时按钮已禁用、弹窗展示了中文原因（见上面 reason 计算）——
    // 这里保留防御性早退，但用户路径上不再出现「点了没反应」。
    if (!cancelledStatusId || !completedStatusId) return
    setResolvingConflict(true)
    try {
      // Sequential: each child transition is a CAS-guarded command, so a
      // parallel fan-out would trip the store's per-target single-flight
      // guard and race the version chain.
      for (const childId of conflict.childIds) {
        await transitionWorkItem(childId, cancelledStatusId)
      }
      await transitionWorkItem(conflict.parentId, completedStatusId)
      closeConflict()
    } finally {
      setResolvingConflict(false)
    }
  }

  const moveChildrenAndComplete = async (targetParentId: string) => {
    if (!conflict) return
    // 缺 completed 类目时按钮已禁用 + 弹窗已给出中文原因，这里仅作防御。
    if (!completedStatusId) return
    setResolvingConflict(true)
    try {
      for (const childId of conflict.childIds) {
        await moveWorkItem(childId, targetParentId)
      }
      await transitionWorkItem(conflict.parentId, completedStatusId)
      closeConflict()
    } finally {
      setResolvingConflict(false)
    }
  }

  useEffect(() => {
    if (!spaceId) {
      reset()
      return
    }
    let cancelled = false
    const run = () => {
      if (cancelled) return
      try {
        const database = spaceDBManager.current
        const repository = new TaskSpaceRepository(database, spaceId)
        const noteRepository = new WorkItemNoteRepository(database, spaceId)
        const noteRepositoryWithConflict = noteRepository as unknown as NoteRepositoryWithConflict
        attachNoteRepository({
          read: (workItemId) => noteRepository.read(workItemId),
          saveLocal: (input) => noteRepository.saveLocal(input),
          dispatchReplace: (workItemId) => noteRepository.dispatchReplace(workItemId),
          resolveReloadRemote: (workItemId) => noteRepository.resolveReloadRemote(workItemId),
          resolveOverwriteLocal: (workItemId) => noteRepository.resolveOverwriteLocal(workItemId),
          readConflict: async (workItemId) => await noteRepositoryWithConflict.conflict(workItemId) ?? null,
          retryDraft: (workItemId) => noteRepository.retryDraft(workItemId),
          persistDraft: (input) => noteRepository.persistDraft(input),
        })
        void (async () => {
          if (cancelled) return
          await hydrate(spaceId, repository)
        })()
      } catch (hydrationError) {
        // The route guard normally prevents this; keep the workbench
        // fail-closed with a stable message if it races.
        useTaskSpaceStore.setState({
          error: resolveTaskSpaceMutationError(hydrationError).message,
          isLoading: false,
        })
      }
    }
    if (spaceDBManager.currentSpaceId === spaceId) {
      run()
    } else {
      // The space store publishes currentSpaceId before its switchTo()
      // completes; hydrate only once the space database is actually ready.
      const onSpaceSwitched = () => {
        if (spaceDBManager.currentSpaceId === spaceId) run()
      }
      window.addEventListener(PXII_SPACE_SWITCHED_EVENT, onSpaceSwitched)
      return () => {
        cancelled = true
        window.removeEventListener(PXII_SPACE_SWITCHED_EVENT, onSpaceSwitched)
        attachNoteRepository(null)
      }
    }
    return () => {
      cancelled = true
      attachNoteRepository(null)
    }
  }, [attachNoteRepository, hydrate, reset, spaceId])

  useEffect(() => {
    if (!selectedWorkItemId || !noteRepositoryReady) return
    void loadNote(selectedWorkItemId)
  }, [loadNote, noteRepositoryReady, selectedWorkItemId])

  // A Note edit that reached the S4 outbox while offline is pushed by the sync
  // engine on reconnect.  When the server rejects it (version_conflict), the
  // push terminal application writes a workItemNoteConflicts row and pins the
  // note to 'conflict' — but the UI only learns about it by re-reading the
  // note.  Reload the currently selected note after each sync cycle so a
  // newly-arrived conflict (or a newly-applied remote edit) is reflected in the
  // editor instead of staying stale until the user re-selects the item.
  useEffect(() => {
    if (!selectedWorkItemId || !noteRepositoryReady) return
    const unregister = syncEngine.onSyncComplete?.(() => {
      void loadNote(selectedWorkItemId)
    })
    return unregister
  }, [loadNote, noteRepositoryReady, selectedWorkItemId])

  // Flush any debounced Note edit before the space database switches or closes
  // (space switch + logout).  spaceDBManager awaits these listeners while the
  // old DB is still open, so a dirty Note is persisted to local storage/outbox
  // instead of being dropped by the unmount/reset cancel path.
  useEffect(() => {
    const unregister = spaceDBManager.onBeforeSwitch(({ fromSpaceId }) => {
      if (fromSpaceId !== spaceId) return undefined
      return flushNote('space-switch').catch(() => undefined)
    })
    return () => unregister()
  }, [flushNote, spaceId])

  // 层级编码（1 / 1.2 / 1.2.3）：客户端派生，不落库。父项移动会重排整棵
  // 子树的编号 —— 这是特性（反映当前结构）；稳定身份仍是 displayKey。
  const hierarchyCodes = useMemo(() => buildHierarchyCodes(workItems), [workItems])
  const visibleItems = useMemo(() => {
    const projectItems = selectProjectTree(workItems, selectedProjectId)
    if (!isTreeFilterActive(treeFilter)) return projectItems
    const isBlockedById: Record<string, boolean> = {}
    for (const [id, signal] of Object.entries(blockedSignals)) isBlockedById[id] = signal.isBlocked
    return filterWorkItemTree(projectItems, treeFilter, {
      categoryById,
      isBlockedById,
      codeById: hierarchyCodes,
    })
  }, [workItems, selectedProjectId, treeFilter, blockedSignals, categoryById, hierarchyCodes])
  const treeFilterActive = isTreeFilterActive(treeFilter)
  // 父子完成护栏的前置信号：每个父项下未完成的直接子项数。
  const openChildCountById = useMemo(
    () => countOpenChildren(workItems, categoryById),
    [workItems, categoryById],
  )
  // 依赖端点的本地名称解析：服务端最小投影（跨项目 5 字段）是权威，
  // 但它随 relation-set 查询才到达 —— 没有本地回退时，边会渲染成裸 UUID。
  const workItemNameById = useMemo(
    () => Object.fromEntries(workItems.map((item) => [item.id, {
      displayKey: item.displayKey,
      title: item.title,
      statusDefinitionId: item.statusDefinitionId,
      // ★ D2（ADR-0004）：归档提示需要端点的归档事实（真值表不受影响）。
      archivedAt: item.archivedAt,
      code: hierarchyCodes[item.id],
    }])),
    [workItems, hierarchyCodes],
  )
  const selectedWorkItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null
  // 关系图节点解析：状态类目 + 投入（节点信息密度）。
  const resolveItem = useCallback((id: string) => {
    const item = workItems.find((candidate) => candidate.id === id)
    if (!item) return undefined
    return {
      displayKey: item.displayKey,
      title: item.title,
      statusCategory: categoryById[id],
      effortActualSeconds: item.effortActualSeconds,
      effortEstimateLowerSeconds: item.effortEstimateLowerSeconds,
      effortEstimateUpperSeconds: item.effortEstimateUpperSeconds,
    }
  }, [workItems, categoryById])
  // Same-project nodes that may become a new parent: never the item itself,
  // its descendants, or a depth-3 node (all rejected by the backend anyway).
  const availableParents = selectMoveCandidates(visibleItems, selectedWorkItemId)

  // BlockerAck: starting focus on a blocked item is allowed, but only after an
  // explicit, recorded decision.  "Cancel" walks the user to the upstream.
  const handleLaunchBlocked = (workItem: CachedWorkItem) => {
    setBlockedLaunch(workItem)
  }
  // ★ 「强制继续」必须真的继续：此前只关弹窗（不导航、不记录），而按钮在
  //   blocked 时永远拦截 —— 用户点两次、弹两次，永远开不了会话。
  //   现在：记一条本地 BlockerAck、放行一次（/timer 判定时消费）、去计时页。
  const handleBlockerAckProceed = useCallback(() => {
    const target = blockedLaunch
    if (!target) return
    recordBlockerAck({
      workItemId: target.id,
      blockerIds: selectedBlockers.map((edge) => edge.toWorkItemId),
      source: 'tasks',
    })
    acknowledgeLaunch(target.id)
    setBlockedLaunch(null)
    router.push('/timer')
  }, [blockedLaunch, selectedBlockers, acknowledgeLaunch, router])
  const handleBlockerAckCancel = useCallback(() => {
    const first = selectedBlockers[0]
    setBlockedLaunch(null)
    if (!first) return
    if (selectedWorkItemId && selectedWorkItemId !== first.toWorkItemId) {
      void dispatchNote(selectedWorkItemId).catch(() => undefined)
    }
    selectWorkItem(first.toWorkItemId)
  }, [selectedBlockers, selectedWorkItemId, dispatchNote, selectWorkItem])

  const submitChild = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!createTarget) return
    try {
      if (createTarget.kind === 'root') {
        await createRoot({ title: childTitle })
      } else {
        await createChild(createTarget.parentId, { title: childTitle })
      }
      setCreateTarget(null)
      setChildTitle('')
    } catch {
      // Keep the dialog open with the typed title; the store surfaced a
      // stable error shown inside the dialog.
    }
  }

  const selectWorkItemAndDispatch = (workItemId: string) => {
    if (selectedWorkItemId && selectedWorkItemId !== workItemId) void dispatchNote(selectedWorkItemId).catch(() => undefined)
    selectWorkItem(workItemId)
  }

  // T3 前端打磨: tasks-page keyboard shortcuts (n = create, e = collapse
  // toggle, s = start focus).  Callbacks stay stable per render via
  // useCallback so the hook's effect does not thrash.
  const handleShortcutCreate = useCallback(() => {
    setCreateTarget(selectedWorkItemId ? { kind: 'child', parentId: selectedWorkItemId } : { kind: 'root' })
  }, [selectedWorkItemId])
  const handleShortcutCollapse = useCallback(() => {
    setCollapseSignal((current) => ({
      seq: current.seq + 1,
      mode: current.mode === 'collapse' ? 'expand' : 'collapse',
    }))
  }, [])
  const handleShortcutFocus = useCallback(() => {
    document.querySelector<HTMLButtonElement>('[data-launch-session]')?.click()
  }, [])
  useTaskSpaceShortcuts({
    onCreateWorkItem: handleShortcutCreate,
    onToggleCollapse: handleShortcutCollapse,
    onStartFocus: handleShortcutFocus,
  })

  const handleTreeMove = useCallback((workItemId: string, newParentId: string | null) => {
    void moveWorkItem(workItemId, newParentId).catch(() => undefined)
  }, [moveWorkItem])

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      {error ? <p role="alert" className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="grid min-h-[calc(100vh-7rem)] min-w-0 flex-1 grid-cols-1 md:grid-cols-[180px_280px_minmax(0,1fr)]">
        <ProjectRail
          projects={projects}
          selectedId={selectedProjectId}
          onSelect={selectProject}
          onCreate={createProject}
        />
        <section className="min-w-0 border-y md:border-y-0 md:border-x" aria-label="Work item tree">
          <div className="flex items-center justify-between border-b px-3 py-3">
            <h2 className="text-sm font-semibold">Work items</h2>
            {isLoading ? <span className="text-xs text-muted-foreground">Loading</span> : null}
          </div>
          {selectedProjectId ? (
            <>
              <div className="grid gap-2 border-b px-3 py-2">
                <Input
                  aria-label="搜索工作项"
                  placeholder="搜索标题或编号…"
                  value={treeFilter.query}
                  onChange={(event) => setTreeFilter((current) => ({ ...current, query: event.target.value }))}
                  className="h-8"
                />
                <div className="flex items-center gap-2">
                  <select
                    aria-label="按状态筛选"
                    className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none"
                    value={treeFilter.status}
                    onChange={(event) => setTreeFilter((current) => ({
                      ...current,
                      status: event.target.value as WorkItemTreeFilter['status'],
                    }))}
                  >
                    <option value="all">全部状态</option>
                    <option value="open">未完成</option>
                    <option value="completed">已完成</option>
                  </select>
                  <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      aria-label="只看被阻塞"
                      checked={treeFilter.blockedOnly}
                      onChange={(event) => setTreeFilter((current) => ({
                        ...current,
                        blockedOnly: event.target.checked,
                      }))}
                    />
                    只看被阻塞
                  </label>
                </div>
                {treeFilterActive ? (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span data-filter-count>命中 {visibleItems.length} 项（含父级路径）</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTreeFilter(EMPTY_TREE_FILTER)}
                    >
                      清除筛选
                    </Button>
                  </div>
                ) : null}
              </div>
              {treeFilterActive && visibleItems.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  没有匹配的工作项 —— 调整关键字或清除筛选。
                </p>
              ) : (
                <WorkItemTree
                  items={visibleItems}
                  selectedId={selectedWorkItemId}
                  onSelect={selectWorkItemAndDispatch}
                  onCreateChild={(parentId) => setCreateTarget({ kind: 'child', parentId })}
                  onCreateRoot={() => setCreateTarget({ kind: 'root' })}
                  definitions={definitions}
                  isLoading={isLoading}
                  error={error}
                  pendingMutations={pendingMutations}
                  blockedSignals={blockedSignals}
                  onMove={handleTreeMove}
                  collapseSignal={collapseSignal}
                  filterActive={treeFilterActive}
                  openChildCountById={openChildCountById}
                  codeById={hierarchyCodes}
                />
              )}
            </>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Select a project</p>
          )}
        </section>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-sm font-semibold">Work item</h2>
            <LaunchSessionButton
              workItem={selectedWorkItem}
              blocked={selectedIsBlocked}
              onBlocked={handleLaunchBlocked}
            />
          </div>
          <WorkItemDetail
            workItem={selectedWorkItem}
            definitions={definitions}
            pendingMutations={pendingMutations}
            mutationError={mutationError}
            error={error}
            availableParents={availableParents}
            onUpdate={(input) => updateWorkItem(selectedWorkItemId ?? '', input)}
            onTransition={(statusDefinitionId) => handleTransition(statusDefinitionId)}
            onMove={(parentId) => moveWorkItem(selectedWorkItemId ?? '', parentId)}
            onTrash={() => trashWorkItem(selectedWorkItemId ?? '')}
            onRestore={() => restoreWorkItem(selectedWorkItemId ?? '')}
            onToggleLabel={(labelId, add) => toggleWorkItemLabel(selectedWorkItemId ?? '', labelId, add)}
            openChildCount={selectedWorkItem ? (openChildCountById[selectedWorkItem.id] ?? 0) : null}
            statusHint={selectedWorkItem && waitingResumeSuggestion ? (
              <WaitingResumeHint
                upstreamCount={waitingResumeSuggestion.upstreamCount}
                // 只有「服务端前态命中」且「目标可用」才给一键恢复；否则
                // target 为 null，组件退化为纯说明 —— 让用户显式选择。
                target={waitingResume.target}
                unresolvedReason={waitingResume.unresolvedReason}
                pending={pendingMutations[selectedWorkItem.id] === true}
                archived={selectedWorkItem.archivedAt !== null}
                onResume={waitingResumeTargetId
                  ? () => void handleTransition(waitingResumeTargetId)
                  : undefined}
              />
            ) : null}
            relationsCard={selectedWorkItem ? (
              <WorkItemRelationsCard
                workItem={selectedWorkItem}
                relations={relations.filter((edge) => (
                  edge.fromWorkItemId === selectedWorkItem.id
                  || edge.toWorkItemId === selectedWorkItem.id
                ))}
                nameById={workItemNameById}
                codeById={hierarchyCodes}
                resolveItem={resolveItem}
                candidates={candidateItems}
                crossProjectCandidates={crossProjectCandidateItems}
                allRelations={relations}
                currentProjectId={selectedWorkItem.projectId}
                onSelectNode={(workItemId) => selectWorkItemAndDispatch(workItemId)}
                definitions={definitions ?? null}
                pending={selectedWorkItem ? pendingMutations[selectedWorkItem.id] === true : false}
                onAdd={(input) => handleAddRelation(input).catch(() => undefined)}
                onRemove={(input) => handleRemoveRelation(input).catch(() => undefined)}
                onResolve={(edge) => handleResolveRelation(edge).catch(() => undefined)}
              />
            ) : undefined}
            noteEditor={selectedNote ? (
              <WorkItemNoteEditor
                document={selectedNote.document}
                onChange={updateNoteDocument}
                conflict={noteConflict}
                onReloadRemote={() => resolveReloadRemoteNote(selectedWorkItemId ?? selectedNote.workItemId).catch(() => undefined)}
                onOverwriteLocal={() => resolveOverwriteLocalNote(selectedWorkItemId ?? selectedNote.workItemId).catch(() => undefined)}
                saveLabel={selectedNote.syncState === 'conflict' ? 'Conflict requires review' : selectedNote.syncState === 'dirty' ? 'Local edit pending' : 'Saved'}
                onFlush={(reason) => flushNote(reason).catch(() => undefined)}
              />
            ) : undefined}
          />
        </div>
      </div>
      {blockedLaunch ? (
        <BlockerAckModal
          open
          workItem={blockedLaunch}
          blockers={selectedBlockers
            .map((edge) => workItems.find((item) => item.id === edge.toWorkItemId))
            .filter((item): item is CachedWorkItem => item !== undefined)}
          onProceed={handleBlockerAckProceed}
          onCancel={handleBlockerAckCancel}
        />
      ) : null}
      {conflict && blockedParent ? (
        <ActiveChildConflictDialog
          open
          parentItem={blockedParent}
          conflictChildIds={conflict.childIds}
          conflictChildren={workItems.filter((item) => conflict.childIds.includes(item.id))}
          availableLevel2Parents={relocationTargets}
          busy={resolvingConflict}
          cancelChildrenUnavailableReason={cancelChildrenUnavailableReason}
          moveChildrenUnavailableReason={moveChildrenUnavailableReason}
          onClose={closeConflict}
          onCancelChildrenAndComplete={cancelChildrenAndComplete}
          onMoveChildrenAndComplete={moveChildrenAndComplete}
          onKeepActive={closeConflict}
        />
      ) : null}
      <Dialog
        open={createTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateTarget(null)
            setChildTitle('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create work item</DialogTitle>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={submitChild}>
            <div className="grid gap-2">
              <Label htmlFor="child-title">Title</Label>
              <Input id="child-title" value={childTitle} onChange={(event) => setChildTitle(event.target.value)} required />
            </div>
            {createTarget !== null && mutationError?.targetId === (createTarget.kind === 'root' ? '__root__' : createTarget.parentId) && error
              ? <p role="alert" className="text-sm text-destructive">{error}</p>
              : null}
            <DialogFooter>
              <Button
                type="submit"
                disabled={createTarget !== null && pendingMutations[createTarget.kind === 'root' ? '__root__' : createTarget.parentId] === true}
              >
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
