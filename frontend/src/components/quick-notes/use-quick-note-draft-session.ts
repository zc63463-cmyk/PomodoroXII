'use client'

import {
  QUICK_NOTE_NEW_DRAFT_VERSION_V2,
  type QuickNoteDraftRowOwner,
  type QuickNoteDraftStorageAdapter,
  type QuickNoteNewDraftSnapshotV2,
} from '@/lib/quick-notes/quick-note-draft-repository'
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

type TerminalIntent =
  | { kind: 'record'; promise: Promise<QuickNoteDraftRecordResult> }
  | { kind: 'discard'; promise: Promise<QuickNoteDraftDiscardResult> }

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

function createIssue(code: QuickNoteDraftIssueCode): QuickNoteDraftIssue {
  return { code, retryable: code !== 'projection-failed' }
}

function ownerKey(owner: QuickNoteDraftRowOwner): string {
  return owner.kind === 'v2'
    ? `v2:${owner.draftId}`
    : `raw:${owner.value}`
}

/** @internal deterministic controller seam; do not barrel-export */
export function createQuickNoteDraftSessionController(
  options: QuickNoteDraftSessionControllerInput,
) {
  const {
    adapter,
    spaceId,
    createDraftId = () => crypto.randomUUID(),
    nowIso = () => new Date().toISOString(),
    debounceMs = 500,
  } = options
  const lane: DraftLane = { tail: Promise.resolve() }
  const listeners = new Set<() => void>()
  const frontier = new Map<string, QuickNoteDraftRowOwner>()
  let active = true
  let nextGenerationId = 0
  let revision = 0
  let durable: DurableMarker | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
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

  function publish(patch: Partial<DraftSessionSnapshot>): void {
    if (!active) return
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((listener) => listener())
  }

  function append<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.tail.then(work)
    lane.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function addOwner(owner: QuickNoteDraftRowOwner): void {
    frontier.set(ownerKey(owner), owner)
  }

  function retireOwners(owners: readonly QuickNoteDraftRowOwner[]): void {
    owners.forEach((owner) => frontier.delete(ownerKey(owner)))
  }

  function captureCurrent(): DraftCapture {
    return {
      generation,
      generationId: generation.id,
      revision,
      content: snapshot.draft,
      draftId: generation.draftId,
      owners: [...frontier.values()],
    }
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
  ): Promise<void> {
    if (!force && isDurable(capture)) return Promise.resolve()
    if (isCurrent(capture) && publishSaving) {
      publish({ saveState: 'saving', issue: null })
    }

    return append(async () => {
      if (!force && isDurable(capture)) return
      try {
        if (capture.content.trim()) {
          const persisted = makeV2(capture)
          await adapter.save(persisted)
          retireOwners(capture.owners)
          addOwner({ kind: 'v2', draftId: persisted.draftId })
          markDurable(capture)
          if (isCurrent(capture)) {
            publish({ saveState: 'saved', issue: null })
          }
          return
        }

        const outcome = await adapter.clearIfOwned(capture.owners)
        retireOwners(capture.owners)
        if (outcome === 'different-draft') {
          if (isCurrent(capture)) {
            publish({ saveState: 'idle', issue: null })
          }
          return
        }
        if (outcome === 'cleared' || outcome === 'absent') {
          markDurable(capture)
          if (isCurrent(capture)) {
            publish({ saveState: 'idle', issue: null })
          }
        }
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

  async function restore(): Promise<void> {
    const initialGeneration = generation
    const initialGenerationId = generation.id
    const initialRevision = revision
    let loaded

    try {
      loaded = await adapter.load()
    } catch {
      if (
        active
        && generation === initialGeneration
        && generation.id === initialGenerationId
        && revision === initialRevision
      ) {
        publish({ saveState: 'failed', issue: createIssue('read-failed') })
      }
      return
    }

    if (!active) return
    const canDisplay = generation === initialGeneration
      && generation.id === initialGenerationId
      && revision === initialRevision
      && !snapshot.draft.trim()

    if (loaded.kind === 'absent') {
      if (canDisplay) markDurable(captureCurrent())
      return
    }

    addOwner(loaded.owner)

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
  }

  const controller = {
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
      listeners.clear()
    },
  }

  void restore().catch(() => undefined)
  return controller
}
