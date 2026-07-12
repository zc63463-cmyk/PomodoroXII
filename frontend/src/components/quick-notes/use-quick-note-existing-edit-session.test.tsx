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
    if (result === 'cleared') this.stored = null
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
})
