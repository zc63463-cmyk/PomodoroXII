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
  let resolveInitialRestore!: () => void
  const initialRestoreReady = new Promise<void>((resolve) => {
    resolveInitialRestore = resolve
  })
  let initialRestoreSettled = false
  let active = true
  let restoreGeneration = 0
  let pendingStart: QuickNote | null = null
  let identity: ExistingEditIdentity | null = null
  let blockedRecoveryOwner: ExistingEditRowOwner | null = null
  let snapshot = RESTORING_STATE

  function publish(next: QuickNoteExistingEditState): void {
    if (!active) return
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  function isCurrentRestore(generation: number): boolean {
    return active && restoreGeneration === generation
  }

  function activate(note: QuickNote): void {
    if (!active) return
    blockedRecoveryOwner = null
    identity = {
      editId: createEditId(),
      revision: 0,
      noteId: note.id,
      baseContent: note.content,
      baseUpdatedAt: note.updated_at,
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
    blockedRecoveryOwner = null
    identity = null
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
    identity = makeIdentity(loaded.snapshot)
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
    identity = makeIdentity(loaded.snapshot)
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
      return await adapter.clearIfOwned([owner]) !== 'different-edit'
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
        loaded = await adapter.load()
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

  function change(content: string): void {
    if (!active || identity === null) return
    if (snapshot.phase !== 'saved' && snapshot.phase !== 'dirty') return
    identity = { ...identity, revision: identity.revision + 1 }
    publish({
      ...snapshot,
      phase: 'dirty',
      durability: 'memory-only',
      draft: content,
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
      // Timers and checkpointing enter the controller in the next task.
    },
    deactivate() {
      if (!active) return
      active = false
      pendingStart = null
      listeners.clear()
    },
  }

  void onSaved
  void nowIso
  void checkpointMs
  void autosaveMs
  void flushTimeoutMs
  beginRestore()
  return controller
}
