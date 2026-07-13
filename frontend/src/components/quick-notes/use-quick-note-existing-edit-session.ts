'use client'

import type { QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import type { QuickNoteLifecycleState } from '@/lib/quick-notes/quick-note-repository'
import {
  type ExistingEditLoadResult,
  type ExistingEditRowOwner,
  type QuickNoteExistingEditSnapshotV1,
  type QuickNoteExistingEditStorageAdapter,
} from '@/lib/quick-notes/quick-note-existing-edit-repository'
import type { QuickNote } from '@/types'

export type ExistingEditPhase =
  | 'idle'
  | 'restoring'
  | 'saved'
  | 'dirty'
  | 'checkpointing'
  | 'saving'
  | 'conflict'
  | 'failed'
  | 'target-unavailable'

export type ExistingEditDurability =
  | 'unknown'
  | 'memory-only'
  | 'recovery-durable'
  | 'entity-durable'

export interface QuickNoteExistingEditIssue {
  code:
    | 'recovery-read-failed'
    | 'invalid-recovery-cleanup-failed'
    | 'checkpoint-failed'
    | 'entity-save-failed'
    | 'recovery-cleanup-failed'
    | 'projection-failed'
    | 'switch-flush-timeout'
  retryable: boolean
  durability: ExistingEditDurability
}

export interface QuickNoteExistingEditState {
  phase: ExistingEditPhase
  durability: ExistingEditDurability
  editingNote: QuickNote | null
  draft: string
  conflict: QuickNoteDraftConflict | null
  issue: QuickNoteExistingEditIssue | null
}

export type QuickNoteExistingEditSaveResult =
  | { kind: 'saved'; note: QuickNote; visibility: 'refreshed' | 'pending' }
  | { kind: 'empty' }
  | { kind: 'conflict'; conflict: QuickNoteDraftConflict }
  | { kind: 'unavailable'; lifecycle: QuickNoteLifecycleState | 'missing' }
  | { kind: 'busy'; operation: 'cancel' | 'save' }
  | { kind: 'failed'; issue: QuickNoteExistingEditIssue }

export type QuickNoteExistingEditCancelResult =
  | { kind: 'cancelled' }
  | { kind: 'busy'; operation: 'save' }
  | { kind: 'failed'; issue: QuickNoteExistingEditIssue }

export type QuickNoteExistingEditConflictResult =
  | { kind: 'resolved'; strategy: 'keep-local' | 'use-remote' | 'merge' }
  | { kind: 'conflict'; conflict: QuickNoteDraftConflict }
  | { kind: 'unavailable'; lifecycle: QuickNoteLifecycleState | 'missing' }
  | { kind: 'failed'; issue: QuickNoteExistingEditIssue }

export interface QuickNoteExistingEditSession {
  readonly state: QuickNoteExistingEditState
  start(note: QuickNote): void
  change(content: string): void
  save(options?: {
    closeAfterSave?: boolean
  }): Promise<QuickNoteExistingEditSaveResult>
  cancel(): Promise<QuickNoteExistingEditCancelResult>
  resolveConflict(
    strategy: 'keep-local' | 'use-remote' | 'merge',
  ): Promise<QuickNoteExistingEditConflictResult>
}

interface ExistingEditProjection {
  quickNotes: readonly QuickNote[]
  trashedQuickNotes: readonly QuickNote[]
  lifecycleStateById: Readonly<Record<string, QuickNoteLifecycleState>>
}

/** @internal Deterministic controller seam; React installation is added later. */
export interface QuickNoteExistingEditSessionController {
  readonly spaceId: string
  readonly state: QuickNoteExistingEditState
  start(note: QuickNote): void
  change(content: string): void
  save(options?: {
    closeAfterSave?: boolean
  }): Promise<QuickNoteExistingEditSaveResult>
  cancel(): Promise<QuickNoteExistingEditCancelResult>
  resolveConflict(
    strategy: 'keep-local' | 'use-remote' | 'merge',
  ): Promise<QuickNoteExistingEditConflictResult>
  getSnapshot(): QuickNoteExistingEditState
  subscribe(listener: () => void): () => void
  observeProjection(input: ExistingEditProjection): void
  drainBeforeSwitch(): Promise<void>
  requestBestEffortCheckpoint(): void
  deactivate(): void
}

interface QuickNoteExistingEditSessionControllerInput {
  spaceId: string
  adapter: QuickNoteExistingEditStorageAdapter
  onSaved: (note: QuickNote) => undefined
  createEditId?: () => string
  nowIso?: () => string
  checkpointMs?: number
  autosaveMs?: number
  flushTimeoutMs?: number
}

interface ExistingEditIdentity {
  editId: string
  revision: number
  noteId: string
  baseContent: string
  baseUpdatedAt: string
  baseGeneration: number
}

interface ExistingEditLane {
  tail: Promise<void>
}

interface ExistingEditCheckpointCapture {
  epoch: number
  editId: string
  revision: number
  content: string
}

interface ExistingEditSaveLaneCapture extends ExistingEditCheckpointCapture {
  noteId: string
  baseContent: string
  baseUpdatedAt: string
  baseGeneration: number
  owners: readonly ExistingEditRowOwner[]
}

interface ExistingEditSaveAttempt {
  capture: ExistingEditSaveLaneCapture
  closeAfterSave: boolean
}

interface ExistingEditSaveFlight extends ExistingEditSaveAttempt {
  promise: Promise<QuickNoteExistingEditSaveResult>
}

interface CleanupPendingReceipt {
  editId: string
  revision: number
  content: string
  owners: readonly ExistingEditRowOwner[]
  note: QuickNote
  closeAfterCleanup: boolean
  visibility: 'refreshed' | 'pending'
  cleanupPending: boolean
}

interface ExistingEditCancelFlight {
  kind: 'cancel'
  promise: Promise<QuickNoteExistingEditCancelResult>
}

interface ExistingEditCancelAttempt {
  capture: ExistingEditCheckpointCapture
  owners: readonly ExistingEditRowOwner[]
}

interface ExistingEditConflictFlight {
  kind: 'resolve-conflict'
  strategy: 'keep-local' | 'use-remote' | 'merge'
  promise: Promise<QuickNoteExistingEditConflictResult>
}

type ExistingEditTerminalFlight =
  | ExistingEditCancelFlight
  | ExistingEditConflictFlight

const RESTORING_STATE: QuickNoteExistingEditState = {
  phase: 'restoring',
  durability: 'unknown',
  editingNote: null,
  draft: '',
  conflict: null,
  issue: null,
}

const IDLE_STATE: QuickNoteExistingEditState = {
  phase: 'idle',
  durability: 'entity-durable',
  editingNote: null,
  draft: '',
  conflict: null,
  issue: null,
}

function createIssue(
  code: QuickNoteExistingEditIssue['code'],
  durability: ExistingEditDurability,
): QuickNoteExistingEditIssue {
  return {
    code,
    retryable: code !== 'projection-failed',
    durability,
  }
}

function normalizeContent(content: string): string {
  return content.trim()
}

function makeIdentity(
  snapshot: QuickNoteExistingEditSnapshotV1,
): ExistingEditIdentity {
  return {
    editId: snapshot.editId,
    revision: snapshot.revision,
    noteId: snapshot.noteId,
    baseContent: snapshot.baseContent,
    baseUpdatedAt: snapshot.baseUpdatedAt,
    baseGeneration: 0,
  }
}

function makeMissingTargetDisplayNote(
  snapshot: QuickNoteExistingEditSnapshotV1,
): QuickNote {
  return {
    id: snapshot.noteId,
    content: snapshot.baseContent,
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    session_id: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: snapshot.baseUpdatedAt,
    updated_at: snapshot.baseUpdatedAt,
  }
}

export function createQuickNoteExistingEditSessionController(
  input: QuickNoteExistingEditSessionControllerInput,
): QuickNoteExistingEditSessionController {
  const {
    adapter,
    spaceId,
    onSaved,
    createEditId = () => crypto.randomUUID(),
    nowIso = () => new Date().toISOString(),
    checkpointMs = 500,
    autosaveMs = 900,
    flushTimeoutMs = 3_000,
  } = input
  const listeners = new Set<() => void>()
  const lane: ExistingEditLane = { tail: Promise.resolve() }
  let resolveInitialRestore!: () => void
  const initialRestoreReady = new Promise<void>((resolve) => {
    resolveInitialRestore = resolve
  })
  let initialRestoreSettled = false
  let active = true
  let epoch = 1
  let restoreGeneration = 0
  let pendingStart: QuickNote | null = null
  let identity: ExistingEditIdentity | null = null
  let blockedRecoveryOwner: ExistingEditRowOwner | null = null
  const recoveryOwners: ExistingEditRowOwner[] = []
  let checkpointTimer: ReturnType<typeof setTimeout> | null = null
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  let saveFlight: ExistingEditSaveFlight | null = null
  const saveFlights = new Set<ExistingEditSaveFlight>()
  let cleanupReceipt: CleanupPendingReceipt | null = null
  let terminalFlight: ExistingEditTerminalFlight | null = null
  let unavailableLifecycle: QuickNoteLifecycleState | 'missing' | null = null
  let snapshot = RESTORING_STATE

  function append<T>(work: () => Promise<T>): Promise<T> {
    const queued = lane.tail.then(work, work)
    lane.tail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  function publish(next: QuickNoteExistingEditState): void {
    if (!active) return
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  function isCurrentRestore(generation: number): boolean {
    return active && restoreGeneration === generation
  }

  function cancelTrailingTimers(): void {
    if (checkpointTimer !== null) clearTimeout(checkpointTimer)
    if (autosaveTimer !== null) clearTimeout(autosaveTimer)
    checkpointTimer = null
    autosaveTimer = null
  }

  function ownerKey(owner: ExistingEditRowOwner): string {
    return owner.kind === 'raw'
      ? `raw:${owner.value}`
      : `v1:${owner.editId}:${owner.revision}`
  }

  function rememberRecoveryOwner(owner: ExistingEditRowOwner): void {
    const key = ownerKey(owner)
    if (!recoveryOwners.some((candidate) => ownerKey(candidate) === key)) {
      recoveryOwners.push(owner)
    }
  }

  function resetRecoveryOwners(
    owner?: ExistingEditRowOwner,
  ): void {
    recoveryOwners.length = 0
    if (owner) rememberRecoveryOwner(owner)
  }

  function mergeOwners(
    ...ownerGroups: ReadonlyArray<readonly ExistingEditRowOwner[]>
  ): ExistingEditRowOwner[] {
    const next: ExistingEditRowOwner[] = []
    ownerGroups.forEach((owners) => {
      owners.forEach((owner) => {
        const key = ownerKey(owner)
        if (!next.some((candidate) => ownerKey(candidate) === key)) {
          next.push(owner)
        }
      })
    })
    return next
  }

  function isCurrentCapture(
    capture: ExistingEditCheckpointCapture,
  ): boolean {
    return (
      active
      && epoch === capture.epoch
      && isLatestAcceptedCapture(capture)
    )
  }

  function isLatestAcceptedCapture(
    capture: ExistingEditCheckpointCapture,
  ): boolean {
    return (
      identity?.editId === capture.editId
      && identity.revision === capture.revision
      && snapshot.draft === capture.content
    )
  }

  function isSameEdit(capture: ExistingEditCheckpointCapture): boolean {
    return identity?.editId === capture.editId
  }

  function hasNewerSameEditRevision(
    capture: ExistingEditCheckpointCapture,
  ): boolean {
    return (
      identity?.editId === capture.editId
      && identity.revision > capture.revision
    )
  }

  function hasNewerDurableRecoveryOwner(
    capture: ExistingEditCheckpointCapture,
  ): boolean {
    return recoveryOwners.some((owner) => (
      owner.kind === 'v1'
      && owner.editId === capture.editId
      && owner.revision > capture.revision
    ))
  }

  function hasCurrentDurableRecoveryOwner(): boolean {
    return identity !== null && recoveryOwners.some((owner) => (
      owner.kind === 'v1'
      && owner.editId === identity?.editId
      && owner.revision === identity.revision
    ))
  }

  function isCurrentReceipt(receipt: CleanupPendingReceipt): boolean {
    return (
      active
      && identity?.editId === receipt.editId
      && identity.revision === receipt.revision
      && snapshot.draft === receipt.content
    )
  }

  function latestDurability(
    capture?: ExistingEditCheckpointCapture,
    captureDurability?: ExistingEditDurability,
  ): ExistingEditDurability {
    if (capture && isLatestAcceptedCapture(capture) && captureDurability) {
      return captureDurability
    }
    return snapshot.durability
  }

  function closeCurrentEdit(): void {
    cancelTrailingTimers()
    identity = null
    blockedRecoveryOwner = null
    cleanupReceipt = null
    unavailableLifecycle = null
    resetRecoveryOwners()
    publish(IDLE_STATE)
  }

  function activate(note: QuickNote): void {
    if (!active) return
    cancelTrailingTimers()
    saveFlight = null
    cleanupReceipt = null
    terminalFlight = null
    unavailableLifecycle = null
    blockedRecoveryOwner = null
    resetRecoveryOwners()
    identity = {
      editId: createEditId(),
      revision: 0,
      noteId: note.id,
      baseContent: note.content,
      baseUpdatedAt: note.updated_at,
      baseGeneration: 0,
    }
    publish({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: note,
      draft: note.content,
      conflict: null,
      issue: null,
    })
  }

  function settleClean(generation: number): void {
    if (!isCurrentRestore(generation)) return
    cancelTrailingTimers()
    saveFlight = null
    cleanupReceipt = null
    terminalFlight = null
    unavailableLifecycle = null
    blockedRecoveryOwner = null
    identity = null
    resetRecoveryOwners()
    const requested = pendingStart
    pendingStart = null
    if (requested) {
      activate(requested)
      return
    }
    publish(IDLE_STATE)
  }

  function restoreOwnedState(
    generation: number,
    loaded: Extract<ExistingEditLoadResult, { kind: 'valid' }>,
    phase: 'dirty' | 'conflict' | 'target-unavailable',
    editingNote: QuickNote,
    conflict: QuickNoteDraftConflict | null,
    lifecycle: QuickNoteLifecycleState | 'missing' | null = null,
  ): void {
    if (!isCurrentRestore(generation)) return
    pendingStart = null
    blockedRecoveryOwner = null
    cleanupReceipt = null
    unavailableLifecycle = lifecycle
    resetRecoveryOwners(loaded.owner)
    identity = { ...makeIdentity(loaded.snapshot), baseGeneration: 0 }
    publish({
      phase,
      durability: 'recovery-durable',
      editingNote,
      draft: loaded.snapshot.draft,
      conflict,
      issue: null,
    })
  }

  function blockInvalidRecovery(
    generation: number,
    owner: ExistingEditRowOwner,
  ): void {
    if (!isCurrentRestore(generation)) return
    pendingStart = null
    identity = null
    cleanupReceipt = null
    unavailableLifecycle = null
    resetRecoveryOwners()
    blockedRecoveryOwner = owner
    publish({
      phase: 'failed',
      durability: 'unknown',
      editingNote: null,
      draft: '',
      conflict: null,
      issue: createIssue('invalid-recovery-cleanup-failed', 'unknown'),
    })
  }

  function blockValidRecovery(
    generation: number,
    loaded: Extract<ExistingEditLoadResult, { kind: 'valid' }>,
  ): void {
    if (!isCurrentRestore(generation)) return
    pendingStart = null
    blockedRecoveryOwner = loaded.owner
    cleanupReceipt = null
    unavailableLifecycle = loaded.lifecycle
    resetRecoveryOwners(loaded.owner)
    identity = { ...makeIdentity(loaded.snapshot), baseGeneration: 0 }
    publish({
      phase: 'failed',
      durability: 'recovery-durable',
      editingNote: loaded.note ?? makeMissingTargetDisplayNote(loaded.snapshot),
      draft: loaded.snapshot.draft,
      conflict: null,
      issue: createIssue('recovery-cleanup-failed', 'recovery-durable'),
    })
  }

  async function clearRecovery(
    owner: ExistingEditRowOwner,
  ): Promise<boolean> {
    try {
      return await append(
        () => adapter.clearIfOwned([owner]),
      ) !== 'different-edit'
    } catch {
      return false
    }
  }

  async function classifyValidRecovery(
    generation: number,
    loaded: Extract<ExistingEditLoadResult, { kind: 'valid' }>,
  ): Promise<void> {
    const { snapshot: recovered } = loaded
    const currentNote = loaded.lifecycle === 'active' ? loaded.note : null

    if (currentNote) {
      const draftEqualsEntity =
        normalizeContent(recovered.draft) === normalizeContent(currentNote.content)
      if (draftEqualsEntity) {
        const cleared = await clearRecovery(loaded.owner)
        if (!isCurrentRestore(generation)) return
        if (cleared) settleClean(generation)
        else blockValidRecovery(generation, loaded)
        return
      }

      const localChanged =
        normalizeContent(recovered.draft) !== normalizeContent(recovered.baseContent)
      const baseChanged =
        currentNote.content !== recovered.baseContent
        || currentNote.updated_at !== recovered.baseUpdatedAt

      if (!baseChanged && localChanged) {
        restoreOwnedState(
          generation,
          loaded,
          'dirty',
          currentNote,
          null,
        )
        return
      }

      if (baseChanged && !localChanged) {
        const cleared = await clearRecovery(loaded.owner)
        if (!isCurrentRestore(generation)) return
        if (cleared) settleClean(generation)
        else blockValidRecovery(generation, loaded)
        return
      }

      if (baseChanged && localChanged) {
        restoreOwnedState(
          generation,
          loaded,
          'conflict',
          currentNote,
          {
            note: currentNote,
            localDraft: recovered.draft,
            remoteContent: currentNote.content,
          },
        )
        return
      }
    }

    const localChanged =
      normalizeContent(recovered.draft) !== normalizeContent(recovered.baseContent)
    if (localChanged) {
      restoreOwnedState(
        generation,
        loaded,
        'target-unavailable',
        loaded.note ?? makeMissingTargetDisplayNote(recovered),
        null,
        loaded.lifecycle,
      )
      return
    }

    const cleared = await clearRecovery(loaded.owner)
    if (!isCurrentRestore(generation)) return
    if (cleared) settleClean(generation)
    else blockValidRecovery(generation, loaded)
  }

  async function classifyRecovery(
    generation: number,
    loaded: ExistingEditLoadResult,
  ): Promise<void> {
    if (!isCurrentRestore(generation)) return
    if (loaded.kind === 'absent') {
      settleClean(generation)
      return
    }

    if (loaded.kind === 'invalid') {
      const cleared = await clearRecovery(loaded.owner)
      if (!isCurrentRestore(generation)) return
      if (cleared) settleClean(generation)
      else blockInvalidRecovery(generation, loaded.owner)
      return
    }

    await classifyValidRecovery(generation, loaded)
  }

  async function restore(generation: number): Promise<void> {
    try {
      let loaded: ExistingEditLoadResult
      try {
        loaded = await append(() => adapter.load())
      } catch {
        if (isCurrentRestore(generation)) {
          pendingStart = null
          blockedRecoveryOwner = null
          identity = null
          cleanupReceipt = null
          unavailableLifecycle = null
          publish({
            phase: 'failed',
            durability: 'unknown',
            editingNote: null,
            draft: '',
            conflict: null,
            issue: createIssue('recovery-read-failed', 'unknown'),
          })
        }
        return
      }

      await classifyRecovery(generation, loaded)
    } finally {
      if (generation === 1 && !initialRestoreSettled) {
        initialRestoreSettled = true
        resolveInitialRestore()
      }
    }
  }

  function beginRestore(): void {
    restoreGeneration += 1
    const generation = restoreGeneration
    void restore(generation).catch(() => undefined)
  }

  function start(note: QuickNote): void {
    if (!active) return
    if (snapshot.phase === 'restoring') {
      pendingStart = note
      return
    }
    if (
      snapshot.phase === 'failed'
      && snapshot.issue?.code === 'recovery-read-failed'
    ) {
      pendingStart = note
      publish(RESTORING_STATE)
      beginRestore()
      return
    }
    if (blockedRecoveryOwner !== null) return
    if (snapshot.phase !== 'idle' && snapshot.phase !== 'saved') return
    activate(note)
  }

  function captureCurrentRevision(): ExistingEditCheckpointCapture | null {
    if (!active || identity === null || identity.revision <= 0) return null
    return {
      epoch,
      editId: identity.editId,
      revision: identity.revision,
      content: snapshot.draft,
    }
  }

  function queueCheckpoint(
    capture: ExistingEditCheckpointCapture,
  ): Promise<void> {
    return append(async () => {
      if (!isCurrentCapture(capture) || identity === null) return
      const baseGeneration = identity.baseGeneration
      const recovery: QuickNoteExistingEditSnapshotV1 = {
        version: 1,
        editId: capture.editId,
        revision: capture.revision,
        noteId: identity.noteId,
        baseContent: identity.baseContent,
        baseUpdatedAt: identity.baseUpdatedAt,
        draft: capture.content,
        updatedAt: nowIso(),
      }
      if (
        snapshot.phase !== 'saving'
        && snapshot.phase !== 'conflict'
        && snapshot.phase !== 'target-unavailable'
      ) {
        publish({
          ...snapshot,
          phase: 'checkpointing',
          durability: 'memory-only',
          issue: null,
        })
      }

      try {
        await adapter.checkpoint(recovery)
      } catch {
        if (
          isCurrentCapture(capture)
          && identity?.baseGeneration === baseGeneration
          && snapshot.phase !== 'saving'
        ) {
          const issue = createIssue('checkpoint-failed', 'memory-only')
          const preserveDomainPhase =
            snapshot.phase === 'conflict'
            || snapshot.phase === 'target-unavailable'
          publish({
            ...snapshot,
            phase: preserveDomainPhase ? snapshot.phase : 'failed',
            durability: 'memory-only',
            issue: preserveDomainPhase ? null : issue,
          })
        }
        return
      }

      resetRecoveryOwners({
        kind: 'v1',
        editId: capture.editId,
        revision: capture.revision,
      })
      if (
        isCurrentCapture(capture)
        && identity?.baseGeneration === baseGeneration
      ) {
        const phase =
          snapshot.phase === 'saving'
          || snapshot.phase === 'conflict'
          || snapshot.phase === 'target-unavailable'
            ? snapshot.phase
            : 'dirty'
        publish({
          ...snapshot,
          phase,
          durability: 'recovery-durable',
          issue: null,
        })
      }
    })
  }

  function observeBackgroundWork(work: Promise<unknown>): void {
    void work.then(
      () => undefined,
      () => undefined,
    )
  }

  function scheduleTrailingWork(
    capture: ExistingEditCheckpointCapture,
  ): void {
    cancelTrailingTimers()
    checkpointTimer = setTimeout(() => {
      checkpointTimer = null
      observeBackgroundWork(queueCheckpoint(capture))
    }, checkpointMs)
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      if (!isCurrentCapture(capture)) return
      observeBackgroundWork(save())
    }, autosaveMs)
  }

  function change(content: string): void {
    if (!active || identity === null) return
    if (
      snapshot.phase !== 'saved'
      && snapshot.phase !== 'dirty'
      && snapshot.phase !== 'checkpointing'
      && snapshot.phase !== 'saving'
      && snapshot.phase !== 'failed'
    ) return
    identity = { ...identity, revision: identity.revision + 1 }
    cleanupReceipt = null
    unavailableLifecycle = null
    const capture: ExistingEditCheckpointCapture = {
      epoch,
      editId: identity.editId,
      revision: identity.revision,
      content,
    }
    scheduleTrailingWork(capture)
    publish({
      ...snapshot,
      phase: 'dirty',
      durability: 'memory-only',
      draft: content,
      conflict: null,
      issue: null,
    })
  }

  async function preserveSuccessorAfterCleanup(
    capture: ExistingEditCheckpointCapture,
  ): Promise<void> {
    resetRecoveryOwners()
    if (!hasNewerSameEditRevision(capture) || identity === null) return

    const successorBaseGeneration = identity.baseGeneration
    const successor: QuickNoteExistingEditSnapshotV1 = {
      version: 1,
      editId: identity.editId,
      revision: identity.revision,
      noteId: identity.noteId,
      baseContent: identity.baseContent,
      baseUpdatedAt: identity.baseUpdatedAt,
      draft: snapshot.draft,
      updatedAt: nowIso(),
    }
    const successorCapture: ExistingEditCheckpointCapture = {
      epoch: capture.epoch,
      editId: successor.editId,
      revision: successor.revision,
      content: successor.draft,
    }
    try {
      await adapter.checkpoint(successor)
      resetRecoveryOwners({
        kind: 'v1',
        editId: successor.editId,
        revision: successor.revision,
      })
      if (
        isCurrentCapture(successorCapture)
        && identity?.baseGeneration === successorBaseGeneration
      ) {
        publish({
          ...snapshot,
          phase: 'dirty',
          durability: 'recovery-durable',
          issue: null,
        })
      }
    } catch {
      if (
        isCurrentCapture(successorCapture)
        && identity?.baseGeneration === successorBaseGeneration
      ) {
        const issue = createIssue('checkpoint-failed', 'memory-only')
        publish({
          ...snapshot,
          phase: 'failed',
          durability: 'memory-only',
          issue,
        })
      }
    }
  }

  async function runSave(
    flight: ExistingEditSaveAttempt,
  ): Promise<QuickNoteExistingEditSaveResult> {
    const { capture } = flight
    let baseContent = capture.baseContent
    let baseUpdatedAt = capture.baseUpdatedAt
    if (
      identity?.editId === capture.editId
      && identity.baseGeneration > capture.baseGeneration
    ) {
      baseContent = identity.baseContent
      baseUpdatedAt = identity.baseUpdatedAt
    }
    const attemptedOwner: ExistingEditRowOwner = {
      kind: 'v1',
      editId: capture.editId,
      revision: capture.revision,
    }
    const cleanupOwners = mergeOwners(
      capture.owners,
      [...recoveryOwners],
      [attemptedOwner],
    )
    const recovery: QuickNoteExistingEditSnapshotV1 = {
      version: 1,
      editId: capture.editId,
      revision: capture.revision,
      noteId: capture.noteId,
      baseContent,
      baseUpdatedAt,
      draft: capture.content,
      updatedAt: nowIso(),
    }
    let checkpointIssue: QuickNoteExistingEditIssue | null = null
    let captureRecoveryDurable = false

    if (!hasNewerDurableRecoveryOwner(capture)) {
      try {
        await adapter.checkpoint(recovery)
        resetRecoveryOwners(attemptedOwner)
        captureRecoveryDurable = true
        if (
          isCurrentCapture(capture)
          && snapshot.durability !== 'recovery-durable'
        ) {
          publish({
            ...snapshot,
            durability: 'recovery-durable',
          })
        }
      } catch {
        checkpointIssue = createIssue('checkpoint-failed', 'memory-only')
      }
    }

    if (normalizeContent(capture.content) === '') {
      if (isCurrentCapture(capture)) {
        publish({
          ...snapshot,
          phase: checkpointIssue ? 'failed' : 'dirty',
          durability: captureRecoveryDurable
            ? 'recovery-durable'
            : 'memory-only',
          issue: checkpointIssue,
        })
      }
      return { kind: 'empty' }
    }

    let update: Awaited<ReturnType<
      QuickNoteExistingEditStorageAdapter['updateEntity']
    >>
    try {
      update = await adapter.updateEntity({
        noteId: capture.noteId,
        baseContent,
        baseUpdatedAt,
        draft: capture.content,
      })
    } catch {
      const ownDurability: ExistingEditDurability = captureRecoveryDurable
        ? 'recovery-durable'
        : 'memory-only'
      const issue = createIssue(
        checkpointIssue ? 'checkpoint-failed' : 'entity-save-failed',
        latestDurability(capture, ownDurability),
      )
      if (isCurrentCapture(capture)) {
        publish({
          ...snapshot,
          phase: 'failed',
          durability: issue.durability,
          issue,
        })
      }
      return { kind: 'failed', issue }
    }

    const checkpointDurability: ExistingEditDurability = captureRecoveryDurable
      ? 'recovery-durable'
      : 'memory-only'
    if (update.kind === 'conflict') {
      const conflict: QuickNoteDraftConflict = {
        note: update.note,
        localDraft: capture.content,
        remoteContent: update.note.content,
      }
      if (isCurrentCapture(capture)) {
        unavailableLifecycle = null
        publish({
          ...snapshot,
          phase: 'conflict',
          durability: checkpointDurability,
          editingNote: update.note,
          draft: capture.content,
          conflict,
          issue: null,
        })
      }
      return { kind: 'conflict', conflict }
    }

    if (update.kind === 'unavailable') {
      if (isCurrentCapture(capture)) {
        unavailableLifecycle = update.lifecycle
        publish({
          ...snapshot,
          phase: 'target-unavailable',
          durability: checkpointDurability,
          draft: capture.content,
          conflict: null,
          issue: null,
        })
      }
      return { kind: 'unavailable', lifecycle: update.lifecycle }
    }

    const newerRevisionAtCommit = hasNewerSameEditRevision(capture)
    if (isSameEdit(capture) && identity !== null) {
      unavailableLifecycle = null
      identity = {
        ...identity,
        baseContent: update.note.content,
        baseUpdatedAt: update.note.updated_at,
        baseGeneration: identity.baseGeneration + 1,
      }
      if (newerRevisionAtCommit) {
        publish({
          ...snapshot,
          phase: 'dirty',
          editingNote: update.note,
          conflict: null,
          issue: null,
        })
      } else if (isCurrentCapture(capture)) {
        publish({
          ...snapshot,
          phase: 'saving',
          durability: 'entity-durable',
          editingNote: update.note,
          draft: capture.content,
          conflict: null,
          issue: null,
        })
      }
    }

    let cleanupResult: 'cleared' | 'absent' | 'different-edit' | 'skipped' =
      'skipped'
    let cleanupFailed = false
    const newerRevisionBeforeCleanup = hasNewerSameEditRevision(capture)
    if (!newerRevisionBeforeCleanup) {
      try {
        cleanupResult = await adapter.clearIfOwned(cleanupOwners)
        cleanupFailed = cleanupResult === 'different-edit'
      } catch {
        cleanupFailed = true
      }
    }
    if (cleanupResult === 'cleared' || cleanupResult === 'absent') {
      await preserveSuccessorAfterCleanup(capture)
    }

    let visibility: 'refreshed' | 'pending' = 'pending'
    let projectionIssue: QuickNoteExistingEditIssue | null = null
    if (active && epoch === capture.epoch) {
      try {
        onSaved(update.note)
        visibility = 'refreshed'
      } catch {
        projectionIssue = createIssue('projection-failed', 'entity-durable')
      }
    }

    const receipt: CleanupPendingReceipt = {
      editId: capture.editId,
      revision: capture.revision,
      content: capture.content,
      owners: cleanupOwners,
      note: update.note,
      closeAfterCleanup: flight.closeAfterSave,
      visibility,
      cleanupPending: cleanupFailed,
    }

    if (cleanupFailed) {
      cleanupReceipt = receipt
      const cleanupIssue = createIssue(
        'recovery-cleanup-failed',
        latestDurability(capture, 'entity-durable'),
      )
      if (isCurrentCapture(capture)) {
        publish({
          ...snapshot,
          phase: 'failed',
          durability: cleanupIssue.durability,
          editingNote: update.note,
          draft: capture.content,
          conflict: null,
          issue: cleanupIssue,
        })
      }
      return { kind: 'failed', issue: cleanupIssue }
    }

    if (projectionIssue) cleanupReceipt = receipt
    else if (
      cleanupReceipt?.editId === capture.editId
      && cleanupReceipt.revision === capture.revision
    ) cleanupReceipt = null

    if (isCurrentCapture(capture) && !flight.closeAfterSave) {
      publish({
        ...snapshot,
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: update.note,
        draft: capture.content,
        conflict: null,
        issue: projectionIssue,
      })
    }
    if (
      isCurrentCapture(capture)
      && flight.closeAfterSave
      && (cleanupResult === 'cleared' || cleanupResult === 'absent')
    ) {
      closeCurrentEdit()
    }

    return { kind: 'saved', note: update.note, visibility }
  }

  function captureSaveLane(): ExistingEditSaveLaneCapture | null {
    if (!active || identity === null) return null
    return {
      epoch,
      editId: identity.editId,
      revision: identity.revision,
      noteId: identity.noteId,
      baseContent: identity.baseContent,
      baseUpdatedAt: identity.baseUpdatedAt,
      baseGeneration: identity.baseGeneration,
      content: snapshot.draft,
      owners: [...recoveryOwners],
    }
  }

  function trackSaveFlight(flight: ExistingEditSaveFlight): void {
    saveFlight = flight
    saveFlights.add(flight)
    void flight.promise.then(
      () => {
        saveFlights.delete(flight)
        if (saveFlight === flight) saveFlight = null
      },
      () => {
        saveFlights.delete(flight)
        if (saveFlight === flight) saveFlight = null
      },
    )
  }

  async function runCleanupReceipt(
    flight: ExistingEditSaveAttempt,
    receipt: CleanupPendingReceipt,
  ): Promise<QuickNoteExistingEditSaveResult> {
    receipt.closeAfterCleanup ||= flight.closeAfterSave
    let cleanupResult: 'cleared' | 'absent' | 'different-edit'
    try {
      cleanupResult = await adapter.clearIfOwned(receipt.owners)
    } catch {
      const issue = createIssue(
        'recovery-cleanup-failed',
        latestDurability(flight.capture, 'entity-durable'),
      )
      return { kind: 'failed', issue }
    }

    if (cleanupResult === 'different-edit') {
      const issue = createIssue(
        'recovery-cleanup-failed',
        latestDurability(flight.capture, 'entity-durable'),
      )
      return { kind: 'failed', issue }
    }

    receipt.cleanupPending = false
    await preserveSuccessorAfterCleanup(flight.capture)
    if (cleanupReceipt === receipt) {
      cleanupReceipt = receipt.visibility === 'pending' ? receipt : null
    }

    if (isCurrentReceipt(receipt)) {
      if (receipt.closeAfterCleanup || flight.closeAfterSave) {
        closeCurrentEdit()
      } else {
        publish({
          ...snapshot,
          phase: 'saved',
          durability: 'entity-durable',
          editingNote: receipt.note,
          draft: receipt.content,
          conflict: null,
          issue: receipt.visibility === 'pending'
            ? createIssue('projection-failed', 'entity-durable')
            : null,
        })
      }
    }

    return {
      kind: 'saved',
      note: receipt.note,
      visibility: receipt.visibility,
    }
  }

  function save(options: {
    closeAfterSave?: boolean
  } = {}): Promise<QuickNoteExistingEditSaveResult> {
    const closeAfterSave = options.closeAfterSave ?? false
    cancelTrailingTimers()
    if (!active || identity === null) {
      return Promise.resolve({ kind: 'busy', operation: 'save' })
    }

    if (terminalFlight?.kind === 'cancel') {
      return Promise.resolve({ kind: 'busy', operation: 'cancel' })
    }
    if (terminalFlight?.kind === 'resolve-conflict') {
      return Promise.resolve({ kind: 'busy', operation: 'save' })
    }

    if (
      saveFlight
      && saveFlight.capture.epoch === epoch
      && saveFlight.capture.editId === identity.editId
      && saveFlight.capture.revision === identity.revision
      && saveFlight.capture.content === snapshot.draft
    ) {
      saveFlight.closeAfterSave ||= closeAfterSave
      if (cleanupReceipt && isCurrentReceipt(cleanupReceipt)) {
        cleanupReceipt.closeAfterCleanup ||= closeAfterSave
      }
      return saveFlight.promise
    }

    if (cleanupReceipt && isCurrentReceipt(cleanupReceipt)) {
      cleanupReceipt.closeAfterCleanup ||= closeAfterSave
      if (!cleanupReceipt.cleanupPending) {
        const receipt = cleanupReceipt
        if (receipt.closeAfterCleanup) closeCurrentEdit()
        return Promise.resolve({
          kind: 'saved',
          note: receipt.note,
          visibility: receipt.visibility,
        })
      }

      const receipt = cleanupReceipt
      const capture = captureSaveLane()
      if (!capture) {
        return Promise.resolve({ kind: 'busy', operation: 'save' })
      }
      const promise = append(() => runCleanupReceipt(flight, receipt))
      const flight: ExistingEditSaveFlight = {
        capture,
        closeAfterSave,
        promise,
      }
      trackSaveFlight(flight)
      return promise
    }
    cleanupReceipt = null

    if (snapshot.phase === 'target-unavailable' && unavailableLifecycle) {
      return Promise.resolve({
        kind: 'unavailable',
        lifecycle: unavailableLifecycle,
      })
    }

    if (snapshot.phase === 'saved') {
      const note = snapshot.editingNote
      if (!note || normalizeContent(snapshot.draft) === '') {
        return Promise.resolve({ kind: 'empty' })
      }
      if (closeAfterSave) {
        closeCurrentEdit()
      }
      return Promise.resolve({
        kind: 'saved',
        note,
        visibility: 'refreshed',
      })
    }

    const capture = captureSaveLane()
    if (!capture) {
      return Promise.resolve({ kind: 'busy', operation: 'save' })
    }
    const promise = append(() => runSave(flight))
    const flight: ExistingEditSaveFlight = {
      capture,
      closeAfterSave,
      promise,
    }
    trackSaveFlight(flight)
    if (isCurrentCapture(capture)) {
      publish({
        ...snapshot,
        phase: 'saving',
        issue: null,
      })
    }
    return promise
  }

  async function runCancel(
    attempt: ExistingEditCancelAttempt,
  ): Promise<QuickNoteExistingEditCancelResult> {
    const { capture, owners } = attempt
    let cleanupResult: 'cleared' | 'absent' | 'different-edit'
    try {
      cleanupResult = await adapter.clearIfOwned(owners)
    } catch {
      const issue = createIssue(
        'recovery-cleanup-failed',
        latestDurability(),
      )
      return { kind: 'failed', issue }
    }

    if (cleanupResult === 'different-edit') {
      const issue = createIssue(
        'recovery-cleanup-failed',
        latestDurability(),
      )
      return { kind: 'failed', issue }
    }

    if (cleanupReceipt?.editId === capture.editId) cleanupReceipt = null
    await preserveSuccessorAfterCleanup(capture)
    if (isCurrentCapture(capture)) closeCurrentEdit()
    return { kind: 'cancelled' }
  }

  function cancel(): Promise<QuickNoteExistingEditCancelResult> {
    cancelTrailingTimers()
    if (terminalFlight?.kind === 'cancel') return terminalFlight.promise
    if (saveFlights.size > 0 || terminalFlight?.kind === 'resolve-conflict') {
      return Promise.resolve({ kind: 'busy', operation: 'save' })
    }
    if (!active || identity === null) {
      return Promise.resolve({ kind: 'cancelled' })
    }

    const capture: ExistingEditCheckpointCapture = {
      epoch,
      editId: identity.editId,
      revision: identity.revision,
      content: snapshot.draft,
    }
    const receiptOwners = cleanupReceipt?.editId === capture.editId
      ? cleanupReceipt.owners
      : []
    const attemptedOwner: ExistingEditRowOwner[] = capture.revision > 0
      ? [{ kind: 'v1', editId: capture.editId, revision: capture.revision }]
      : []
    const attempt: ExistingEditCancelAttempt = {
      capture,
      owners: mergeOwners([...recoveryOwners], receiptOwners, attemptedOwner),
    }
    const promise = append(() => runCancel(attempt))
    const flight: ExistingEditCancelFlight = {
      kind: 'cancel',
      promise,
    }
    terminalFlight = flight
    void promise.then(
      () => {
        if (terminalFlight === flight) terminalFlight = null
      },
      () => {
        if (terminalFlight === flight) terminalFlight = null
      },
    )
    return promise
  }

  function preserveCurrentConflict(): QuickNoteExistingEditConflictResult {
    if (snapshot.conflict) {
      return { kind: 'conflict', conflict: snapshot.conflict }
    }
    if (unavailableLifecycle) {
      return { kind: 'unavailable', lifecycle: unavailableLifecycle }
    }
    return {
      kind: 'failed',
      issue: createIssue('entity-save-failed', snapshot.durability),
    }
  }

  async function runConflictResolution(
    strategy: 'keep-local' | 'use-remote' | 'merge',
  ): Promise<QuickNoteExistingEditConflictResult> {
    if (!active || identity === null) return preserveCurrentConflict()
    const capture: ExistingEditSaveLaneCapture = {
      epoch,
      editId: identity.editId,
      revision: identity.revision,
      noteId: identity.noteId,
      baseContent: identity.baseContent,
      baseUpdatedAt: identity.baseUpdatedAt,
      baseGeneration: identity.baseGeneration,
      content: snapshot.draft,
      owners: mergeOwners(
        [...recoveryOwners],
        cleanupReceipt?.editId === identity.editId
          ? cleanupReceipt.owners
          : [],
      ),
    }
    let target: Awaited<ReturnType<
      QuickNoteExistingEditStorageAdapter['readTarget']
    >>
    try {
      target = await adapter.readTarget(capture.noteId)
    } catch {
      return {
        kind: 'failed',
        issue: createIssue('entity-save-failed', latestDurability()),
      }
    }

    const lifecycle = target.lifecycle === 'active' && target.note === null
      ? 'missing'
      : target.lifecycle
    if (lifecycle !== 'active' || target.note === null) {
      unavailableLifecycle = lifecycle
      if (isCurrentCapture(capture)) {
        publish({
          ...snapshot,
          phase: 'target-unavailable',
          conflict: null,
          issue: null,
        })
      }
      return { kind: 'unavailable', lifecycle }
    }
    const remote = target.note

    if (strategy === 'use-remote') {
      let cleanupResult: 'cleared' | 'absent' | 'different-edit'
      try {
        cleanupResult = await adapter.clearIfOwned(capture.owners)
      } catch {
        return {
          kind: 'failed',
          issue: createIssue('recovery-cleanup-failed', latestDurability()),
        }
      }
      if (cleanupResult === 'different-edit') {
        return {
          kind: 'failed',
          issue: createIssue('recovery-cleanup-failed', latestDurability()),
        }
      }

      cleanupReceipt = null
      await preserveSuccessorAfterCleanup(capture)
      if (isCurrentCapture(capture) && identity !== null) {
        let projectionIssue: QuickNoteExistingEditIssue | null = null
        try {
          onSaved(remote)
        } catch {
          projectionIssue = createIssue('projection-failed', 'entity-durable')
        }
        identity = {
          ...identity,
          baseContent: remote.content,
          baseUpdatedAt: remote.updated_at,
          baseGeneration: identity.baseGeneration + 1,
        }
        unavailableLifecycle = null
        publish({
          phase: 'saved',
          durability: 'entity-durable',
          editingNote: remote,
          draft: remote.content,
          conflict: null,
          issue: projectionIssue,
        })
      }
      return { kind: 'resolved', strategy }
    }

    if (strategy === 'merge') {
      if (!isCurrentCapture(capture) || identity === null) {
        return preserveCurrentConflict()
      }
      const merged = `${capture.content.trimEnd()}\n\n--- 远端版本 ---\n${remote.content.trim()}`
      identity = {
        ...identity,
        revision: identity.revision + 1,
        baseContent: remote.content,
        baseUpdatedAt: remote.updated_at,
        baseGeneration: identity.baseGeneration + 1,
      }
      cleanupReceipt = null
      unavailableLifecycle = null
      const mergedCapture: ExistingEditCheckpointCapture = {
        epoch,
        editId: identity.editId,
        revision: identity.revision,
        content: merged,
      }
      scheduleTrailingWork(mergedCapture)
      publish({
        phase: 'dirty',
        durability: 'memory-only',
        editingNote: remote,
        draft: merged,
        conflict: null,
        issue: null,
      })
      return { kind: 'resolved', strategy }
    }

    if (!isCurrentCapture(capture) || identity === null) {
      return preserveCurrentConflict()
    }
    identity = {
      ...identity,
      baseContent: remote.content,
      baseUpdatedAt: remote.updated_at,
      baseGeneration: identity.baseGeneration + 1,
    }
    unavailableLifecycle = null
    publish({
      ...snapshot,
      phase: 'dirty',
      durability: 'memory-only',
      editingNote: remote,
      conflict: null,
      issue: null,
    })
    const keepLocalCapture = captureSaveLane()
    if (!keepLocalCapture) return preserveCurrentConflict()
    const saveResult = await runSave({
      capture: keepLocalCapture,
      closeAfterSave: false,
    })
    switch (saveResult.kind) {
      case 'saved':
      case 'empty':
        return { kind: 'resolved', strategy }
      case 'conflict':
        return saveResult
      case 'unavailable':
        return saveResult
      case 'failed':
        return saveResult
      case 'busy':
        return {
          kind: 'failed',
          issue: createIssue('entity-save-failed', snapshot.durability),
        }
    }
  }

  function resolveConflict(
    strategy: 'keep-local' | 'use-remote' | 'merge',
  ): Promise<QuickNoteExistingEditConflictResult> {
    if (snapshot.phase === 'target-unavailable' && unavailableLifecycle) {
      return Promise.resolve({
        kind: 'unavailable',
        lifecycle: unavailableLifecycle,
      })
    }
    cancelTrailingTimers()
    if (
      terminalFlight?.kind === 'resolve-conflict'
      && terminalFlight.strategy === strategy
    ) return terminalFlight.promise
    if (terminalFlight !== null || saveFlights.size > 0) {
      return Promise.resolve(preserveCurrentConflict())
    }
    if (!active || identity === null) {
      return Promise.resolve(preserveCurrentConflict())
    }

    const promise = append(() => runConflictResolution(strategy))
    const flight: ExistingEditConflictFlight = {
      kind: 'resolve-conflict',
      strategy,
      promise,
    }
    terminalFlight = flight
    void promise.then(
      () => {
        if (terminalFlight === flight) terminalFlight = null
      },
      () => {
        if (terminalFlight === flight) terminalFlight = null
      },
    )
    return promise
  }

  function observeProjection(input: ExistingEditProjection): void {
    if (!active || identity === null) return
    const noteId = identity.noteId
    const activeNote = input.quickNotes.find((note) => note.id === noteId)
    const trashedNote = input.trashedQuickNotes.find(
      (note) => note.id === noteId,
    )
    const recordedLifecycle = input.lifecycleStateById[noteId]
    const lifecycle: QuickNoteLifecycleState | 'missing' = activeNote
      ? 'active'
      : trashedNote
        ? recordedLifecycle ?? 'trashed'
        : recordedLifecycle ?? 'missing'

    if (lifecycle === 'active' && !activeNote) return
    if (lifecycle === 'active' && activeNote) {
      const baseChanged =
        activeNote.content !== identity.baseContent
        || activeNote.updated_at !== identity.baseUpdatedAt
      if (!baseChanged) {
        if (snapshot.phase !== 'target-unavailable') return

        unavailableLifecycle = null
        const hasLocalWork =
          normalizeContent(snapshot.draft) !== normalizeContent(identity.baseContent)
        if (hasLocalWork) {
          const capture = captureCurrentRevision()
          if (capture) scheduleTrailingWork(capture)
          publish({
            ...snapshot,
            phase: 'dirty',
            editingNote: activeNote,
            conflict: null,
            issue: null,
          })
          return
        }

        cleanupReceipt = null
        publish({
          phase: 'saved',
          durability: 'entity-durable',
          editingNote: activeNote,
          draft: activeNote.content,
          conflict: null,
          issue: null,
        })
        return
      }

      const hasLocalWork =
        snapshot.phase === 'dirty'
        || snapshot.phase === 'checkpointing'
        || snapshot.phase === 'saving'
        || snapshot.phase === 'failed'
        || snapshot.phase === 'conflict'
        || snapshot.phase === 'target-unavailable'
      cancelTrailingTimers()
      unavailableLifecycle = null
      if (hasLocalWork) {
        const durability = hasCurrentDurableRecoveryOwner()
          ? 'recovery-durable'
          : snapshot.durability
        const conflict: QuickNoteDraftConflict = {
          note: activeNote,
          localDraft: snapshot.draft,
          remoteContent: activeNote.content,
        }
        publish({
          ...snapshot,
          phase: 'conflict',
          durability,
          editingNote: activeNote,
          conflict,
          issue: null,
        })
        return
      }

      identity = {
        ...identity,
        baseContent: activeNote.content,
        baseUpdatedAt: activeNote.updated_at,
        baseGeneration: identity.baseGeneration + 1,
      }
      cleanupReceipt = null
      publish({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: activeNote,
        draft: activeNote.content,
        conflict: null,
        issue: null,
      })
      return
    }

    const hasLocalWork =
      snapshot.phase === 'dirty'
      || snapshot.phase === 'checkpointing'
      || snapshot.phase === 'saving'
      || snapshot.phase === 'failed'
      || snapshot.phase === 'conflict'
      || snapshot.phase === 'target-unavailable'
    if (!hasLocalWork) {
      closeCurrentEdit()
      return
    }

    cancelTrailingTimers()
    unavailableLifecycle = lifecycle
    publish({
      ...snapshot,
      phase: 'target-unavailable',
      conflict: null,
      issue: null,
    })
  }

  const controller: QuickNoteExistingEditSessionController = {
    spaceId,
    get state() {
      return snapshot
    },
    start,
    change,
    save,
    cancel,
    resolveConflict,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (!active) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    observeProjection,
    async drainBeforeSwitch() {
      if (!active) return
      await initialRestoreReady
    },
    requestBestEffortCheckpoint() {
      const capture = captureCurrentRevision()
      if (capture) observeBackgroundWork(queueCheckpoint(capture))
    },
    deactivate() {
      if (!active) return
      active = false
      epoch += 1
      cancelTrailingTimers()
      pendingStart = null
      listeners.clear()
    },
  }

  void flushTimeoutMs
  beginRestore()
  return controller
}
