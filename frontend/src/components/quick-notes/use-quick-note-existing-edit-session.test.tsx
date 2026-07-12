import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuickNote } from '@/types'
import type { QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import type { QuickNoteLifecycleState } from '@/lib/quick-notes/quick-note-repository'
import {
  QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION,
  type ExistingEditLoadResult,
  type ExistingEditRowOwner,
  type ExistingEditSaveCapture,
  type ExistingEditUpdateResult,
  type QuickNoteExistingEditSnapshotV1,
  type QuickNoteExistingEditStorageAdapter,
} from '@/lib/quick-notes/quick-note-existing-edit-repository'
import {
  createQuickNoteExistingEditSessionController,
  type QuickNoteExistingEditState,
} from '@/components/quick-notes/use-quick-note-existing-edit-session'

const BASE_UPDATED_AT = '2026-07-12T04:00:00.000Z'
const RECOVERY_UPDATED_AT = '2026-07-12T04:00:01.000Z'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

type AdapterEffect<T> = () => Promise<T>
type ControlledReadTargetResult = {
  note: QuickNote | null
  lifecycle: QuickNoteLifecycleState | 'missing'
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeQuickNote(overrides: Partial<QuickNote> = {}): QuickNote {
  return {
    id: 'quick-note-1',
    content: 'base',
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    session_id: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: BASE_UPDATED_AT,
    updated_at: BASE_UPDATED_AT,
    ...overrides,
  }
}

function makeSnapshot(
  overrides: Partial<QuickNoteExistingEditSnapshotV1> = {},
): QuickNoteExistingEditSnapshotV1 {
  return {
    version: QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION,
    editId: 'recovered-edit-1',
    revision: 1,
    noteId: 'quick-note-1',
    baseContent: 'base',
    baseUpdatedAt: BASE_UPDATED_AT,
    draft: 'recovered local',
    updatedAt: RECOVERY_UPDATED_AT,
    ...overrides,
  }
}

function validRecoveredLoad({
  snapshot: snapshotOverrides = {},
  note,
  lifecycle = 'active',
}: {
  snapshot?: Partial<QuickNoteExistingEditSnapshotV1>
  note?: QuickNote | null
  lifecycle?: QuickNoteLifecycleState | 'missing'
} = {}): ExistingEditLoadResult {
  const snapshot = makeSnapshot(snapshotOverrides)
  const resolvedNote = note === undefined
    ? makeQuickNote({
      id: snapshot.noteId,
      content: snapshot.baseContent,
      updated_at: snapshot.baseUpdatedAt,
    })
    : note

  return {
    kind: 'valid',
    snapshot,
    owner: {
      kind: 'v1',
      editId: snapshot.editId,
      revision: snapshot.revision,
    },
    note: resolvedNote,
    lifecycle,
  }
}

class ControlledQuickNoteExistingEditAdapter
implements QuickNoteExistingEditStorageAdapter {
  loadResult: ExistingEditLoadResult = { kind: 'absent' }
  readTargetResult: ControlledReadTargetResult = {
    note: makeQuickNote(),
    lifecycle: 'active',
  }
  updateResult: ExistingEditUpdateResult = {
    kind: 'updated',
    note: makeQuickNote(),
  }
  clearResult: 'cleared' | 'absent' | 'different-edit' = 'cleared'
  stored: QuickNoteExistingEditSnapshotV1 | null = null
  readonly operationLog: string[] = []
  readonly loadEffects: Array<AdapterEffect<ExistingEditLoadResult>> = []
  readonly readTargetEffects: Array<AdapterEffect<ControlledReadTargetResult>> = []
  readonly checkpointEffects: Array<AdapterEffect<void>> = []
  readonly updateEffects: Array<AdapterEffect<ExistingEditUpdateResult>> = []
  readonly clearEffects: Array<
    AdapterEffect<'cleared' | 'absent' | 'different-edit'>
  > = []
  readonly readTargetCalls: string[] = []
  readonly checkpointCalls: QuickNoteExistingEditSnapshotV1[] = []
  readonly updateCalls: ExistingEditSaveCapture[] = []
  readonly clearCalls: Array<readonly ExistingEditRowOwner[]> = []

  async load(): Promise<ExistingEditLoadResult> {
    this.operationLog.push('load')
    return this.loadEffects.shift()?.() ?? this.loadResult
  }

  async readTarget(noteId: string): Promise<ControlledReadTargetResult> {
    this.operationLog.push('read-target')
    this.readTargetCalls.push(noteId)
    return this.readTargetEffects.shift()?.() ?? this.readTargetResult
  }

  async checkpoint(snapshot: QuickNoteExistingEditSnapshotV1): Promise<void> {
    this.operationLog.push(`checkpoint:${snapshot.draft}`)
    this.checkpointCalls.push(snapshot)
    await this.checkpointEffects.shift()?.()
    this.stored = snapshot
  }

  async updateEntity(
    capture: ExistingEditSaveCapture,
  ): Promise<ExistingEditUpdateResult> {
    this.operationLog.push(`update:${capture.draft}`)
    this.updateCalls.push(capture)
    return this.updateEffects.shift()?.() ?? this.updateResult
  }

  async clearIfOwned(
    owners: readonly ExistingEditRowOwner[],
  ): Promise<'cleared' | 'absent' | 'different-edit'> {
    this.operationLog.push('clear')
    this.clearCalls.push(owners)
    const effect = this.clearEffects.shift()
    const result = effect ? await effect() : this.clearResult
    if (result === 'cleared' && this.stored !== null) {
      const stored = this.stored
      const ownsStored = owners.some((owner) => (
        owner.kind === 'v1'
        && owner.editId === stored.editId
        && owner.revision === stored.revision
      ))
      if (!ownsStored) return 'different-edit'
      this.stored = null
    }
    return result
  }
}

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

type ControllerInput = Parameters<
  typeof createQuickNoteExistingEditSessionController
>[0]

function controllerOptions(
  adapter: ControlledQuickNoteExistingEditAdapter,
  onSaved: (note: QuickNote) => undefined = () => undefined,
): ControllerInput {
  let nextEditId = 1
  return {
    spaceId: 'space-a',
    adapter,
    onSaved,
    createEditId: () => `edit-${nextEditId++}`,
    nowIso: () => '2026-07-12T04:00:00.000Z',
    checkpointMs: 500,
    autosaveMs: 900,
    flushTimeoutMs: 3_000,
  }
}

function expectIdle(state: QuickNoteExistingEditState): void {
  expect(state).toEqual({
    phase: 'idle',
    durability: 'entity-durable',
    editingNote: null,
    draft: '',
    conflict: null,
    issue: null,
  })
}

describe('QuickNote existing-edit session controller', () => {
  let adapter: ControlledQuickNoteExistingEditAdapter

  beforeEach(() => {
    vi.useFakeTimers()
    adapter = new ControlledQuickNoteExistingEditAdapter()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('starts in restoring and resolves an absent row to idle entity durability', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)

    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    expect(controller.spaceId).toBe('space-a')
    expect(controller.getSnapshot()).toEqual({
      phase: 'restoring',
      durability: 'unknown',
      editingNote: null,
      draft: '',
      conflict: null,
      issue: null,
    })
    await flushMicrotasks()
    expect(adapter.operationLog).toEqual(['load'])

    load.resolve({ kind: 'absent' })
    await flushMicrotasks()

    expectIdle(controller.getSnapshot())
  })

  it('activates only the latest pending start after an absent restore', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)
    const first = makeQuickNote({ id: 'first', content: 'first content' })
    const latest = makeQuickNote({ id: 'latest', content: 'latest content' })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    controller.start(first)
    const restoringSnapshot = controller.getSnapshot()
    controller.start(latest)

    expect(controller.getSnapshot()).toBe(restoringSnapshot)
    expect(controller.state.editingNote).toBeNull()
    load.resolve({ kind: 'absent' })
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: { id: 'latest' },
      draft: 'latest content',
      issue: null,
    })
  })

  it('clears normalized-equal stale recovery without updating the entity', async () => {
    const snapshot = makeSnapshot({ draft: '  current entity  ' })
    adapter.loadResult = validRecoveredLoad({
      snapshot,
      note: makeQuickNote({ content: 'current entity' }),
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expectIdle(controller.state)
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
    ]])
    expect(adapter.updateCalls).toEqual([])
    expect(adapter.checkpointCalls).toEqual([])
  })

  it('lets normalized equality cleanup win when only the entity timestamp changed', async () => {
    const snapshot = makeSnapshot({ draft: '  base  ' })
    adapter.loadResult = validRecoveredLoad({
      snapshot,
      note: makeQuickNote({
        content: snapshot.baseContent,
        updated_at: '2026-07-12T05:00:00.000Z',
      }),
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expectIdle(controller.state)
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
    ]])
    expect(adapter.updateCalls).toEqual([])
    expect(adapter.checkpointCalls).toEqual([])
  })

  it('restores a local-only edit as dirty and recovery durable', async () => {
    const note = makeQuickNote()
    adapter.loadResult = validRecoveredLoad({
      snapshot: { draft: ' complete local draft\n' },
      note,
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state).toEqual({
      phase: 'dirty',
      durability: 'recovery-durable',
      editingNote: note,
      draft: ' complete local draft\n',
      conflict: null,
      issue: null,
    })
    expect(adapter.clearCalls).toEqual([])
  })

  it('clears a remote-only recovery and adopts the entity without an update', async () => {
    const remote = makeQuickNote({
      content: 'remote content',
      updated_at: '2026-07-12T05:00:00.000Z',
    })
    const snapshot = makeSnapshot({ draft: '  base  ' })
    adapter.loadResult = validRecoveredLoad({ snapshot, note: remote })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expectIdle(controller.state)
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
    ]])
    expect(adapter.updateCalls).toEqual([])
  })

  it('restores concurrent local and remote changes as a conflict', async () => {
    const remote = makeQuickNote({
      content: 'remote content',
      updated_at: '2026-07-12T05:00:00.000Z',
    })
    adapter.loadResult = validRecoveredLoad({
      snapshot: { draft: 'local content' },
      note: remote,
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state).toEqual({
      phase: 'conflict',
      durability: 'recovery-durable',
      editingNote: remote,
      draft: 'local content',
      conflict: {
        note: remote,
        localDraft: 'local content',
        remoteContent: 'remote content',
      } satisfies QuickNoteDraftConflict,
      issue: null,
    })
    expect(adapter.clearCalls).toEqual([])
  })

  it('clears an invalid row using its exact raw owner', async () => {
    const owner = { kind: 'raw', value: '{damaged-json' } as const
    adapter.loadResult = { kind: 'invalid', owner }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expectIdle(controller.state)
    expect(adapter.clearCalls).toEqual([[owner]])
  })

  it('blocks replacement when invalid-row cleanup rejects', async () => {
    const owner = { kind: 'raw', value: '{damaged-json' } as const
    adapter.loadResult = { kind: 'invalid', owner }
    adapter.clearEffects.push(() => Promise.reject(new Error('cleanup failed')))
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state).toEqual({
      phase: 'failed',
      durability: 'unknown',
      editingNote: null,
      draft: '',
      conflict: null,
      issue: {
        code: 'invalid-recovery-cleanup-failed',
        retryable: true,
        durability: 'unknown',
      },
    })
    controller.start(makeQuickNote({ id: 'blocked' }))
    expect(controller.state.editingNote).toBeNull()
    expect(adapter.operationLog).toEqual(['load', 'clear'])
  })

  it('blocks replacement when invalid-row cleanup finds a different edit', async () => {
    const owner = { kind: 'raw', value: 'future-row' } as const
    adapter.loadResult = { kind: 'invalid', owner }
    adapter.clearResult = 'different-edit'
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state.issue).toEqual({
      code: 'invalid-recovery-cleanup-failed',
      retryable: true,
      durability: 'unknown',
    })
    controller.start(makeQuickNote({ id: 'blocked' }))
    expect(controller.state.phase).toBe('failed')
    expect(controller.state.editingNote).toBeNull()
  })

  it('retries recovery on the next start after a read failure', async () => {
    const firstLoad = createDeferred<ExistingEditLoadResult>()
    const retryLoad = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => firstLoad.promise, () => retryLoad.promise)
    const requested = makeQuickNote({ id: 'requested', content: 'requested body' })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    firstLoad.reject(new Error('read failed'))
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'failed',
      durability: 'unknown',
      editingNote: null,
      draft: '',
      issue: {
        code: 'recovery-read-failed',
        retryable: true,
        durability: 'unknown',
      },
    })

    controller.start(requested)
    await flushMicrotasks()

    expect(adapter.operationLog).toEqual(['load', 'load'])
    expect(controller.state).toMatchObject({
      phase: 'restoring',
      durability: 'unknown',
      editingNote: null,
      draft: '',
    })
    retryLoad.resolve({ kind: 'absent' })
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: { id: 'requested' },
      draft: 'requested body',
    })
  })

  it('lets recovered work win over a pending start intent', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    controller.start(makeQuickNote({ id: 'requested' }))
    load.resolve(validRecoveredLoad({ snapshot: { draft: 'recovered local' } }))
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'recovery-durable',
      draft: 'recovered local',
      editingNote: { id: 'quick-note-1' },
    })
  })

  it.each([
    ['missing', 'missing'],
    ['trashed', 'trashed'],
    ['archived', 'archived'],
    ['converted', 'converted'],
    ['sync-deleted', 'sync-deleted'],
  ] as const)(
    'restores a %s target with local work as unavailable',
    async (_label, lifecycle) => {
      const note = lifecycle === 'missing'
        ? null
        : makeQuickNote({ id: `note-${lifecycle}` })
      adapter.loadResult = validRecoveredLoad({
        snapshot: {
          noteId: note?.id ?? 'purged-note',
          draft: `local ${lifecycle} work`,
        },
        note,
        lifecycle,
      })
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )

      await flushMicrotasks()

      expect(controller.state).toMatchObject({
        phase: 'target-unavailable',
        durability: 'recovery-durable',
        editingNote: { id: note?.id ?? 'purged-note' },
        draft: `local ${lifecycle} work`,
        conflict: null,
        issue: null,
      })
      expect(adapter.clearCalls).toEqual([])
    },
  )

  it.each([
    ['missing', 'missing'],
    ['trashed', 'trashed'],
    ['archived', 'archived'],
    ['converted', 'converted'],
    ['sync-deleted', 'sync-deleted'],
  ] as const)(
    'clears a %s target recovery when it has no local work',
    async (_label, lifecycle) => {
      const note = lifecycle === 'missing'
        ? null
        : makeQuickNote({ id: `note-${lifecycle}` })
      const snapshot = makeSnapshot({
        noteId: note?.id ?? 'purged-note',
        draft: '  base  ',
      })
      adapter.loadResult = validRecoveredLoad({ snapshot, note, lifecycle })
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )

      await flushMicrotasks()

      expectIdle(controller.state)
      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: snapshot.editId, revision: snapshot.revision },
      ]])
    },
  )

  it('uses a private missing-target display anchor without sending it outward', async () => {
    const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
    const snapshot = makeSnapshot({
      noteId: 'purged-note',
      baseContent: 'display base',
      baseUpdatedAt: '2026-06-30T10:11:12.000Z',
      draft: 'complete local work',
    })
    adapter.loadResult = validRecoveredLoad({
      snapshot,
      note: null,
      lifecycle: 'missing',
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter, onSaved),
    )

    await flushMicrotasks()

    expect(controller.state.editingNote).toEqual({
      id: 'purged-note',
      content: 'display base',
      mood: null,
      tags: [],
      pinned: false,
      archived_at: null,
      archive_file_path: null,
      session_id: null,
      folder_id: null,
      trashed_at: null,
      migrated_to_note_id: null,
      created_at: '2026-06-30T10:11:12.000Z',
      updated_at: '2026-06-30T10:11:12.000Z',
    })
    expect(controller.state.draft).toBe('complete local work')
    expect(adapter.readTargetCalls).toEqual([])
    expect(adapter.checkpointCalls).toEqual([])
    expect(adapter.updateCalls).toEqual([])
    expect(adapter.clearCalls).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it.each([
    ['equal active', validRecoveredLoad({ snapshot: { draft: 'base' } })],
    [
      'remote-only active',
      validRecoveredLoad({
        snapshot: { draft: 'base' },
        note: makeQuickNote({
          content: 'remote',
          updated_at: '2026-07-12T05:00:00.000Z',
        }),
      }),
    ],
    [
      'unavailable clean',
      validRecoveredLoad({
        snapshot: { draft: 'base' },
        note: null,
        lifecycle: 'missing',
      }),
    ],
  ] as const)(
    'blocks replacement when %s cleanup reports a different edit',
    async (_label, loadResult) => {
      adapter.loadResult = loadResult
      adapter.clearResult = 'different-edit'
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )

      await flushMicrotasks()

      expect(controller.state.phase).toBe('failed')
      expect(controller.state.durability).toBe('recovery-durable')
      expect(controller.state.issue).toEqual({
        code: 'recovery-cleanup-failed',
        retryable: true,
        durability: 'recovery-durable',
      })
      const before = controller.getSnapshot()
      controller.start(makeQuickNote({ id: 'replacement' }))
      expect(controller.getSnapshot()).toBe(before)
    },
  )

  it('blocks replacement when valid recovery cleanup rejects', async () => {
    adapter.loadResult = validRecoveredLoad({ snapshot: { draft: 'base' } })
    adapter.clearEffects.push(() => Promise.reject(new Error('cleanup failed')))
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'failed',
      durability: 'recovery-durable',
      editingNote: { id: 'quick-note-1' },
      draft: 'base',
      issue: {
        code: 'recovery-cleanup-failed',
        retryable: true,
        durability: 'recovery-durable',
      },
    })
  })

  it('refuses visible ownership while restoring even as the pending intent changes', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const before = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'first', content: 'first' }))
    controller.start(makeQuickNote({ id: 'replacement', content: 'replacement' }))

    expect(controller.getSnapshot()).toBe(before)
    expect(controller.state.editingNote).toBeNull()
    expect(controller.state.draft).toBe('')
  })

  it('refuses replacement of a dirty slot', async () => {
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote({ id: 'owned', content: 'base' }))
    controller.change('complete dirty draft')
    const before = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'replacement', content: 'other' }))

    expect(controller.getSnapshot()).toBe(before)
    expect(controller.state.editingNote?.id).toBe('owned')
    expect(controller.state.draft).toBe('complete dirty draft')
  })

  it('refuses replacement of a failed slot', async () => {
    adapter.loadResult = { kind: 'invalid', owner: { kind: 'raw', value: 'bad' } }
    adapter.clearResult = 'different-edit'
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    const before = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'replacement' }))

    expect(controller.getSnapshot()).toBe(before)
  })

  it('refuses replacement of a conflict slot', async () => {
    adapter.loadResult = validRecoveredLoad({
      snapshot: { draft: 'local' },
      note: makeQuickNote({
        content: 'remote',
        updated_at: '2026-07-12T05:00:00.000Z',
      }),
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    const before = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'replacement' }))

    expect(controller.getSnapshot()).toBe(before)
    expect(controller.state.draft).toBe('local')
  })

  it('refuses replacement of a target-unavailable slot', async () => {
    adapter.loadResult = validRecoveredLoad({
      snapshot: { noteId: 'missing', draft: 'local' },
      note: null,
      lifecycle: 'missing',
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    const before = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'replacement' }))

    expect(controller.getSnapshot()).toBe(before)
    expect(controller.state.editingNote?.id).toBe('missing')
    expect(controller.state.draft).toBe('local')
  })

  it('replaces a clean saved slot with a new stable edit', async () => {
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote({ id: 'first', content: 'first' }))
    const firstSnapshot = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'second', content: 'second' }))

    expect(controller.getSnapshot()).not.toBe(firstSnapshot)
    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: { id: 'second' },
      draft: 'second',
      issue: null,
    })
    expect(adapter.checkpointCalls).toEqual([])
  })

  it('changes synchronously, accepts blank content, and publishes memory-only durability', async () => {
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote({ content: 'base' }))
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.change('   ')

    expect(listener).toHaveBeenCalledOnce()
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      editingNote: { id: 'quick-note-1' },
      draft: '   ',
      conflict: null,
      issue: null,
    })
    expect(adapter.operationLog).toEqual(['load'])
  })

  it('keeps snapshots stable between publications and supports unsubscribe', async () => {
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    const idleSnapshot = controller.getSnapshot()
    expect(controller.getSnapshot()).toBe(idleSnapshot)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    controller.start(makeQuickNote())
    const startedSnapshot = controller.getSnapshot()

    expect(startedSnapshot).not.toBe(idleSnapshot)
    expect(controller.getSnapshot()).toBe(startedSnapshot)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    controller.change('new draft')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('drains only after the initial restore settles', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const drained = vi.fn()
    const drain = controller.drainBeforeSwitch().then(drained)

    await flushMicrotasks()
    expect(drained).not.toHaveBeenCalled()
    load.resolve({ kind: 'absent' })
    await drain

    expect(drained).toHaveBeenCalledOnce()
  })

  it('suppresses publication from a load that completes after deactivation', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const listener = vi.fn()
    controller.subscribe(listener)
    const before = controller.getSnapshot()

    controller.deactivate()
    load.resolve(validRecoveredLoad())
    await flushMicrotasks()

    expect(controller.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('suppresses publication from cleanup that completes after deactivation', async () => {
    const clear = createDeferred<'cleared' | 'absent' | 'different-edit'>()
    adapter.loadResult = validRecoveredLoad({ snapshot: { draft: 'base' } })
    adapter.clearEffects.push(() => clear.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const listener = vi.fn()
    controller.subscribe(listener)
    await flushMicrotasks()
    const before = controller.getSnapshot()

    controller.deactivate()
    clear.resolve('cleared')
    await flushMicrotasks()

    expect(controller.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('makes future and inactive methods safe no-ops', async () => {
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    const before = controller.getSnapshot()

    controller.observeProjection({
      quickNotes: [],
      trashedQuickNotes: [],
      lifecycleStateById: {},
    })
    controller.requestBestEffortCheckpoint()
    expect(controller.getSnapshot()).toBe(before)

    controller.deactivate()
    controller.start(makeQuickNote({ id: 'inactive' }))
    controller.change('inactive')
    controller.observeProjection({
      quickNotes: [makeQuickNote()],
      trashedQuickNotes: [],
      lifecycleStateById: {},
    })
    controller.requestBestEffortCheckpoint()
    await expect(controller.drainBeforeSwitch()).resolves.toBeUndefined()
    expect(controller.getSnapshot()).toBe(before)
  })

  it('grants edit ownership only to the latest start intent while recovery cleanup is pending', async () => {
    const clear = createDeferred<'cleared' | 'absent' | 'different-edit'>()
    adapter.loadResult = validRecoveredLoad({ snapshot: { draft: 'base' } })
    adapter.clearEffects.push(() => clear.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const publishedSnapshots: QuickNoteExistingEditState[] = []
    controller.subscribe(() => {
      publishedSnapshots.push(controller.getSnapshot())
    })

    await flushMicrotasks()
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: 'recovered-edit-1', revision: 1 },
    ]])
    controller.start(makeQuickNote({ id: 'first', content: 'first content' }))
    controller.start(makeQuickNote({ id: 'latest', content: 'latest content' }))

    expect(controller.state.phase).toBe('restoring')
    expect(controller.state.editingNote).toBeNull()
    expect(publishedSnapshots).toEqual([])
    clear.resolve('cleared')
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: { id: 'latest' },
      draft: 'latest content',
    })
    const publishedOwnerIds = publishedSnapshots.flatMap((snapshot) => (
      snapshot.editingNote ? [snapshot.editingNote.id] : []
    ))
    expect(publishedOwnerIds).not.toContain('first')
    expect(publishedOwnerIds).toEqual(['latest'])
  })

  it('grants edit ownership only to the latest start intent during recovery-read retry', async () => {
    const retryLoad = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(
      () => Promise.reject(new Error('read failed')),
      () => retryLoad.promise,
    )
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const publishedSnapshots: QuickNoteExistingEditState[] = []
    controller.subscribe(() => {
      publishedSnapshots.push(controller.getSnapshot())
    })
    await flushMicrotasks()

    controller.start(makeQuickNote({ id: 'first', content: 'first content' }))
    controller.start(makeQuickNote({ id: 'latest', content: 'latest content' }))
    await flushMicrotasks()

    expect(controller.state.phase).toBe('restoring')
    expect(controller.state.editingNote).toBeNull()
    expect(publishedSnapshots.every((snapshot) => (
      snapshot.editingNote === null
    ))).toBe(true)
    expect(adapter.operationLog).toEqual(['load', 'load'])

    retryLoad.resolve({ kind: 'absent' })
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: { id: 'latest' },
      draft: 'latest content',
    })
    const publishedOwnerIds = publishedSnapshots.flatMap((snapshot) => (
      snapshot.editingNote ? [snapshot.editingNote.id] : []
    ))
    expect(publishedOwnerIds).not.toContain('first')
    expect(publishedOwnerIds).toEqual(['latest'])
  })

  it('classifies an updated_at-only entity change as a base change', async () => {
    const remote = makeQuickNote({
      content: 'base',
      updated_at: '2026-07-12T05:00:00.000Z',
    })
    adapter.loadResult = validRecoveredLoad({
      snapshot: { draft: 'local content' },
      note: remote,
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'conflict',
      durability: 'recovery-durable',
      editingNote: remote,
      draft: 'local content',
      conflict: {
        note: remote,
        localDraft: 'local content',
        remoteContent: 'base',
      },
    })
    expect(adapter.clearCalls).toEqual([])
  })

  it('classifies a content-only entity change as a base change', async () => {
    const remote = makeQuickNote({
      content: 'remote content',
      updated_at: BASE_UPDATED_AT,
    })
    adapter.loadResult = validRecoveredLoad({
      snapshot: { draft: 'local content' },
      note: remote,
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'conflict',
      durability: 'recovery-durable',
      editingNote: remote,
      draft: 'local content',
      conflict: {
        note: remote,
        localDraft: 'local content',
        remoteContent: 'remote content',
      },
    })
    expect(adapter.clearCalls).toEqual([])
  })

  it('preserves the complete stored snapshot when recovery cleanup rejects and attempts cleanup once', async () => {
    const expectedStored = makeSnapshot({
      editId: 'stored-edit',
      revision: 7,
      noteId: 'stored-note',
      baseContent: 'stored base',
      baseUpdatedAt: '2026-07-12T03:00:00.000Z',
      draft: 'stored base',
      updatedAt: '2026-07-12T03:30:00.000Z',
    })
    const storedClone = { ...expectedStored }
    const loadClone = { ...expectedStored }
    adapter.stored = storedClone
    adapter.loadResult = validRecoveredLoad({
      snapshot: loadClone,
      note: makeQuickNote({
        id: expectedStored.noteId,
        content: expectedStored.baseContent,
        updated_at: expectedStored.baseUpdatedAt,
      }),
    })
    adapter.clearEffects.push(() => Promise.reject(new Error('cleanup failed')))
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )

    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'failed',
      durability: 'recovery-durable',
      editingNote: { id: 'stored-note' },
      draft: 'stored base',
      issue: { code: 'recovery-cleanup-failed' },
    })
    expect(adapter.stored).toEqual(expectedStored)
    expect(adapter.stored).toBe(storedClone)
    expect(adapter.clearCalls).toEqual([[
      {
        kind: 'v1',
        editId: expectedStored.editId,
        revision: expectedStored.revision,
      },
    ]])
  })

  it('ignores change while restoring so recovered content remains authoritative', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const listener = vi.fn()
    controller.subscribe(listener)
    const before = controller.getSnapshot()

    controller.change('must not replace recovery')

    expect(controller.getSnapshot()).toBe(before)
    expect(controller.state.phase).toBe('restoring')
    expect(controller.state.draft).toBe('')
    expect(listener).not.toHaveBeenCalled()

    load.resolve(validRecoveredLoad({ snapshot: { draft: 'recovered content' } }))
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'recovery-durable',
      draft: 'recovered content',
    })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('drains only after deferred recovery cleanup completes', async () => {
    const clear = createDeferred<'cleared' | 'absent' | 'different-edit'>()
    adapter.loadResult = validRecoveredLoad({ snapshot: { draft: 'base' } })
    adapter.clearEffects.push(() => clear.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    const drained = vi.fn()
    const drain = controller.drainBeforeSwitch().then(drained)

    await flushMicrotasks()
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: 'recovered-edit-1', revision: 1 },
    ]])
    expect(drained).not.toHaveBeenCalled()
    clear.resolve('cleared')
    await drain

    expect(drained).toHaveBeenCalledOnce()
    expectIdle(controller.state)
  })

  it('observes expected asynchronous rejections without an unhandled event', async () => {
    const onUnhandled = vi.fn((event: PromiseRejectionEvent) => {
      event.preventDefault()
    })
    const load = createDeferred<ExistingEditLoadResult>()
    adapter.loadEffects.push(() => load.promise)
    window.addEventListener('unhandledrejection', onUnhandled)

    try {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      load.reject(new Error('expected read failure'))
      await flushMicrotasks()
      await vi.runAllTimersAsync()

      expect(controller.state.issue?.code).toBe('recovery-read-failed')
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled)
    }
  })

  it('checkpoints at 500ms and starts entity autosave at 900ms', async () => {
    const updated = makeQuickNote({
      content: 'local revision',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: updated }
    const onSaved = vi.fn((note: QuickNote): undefined => {
      adapter.operationLog.push(`projection:${note.content}`)
      return undefined
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter, onSaved),
    )
    await flushMicrotasks()
    adapter.operationLog.length = 0
    controller.start(makeQuickNote())
    controller.change('local revision')

    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.operationLog).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.operationLog).toEqual(['checkpoint:local revision'])
    await vi.advanceTimersByTimeAsync(399)
    expect(adapter.updateCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(adapter.operationLog).toEqual([
      'checkpoint:local revision',
      'checkpoint:local revision',
      'update:local revision',
      'clear',
      'projection:local revision',
    ])
    expect(adapter.updateCalls).toEqual([{
      noteId: 'quick-note-1',
      baseContent: 'base',
      baseUpdatedAt: BASE_UPDATED_AT,
      draft: 'local revision',
    }])
  })

  it('serializes a successor checkpoint behind an older lane task', async () => {
    const firstCheckpoint = createDeferred<void>()
    adapter.checkpointEffects.push(() => firstCheckpoint.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    adapter.operationLog.length = 0
    controller.start(makeQuickNote())
    controller.change('revision one')

    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.operationLog).toEqual(['checkpoint:revision one'])
    controller.change('revision two')
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.operationLog).toEqual(['checkpoint:revision one'])

    firstCheckpoint.resolve()
    await flushMicrotasks()

    expect(adapter.operationLog).toEqual([
      'checkpoint:revision one',
      'checkpoint:revision two',
    ])
  })

  it('keeps the latest revision memory-only when an older checkpoint completes', async () => {
    const firstCheckpoint = createDeferred<void>()
    adapter.checkpointEffects.push(() => firstCheckpoint.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    await vi.advanceTimersByTimeAsync(500)
    expect(controller.state.phase).toBe('checkpointing')

    controller.change('revision two')
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'revision two',
    })
    firstCheckpoint.resolve()
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'revision two',
    })
  })

  it('skips a stale autosave before entity update', async () => {
    adapter.updateResult = {
      kind: 'updated',
      note: makeQuickNote({
        content: 'latest revision',
        updated_at: '2026-07-12T04:00:02.000Z',
      }),
    }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('stale revision')

    await vi.advanceTimersByTimeAsync(899)
    controller.change('latest revision')
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.updateCalls).toEqual([])

    await vi.advanceTimersByTimeAsync(899)
    expect(adapter.updateCalls).toHaveLength(1)
    expect(adapter.updateCalls[0]?.draft).toBe('latest revision')
  })

  it('saves checkpoint then entity then cleanup then projection', async () => {
    const updated = makeQuickNote({
      content: 'complete local draft',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: updated }
    const onSaved = vi.fn((note: QuickNote): undefined => {
      adapter.operationLog.push(`projection:${note.content}`)
      return undefined
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter, onSaved),
    )
    await flushMicrotasks()
    adapter.operationLog.length = 0
    controller.start(makeQuickNote())
    controller.change('complete local draft')

    const result = await controller.save()

    expect(result).toEqual({
      kind: 'saved',
      note: updated,
      visibility: 'refreshed',
    })
    expect(adapter.operationLog).toEqual([
      'checkpoint:complete local draft',
      'update:complete local draft',
      'clear',
      'projection:complete local draft',
    ])
    expect(adapter.checkpointCalls).toEqual([{
      version: QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION,
      editId: 'edit-1',
      revision: 1,
      noteId: 'quick-note-1',
      baseContent: 'base',
      baseUpdatedAt: BASE_UPDATED_AT,
      draft: 'complete local draft',
      updatedAt: BASE_UPDATED_AT,
    }])
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: 'edit-1', revision: 1 },
    ]])
    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: updated,
      draft: 'complete local draft',
      issue: null,
    })
  })

  it('rebases a successor after an older entity commit without self-conflict', async () => {
    const firstUpdate = createDeferred<ExistingEditUpdateResult>()
    const firstCommitted = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    const secondCommitted = makeQuickNote({
      content: 'revision two',
      updated_at: '2026-07-12T04:00:03.000Z',
    })
    adapter.updateEffects.push(() => firstUpdate.promise)
    adapter.updateResult = { kind: 'updated', note: secondCommitted }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const olderSave = controller.save()
    await flushMicrotasks()
    expect(controller.state.phase).toBe('saving')

    controller.change('revision two')
    firstUpdate.resolve({ kind: 'updated', note: firstCommitted })
    await olderSave

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      editingNote: firstCommitted,
      draft: 'revision two',
    })
    const successorResult = await controller.save()

    expect(successorResult.kind).toBe('saved')
    expect(adapter.updateCalls).toEqual([
      {
        noteId: 'quick-note-1',
        baseContent: 'base',
        baseUpdatedAt: BASE_UPDATED_AT,
        draft: 'revision one',
      },
      {
        noteId: 'quick-note-1',
        baseContent: 'revision one',
        baseUpdatedAt: '2026-07-12T04:00:02.000Z',
        draft: 'revision two',
      },
    ])
  })

  it('materializes a rebased base when a queued successor checkpoint starts', async () => {
    const firstUpdate = createDeferred<ExistingEditUpdateResult>()
    const firstCommitted = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateEffects.push(() => firstUpdate.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const olderSave = controller.save()
    await flushMicrotasks()

    controller.change('revision two')
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.checkpointCalls).toHaveLength(1)
    firstUpdate.resolve({ kind: 'updated', note: firstCommitted })
    await olderSave
    await flushMicrotasks()

    expect(adapter.checkpointCalls).toHaveLength(2)
    expect(adapter.checkpointCalls[1]).toMatchObject({
      revision: 2,
      baseContent: 'revision one',
      baseUpdatedAt: '2026-07-12T04:00:02.000Z',
      draft: 'revision two',
    })
  })

  it('does not publish durability after a checkpoint base generation changes', async () => {
    const firstUpdate = createDeferred<ExistingEditUpdateResult>()
    const successorCheckpoint = createDeferred<void>()
    const firstCommitted = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateEffects.push(() => firstUpdate.promise)
    adapter.checkpointEffects.push(
      () => Promise.resolve(),
      () => successorCheckpoint.promise,
    )
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const olderSave = controller.save()
    await flushMicrotasks()

    controller.change('revision two')
    await vi.advanceTimersByTimeAsync(500)
    firstUpdate.resolve({ kind: 'updated', note: firstCommitted })
    await olderSave
    await flushMicrotasks()
    expect(adapter.checkpointCalls[1]).toMatchObject({
      baseContent: 'revision one',
      baseUpdatedAt: '2026-07-12T04:00:02.000Z',
    })

    controller.change('revision three')
    successorCheckpoint.resolve()
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'revision three',
    })
  })

  it('does not clear an older row while a newer revision is memory-only', async () => {
    const update = createDeferred<ExistingEditUpdateResult>()
    const committed = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateEffects.push(() => update.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const save = controller.save()
    await flushMicrotasks()
    expect(adapter.stored).toMatchObject({ revision: 1, draft: 'revision one' })

    controller.change('revision two')
    update.resolve({ kind: 'updated', note: committed })
    await save

    expect(adapter.clearCalls).toEqual([])
    expect(adapter.stored).toMatchObject({ revision: 1, draft: 'revision one' })
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'revision two',
    })
  })

  it('checkpoints blank input but returns empty from save', async () => {
    const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter, onSaved),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('   ')

    const result = await controller.save({ closeAfterSave: true })

    expect(result).toEqual({ kind: 'empty' })
    expect(adapter.checkpointCalls).toEqual([{
      version: QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION,
      editId: 'edit-1',
      revision: 1,
      noteId: 'quick-note-1',
      baseContent: 'base',
      baseUpdatedAt: BASE_UPDATED_AT,
      draft: '   ',
      updatedAt: BASE_UPDATED_AT,
    }])
    expect(adapter.updateCalls).toEqual([])
    expect(adapter.clearCalls).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'recovery-durable',
      draft: '   ',
    })
  })

  it('refuses replacement while checkpointing', async () => {
    const checkpoint = createDeferred<void>()
    adapter.checkpointEffects.push(() => checkpoint.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote({ id: 'owned' }))
    controller.change('local')
    await vi.advanceTimersByTimeAsync(500)
    expect(controller.state.phase).toBe('checkpointing')
    const before = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'replacement' }))

    expect(controller.getSnapshot()).toBe(before)
    expect(controller.state.editingNote?.id).toBe('owned')
    checkpoint.resolve()
    await flushMicrotasks()
  })

  it('refuses replacement while saving', async () => {
    const update = createDeferred<ExistingEditUpdateResult>()
    adapter.updateEffects.push(() => update.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote({ id: 'owned' }))
    controller.change('local')
    const save = controller.save()
    await flushMicrotasks()
    const before = controller.getSnapshot()

    controller.start(makeQuickNote({ id: 'replacement' }))

    expect(controller.getSnapshot()).toBe(before)
    expect(controller.state.editingNote?.id).toBe('owned')
    update.resolve({
      kind: 'updated',
      note: makeQuickNote({ id: 'owned', content: 'local' }),
    })
    await save
  })

  it('retains the owner frontier when the latest save checkpoint rejects', async () => {
    const updated = makeQuickNote({
      content: 'revision two',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: updated }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.stored).toMatchObject({ revision: 1 })

    controller.change('revision two')
    adapter.checkpointEffects.push(() => Promise.reject(new Error('blocked')))
    const result = await controller.save()

    expect(result).toEqual({
      kind: 'saved',
      note: updated,
      visibility: 'refreshed',
    })
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: 'edit-1', revision: 1 },
      { kind: 'v1', editId: 'edit-1', revision: 2 },
    ]])
    expect(adapter.stored).toBeNull()
    expect(adapter.updateCalls).toHaveLength(1)

    adapter.loadResult = { kind: 'absent' }
    const reconstructed = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()

    expectIdle(reconstructed.state)
    expect(adapter.updateCalls).toHaveLength(1)
  })

  it('coalesces the same exact edit and revision save into one Promise', async () => {
    const autosaveCheckpoint = createDeferred<void>()
    adapter.checkpointEffects.push(
      () => Promise.resolve(),
      () => autosaveCheckpoint.promise,
    )
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('single flight')
    await vi.advanceTimersByTimeAsync(900)
    expect(controller.state.phase).toBe('saving')
    expect(adapter.checkpointCalls).toHaveLength(2)

    const first = controller.save({ closeAfterSave: true })
    const second = controller.save({ closeAfterSave: false })

    expect(second).toBe(first)
    autosaveCheckpoint.resolve()
    await expect(first).resolves.toMatchObject({ kind: 'saved' })
    expect(adapter.updateCalls).toHaveLength(1)
    expectIdle(controller.state)
  })

  it('resets both trailing timers so only the latest capture reaches storage', async () => {
    adapter.updateResult = {
      kind: 'updated',
      note: makeQuickNote({
        content: 'latest capture',
        updated_at: '2026-07-12T04:00:02.000Z',
      }),
    }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    adapter.operationLog.length = 0
    controller.start(makeQuickNote())
    controller.change('superseded capture')
    await vi.advanceTimersByTimeAsync(400)
    controller.change('latest capture')

    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.operationLog).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.operationLog).toEqual(['checkpoint:latest capture'])
    await vi.advanceTimersByTimeAsync(399)
    expect(adapter.updateCalls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(adapter.updateCalls).toHaveLength(1)
    expect(adapter.updateCalls[0]?.draft).toBe('latest capture')
    expect(adapter.checkpointCalls.every((call) => (
      call.draft === 'latest capture'
    ))).toBe(true)
  })

  it('accepts new input during checkpointing and preserves latest durability', async () => {
    const checkpoint = createDeferred<void>()
    adapter.checkpointEffects.push(() => checkpoint.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('older checkpoint')
    await vi.advanceTimersByTimeAsync(500)
    expect(controller.state.phase).toBe('checkpointing')

    controller.change('new during checkpoint')
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'new during checkpoint',
    })
    checkpoint.resolve()
    await flushMicrotasks()

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'new during checkpoint',
    })
  })

  it('accepts new input during saving and rebases the latest dirty revision', async () => {
    const update = createDeferred<ExistingEditUpdateResult>()
    const committed = makeQuickNote({
      content: 'older save',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateEffects.push(() => update.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('older save')
    const save = controller.save()
    await flushMicrotasks()

    controller.change('new during save')
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'new during save',
    })
    update.resolve({ kind: 'updated', note: committed })
    await save

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      editingNote: committed,
      draft: 'new during save',
    })
    expect(adapter.clearCalls).toEqual([])
  })

  it('serializes restore load and recovery cleanup through the mutable lane', async () => {
    const load = createDeferred<ExistingEditLoadResult>()
    const clear = createDeferred<'cleared' | 'absent' | 'different-edit'>()
    adapter.loadEffects.push(() => load.promise)
    adapter.clearEffects.push(() => clear.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    expect(adapter.operationLog).toEqual(['load'])

    controller.start(makeQuickNote({ id: 'pending', content: 'pending base' }))
    load.resolve(validRecoveredLoad({ snapshot: { draft: 'base' } }))
    await flushMicrotasks()
    expect(adapter.operationLog).toEqual(['load', 'clear'])
    expect(controller.state.phase).toBe('restoring')

    clear.resolve('cleared')
    await flushMicrotasks()
    controller.change('pending local')
    await vi.advanceTimersByTimeAsync(500)

    expect(adapter.operationLog).toEqual([
      'load',
      'clear',
      'checkpoint:pending local',
    ])
  })

  it('returns a typed conflict from the authoritative entity update', async () => {
    const remote = makeQuickNote({
      content: 'remote revision',
      updated_at: '2026-07-12T05:00:00.000Z',
    })
    adapter.updateResult = { kind: 'conflict', note: remote }
    const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter, onSaved),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('local revision')

    const result = await controller.save()

    expect(result).toEqual({
      kind: 'conflict',
      conflict: {
        note: remote,
        localDraft: 'local revision',
        remoteContent: 'remote revision',
      },
    })
    expect(controller.state).toMatchObject({
      phase: 'conflict',
      durability: 'recovery-durable',
      draft: 'local revision',
      conflict: {
        note: remote,
        localDraft: 'local revision',
        remoteContent: 'remote revision',
      },
    })
    expect(adapter.clearCalls).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('returns a typed unavailable result from the authoritative entity update', async () => {
    adapter.updateResult = { kind: 'unavailable', lifecycle: 'trashed' }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('local revision')

    const result = await controller.save()

    expect(result).toEqual({ kind: 'unavailable', lifecycle: 'trashed' })
    expect(controller.state).toMatchObject({
      phase: 'target-unavailable',
      durability: 'recovery-durable',
      draft: 'local revision',
    })
    expect(adapter.clearCalls).toEqual([])
  })

  it('returns saved pending when projection throws after entity durability', async () => {
    const updated = makeQuickNote({
      content: 'local revision',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: updated }
    const onSaved = vi.fn((_note: QuickNote): undefined => {
      throw new Error('projection unavailable')
    })
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter, onSaved),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('local revision')

    const result = await controller.save()

    expect(result).toEqual({
      kind: 'saved',
      note: updated,
      visibility: 'pending',
    })
    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: updated,
      issue: {
        code: 'projection-failed',
        retryable: false,
        durability: 'entity-durable',
      },
    })
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('rebases a successor save that was queued before the older commit', async () => {
    const firstUpdate = createDeferred<ExistingEditUpdateResult>()
    const firstCommitted = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    const secondCommitted = makeQuickNote({
      content: 'revision two',
      updated_at: '2026-07-12T04:00:03.000Z',
    })
    adapter.updateEffects.push(
      () => firstUpdate.promise,
      async () => {
        const capture = adapter.updateCalls.at(-1)
        if (
          capture?.baseContent !== firstCommitted.content
          || capture.baseUpdatedAt !== firstCommitted.updated_at
        ) return { kind: 'conflict', note: firstCommitted }
        return { kind: 'updated', note: secondCommitted }
      },
    )
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const olderSave = controller.save()
    await flushMicrotasks()

    controller.change('revision two')
    const successorSave = controller.save()
    expect(adapter.updateCalls).toHaveLength(1)
    firstUpdate.resolve({ kind: 'updated', note: firstCommitted })

    await expect(olderSave).resolves.toMatchObject({ kind: 'saved' })
    await expect(successorSave).resolves.toEqual({
      kind: 'saved',
      note: secondCommitted,
      visibility: 'refreshed',
    })
    expect(adapter.updateCalls[1]).toEqual({
      noteId: 'quick-note-1',
      baseContent: 'revision one',
      baseUpdatedAt: '2026-07-12T04:00:02.000Z',
      draft: 'revision two',
    })
  })

  it('materializes each owned base across multiple queued successor saves', async () => {
    const firstUpdate = createDeferred<ExistingEditUpdateResult>()
    const committed = [
      makeQuickNote({
        content: 'revision one',
        updated_at: '2026-07-12T04:00:02.000Z',
      }),
      makeQuickNote({
        content: 'revision two',
        updated_at: '2026-07-12T04:00:03.000Z',
      }),
      makeQuickNote({
        content: 'revision three',
        updated_at: '2026-07-12T04:00:04.000Z',
      }),
    ]
    adapter.updateEffects.push(
      () => firstUpdate.promise,
      async () => ({ kind: 'updated', note: committed[1]! }),
      async () => ({ kind: 'updated', note: committed[2]! }),
    )
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const saves = [controller.save()]
    await flushMicrotasks()

    controller.change('revision two')
    saves.push(controller.save())
    controller.change('revision three')
    saves.push(controller.save())
    firstUpdate.resolve({ kind: 'updated', note: committed[0]! })
    await Promise.all(saves)

    expect(adapter.updateCalls).toEqual([
      {
        noteId: 'quick-note-1',
        baseContent: 'base',
        baseUpdatedAt: BASE_UPDATED_AT,
        draft: 'revision one',
      },
      {
        noteId: 'quick-note-1',
        baseContent: 'revision one',
        baseUpdatedAt: '2026-07-12T04:00:02.000Z',
        draft: 'revision two',
      },
      {
        noteId: 'quick-note-1',
        baseContent: 'revision two',
        baseUpdatedAt: '2026-07-12T04:00:03.000Z',
        draft: 'revision three',
      },
    ])
  })

  it('merges owners that become durable after a save was queued', async () => {
    const olderCheckpoint = createDeferred<void>()
    const updated = makeQuickNote({
      content: 'revision two',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.checkpointEffects.push(() => olderCheckpoint.promise)
    adapter.updateResult = { kind: 'updated', note: updated }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    await vi.advanceTimersByTimeAsync(500)

    controller.change('revision two')
    adapter.checkpointEffects.push(() => Promise.reject(new Error('blocked')))
    const save = controller.save()
    expect(adapter.clearCalls).toEqual([])
    olderCheckpoint.resolve()
    const result = await save

    expect(result).toEqual({
      kind: 'saved',
      note: updated,
      visibility: 'refreshed',
    })
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: 'edit-1', revision: 1 },
      { kind: 'v1', editId: 'edit-1', revision: 2 },
    ]])
    expect(adapter.stored).toBeNull()
  })

  it('rechecks synchronous subscriber input before cleanup', async () => {
    const committed = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: committed }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    let changed = false
    controller.subscribe(() => {
      if (
        !changed
        && controller.state.phase === 'saving'
        && controller.state.durability === 'entity-durable'
      ) {
        changed = true
        controller.change('revision two from subscriber')
      }
    })

    await expect(controller.save()).resolves.toMatchObject({ kind: 'saved' })

    expect(changed).toBe(true)
    expect(adapter.clearCalls).toEqual([])
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      editingNote: committed,
      draft: 'revision two from subscriber',
    })
  })

  it('does not cleanup after deactivation hides a newer memory-only revision', async () => {
    const update = createDeferred<ExistingEditUpdateResult>()
    const committed = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateEffects.push(() => update.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const save = controller.save()
    await flushMicrotasks()

    controller.change('revision two before deactivation')
    const beforeDeactivate = controller.getSnapshot()
    controller.deactivate()
    update.resolve({ kind: 'updated', note: committed })
    await save

    expect(adapter.clearCalls).toEqual([])
    expect(controller.getSnapshot()).toBe(beforeDeactivate)
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'revision two before deactivation',
    })
  })

  it('restores a successor checkpoint when cleanup clears during newer input', async () => {
    const clear = createDeferred<'cleared' | 'absent' | 'different-edit'>()
    const committed = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: committed }
    adapter.clearEffects.push(() => clear.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const save = controller.save()
    await flushMicrotasks()
    expect(adapter.clearCalls).toHaveLength(1)
    expect(controller.state).toMatchObject({
      phase: 'saving',
      durability: 'entity-durable',
    })

    controller.change('revision two during cleanup')
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'revision two during cleanup',
    })
    clear.resolve('cleared')
    await save

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'recovery-durable',
      editingNote: committed,
      draft: 'revision two during cleanup',
    })
    expect(adapter.clearCalls).toHaveLength(1)
    expect(adapter.checkpointCalls).toHaveLength(2)
    expect(adapter.checkpointCalls[1]).toMatchObject({
      editId: 'edit-1',
      revision: 2,
      noteId: 'quick-note-1',
      baseContent: 'revision one',
      baseUpdatedAt: '2026-07-12T04:00:02.000Z',
      draft: 'revision two during cleanup',
    })
    expect(adapter.stored).toMatchObject({
      revision: 2,
      draft: 'revision two during cleanup',
    })
  })

  it('exposes the identical real Promise to a reentrant same-revision save', async () => {
    const committed = makeQuickNote({
      content: 'single revision',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: committed }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('single revision')
    let reentered = false
    let reentrantSave: ReturnType<typeof controller.save> | undefined
    controller.subscribe(() => {
      if (!reentered && controller.state.phase === 'saving') {
        reentered = true
        reentrantSave = controller.save({ closeAfterSave: true })
      }
    })

    const firstSave = controller.save({ closeAfterSave: false })

    expect(reentrantSave).toBeInstanceOf(Promise)
    expect(reentrantSave).toBe(firstSave)
    await expect(firstSave).resolves.toMatchObject({ kind: 'saved' })
    expect(adapter.updateCalls).toHaveLength(1)
    expectIdle(controller.state)
  })

  it('keeps rev1 ahead of a rev2 save queued by the saving subscriber', async () => {
    const committedOne = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    const committedTwo = makeQuickNote({
      content: 'revision two',
      updated_at: '2026-07-12T04:00:03.000Z',
    })
    adapter.updateEffects.push(
      async () => ({ kind: 'updated', note: committedOne }),
      async () => ({ kind: 'updated', note: committedTwo }),
    )
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    let queuedSuccessor = false
    let successorSave: ReturnType<typeof controller.save> | undefined
    controller.subscribe(() => {
      if (!queuedSuccessor && controller.state.phase === 'saving') {
        queuedSuccessor = true
        controller.change('revision two')
        successorSave = controller.save()
      }
    })

    const firstSave = controller.save()
    await Promise.all([firstSave, successorSave])

    expect(adapter.updateCalls.map((capture) => capture.draft)).toEqual([
      'revision one',
      'revision two',
    ])
  })

  it('does not rearm stale timers after a dirty subscriber saves', async () => {
    const committed = makeQuickNote({
      content: 'subscriber save',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: committed }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    let captured = false
    let subscriberSave: ReturnType<typeof controller.save> | undefined
    controller.subscribe(() => {
      if (!captured && controller.state.phase === 'dirty') {
        captured = true
        subscriberSave = controller.save()
      }
    })

    controller.change('subscriber save')
    await subscriberSave
    expect(adapter.checkpointCalls).toHaveLength(1)
    expect(adapter.updateCalls).toHaveLength(1)
    expect(adapter.clearCalls).toHaveLength(1)
    expect(adapter.stored).toBeNull()

    await vi.advanceTimersByTimeAsync(901)

    expect(adapter.checkpointCalls).toHaveLength(1)
    expect(adapter.updateCalls).toHaveLength(1)
    expect(adapter.clearCalls).toHaveLength(1)
    expect(adapter.stored).toBeNull()
  })

  it('keeps repeated background checkpoint authority bounded to the latest row', async () => {
    const committed = makeQuickNote({
      content: 'revision four',
      updated_at: '2026-07-12T04:00:05.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: committed }
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())

    for (let revision = 1; revision <= 4; revision += 1) {
      controller.change(`revision ${revision}`)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(adapter.stored).toMatchObject({
      revision: 4,
      draft: 'revision 4',
    })

    await expect(controller.save()).resolves.toMatchObject({ kind: 'saved' })

    expect(adapter.clearCalls).toEqual([[
      { kind: 'v1', editId: 'edit-1', revision: 4 },
    ]])
    expect(adapter.stored).toBeNull()
  })

  it('does not let mismatched owners clear the controlled stored row', async () => {
    const stored = makeSnapshot({ editId: 'stored-edit', revision: 7 })
    adapter.stored = stored

    const result = await adapter.clearIfOwned([
      { kind: 'v1', editId: 'other-edit', revision: 7 },
      { kind: 'v1', editId: 'stored-edit', revision: 6 },
    ])

    expect(result).toBe('different-edit')
    expect(adapter.stored).toBe(stored)
  })

  it('keeps newer input memory-only when compensation completes stale', async () => {
    const clear = createDeferred<'cleared' | 'absent' | 'different-edit'>()
    const compensation = createDeferred<void>()
    const committed = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: committed }
    adapter.checkpointEffects.push(
      () => Promise.resolve(),
      () => compensation.promise,
    )
    adapter.clearEffects.push(() => clear.promise)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const save = controller.save()
    await flushMicrotasks()

    controller.change('revision two during cleanup')
    clear.resolve('cleared')
    await flushMicrotasks()
    expect(adapter.checkpointCalls).toHaveLength(2)
    controller.change('revision three during compensation')
    compensation.resolve()
    await save

    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'memory-only',
      draft: 'revision three during compensation',
    })
    expect(adapter.stored).toMatchObject({
      revision: 2,
      draft: 'revision two during cleanup',
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'recovery-durable',
      draft: 'revision three during compensation',
    })
    expect(adapter.stored).toMatchObject({
      revision: 3,
      draft: 'revision three during compensation',
    })
  })

  it('does not let an older stacked save overwrite compensated recovery', async () => {
    const firstCleanup = createDeferred<
      'cleared' | 'absent' | 'different-edit'
    >()
    const secondUpdate = createDeferred<ExistingEditUpdateResult>()
    const committedOne = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    const committedTwo = makeQuickNote({
      content: 'revision two',
      updated_at: '2026-07-12T04:00:03.000Z',
    })
    const committedThree = makeQuickNote({
      content: 'revision three',
      updated_at: '2026-07-12T04:00:04.000Z',
    })
    adapter.clearEffects.push(() => firstCleanup.promise)
    adapter.updateEffects.push(
      async () => ({ kind: 'updated', note: committedOne }),
      () => secondUpdate.promise,
      async () => ({ kind: 'updated', note: committedThree }),
    )
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('revision one')
    const firstSave = controller.save()
    await flushMicrotasks()
    expect(adapter.clearCalls).toHaveLength(1)

    controller.change('revision two')
    const secondSave = controller.save()
    controller.change('revision three')
    const thirdSave = controller.save()
    firstCleanup.resolve('cleared')
    await flushMicrotasks()

    const compensatedRecovery = adapter.checkpointCalls.find((call) => (
      call.revision === 3 && call.draft === 'revision three'
    ))
    expect(compensatedRecovery).toBeDefined()
    expect(adapter.updateCalls.map((capture) => capture.draft)).toEqual([
      'revision one',
      'revision two',
    ])
    expect(adapter.stored).toBe(compensatedRecovery)
    expect(adapter.stored).toEqual(compensatedRecovery)
    expect(adapter.checkpointCalls.some((call) => (
      call.revision === 2 && call.draft === 'revision two'
    ))).toBe(false)
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'recovery-durable',
      draft: 'revision three',
    })

    secondUpdate.resolve({ kind: 'updated', note: committedTwo })
    const results = await Promise.all([firstSave, secondSave, thirdSave])

    expect(results.map((result) => result.kind)).toEqual([
      'saved',
      'saved',
      'saved',
    ])
    expect(adapter.updateCalls.map((capture) => capture.draft)).toEqual([
      'revision one',
      'revision two',
      'revision three',
    ])
    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: committedThree,
      draft: 'revision three',
    })
    expect(adapter.stored).toBeNull()
  })

  it('honors a close upgrade from the terminal saved publication', async () => {
    const committed = makeQuickNote({
      content: 'terminal close',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    adapter.updateResult = { kind: 'updated', note: committed }
    const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
    const controller = createQuickNoteExistingEditSessionController(
      controllerOptions(adapter, onSaved),
    )
    await flushMicrotasks()
    controller.start(makeQuickNote())
    controller.change('terminal close')
    let upgraded = false
    let upgradedSave: ReturnType<typeof controller.save> | undefined
    controller.subscribe(() => {
      if (!upgraded && controller.state.phase === 'saved') {
        upgraded = true
        upgradedSave = controller.save({ closeAfterSave: true })
      }
    })

    const firstSave = controller.save({ closeAfterSave: false })
    await expect(firstSave).resolves.toMatchObject({ kind: 'saved' })

    expect(upgradedSave).toBe(firstSave)
    expectIdle(controller.state)
    expect(adapter.checkpointCalls).toHaveLength(1)
    expect(adapter.updateCalls).toHaveLength(1)
    expect(adapter.clearCalls).toHaveLength(1)
    expect(onSaved).toHaveBeenCalledOnce()
  })

})
