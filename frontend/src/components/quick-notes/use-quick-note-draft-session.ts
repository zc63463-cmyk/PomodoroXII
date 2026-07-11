'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  QUICK_NOTE_NEW_DRAFT_VERSION_V2,
  createDexieQuickNoteDraftAdapter,
  type QuickNoteDraftRowOwner,
  type QuickNoteDraftStorageAdapter,
  type QuickNoteNewDraftSnapshotV2,
} from '@/lib/quick-notes/quick-note-draft-repository'
import { spaceDBManager } from '@/services/space-db'
import type { QuickNote } from '@/types'

export type QuickNoteDraftSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'restored'
  | 'failed'

export type QuickNoteDraftIssueCode =
  | 'read-failed'
  | 'invalid-record-cleanup-failed'
  | 'migration-save-failed'
  | 'save-failed'
  | 'discard-failed'
  | 'record-failed'
  | 'projection-failed'
  | 'switch-flush-timeout'

export interface QuickNoteDraftIssue {
  code: QuickNoteDraftIssueCode
  retryable: boolean
}

export type QuickNoteDraftRecordResult =
  | {
    kind: 'recorded'
    note: QuickNote
    visibility: 'refreshed' | 'pending'
  }
  | { kind: 'empty' }
  | { kind: 'busy'; operation: 'discard' }
  | { kind: 'failed'; issue: QuickNoteDraftIssue }

export type QuickNoteDraftDiscardResult =
  | { kind: 'discarded' }
  | { kind: 'superseded' }
  | { kind: 'busy'; operation: 'record' }
  | { kind: 'failed'; issue: QuickNoteDraftIssue }

export interface QuickNoteDraftSession {
  readonly draft: string
  readonly saveState: QuickNoteDraftSaveState
  readonly issue: QuickNoteDraftIssue | null
  change(next: string): void
  record(): Promise<QuickNoteDraftRecordResult>
  discard(): Promise<QuickNoteDraftDiscardResult>
}

interface DraftSessionSnapshot {
  draft: string
  saveState: QuickNoteDraftSaveState
  issue: QuickNoteDraftIssue | null
}

/** @internal Test seam; do not re-export from an application barrel. */
export interface QuickNoteDraftSessionController extends QuickNoteDraftSession {
  readonly spaceId: string
  getSnapshot(): DraftSessionSnapshot
  subscribe(listener: () => void): () => void
  drainBeforeSwitch(): Promise<void>
  requestBestEffortFlush(): void
  deactivate(): void
}

type TerminalIntent =
  | { kind: 'record'; promise: Promise<QuickNoteDraftRecordResult> }
  | { kind: 'discard'; promise: Promise<QuickNoteDraftDiscardResult> }

type RecordStorageOutcome =
  | { kind: 'committed'; note: QuickNote }
  | { kind: 'failed'; issue: QuickNoteDraftIssue }

type DiscardStorageOutcome =
  | { kind: 'resolved'; outcome: 'cleared' | 'absent' | 'different-draft' }
  | { kind: 'failed'; issue: QuickNoteDraftIssue }

interface DraftGeneration {
  id: number
  draftId: string | null
  consumed: boolean
  terminal: TerminalIntent | null
}

interface DraftCapture {
  generation: DraftGeneration
  generationId: number
  revision: number
  content: string
  draftId: string | null
  owners: readonly QuickNoteDraftRowOwner[]
  includeRestoredOwner: boolean
}

interface DurableMarker {
  generationId: number
  revision: number
  content: string
}

interface DraftLane {
  tail: Promise<void>
}

interface QuickNoteDraftSessionControllerInput {
  spaceId: string
  adapter: QuickNoteDraftStorageAdapter
  onRecorded: (note: QuickNote) => undefined
  createDraftId?: () => string
  nowIso?: () => string
  debounceMs?: number
  flushTimeoutMs?: number
}

interface ReconcileOptions {
  force?: boolean
  failureCode?: QuickNoteDraftIssueCode
  publishSaving?: boolean
}

type ReconcileOutcome = 'durable' | 'different-draft'

function createIssue(code: QuickNoteDraftIssueCode): QuickNoteDraftIssue {
  return { code, retryable: code !== 'projection-failed' }
}

function ownerKey(owner: QuickNoteDraftRowOwner): string {
  return owner.kind === 'v2'
    ? `v2:${owner.draftId}`
    : `raw:${owner.value}`
}

async function awaitBeforeDeadline(
  promise: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return false

  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), remaining)
      }),
    ])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

export function createQuickNoteDraftSessionController(
  options: QuickNoteDraftSessionControllerInput,
): QuickNoteDraftSessionController {
  const {
    adapter,
    spaceId,
    onRecorded,
    createDraftId = () => crypto.randomUUID(),
    nowIso = () => new Date().toISOString(),
    debounceMs = 500,
    flushTimeoutMs = 3_000,
  } = options
  const lane: DraftLane = { tail: Promise.resolve() }
  const listeners = new Set<() => void>()
  const progressWaiters = new Set<() => void>()
  const frontier = new Map<string, QuickNoteDraftRowOwner>()
  let resolveRestoreReady: () => void = () => undefined
  const restoreReady = new Promise<void>((resolve) => {
    resolveRestoreReady = resolve
  })
  let active = true
  let nextGenerationId = 0
  let revision = 0
  let durable: DurableMarker | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let restoreSettled = false
  let terminalQueuedBeforeRestore = false
  let restoredOwner: QuickNoteDraftRowOwner | null = null
  let snapshot: DraftSessionSnapshot = {
    draft: '',
    saveState: 'idle',
    issue: null,
  }

  function newGeneration(): DraftGeneration {
    nextGenerationId += 1
    return {
      id: nextGenerationId,
      draftId: null,
      consumed: false,
      terminal: null,
    }
  }

  let generation = newGeneration()

  function signalProgress(): void {
    const waiters = [...progressWaiters]
    progressWaiters.clear()
    waiters.forEach((resolve) => resolve())
  }

  async function awaitProgressBeforeDeadline(deadline: number): Promise<boolean> {
    let resolveProgress!: () => void
    const progress = new Promise<void>((resolve) => {
      resolveProgress = resolve
      progressWaiters.add(resolve)
    })
    try {
      return await awaitBeforeDeadline(progress, deadline)
    } finally {
      progressWaiters.delete(resolveProgress)
    }
  }

  function publish(patch: Partial<DraftSessionSnapshot>): void {
    if (!active) return
    snapshot = { ...snapshot, ...patch }
    signalProgress()
    listeners.forEach((listener) => listener())
  }

  function append<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.tail.then(work)
    lane.tail = result.then(
      () => undefined,
      () => undefined,
    )
    signalProgress()
    return result
  }

  function addOwner(owner: QuickNoteDraftRowOwner): void {
    frontier.set(ownerKey(owner), owner)
  }

  function retireOwners(owners: readonly QuickNoteDraftRowOwner[]): void {
    owners.forEach((owner) => frontier.delete(ownerKey(owner)))
  }

  function ownersForCapture(
    capture: DraftCapture,
  ): readonly QuickNoteDraftRowOwner[] {
    const merged = new Map<string, QuickNoteDraftRowOwner>()
    capture.owners.forEach((owner) => {
      const key = ownerKey(owner)
      if (frontier.has(key)) merged.set(key, owner)
    })
    if (
      capture.includeRestoredOwner
      && restoredOwner !== null
      && frontier.has(ownerKey(restoredOwner))
    ) {
      merged.set(ownerKey(restoredOwner), restoredOwner)
    }
    return [...merged.values()]
  }

  function captureCurrent(): DraftCapture {
    return {
      generation,
      generationId: generation.id,
      revision,
      content: snapshot.draft,
      draftId: generation.draftId,
      owners: [...frontier.values()],
      includeRestoredOwner: terminalQueuedBeforeRestore && !restoreSettled,
    }
  }

  function sameCapture(left: DraftCapture, right: DraftCapture): boolean {
    return left.generation === right.generation
      && left.generationId === right.generationId
      && left.revision === right.revision
      && left.content === right.content
      && left.draftId === right.draftId
  }

  function isCurrent(capture: DraftCapture): boolean {
    return isSameRevision(capture) && snapshot.draft === capture.content
  }

  function isSameRevision(capture: DraftCapture): boolean {
    return active
      && generation === capture.generation
      && generation.id === capture.generationId
      && revision === capture.revision
  }

  function markDurable(capture: DraftCapture): void {
    durable = {
      generationId: capture.generationId,
      revision: capture.revision,
      content: capture.content,
    }
  }

  function isDurable(capture: DraftCapture): boolean {
    return durable?.generationId === capture.generationId
      && durable.revision === capture.revision
      && durable.content === capture.content
  }

  function makeV2(capture: DraftCapture): QuickNoteNewDraftSnapshotV2 {
    if (!capture.draftId) {
      throw new Error('Non-blank QuickNote drafts require a draftId')
    }
    return {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: capture.draftId,
      content: capture.content,
      updatedAt: nowIso(),
    }
  }

  function reconcile(
    capture: DraftCapture,
    {
      force = false,
      failureCode = 'save-failed',
      publishSaving = true,
    }: ReconcileOptions = {},
  ): Promise<ReconcileOutcome> {
    if (!force && isDurable(capture)) return Promise.resolve('durable')
    if (isCurrent(capture) && publishSaving) {
      publish({ saveState: 'saving', issue: null })
    }

    return append(async () => {
      const owners = ownersForCapture(capture)
      if (!force && isDurable(capture)) return 'durable'
      try {
        if (capture.content.trim()) {
          const persisted = makeV2(capture)
          await adapter.save(persisted)
          retireOwners(owners)
          addOwner({ kind: 'v2', draftId: persisted.draftId })
          markDurable(capture)
          if (isCurrent(capture)) {
            publish({ saveState: 'saved', issue: null })
          }
          return 'durable'
        }

        const outcome = await adapter.clearIfOwned(owners)
        retireOwners(owners)
        if (outcome === 'different-draft') {
          if (isCurrent(capture)) {
            publish({ saveState: 'idle', issue: null })
          }
          return 'different-draft'
        }

        markDurable(capture)
        if (isCurrent(capture)) {
          publish({ saveState: 'idle', issue: null })
        }
        return 'durable'
      } catch {
        const mappedIssue = createIssue(failureCode)
        if (isCurrent(capture)) {
          publish({ saveState: 'failed', issue: mappedIssue })
        }
        throw mappedIssue
      }
    })
  }

  function cancelTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function publishSwitchFlushTimeout(): void {
    if (!active) return
    publish({
      saveState: 'failed',
      issue: createIssue('switch-flush-timeout'),
    })
  }

  async function drainBeforeSwitch(): Promise<void> {
    if (!active) return
    cancelTimer()
    const deadline = Date.now() + flushTimeoutMs

    if (!await awaitBeforeDeadline(restoreReady, deadline)) {
      publishSwitchFlushTimeout()
      return
    }

    while (active) {
      const before = captureCurrent()
      const capturedTail = lane.tail
      if (!await awaitBeforeDeadline(capturedTail, deadline)) {
        publishSwitchFlushTimeout()
        return
      }
      if (!active) return

      const after = captureCurrent()
      if (!sameCapture(before, after) || lane.tail !== capturedTail) continue
      if (isDurable(after)) return

      let reconcileFailed = false
      let reconcileOutcome: ReconcileOutcome | null = null
      const forcedReconcile = reconcile(after, { force: true }).then(
        (outcome) => {
          reconcileOutcome = outcome
        },
        () => {
          reconcileFailed = true
        },
      )
      const forcedTail = lane.tail
      if (!await awaitBeforeDeadline(forcedReconcile, deadline)) {
        publishSwitchFlushTimeout()
        return
      }
      if (!active) return
      const captureRemainsExact = sameCapture(after, captureCurrent())
      const tailRemainsExact = lane.tail === forcedTail
      if (reconcileFailed && captureRemainsExact && tailRemainsExact) return
      if (
        reconcileOutcome === 'different-draft'
        && captureRemainsExact
        && tailRemainsExact
      ) {
        if (!await awaitProgressBeforeDeadline(deadline)) {
          publishSwitchFlushTimeout()
          return
        }
      }
    }
  }

  function requestBestEffortFlush(): void {
    if (!active) return
    cancelTimer()
    if (generation.terminal !== null || generation.consumed) return
    const capture = captureCurrent()
    if (isDurable(capture)) return
    void reconcile(capture, { force: true }).catch(() => undefined)
  }

  function change(next: string): void {
    if (!active) return
    cancelTimer()
    if (
      generation.consumed
      || generation.terminal !== null
      || (!next.trim() && generation.draftId !== null)
    ) {
      generation = newGeneration()
    }

    revision += 1
    if (next.trim() && generation.draftId === null) {
      generation.draftId = createDraftId()
      addOwner({ kind: 'v2', draftId: generation.draftId })
    }
    publish({
      draft: next,
      saveState: next.trim() ? 'dirty' : 'idle',
      issue: null,
    })

    if (!next.trim()) {
      void reconcile(captureCurrent(), { force: true }).catch(() => undefined)
      return
    }

    timer = setTimeout(() => {
      timer = null
      void reconcile(captureCurrent()).catch(() => undefined)
    }, debounceMs)
  }

  function record(): Promise<QuickNoteDraftRecordResult> {
    const ownedGeneration = generation
    if (ownedGeneration.terminal?.kind === 'record') {
      return ownedGeneration.terminal.promise
    }
    if (ownedGeneration.terminal?.kind === 'discard') {
      return Promise.resolve({ kind: 'busy', operation: 'discard' })
    }
    if (!active) {
      return Promise.resolve({ kind: 'empty' })
    }
    if (!snapshot.draft.trim()) {
      return Promise.resolve({ kind: 'empty' })
    }

    cancelTimer()
    if (ownedGeneration.draftId === null) {
      ownedGeneration.draftId = createDraftId()
      addOwner({ kind: 'v2', draftId: ownedGeneration.draftId })
    }
    if (!restoreSettled) terminalQueuedBeforeRestore = true
    const capture = captureCurrent()
    const submitted = makeV2(capture)
    const submittedOwner: QuickNoteDraftRowOwner = {
      kind: 'v2',
      draftId: submitted.draftId,
    }
    const storage = append(async (): Promise<RecordStorageOutcome> => {
      await restoreReady
      const owners = ownersForCapture(capture)
      try {
        await adapter.save(submitted)
      } catch {
        return { kind: 'failed', issue: createIssue('save-failed') }
      }

      retireOwners(owners)
      addOwner(submittedOwner)
      markDurable(capture)

      try {
        const note = await adapter.record(submitted)
        retireOwners([...owners, submittedOwner])
        return { kind: 'committed', note }
      } catch {
        return { kind: 'failed', issue: createIssue('record-failed') }
      }
    })

    // The continuation compares against the exact Promise attached below.
    let operation!: Promise<QuickNoteDraftRecordResult>
    // eslint-disable-next-line prefer-const
    operation = storage.then((outcome): QuickNoteDraftRecordResult => {
      if (outcome.kind === 'failed') {
        if (generation === ownedGeneration && isCurrent(capture)) {
          publish({ saveState: 'failed', issue: outcome.issue })
        }
        if (
          ownedGeneration.terminal?.kind === 'record'
          && ownedGeneration.terminal.promise === operation
        ) {
          ownedGeneration.terminal = null
        }
        return outcome
      }

      ownedGeneration.consumed = true
      if (generation === ownedGeneration && isCurrent(capture)) {
        publish({ draft: '', saveState: 'idle', issue: null })
      }
      if (!active) {
        return { kind: 'recorded', note: outcome.note, visibility: 'pending' }
      }

      try {
        onRecorded(outcome.note)
        return { kind: 'recorded', note: outcome.note, visibility: 'refreshed' }
      } catch {
        if (generation === ownedGeneration && isSameRevision(capture)) {
          publish({ saveState: 'failed', issue: createIssue('projection-failed') })
        }
        return { kind: 'recorded', note: outcome.note, visibility: 'pending' }
      }
    })
    ownedGeneration.terminal = { kind: 'record', promise: operation }
    return operation
  }

  function discard(): Promise<QuickNoteDraftDiscardResult> {
    const ownedGeneration = generation
    if (ownedGeneration.terminal?.kind === 'discard') {
      return ownedGeneration.terminal.promise
    }
    if (ownedGeneration.terminal?.kind === 'record') {
      return Promise.resolve({ kind: 'busy', operation: 'record' })
    }
    if (!active) {
      return Promise.resolve({ kind: 'discarded' })
    }

    cancelTimer()
    if (!restoreSettled) terminalQueuedBeforeRestore = true
    const capture = captureCurrent()
    const storage = append(async (): Promise<DiscardStorageOutcome> => {
      await restoreReady
      const owners = ownersForCapture(capture)
      try {
        const outcome = await adapter.clearIfOwned(owners)
        retireOwners(owners)
        return { kind: 'resolved', outcome }
      } catch {
        return { kind: 'failed', issue: createIssue('discard-failed') }
      }
    })

    // The continuation compares against the exact Promise attached below.
    let operation!: Promise<QuickNoteDraftDiscardResult>
    // eslint-disable-next-line prefer-const
    operation = storage.then((outcome): QuickNoteDraftDiscardResult => {
      if (outcome.kind === 'failed') {
        if (generation === ownedGeneration && isCurrent(capture)) {
          publish({ saveState: 'failed', issue: outcome.issue })
        }
        if (
          ownedGeneration.terminal?.kind === 'discard'
          && ownedGeneration.terminal.promise === operation
        ) {
          ownedGeneration.terminal = null
        }
        return outcome
      }

      if (outcome.outcome === 'different-draft' || generation !== ownedGeneration) {
        return { kind: 'superseded' }
      }

      ownedGeneration.consumed = true
      if (isCurrent(capture)) {
        publish({ draft: '', saveState: 'idle', issue: null })
      }
      return { kind: 'discarded' }
    })
    ownedGeneration.terminal = { kind: 'discard', promise: operation }
    return operation
  }

  async function restore(): Promise<void> {
    const initialGeneration = generation
    const initialGenerationId = generation.id
    const initialRevision = revision

    try {
      let loaded
      try {
        loaded = await adapter.load()
      } catch {
        if (
          !terminalQueuedBeforeRestore
          && active
          && generation === initialGeneration
          && generation.id === initialGenerationId
          && revision === initialRevision
        ) {
          publish({ saveState: 'failed', issue: createIssue('read-failed') })
        }
        return
      }

      if (
        loaded.kind !== 'absent'
        && (active || terminalQueuedBeforeRestore)
      ) {
        restoredOwner = loaded.owner
        addOwner(loaded.owner)
      }
      if (terminalQueuedBeforeRestore) return
      if (!active) return
      const canDisplay = generation === initialGeneration
        && generation.id === initialGenerationId
        && revision === initialRevision
        && !snapshot.draft.trim()

      if (loaded.kind === 'absent') {
        if (canDisplay) markDurable(captureCurrent())
        return
      }

      if (loaded.kind === 'invalid') {
        const cleanupCapture = captureCurrent()
        const cleanup = append(async () => {
          try {
            const outcome = await adapter.clearIfOwned([loaded.owner])
            retireOwners([loaded.owner])
            if (
              (outcome === 'cleared' || outcome === 'absent')
              && isCurrent(cleanupCapture)
              && !cleanupCapture.content.trim()
            ) {
              markDurable(cleanupCapture)
            }
          } catch {
            const mappedIssue = createIssue('invalid-record-cleanup-failed')
            if (isCurrent(cleanupCapture)) {
              publish({ saveState: 'failed', issue: mappedIssue })
            }
            throw mappedIssue
          }
        })
        void cleanup.catch(() => undefined)
        return
      }

      if (!canDisplay) {
        void reconcile(captureCurrent(), { force: true }).catch(() => undefined)
        return
      }

      if (loaded.snapshot.version === QUICK_NOTE_NEW_DRAFT_VERSION_V2) {
        generation.draftId = loaded.snapshot.draftId
        publish({
          draft: loaded.snapshot.content,
          saveState: 'restored',
          issue: null,
        })
        markDurable(captureCurrent())
        return
      }

      generation.draftId = createDraftId()
      addOwner({ kind: 'v2', draftId: generation.draftId })
      publish({
        draft: loaded.snapshot.content,
        saveState: 'restored',
        issue: null,
      })
      void reconcile(captureCurrent(), {
        force: true,
        failureCode: 'migration-save-failed',
        publishSaving: false,
      }).catch(() => undefined)
    } finally {
      if (!restoreSettled) {
        restoreSettled = true
        resolveRestoreReady()
      }
    }
  }

  const controller: QuickNoteDraftSessionController = {
    spaceId,
    get draft() {
      return snapshot.draft
    },
    get saveState() {
      return snapshot.saveState
    },
    get issue() {
      return snapshot.issue
    },
    change,
    record,
    discard,
    drainBeforeSwitch,
    requestBestEffortFlush,
    getSnapshot() {
      return snapshot
    },
    subscribe(listener: () => void): () => void {
      if (!active) return () => undefined
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    deactivate() {
      if (!active) return
      active = false
      cancelTimer()
      signalProgress()
      listeners.clear()
    },
  }

  void restore().catch(() => undefined)
  return controller
}

const EMPTY_SNAPSHOT: DraftSessionSnapshot = {
  draft: '',
  saveState: 'idle',
  issue: null,
}

export function useQuickNoteDraftSession(input: {
  onRecorded: (note: QuickNote) => undefined
}): QuickNoteDraftSession {
  const latestOnRecorded = useRef(input.onRecorded)
  latestOnRecorded.current = input.onRecorded
  const controllerRef = useRef<QuickNoteDraftSessionController | null>(null)
  const unsubscribeControllerRef = useRef<(() => void) | null>(null)
  const [snapshot, setSnapshot] = useState<DraftSessionSnapshot>(EMPTY_SNAPSHOT)

  useEffect(() => {
    let mounted = true

    const install = (spaceId: string): void => {
      unsubscribeControllerRef.current?.()
      unsubscribeControllerRef.current = null
      controllerRef.current?.deactivate()

      const controller = createQuickNoteDraftSessionController({
        spaceId,
        adapter: createDexieQuickNoteDraftAdapter(spaceDBManager.current),
        onRecorded: (note) => {
          latestOnRecorded.current(note)
          return undefined
        },
      })
      controllerRef.current = controller
      unsubscribeControllerRef.current = controller.subscribe(() => {
        if (!mounted || controllerRef.current !== controller) return
        setSnapshot(controller.getSnapshot())
      })
      if (mounted && controllerRef.current === controller) {
        setSnapshot(controller.getSnapshot())
      }
    }

    const unregisterBeforeSwitch = spaceDBManager.onBeforeSwitch(({ fromSpaceId }) => {
      const controller = controllerRef.current
      if (!controller || controller.spaceId !== fromSpaceId) return
      return controller.drainBeforeSwitch()
    })
    const unregisterSwitch = spaceDBManager.onSwitch(install)
    if (spaceDBManager.currentSpaceId !== null) {
      install(spaceDBManager.currentSpaceId)
    }

    const handlePageHide = (): void => {
      controllerRef.current?.requestBestEffortFlush()
    }
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      mounted = false
      unregisterBeforeSwitch()
      unregisterSwitch()
      window.removeEventListener('pagehide', handlePageHide)
      const controller = controllerRef.current
      controller?.requestBestEffortFlush()
      controller?.deactivate()
      unsubscribeControllerRef.current?.()
      unsubscribeControllerRef.current = null
      controllerRef.current = null
    }
  }, [])

  const change = useCallback((next: string): void => {
    controllerRef.current?.change(next)
  }, [])
  const record = useCallback((): Promise<QuickNoteDraftRecordResult> => {
    return controllerRef.current?.record() ?? Promise.resolve({ kind: 'empty' })
  }, [])
  const discard = useCallback((): Promise<QuickNoteDraftDiscardResult> => {
    return controllerRef.current?.discard() ?? Promise.resolve({ kind: 'discarded' })
  }, [])

  return {
    ...snapshot,
    change,
    record,
    discard,
  }
}
