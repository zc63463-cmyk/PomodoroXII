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

interface ExistingEditSaveFlight {
  capture: ExistingEditSaveLaneCapture
  closeAfterSave: boolean
  promise: Promise<QuickNoteExistingEditSaveResult>
}

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
      && identity?.editId === capture.editId
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

  function activate(note: QuickNote): void {
    if (!active) return
    cancelTrailingTimers()
    saveFlight = null
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
  ): void {
    if (!isCurrentRestore(generation)) return
    pendingStart = null
    blockedRecoveryOwner = null
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
      if (snapshot.phase !== 'saving') {
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
          publish({
            ...snapshot,
            phase: 'failed',
            durability: 'memory-only',
            issue,
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
        publish({
          ...snapshot,
          phase: snapshot.phase === 'saving' ? 'saving' : 'dirty',
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

  async function runSave(
    flight: ExistingEditSaveFlight,
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

    try {
      await adapter.checkpoint(recovery)
      resetRecoveryOwners(attemptedOwner)
    } catch {
      checkpointIssue = createIssue('checkpoint-failed', 'memory-only')
    }

    if (normalizeContent(capture.content) === '') {
      if (isCurrentCapture(capture)) {
        publish({
          ...snapshot,
          phase: checkpointIssue ? 'failed' : 'dirty',
          durability: checkpointIssue ? 'memory-only' : 'recovery-durable',
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
      const issue = checkpointIssue
        ?? createIssue('entity-save-failed', 'recovery-durable')
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

    const checkpointDurability: ExistingEditDurability = checkpointIssue
      ? 'memory-only'
      : 'recovery-durable'
    if (update.kind === 'conflict') {
      const conflict: QuickNoteDraftConflict = {
        note: update.note,
        localDraft: capture.content,
        remoteContent: update.note.content,
      }
      if (isCurrentCapture(capture)) {
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
    let cleanupIssue: QuickNoteExistingEditIssue | null = null
    const newerRevisionBeforeCleanup = hasNewerSameEditRevision(capture)
    if (!newerRevisionBeforeCleanup) {
      try {
        cleanupResult = await adapter.clearIfOwned(cleanupOwners)
        if (cleanupResult === 'different-edit') {
          cleanupIssue = createIssue(
            'recovery-cleanup-failed',
            'entity-durable',
          )
        }
      } catch {
        cleanupIssue = createIssue(
          'recovery-cleanup-failed',
          'entity-durable',
        )
      }
    }
    if (cleanupResult === 'cleared' || cleanupResult === 'absent') {
      resetRecoveryOwners()
      if (hasNewerSameEditRevision(capture) && identity !== null) {
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

    if (cleanupIssue) {
      if (isCurrentCapture(capture)) {
        publish({
          ...snapshot,
          phase: 'failed',
          durability: 'entity-durable',
          editingNote: update.note,
          draft: capture.content,
          conflict: null,
          issue: cleanupIssue,
        })
      }
      return { kind: 'failed', issue: cleanupIssue }
    }

    if (isCurrentCapture(capture)) {
      if (
        flight.closeAfterSave
        && (cleanupResult === 'cleared' || cleanupResult === 'absent')
      ) {
        cancelTrailingTimers()
        identity = null
        blockedRecoveryOwner = null
        resetRecoveryOwners()
        publish(IDLE_STATE)
      } else {
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
    }

    return { kind: 'saved', note: update.note, visibility }
  }

  function save(options: {
    closeAfterSave?: boolean
  } = {}): Promise<QuickNoteExistingEditSaveResult> {
    const closeAfterSave = options.closeAfterSave ?? false
    cancelTrailingTimers()
    if (!active || identity === null) {
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
      return saveFlight.promise
    }

    if (snapshot.phase === 'saved') {
      const note = snapshot.editingNote
      if (!note || normalizeContent(snapshot.draft) === '') {
        return Promise.resolve({ kind: 'empty' })
      }
      if (closeAfterSave) {
        identity = null
        resetRecoveryOwners()
        publish(IDLE_STATE)
      }
      return Promise.resolve({
        kind: 'saved',
        note,
        visibility: 'refreshed',
      })
    }

    const capture: ExistingEditSaveLaneCapture = {
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
    const promise = append(() => runSave(flight))
    const flight: ExistingEditSaveFlight = {
      capture,
      closeAfterSave,
      promise,
    }
    saveFlight = flight
    if (isCurrentCapture(capture)) {
      publish({
        ...snapshot,
        phase: 'saving',
        issue: null,
      })
    }
    void promise.then(
      () => {
        if (saveFlight === flight) saveFlight = null
      },
      () => {
        if (saveFlight === flight) saveFlight = null
      },
    )
    return promise
  }

  const controller: QuickNoteExistingEditSessionController = {
    spaceId,
    get state() {
      return snapshot
    },
    start,
    change,
    save,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (!active) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    observeProjection(input) {
      void input
    },
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
