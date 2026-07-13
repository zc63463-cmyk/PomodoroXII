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

type ExistingEditController = ReturnType<
  typeof createQuickNoteExistingEditSessionController
>

async function enterConflict(
  adapter: ControlledQuickNoteExistingEditAdapter,
  {
    localDraft = 'local revision',
    remote = makeQuickNote({
      content: 'remote revision',
      updated_at: '2026-07-12T05:00:00.000Z',
    }),
    onSaved,
  }: {
    localDraft?: string
    remote?: QuickNote
    onSaved?: (note: QuickNote) => undefined
  } = {},
): Promise<ExistingEditController> {
  adapter.updateResult = { kind: 'conflict', note: remote }
  const controller = createQuickNoteExistingEditSessionController(
    controllerOptions(adapter, onSaved),
  )
  await flushMicrotasks()
  controller.start(makeQuickNote())
  controller.change(localDraft)
  await expect(controller.save()).resolves.toEqual({
    kind: 'conflict',
    conflict: {
      note: remote,
      localDraft,
      remoteContent: remote.content,
    },
  })
  return controller
}

function projectionFor(
  noteId: string,
  lifecycle: QuickNoteLifecycleState | 'missing',
  note: QuickNote | null,
) {
  const lifecycleStateById: Record<string, QuickNoteLifecycleState> = {}
  if (lifecycle !== 'missing') lifecycleStateById[noteId] = lifecycle
  return {
    quickNotes: lifecycle === 'active' && note ? [note] : [],
    trashedQuickNotes: lifecycle === 'trashed' && note ? [note] : [],
    lifecycleStateById,
  }
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
      quickNotes: [makeQuickNote()],
      trashedQuickNotes: [],
      lifecycleStateById: { 'quick-note-1': 'active' },
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

  it('reports latest recovery durability when an older skipped save fails', async () => {
    const firstCleanup = createDeferred<
      'cleared' | 'absent' | 'different-edit'
    >()
    const thirdUpdate = createDeferred<ExistingEditUpdateResult>()
    const committedOne = makeQuickNote({
      content: 'revision one',
      updated_at: '2026-07-12T04:00:02.000Z',
    })
    const committedThree = makeQuickNote({
      content: 'revision three',
      updated_at: '2026-07-12T04:00:04.000Z',
    })
    adapter.clearEffects.push(() => firstCleanup.promise)
    adapter.updateEffects.push(
      async () => ({ kind: 'updated', note: committedOne }),
      () => Promise.reject(new Error('revision two update failed')),
      () => thirdUpdate.promise,
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

    const secondResult = await secondSave

    expect(secondResult).toEqual({
      kind: 'failed',
      issue: {
        code: 'entity-save-failed',
        retryable: true,
        durability: 'recovery-durable',
      },
    })
    expect(adapter.checkpointCalls.some((call) => (
      call.revision === 2 && call.draft === 'revision two'
    ))).toBe(false)
    expect(adapter.stored).toMatchObject({
      editId: 'edit-1',
      revision: 3,
      draft: 'revision three',
    })
    expect(controller.state).toMatchObject({
      phase: 'dirty',
      durability: 'recovery-durable',
      editingNote: committedOne,
      draft: 'revision three',
      issue: null,
    })

    thirdUpdate.resolve({ kind: 'updated', note: committedThree })
    await expect(firstSave).resolves.toMatchObject({ kind: 'saved' })
    await expect(thirdSave).resolves.toMatchObject({ kind: 'saved' })
    expect(controller.state).toMatchObject({
      phase: 'saved',
      durability: 'entity-durable',
      editingNote: committedThree,
      draft: 'revision three',
    })
    expect(adapter.stored).toBeNull()
  })

  describe('Task 5 staged save failures and cleanup receipts', () => {
    it('keeps a successful entity save entity-durable when checkpoint rejects', async () => {
      const committed = makeQuickNote({
        content: 'entity wins',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      adapter.checkpointEffects.push(
        () => Promise.reject(new Error('checkpoint blocked')),
      )
      adapter.updateResult = { kind: 'updated', note: committed }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('entity wins')

      await expect(controller.save()).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'refreshed',
      })
      expect(controller.state).toMatchObject({
        phase: 'saved',
        durability: 'entity-durable',
        draft: 'entity wins',
        issue: null,
      })
    })

    it('reports the latest revision memory-only when checkpoint and entity reject', async () => {
      adapter.checkpointEffects.push(
        () => Promise.reject(new Error('checkpoint blocked')),
      )
      adapter.updateEffects.push(
        () => Promise.reject(new Error('entity blocked')),
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('exact memory draft')

      const result = await controller.save()

      expect(result).toEqual({
        kind: 'failed',
        issue: {
          code: 'checkpoint-failed',
          retryable: true,
          durability: 'memory-only',
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'failed',
        durability: 'memory-only',
        draft: 'exact memory draft',
        issue: result.kind === 'failed' ? result.issue : null,
      })
    })

    it('reports recovery durability when entity update rejects after checkpoint', async () => {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('durable recovery draft')
      await vi.advanceTimersByTimeAsync(500)
      expect(controller.state.durability).toBe('recovery-durable')
      adapter.updateEffects.push(
        () => Promise.reject(new Error('entity blocked')),
      )

      const result = await controller.save()

      expect(result).toEqual({
        kind: 'failed',
        issue: {
          code: 'entity-save-failed',
          retryable: true,
          durability: 'recovery-durable',
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'failed',
        durability: 'recovery-durable',
        draft: 'durable recovery draft',
      })
    })

    it('retries only cleanup after an entity commit whose cleanup rejects', async () => {
      const committed = makeQuickNote({
        content: 'committed once',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('cleanup blocked')),
        async () => 'cleared',
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('committed once')

      await expect(controller.save()).resolves.toEqual({
        kind: 'failed',
        issue: {
          code: 'recovery-cleanup-failed',
          retryable: true,
          durability: 'entity-durable',
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'failed',
        durability: 'entity-durable',
        editingNote: committed,
        draft: 'committed once',
      })
      expect(onSaved).toHaveBeenCalledOnce()
      expect(adapter.checkpointCalls).toHaveLength(1)
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toHaveLength(1)

      await expect(controller.save({ closeAfterSave: true })).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'refreshed',
      })

      expect(adapter.checkpointCalls).toHaveLength(1)
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toHaveLength(2)
      expect(onSaved).toHaveBeenCalledOnce()
      expectIdle(controller.state)
    })

    it.each(['succeeds', 'rejects'] as const)(
      'compensates first-save cleanup after removal when checkpoint %s',
      async (compensation) => {
        const cleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const committed = makeQuickNote({
          content: 'first cleanup removed recovery',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.updateResult = { kind: 'updated', note: committed }
        adapter.clearEffects.push(() => cleanup.promise)
        adapter.readTargetResult = { note: null, lifecycle: 'missing' }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('first cleanup removed recovery')
        const save = controller.save()
        await flushMicrotasks()
        expect(adapter.clearCalls).toHaveLength(1)
        const recoveryBeforeCleanup = adapter.stored
        controller.observeProjection(
          projectionFor(committed.id, 'missing', null),
        )
        if (compensation === 'rejects') {
          adapter.checkpointEffects.push(
            () => Promise.reject(new Error('first-save compensation blocked')),
          )
        }
        cleanup.resolve('cleared')

        await expect(save).resolves.toEqual({
          kind: 'unavailable',
          lifecycle: 'missing',
        })
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        expect(adapter.checkpointCalls).toHaveLength(2)
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.clearCalls).toHaveLength(1)
        expect(onSaved).not.toHaveBeenCalled()
        expect(controller.state).toMatchObject({
          phase: 'target-unavailable',
          durability: compensation === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
          editingNote: committed,
          draft: 'first cleanup removed recovery',
        })
        if (compensation === 'succeeds') {
          expect(adapter.stored).toEqual({
            ...recoveryBeforeCleanup,
            baseContent: committed.content,
            baseUpdatedAt: committed.updated_at,
          })
        } else {
          expect(adapter.stored).toBeNull()
        }
      },
    )

    it('compensates the latest successor after first-save cleanup and removal', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committed = makeQuickNote({
        content: 'first cleanup committed base',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(() => cleanup.promise)
      adapter.readTargetResult = { note: null, lifecycle: 'missing' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('first cleanup committed base')
      const save = controller.save()
      await flushMicrotasks()
      controller.change('successor during first cleanup')
      controller.observeProjection(
        projectionFor(committed.id, 'missing', null),
      )
      cleanup.resolve('cleared')

      await expect(save).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'missing',
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 2,
        baseContent: committed.content,
        baseUpdatedAt: committed.updated_at,
        draft: 'successor during first cleanup',
      })
      expect(controller.state).toMatchObject({
        phase: 'target-unavailable',
        durability: 'recovery-durable',
        editingNote: committed,
        draft: 'successor during first cleanup',
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
    })

    it.each(['succeeds', 'rejects'] as const)(
      'reconciles first-save cleanup against active v2 when compensation %s',
      async (compensation) => {
        const cleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const committedV1 = makeQuickNote({
          content: 'first cleanup committed v1',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const remoteV2 = makeQuickNote({
          content: 'first cleanup authoritative v2',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.updateResult = { kind: 'updated', note: committedV1 }
        adapter.clearEffects.push(() => cleanup.promise)
        adapter.readTargetResult = { note: remoteV2, lifecycle: 'active' }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('first cleanup committed v1')
        const save = controller.save()
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor(remoteV2.id, 'active', remoteV2),
        )
        if (compensation === 'rejects') {
          adapter.checkpointEffects.push(
            () => Promise.reject(new Error('first active compensation blocked')),
          )
        }
        cleanup.resolve('cleared')

        await expect(save).resolves.toEqual({
          kind: 'conflict',
          conflict: {
            note: remoteV2,
            localDraft: 'first cleanup committed v1',
            remoteContent: remoteV2.content,
          },
        })
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: compensation === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
          editingNote: remoteV2,
          draft: 'first cleanup committed v1',
        })
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.clearCalls).toEqual([[
          { kind: 'v1', editId: 'edit-1', revision: 1 },
        ]])
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        expect(onSaved).not.toHaveBeenCalled()
        if (compensation === 'succeeds') {
          expect(adapter.stored).toMatchObject({
            editId: 'edit-1',
            revision: 1,
            baseContent: committedV1.content,
            baseUpdatedAt: committedV1.updated_at,
            draft: 'first cleanup committed v1',
          })
        } else {
          expect(adapter.stored).toBeNull()
        }
      },
    )

    it('preserves a first-save projected conflict when authority read fails after cleanup', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committedV1 = makeQuickNote({
        content: 'first cleanup read failure v1',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const projectedV2 = makeQuickNote({
        content: 'first cleanup projected v2',
        updated_at: '2026-07-12T04:00:03.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committedV1 }
      adapter.clearEffects.push(() => cleanup.promise)
      adapter.readTargetEffects.push(
        () => Promise.reject(new Error('first cleanup authority blocked')),
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('first cleanup read failure v1')
      const save = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(projectedV2.id, 'active', projectedV2),
      )
      cleanup.resolve('cleared')

      await expect(save).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: projectedV2,
          localDraft: 'first cleanup read failure v1',
          remoteContent: projectedV2.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: projectedV2,
      })
      expect(adapter.stored).toMatchObject({
        revision: 1,
        baseContent: committedV1.content,
        baseUpdatedAt: committedV1.updated_at,
      })
      expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
    })

    it('compensates the latest successor after first-save cleanup and active v2', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committedV1 = makeQuickNote({
        content: 'successor active committed v1',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const remoteV2 = makeQuickNote({
        content: 'successor authoritative v2',
        updated_at: '2026-07-12T04:00:03.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committedV1 }
      adapter.clearEffects.push(() => cleanup.promise)
      adapter.readTargetResult = { note: remoteV2, lifecycle: 'active' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('successor active committed v1')
      const save = controller.save()
      await flushMicrotasks()
      controller.change('latest successor against active v2')
      controller.observeProjection(
        projectionFor(remoteV2.id, 'active', remoteV2),
      )
      cleanup.resolve('cleared')

      await expect(save).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: remoteV2,
          localDraft: 'latest successor against active v2',
          remoteContent: remoteV2.content,
        },
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 2,
        baseContent: committedV1.content,
        baseUpdatedAt: committedV1.updated_at,
        draft: 'latest successor against active v2',
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: remoteV2,
        draft: 'latest successor against active v2',
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
    })

    it('drops first-save recovery durability while post-cleanup authority read is pending', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const authorityRead = createDeferred<ControlledReadTargetResult>()
      const committedV1 = makeQuickNote({
        content: 'first pending authority v1',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const remoteV2 = makeQuickNote({
        content: 'first pending authority v2',
        updated_at: '2026-07-12T04:00:03.000Z',
      })
      const remoteV3 = makeQuickNote({
        content: 'first superseding projection v3',
        updated_at: '2026-07-12T04:00:04.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committedV1 }
      adapter.clearEffects.push(() => cleanup.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('first pending authority v1')
      const save = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(remoteV2.id, 'active', remoteV2),
      )
      adapter.readTargetEffects.push(() => authorityRead.promise)
      cleanup.resolve('cleared')
      await flushMicrotasks()

      expect(adapter.stored).toBeNull()
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'memory-only',
        draft: 'first pending authority v1',
        conflict: { note: remoteV2 },
      })
      controller.observeProjection(
        projectionFor(remoteV3.id, 'active', remoteV3),
      )
      authorityRead.resolve({ note: remoteV2, lifecycle: 'active' })
      await expect(save).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: remoteV3,
          localDraft: 'first pending authority v1',
          remoteContent: remoteV3.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: remoteV3,
        conflict: { note: remoteV3 },
      })
    })

    it('treats an authoritative prior base as conflict before first-save cleanup', async () => {
      const update = createDeferred<ExistingEditUpdateResult>()
      const base = makeQuickNote()
      const committed = makeQuickNote({
        content: 'prior-base first-save local',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      adapter.updateEffects.push(() => update.promise)
      adapter.readTargetResult = { note: base, lifecycle: 'active' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.change('prior-base first-save local')
      const save = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )
      update.resolve({ kind: 'updated', note: committed })

      await expect(save).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: base,
          localDraft: 'prior-base first-save local',
          remoteContent: base.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        editingNote: base,
        draft: 'prior-base first-save local',
        conflict: { note: base },
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toEqual([])
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 1,
        draft: 'prior-base first-save local',
      })
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('caches projection-pending visibility without replaying entity or projection', async () => {
      const committed = makeQuickNote({
        content: 'projection pending',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => {
        throw new Error('projection blocked')
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('projection pending')

      const first = await controller.save()
      const second = await controller.save()

      expect(first).toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'pending',
      })
      expect(second).toEqual(first)
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toHaveLength(1)
      expect(onSaved).toHaveBeenCalledOnce()
      expect(controller.state).toMatchObject({
        phase: 'saved',
        durability: 'entity-durable',
        issue: {
          code: 'projection-failed',
          retryable: false,
          durability: 'entity-durable',
        },
      })
    })

    it('keeps cached pending visibility when cleanup-only retry succeeds', async () => {
      const committed = makeQuickNote({
        content: 'cleanup and projection pending',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => {
        throw new Error('projection blocked')
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('cleanup blocked')),
        async () => 'cleared',
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('cleanup and projection pending')

      await expect(controller.save()).resolves.toMatchObject({
        kind: 'failed',
        issue: {
          code: 'recovery-cleanup-failed',
          durability: 'entity-durable',
        },
      })
      await expect(controller.save()).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'pending',
      })

      expect(adapter.checkpointCalls).toHaveLength(1)
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toHaveLength(2)
      expect(onSaved).toHaveBeenCalledOnce()
      expect(controller.state).toMatchObject({
        phase: 'saved',
        durability: 'entity-durable',
        issue: {
          code: 'projection-failed',
          durability: 'entity-durable',
        },
      })
    })

    it('blocks cleanup-receipt save retry after the target becomes unavailable', async () => {
      const committed = makeQuickNote({
        content: 'entity committed before archive',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('cleanup blocked')),
        async () => 'cleared',
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('entity committed before archive')
      await expect(controller.save()).resolves.toMatchObject({
        kind: 'failed',
        issue: { code: 'recovery-cleanup-failed' },
      })
      controller.observeProjection(
        projectionFor(committed.id, 'archived', committed),
      )
      const unavailable = controller.getSnapshot()

      await expect(controller.save()).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'archived',
      })

      expect(controller.getSnapshot()).toBe(unavailable)
      expect(adapter.clearCalls).toHaveLength(1)
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 1,
        draft: 'entity committed before archive',
      })

      await expect(controller.cancel()).resolves.toEqual({ kind: 'cancelled' })
      expect(adapter.clearCalls).toHaveLength(2)
      expect(adapter.stored).toBeNull()
      expectIdle(controller.state)
    })

    it.each(['succeeds', 'rejects'] as const)(
      'compensates a cleared receipt after target removal when checkpoint %s',
      async (compensation) => {
        const retryCleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const committed = makeQuickNote({
          content: 'receipt cleared during removal',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.updateResult = { kind: 'updated', note: committed }
        adapter.readTargetResult = { note: null, lifecycle: 'missing' }
        adapter.clearEffects.push(
          () => Promise.reject(new Error('first cleanup blocked')),
          () => retryCleanup.promise,
        )
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('receipt cleared during removal')
        await controller.save()
        const recoveryBeforeRetry = adapter.stored

        const retry = controller.save()
        await flushMicrotasks()
        expect(adapter.clearCalls).toHaveLength(2)
        controller.observeProjection(
          projectionFor(committed.id, 'missing', null),
        )
        if (compensation === 'rejects') {
          adapter.checkpointEffects.push(
            () => Promise.reject(new Error('compensation blocked')),
          )
        }
        retryCleanup.resolve('cleared')

        await expect(retry).resolves.toEqual({
          kind: 'unavailable',
          lifecycle: 'missing',
        })
        expect(adapter.checkpointCalls).toHaveLength(2)
        expect(onSaved).toHaveBeenCalledOnce()
        expect(controller.state).toMatchObject({
          phase: 'target-unavailable',
          durability: compensation === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
          editingNote: committed,
          draft: 'receipt cleared during removal',
          conflict: null,
          issue: null,
        })
        if (compensation === 'succeeds') {
          expect(adapter.stored).toEqual({
            ...recoveryBeforeRetry,
            baseContent: committed.content,
            baseUpdatedAt: committed.updated_at,
          })
        } else {
          expect(adapter.stored).toBeNull()
        }
        await expect(controller.save()).resolves.toEqual({
          kind: 'unavailable',
          lifecycle: 'missing',
        })
      },
    )

    it('compensates the latest successor after receipt cleanup and removal', async () => {
      const retryCleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committed = makeQuickNote({
        content: 'receipt committed base',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.readTargetResult = { note: null, lifecycle: 'missing' }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('first cleanup blocked')),
        () => retryCleanup.promise,
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('receipt committed base')
      await controller.save()

      const retry = controller.save()
      await flushMicrotasks()
      controller.change('latest successor before removal')
      controller.observeProjection(
        projectionFor(committed.id, 'missing', null),
      )
      retryCleanup.resolve('cleared')

      await expect(retry).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'missing',
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 2,
        baseContent: committed.content,
        baseUpdatedAt: committed.updated_at,
        draft: 'latest successor before removal',
      })
      expect(controller.state).toMatchObject({
        phase: 'target-unavailable',
        durability: 'recovery-durable',
        editingNote: committed,
        draft: 'latest successor before removal',
      })
    })

    it.each(['succeeds', 'rejects'] as const)(
      'reconciles receipt cleanup against active v2 when compensation %s',
      async (compensation) => {
        const retryCleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const committedV1 = makeQuickNote({
          content: 'receipt committed v1',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const remoteV2 = makeQuickNote({
          content: 'receipt authoritative v2',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.updateResult = { kind: 'updated', note: committedV1 }
        adapter.clearEffects.push(
          () => Promise.reject(new Error('first cleanup blocked')),
          () => retryCleanup.promise,
        )
        adapter.readTargetResult = { note: remoteV2, lifecycle: 'active' }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('receipt committed v1')
        await controller.save()

        const retry = controller.save()
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor(remoteV2.id, 'active', remoteV2),
        )
        if (compensation === 'rejects') {
          adapter.checkpointEffects.push(
            () => Promise.reject(new Error('receipt compensation blocked')),
          )
        }
        retryCleanup.resolve('cleared')

        await expect(retry).resolves.toEqual({
          kind: 'conflict',
          conflict: {
            note: remoteV2,
            localDraft: 'receipt committed v1',
            remoteContent: remoteV2.content,
          },
        })
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.clearCalls).toEqual([
          [{ kind: 'v1', editId: 'edit-1', revision: 1 }],
          [{ kind: 'v1', editId: 'edit-1', revision: 1 }],
        ])
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        expect(onSaved).toHaveBeenCalledTimes(1)
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: compensation === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
          editingNote: remoteV2,
          draft: 'receipt committed v1',
        })
        if (compensation === 'succeeds') {
          expect(adapter.stored).toMatchObject({
            editId: 'edit-1',
            revision: 1,
            baseContent: committedV1.content,
            baseUpdatedAt: committedV1.updated_at,
            draft: 'receipt committed v1',
          })
        } else {
          expect(adapter.stored).toBeNull()
        }
      },
    )

    it('preserves observed receipt conflict when post-cleanup authority read fails', async () => {
      const retryCleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committedV1 = makeQuickNote({
        content: 'receipt read failure v1',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const projectedV2 = makeQuickNote({
        content: 'projected v2 before failed read',
        updated_at: '2026-07-12T04:00:03.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committedV1 }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('first cleanup blocked')),
        () => retryCleanup.promise,
      )
      adapter.readTargetEffects.push(
        () => Promise.reject(new Error('authority read blocked')),
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('receipt read failure v1')
      await controller.save()

      const retry = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(projectedV2.id, 'active', projectedV2),
      )
      retryCleanup.resolve('cleared')

      await expect(retry).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: projectedV2,
          localDraft: 'receipt read failure v1',
          remoteContent: projectedV2.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: projectedV2,
        draft: 'receipt read failure v1',
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 1,
        baseContent: committedV1.content,
        baseUpdatedAt: committedV1.updated_at,
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
    })

    it('drops receipt recovery durability while post-cleanup authority read is pending', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const authorityRead = createDeferred<ControlledReadTargetResult>()
      const committedV1 = makeQuickNote({
        content: 'receipt pending authority v1',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const remoteV2 = makeQuickNote({
        content: 'receipt pending authority v2',
        updated_at: '2026-07-12T04:00:03.000Z',
      })
      const remoteV3 = makeQuickNote({
        content: 'receipt superseding projection v3',
        updated_at: '2026-07-12T04:00:04.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committedV1 }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('first cleanup blocked')),
        () => cleanup.promise,
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('receipt pending authority v1')
      await controller.save()
      const retry = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(remoteV2.id, 'active', remoteV2),
      )
      adapter.readTargetEffects.push(() => authorityRead.promise)
      cleanup.resolve('cleared')
      await flushMicrotasks()

      expect(adapter.stored).toBeNull()
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'memory-only',
        draft: 'receipt pending authority v1',
        conflict: { note: remoteV2 },
      })
      controller.observeProjection(
        projectionFor(remoteV3.id, 'active', remoteV3),
      )
      authorityRead.resolve({ note: remoteV2, lifecycle: 'active' })
      await expect(retry).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: remoteV3,
          localDraft: 'receipt pending authority v1',
          remoteContent: remoteV3.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: remoteV3,
        conflict: { note: remoteV3 },
      })
    })

    it('treats an authoritative prior base as conflict after receipt cleanup', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const base = makeQuickNote()
      const committed = makeQuickNote({
        content: 'prior-base receipt local',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('first cleanup blocked')),
        () => cleanup.promise,
      )
      adapter.readTargetResult = { note: base, lifecycle: 'active' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.change('prior-base receipt local')
      await controller.save()
      const retry = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )
      cleanup.resolve('cleared')

      await expect(retry).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: base,
          localDraft: 'prior-base receipt local',
          remoteContent: base.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: base,
        draft: 'prior-base receipt local',
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toHaveLength(2)
      expect(adapter.checkpointCalls).toHaveLength(2)
      expect(adapter.stored).toMatchObject({
        revision: 1,
        baseContent: committed.content,
        baseUpdatedAt: committed.updated_at,
        draft: 'prior-base receipt local',
      })
      expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it('reports latest memory durability when older committed cleanup rejects', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committed = makeQuickNote({
        content: 'older committed',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(() => cleanup.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('older committed')
      const olderSave = controller.save()
      await flushMicrotasks()
      expect(adapter.clearCalls).toHaveLength(1)

      controller.change('newer memory-only')
      cleanup.reject(new Error('cleanup blocked'))
      const result = await olderSave

      expect(result).toEqual({
        kind: 'failed',
        issue: {
          code: 'recovery-cleanup-failed',
          retryable: true,
          durability: 'memory-only',
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'memory-only',
        editingNote: committed,
        draft: 'newer memory-only',
        issue: null,
      })
    })

    it('OR-upgrades close intent for same-revision cleanup receipt callers', async () => {
      const retryCleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committed = makeQuickNote({
        content: 'close after receipt',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('first cleanup blocked')),
        () => retryCleanup.promise,
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('close after receipt')
      await controller.save()

      const firstRetry = controller.save({ closeAfterSave: false })
      const upgradedRetry = controller.save({ closeAfterSave: true })

      expect(upgradedRetry).toBe(firstRetry)
      retryCleanup.resolve('cleared')
      await expect(firstRetry).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'refreshed',
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toHaveLength(2)
      expectIdle(controller.state)
    })

    it('protects successor input when delayed receipt cleanup removes the old row', async () => {
      const retryCleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const committed = makeQuickNote({
        content: 'receipt revision',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const successorCommitted = makeQuickNote({
        content: 'successor revision',
        updated_at: '2026-07-12T04:00:03.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearEffects.push(
        () => Promise.reject(new Error('first cleanup blocked')),
        () => retryCleanup.promise,
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('receipt revision')
      await controller.save()

      const receiptRetry = controller.save({ closeAfterSave: true })
      await flushMicrotasks()
      expect(adapter.clearCalls).toHaveLength(2)
      controller.change('successor revision')
      retryCleanup.resolve('cleared')
      await expect(receiptRetry).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'refreshed',
      })

      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'recovery-durable',
        editingNote: committed,
        draft: 'successor revision',
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 2,
        draft: 'successor revision',
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(onSaved).toHaveBeenCalledOnce()

      adapter.updateResult = { kind: 'updated', note: successorCommitted }
      await expect(controller.save()).resolves.toMatchObject({ kind: 'saved' })
      expect(adapter.updateCalls).toHaveLength(2)
      expect(onSaved).toHaveBeenCalledTimes(2)
      expect(controller.state).toMatchObject({
        phase: 'saved',
        editingNote: successorCommitted,
        draft: 'successor revision',
      })
    })

    it.each(['rejected', 'different-edit'] as const)(
      'reports successor durability when stale receipt cleanup is %s',
      async (cleanupFailure) => {
        const staleCleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const committed = makeQuickNote({
          content: 'stale receipt revision',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        adapter.updateResult = { kind: 'updated', note: committed }
        adapter.clearEffects.push(
          () => Promise.reject(new Error('first cleanup blocked')),
          () => staleCleanup.promise,
        )
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('stale receipt revision')
        await controller.save()

        const staleRetry = controller.save()
        await flushMicrotasks()
        controller.change('successor after stale receipt')
        if (cleanupFailure === 'rejected') {
          staleCleanup.reject(new Error('stale cleanup rejected'))
        } else {
          staleCleanup.resolve('different-edit')
        }

        await expect(staleRetry).resolves.toEqual({
          kind: 'failed',
          issue: {
            code: 'recovery-cleanup-failed',
            retryable: true,
            durability: 'memory-only',
          },
        })
        expect(controller.state).toMatchObject({
          phase: 'dirty',
          durability: 'memory-only',
          editingNote: committed,
          draft: 'successor after stale receipt',
          issue: null,
        })
        expect(adapter.updateCalls).toHaveLength(1)
      },
    )

    it('bounds different-edit receipt retries to one cleanup call per save', async () => {
      const committed = makeQuickNote({
        content: 'different owner',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.clearResult = 'different-edit'
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('different owner')

      await expect(controller.save()).resolves.toMatchObject({ kind: 'failed' })
      await expect(controller.save()).resolves.toMatchObject({ kind: 'failed' })
      await expect(controller.save()).resolves.toMatchObject({ kind: 'failed' })

      expect(adapter.checkpointCalls).toHaveLength(1)
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toHaveLength(3)
      expect(controller.state).toMatchObject({
        phase: 'failed',
        durability: 'entity-durable',
        draft: 'different owner',
      })
    })

    describe('Task 5 authority receipt race specifications', () => {
      it('keeps one receipt through authority success, rejected and different cleanup, then refreshes once', async () => {
        const update = createDeferred<ExistingEditUpdateResult>()
        const committed = makeQuickNote({
          content: 'receipt lifecycle',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.updateEffects.push(() => update.promise)
        adapter.readTargetResult = { note: committed, lifecycle: 'active' }
        adapter.clearEffects.push(
          () => Promise.reject(new Error('cleanup rejected')),
          async () => 'different-edit',
          async () => 'cleared',
        )
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('receipt lifecycle')
        const first = controller.save()
        await flushMicrotasks()

        // Explicit projection stage between entity update and authority read.
        controller.observeProjection(projectionFor('quick-note-1', 'active', makeQuickNote()))
        update.resolve({ kind: 'updated', note: committed })

        await expect(first).resolves.toEqual({
          kind: 'failed',
          issue: {
            code: 'recovery-cleanup-failed',
            retryable: true,
            durability: 'entity-durable',
          },
        })
        expect(controller.state.issue?.code).toBe('recovery-cleanup-failed')
        await expect(controller.save()).resolves.toMatchObject({
          kind: 'failed',
          issue: { code: 'recovery-cleanup-failed' },
        })
        await expect(controller.save()).resolves.toEqual({
          kind: 'saved',
          note: committed,
          visibility: 'refreshed',
        })

        expect(onSaved).toHaveBeenCalledTimes(1)
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.checkpointCalls).toHaveLength(1)
        expect(adapter.clearCalls).toHaveLength(3)
        expect(controller.state).toMatchObject({
          phase: 'saved',
          durability: 'entity-durable',
          editingNote: committed,
          issue: null,
        })
      })

      it('finishes receipt cleanup when its authority read is superseded by active v2 and v3', async () => {
        const update = createDeferred<ExistingEditUpdateResult>()
        const firstAuthority = createDeferred<ControlledReadTargetResult>()
        const retryAuthority = createDeferred<ControlledReadTargetResult>()
        const committed = makeQuickNote({
          content: 'authority receipt v1',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const remoteV2 = makeQuickNote({
          content: 'authority receipt v2',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        const remoteV3 = makeQuickNote({
          content: 'authority receipt v3',
          updated_at: '2026-07-12T04:00:04.000Z',
        })
        adapter.updateEffects.push(() => update.promise)
        adapter.readTargetEffects.push(
          () => firstAuthority.promise,
          () => retryAuthority.promise,
        )
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('authority receipt v1')
        const first = controller.save()
        await flushMicrotasks()
        controller.observeProjection(projectionFor(committed.id, 'active', makeQuickNote()))
        update.resolve({ kind: 'updated', note: committed })
        await flushMicrotasks()
        controller.observeProjection(projectionFor(remoteV2.id, 'active', remoteV2))
        firstAuthority.resolve({ note: committed, lifecycle: 'active' })
        await expect(first).resolves.toEqual({
          kind: 'saved',
          note: committed,
          visibility: 'pending',
        })
        expect(adapter.clearCalls).toEqual([])

        const retry = controller.save()
        await flushMicrotasks()
        controller.observeProjection(projectionFor(remoteV2.id, 'active', { ...remoteV2 }))
        controller.observeProjection(projectionFor(remoteV3.id, 'active', remoteV3))
        retryAuthority.resolve({ note: remoteV3, lifecycle: 'active' })
        await expect(retry).resolves.toMatchObject({ kind: 'conflict' })

        expect(adapter.clearCalls).toHaveLength(1)
        expect(adapter.stored).toBeNull()
        adapter.loadResult = { kind: 'absent' }
        const remounted = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        expectIdle(remounted.state)
      })

      it('treats repeated identical projection during pending authority as benign', async () => {
        const update = createDeferred<ExistingEditUpdateResult>()
        const authority = createDeferred<ControlledReadTargetResult>()
        const committed = makeQuickNote({
          content: 'benign projection',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        adapter.updateEffects.push(() => update.promise)
        adapter.readTargetEffects.push(() => authority.promise)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('benign projection')
        const save = controller.save()
        await flushMicrotasks()
        controller.observeProjection(projectionFor(committed.id, 'active', makeQuickNote()))
        update.resolve({ kind: 'updated', note: committed })
        await flushMicrotasks()

        controller.observeProjection(projectionFor(committed.id, 'active', committed))
        const pendingSnapshot = controller.getSnapshot()
        controller.observeProjection(projectionFor(committed.id, 'active', { ...committed }))
        expect(controller.getSnapshot()).toBe(pendingSnapshot)
        expect(controller.state.phase).not.toBe('failed')
        expect(controller.state.phase).not.toBe('saving')
        authority.resolve({ note: committed, lifecycle: 'active' })

        await expect(save).resolves.toEqual({
          kind: 'saved',
          note: committed,
          visibility: 'refreshed',
        })
        expect(adapter.clearCalls).toHaveLength(1)
      })

      it('cleans normalized equality without conflict and tolerates synchronous projection reentry', async () => {
        const remote = makeQuickNote({
          content: '  locally equal  ',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        adapter.readTargetResult = { note: remote, lifecycle: 'active' }
        const onSaved = vi.fn((_note: QuickNote): undefined => {
          controller.observeProjection(projectionFor(remote.id, 'active', { ...remote }))
          return undefined
        })
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('locally equal')
        expect(vi.getTimerCount()).toBe(2)

        controller.observeProjection(projectionFor(remote.id, 'active', remote))
        await flushMicrotasks()

        expect(vi.getTimerCount()).toBe(0)
        expect(controller.state).toMatchObject({
          phase: 'saved',
          durability: 'entity-durable',
          editingNote: remote,
          draft: remote.content,
          conflict: null,
          issue: null,
        })
        expect(adapter.updateCalls).toEqual([])
        expect(adapter.clearCalls).toHaveLength(1)
        expect(onSaved).toHaveBeenCalledOnce()
      })

      it.each(['rejected', 'different-edit'] as const)(
        'preserves the complete normalized-equal row when canonical cleanup is %s',
        async (failure) => {
          const stored = makeSnapshot({
            editId: 'edit-1',
            revision: 1,
            draft: 'locally equal',
          })
          const remote = makeQuickNote({
            content: ' locally equal ',
            updated_at: '2026-07-12T04:00:03.000Z',
          })
          adapter.stored = stored
          adapter.readTargetResult = { note: remote, lifecycle: 'active' }
          adapter.clearEffects.push(() => failure === 'rejected'
            ? Promise.reject(new Error('cleanup rejected'))
            : Promise.resolve('different-edit'))
          const controller = createQuickNoteExistingEditSessionController(
            controllerOptions(adapter),
          )
          await flushMicrotasks()
          controller.start(makeQuickNote())
          controller.change('locally equal')

          controller.observeProjection(projectionFor(remote.id, 'active', remote))
          await flushMicrotasks()

          expect(controller.state).toMatchObject({
            phase: 'dirty',
            durability: 'memory-only',
            editingNote: makeQuickNote(),
            draft: 'locally equal',
            conflict: null,
            issue: { code: 'recovery-cleanup-failed' },
          })
          expect(adapter.stored).toBe(stored)
          expect(adapter.updateCalls).toEqual([])
          expect(adapter.clearCalls).toHaveLength(1)
        },
      )

      it('keeps an authority-pending receipt from being replaced by a clean start', async () => {
        const update = createDeferred<ExistingEditUpdateResult>()
        const committed = makeQuickNote({
          content: 'authority pending original',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        adapter.updateEffects.push(() => update.promise)
        adapter.readTargetEffects.push(
          () => Promise.reject(new Error('authority unavailable')),
          async () => ({ note: committed, lifecycle: 'active' }),
        )
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('authority pending original')
        const first = controller.save()
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor(committed.id, 'active', makeQuickNote()),
        )
        update.resolve({ kind: 'updated', note: committed })

        await expect(first).resolves.toEqual({
          kind: 'saved',
          note: committed,
          visibility: 'pending',
        })
        controller.start(makeQuickNote({
          id: 'replacement',
          content: 'must not replace receipt',
        }))
        expect(controller.state.editingNote?.id).toBe(committed.id)
        expect(controller.state.draft).toBe('authority pending original')

        await expect(controller.save()).resolves.toEqual({
          kind: 'saved',
          note: committed,
          visibility: 'refreshed',
        })
        expect(onSaved).toHaveBeenCalledOnce()
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.clearCalls).toHaveLength(1)
      })

      it('keeps a projection-pending receipt from being replaced by a clean start', async () => {
        const committed = makeQuickNote({
          content: 'projection pending original',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        adapter.updateResult = { kind: 'updated', note: committed }
        const onSaved = vi.fn((_note: QuickNote): undefined => {
          throw new Error('projection blocked')
        })
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('projection pending original')
        await expect(controller.save()).resolves.toMatchObject({
          kind: 'saved',
          visibility: 'pending',
        })

        controller.start(makeQuickNote({
          id: 'replacement',
          content: 'must not replace projection receipt',
        }))

        expect(controller.state.editingNote?.id).toBe(committed.id)
        expect(controller.state.draft).toBe('projection pending original')
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.clearCalls).toHaveLength(1)
        expect(onSaved).toHaveBeenCalledOnce()
      })

      it('rechecks canonical authority before normalized-equality cleanup', async () => {
        const projectedEqual = makeQuickNote({
          content: ' local draft ',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const authoritativeV3 = makeQuickNote({
          content: 'authoritative remote v3',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        adapter.readTargetResult = {
          note: authoritativeV3,
          lifecycle: 'active',
        }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local draft')
        await vi.advanceTimersByTimeAsync(500)

        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', projectedEqual),
        )
        await flushMicrotasks()

        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        expect(adapter.clearCalls).toEqual([])
        expect(adapter.stored).toMatchObject({ draft: 'local draft' })
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: 'recovery-durable',
          editingNote: authoritativeV3,
          draft: 'local draft',
          conflict: {
            note: authoritativeV3,
            localDraft: 'local draft',
            remoteContent: authoritativeV3.content,
          },
        })
      })

      it('compensates normalized-equality cleanup when projection advances to remote v3', async () => {
        const clear = createDeferred<'cleared' | 'absent' | 'different-edit'>()
        const projectedEqual = makeQuickNote({
          content: ' local draft ',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const remoteV3 = makeQuickNote({
          content: 'remote v3 during equality cleanup',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        adapter.readTargetEffects.push(
          async () => ({ note: projectedEqual, lifecycle: 'active' }),
          async () => ({ note: remoteV3, lifecycle: 'active' }),
        )
        adapter.clearEffects.push(() => clear.promise)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local draft')
        await vi.advanceTimersByTimeAsync(500)

        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', projectedEqual),
        )
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor(remoteV3.id, 'active', remoteV3),
        )
        clear.resolve('cleared')
        await flushMicrotasks()

        expect(adapter.readTargetCalls).toEqual([
          'quick-note-1',
          'quick-note-1',
        ])
        expect(adapter.clearCalls).toHaveLength(1)
        expect(adapter.stored).toMatchObject({ draft: 'local draft' })
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: 'recovery-durable',
          editingNote: remoteV3,
          draft: 'local draft',
          conflict: { note: remoteV3 },
        })
      })

      it('preserves conflict state and recovery row when equality cleanup rejects', async () => {
        const remoteV2 = makeQuickNote({
          content: 'remote v2',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const projectedEqual = makeQuickNote({
          content: ' local draft ',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        adapter.readTargetResult = { note: projectedEqual, lifecycle: 'active' }
        adapter.clearEffects.push(
          () => Promise.reject(new Error('canonical cleanup rejected')),
        )
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local draft')
        await vi.advanceTimersByTimeAsync(500)
        controller.observeProjection(projectionFor(remoteV2.id, 'active', remoteV2))
        const before = controller.getSnapshot()
        const stored = adapter.stored

        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', projectedEqual),
        )
        await flushMicrotasks()

        expect(controller.state).toEqual(before)
        expect(adapter.stored).toBe(stored)
        expect(adapter.clearCalls).toHaveLength(1)
      })

      it('preserves target-unavailable state and recovery row when equality cleanup finds a different edit', async () => {
        const projectedEqual = makeQuickNote({
          content: ' local draft ',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        adapter.readTargetResult = { note: projectedEqual, lifecycle: 'active' }
        adapter.clearResult = 'different-edit'
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local draft')
        await vi.advanceTimersByTimeAsync(500)
        controller.observeProjection(
          projectionFor('quick-note-1', 'missing', null),
        )
        const before = controller.getSnapshot()
        const stored = adapter.stored

        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', projectedEqual),
        )
        await flushMicrotasks()

        expect(controller.state).toEqual(before)
        expect(adapter.stored).toBe(stored)
        expect(adapter.clearCalls).toHaveLength(1)
      })

      it('preserves entity-durable failed state and receipt row when equality cleanup rejects', async () => {
        const committed = makeQuickNote({
          content: 'entity durable local',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const projectedEqual = makeQuickNote({
          content: ' entity durable local ',
          updated_at: '2026-07-12T04:00:03.000Z',
        })
        adapter.updateResult = { kind: 'updated', note: committed }
        adapter.readTargetResult = { note: projectedEqual, lifecycle: 'active' }
        adapter.clearEffects.push(
          () => Promise.reject(new Error('first cleanup rejected')),
          () => Promise.reject(new Error('equality cleanup rejected')),
        )
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('entity durable local')
        await controller.save()
        const before = controller.getSnapshot()
        const stored = adapter.stored

        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', projectedEqual),
        )
        await flushMicrotasks()

        expect(controller.state).toEqual(before)
        expect(adapter.stored).toBe(stored)
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.clearCalls).toHaveLength(2)
      })

      it('preserves the entering state and row when equality authority read rejects', async () => {
        const projectedEqual = makeQuickNote({
          content: ' local draft ',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        adapter.readTargetEffects.push(
          () => Promise.reject(new Error('authority read rejected')),
        )
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local draft')
        await vi.advanceTimersByTimeAsync(500)
        const before = controller.getSnapshot()
        const stored = adapter.stored

        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', projectedEqual),
        )
        await flushMicrotasks()

        expect(controller.state).toEqual(before)
        expect(adapter.stored).toBe(stored)
        expect(adapter.clearCalls).toEqual([])
      })

      it('single-flights equality authority across save, cancel, and repeated projection', async () => {
        const authority = createDeferred<ControlledReadTargetResult>()
        const projectedEqual = makeQuickNote({
          content: ' local draft ',
          updated_at: '2026-07-12T04:00:02.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.readTargetEffects.push(() => authority.promise)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local draft')
        await vi.advanceTimersByTimeAsync(500)

        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', projectedEqual),
        )
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor(projectedEqual.id, 'active', { ...projectedEqual }),
        )
        const save = controller.save()
        const cancel = controller.cancel()
        authority.resolve({ note: projectedEqual, lifecycle: 'active' })
        await Promise.allSettled([save, cancel])
        await flushMicrotasks()

        expect(adapter.readTargetCalls).toHaveLength(1)
        expect(adapter.checkpointCalls).toHaveLength(1)
        expect(adapter.updateCalls).toEqual([])
        expect(adapter.clearCalls).toHaveLength(1)
        expect(onSaved).toHaveBeenCalledOnce()
      })
    })
  })

  describe('Task 5 session isolation', () => {
    it('does not deduplicate the first projection after closing and reopening the same note', async () => {
      const base = makeQuickNote()
      const remoteV2 = makeQuickNote({
        content: 'remote v2 after reopen',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.observeProjection(projectionFor(remoteV2.id, 'active', remoteV2))
      expect(controller.state.editingNote).toEqual(remoteV2)
      await expect(controller.cancel()).resolves.toEqual({ kind: 'cancelled' })
      expectIdle(controller.state)

      controller.start(base)
      controller.observeProjection(projectionFor(remoteV2.id, 'active', remoteV2))

      expect(controller.state).toMatchObject({
        phase: 'saved',
        editingNote: remoteV2,
        draft: remoteV2.content,
      })
    })
  })

  describe('Task 5 cancel and terminal ownership', () => {
    it('returns busy cancel from save while cancel owns cleanup', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('cancel-owned draft')
      await vi.advanceTimersByTimeAsync(500)
      adapter.clearEffects.push(() => cleanup.promise)

      const cancel = controller.cancel()
      await flushMicrotasks()
      const saveResult = await controller.save()

      expect(saveResult).toEqual({ kind: 'busy', operation: 'cancel' })
      expect(adapter.updateCalls).toEqual([])
      cleanup.resolve('cleared')
      await expect(cancel).resolves.toEqual({ kind: 'cancelled' })
      expectIdle(controller.state)
    })

    it('returns busy save from cancel while stacked save work owns the lane', async () => {
      const firstUpdate = createDeferred<ExistingEditUpdateResult>()
      const firstCommitted = makeQuickNote({
        content: 'first save',
        updated_at: '2026-07-12T04:00:02.000Z',
      })
      const secondCommitted = makeQuickNote({
        content: 'second save',
        updated_at: '2026-07-12T04:00:03.000Z',
      })
      adapter.updateEffects.push(
        () => firstUpdate.promise,
        async () => ({ kind: 'updated', note: secondCommitted }),
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('first save')
      const firstSave = controller.save()
      await flushMicrotasks()
      controller.change('second save')
      const secondSave = controller.save()

      await expect(controller.cancel()).resolves.toEqual({
        kind: 'busy',
        operation: 'save',
      })
      expect(adapter.clearCalls).toEqual([])

      firstUpdate.resolve({ kind: 'updated', note: firstCommitted })
      await Promise.all([firstSave, secondSave])
      expect(adapter.updateCalls.map((call) => call.draft)).toEqual([
        'first save',
        'second save',
      ])
    })

    it('coalesces cancel and captures owners after queued checkpoint settles', async () => {
      const checkpoint = createDeferred<void>()
      adapter.checkpointEffects.push(() => checkpoint.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('checkpoint before cancel')
      await vi.advanceTimersByTimeAsync(500)
      expect(controller.state.phase).toBe('checkpointing')

      const first = controller.cancel()
      const second = controller.cancel()

      expect(second).toBe(first)
      expect(adapter.clearCalls).toEqual([])
      checkpoint.resolve()
      await expect(first).resolves.toEqual({ kind: 'cancelled' })
      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: 'edit-1', revision: 1 },
      ]])
      expectIdle(controller.state)
    })

    it('captures cancel intent before a blocked checkpoint and preserves successor input', async () => {
      const checkpoint = createDeferred<void>()
      adapter.checkpointEffects.push(() => checkpoint.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('revision cancelled at invocation')
      await vi.advanceTimersByTimeAsync(500)
      expect(controller.state.phase).toBe('checkpointing')

      const cancel = controller.cancel()
      controller.change('successor accepted after cancel')
      checkpoint.resolve()
      await expect(cancel).resolves.toEqual({ kind: 'cancelled' })

      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: 'edit-1', revision: 1 },
      ]])
      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'recovery-durable',
        draft: 'successor accepted after cancel',
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 2,
        draft: 'successor accepted after cancel',
      })
    })

    it('merges the lane-start owner frontier into a later cancel intent', async () => {
      const checkpoint = createDeferred<void>()
      adapter.checkpointEffects.push(() => checkpoint.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('checkpointed revision one')
      await vi.advanceTimersByTimeAsync(500)
      expect(controller.state.phase).toBe('checkpointing')

      controller.change('cancelled revision two')
      const cancel = controller.cancel()
      checkpoint.resolve()
      await expect(cancel).resolves.toEqual({ kind: 'cancelled' })

      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: 'edit-1', revision: 1 },
        { kind: 'v1', editId: 'edit-1', revision: 2 },
      ]])
      expect(adapter.stored).toBeNull()
      expectIdle(controller.state)
    })

    it('preserves the exact state when cancel cleanup rejects', async () => {
      adapter.clearEffects.push(
        () => Promise.reject(new Error('cleanup blocked')),
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('must remain exact')
      await vi.advanceTimersByTimeAsync(500)
      const before = controller.getSnapshot()

      await expect(controller.cancel()).resolves.toEqual({
        kind: 'failed',
        issue: {
          code: 'recovery-cleanup-failed',
          retryable: true,
          durability: 'recovery-durable',
        },
      })

      expect(controller.getSnapshot()).toBe(before)
      expect(controller.state.draft).toBe('must remain exact')
    })

    it('preserves the exact state when cancel finds a different edit', async () => {
      adapter.clearResult = 'different-edit'
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('different edit survives')
      await vi.advanceTimersByTimeAsync(500)
      const before = controller.getSnapshot()

      await expect(controller.cancel()).resolves.toEqual({
        kind: 'failed',
        issue: {
          code: 'recovery-cleanup-failed',
          retryable: true,
          durability: 'recovery-durable',
        },
      })

      expect(controller.getSnapshot()).toBe(before)
      expect(controller.state.draft).toBe('different edit survives')
    })

    it.each(['cleared', 'absent'] as const)(
      'closes after cancel cleanup reports %s',
      async (cleanupResult) => {
        adapter.clearResult = cleanupResult
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change(`cancel ${cleanupResult}`)
        await vi.advanceTimersByTimeAsync(500)

        await expect(controller.cancel()).resolves.toEqual({
          kind: 'cancelled',
        })
        expectIdle(controller.state)
      },
    )

    it('does not let stale cancel cleanup close a successor revision', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('cancelled revision')
      await vi.advanceTimersByTimeAsync(500)
      adapter.clearEffects.push(() => cleanup.promise)

      const cancel = controller.cancel()
      await flushMicrotasks()
      controller.change('successor during cancel')
      cleanup.resolve('cleared')
      await expect(cancel).resolves.toEqual({ kind: 'cancelled' })

      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'recovery-durable',
        draft: 'successor during cancel',
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 2,
        draft: 'successor during cancel',
      })
      expect(adapter.updateCalls).toEqual([])
    })
  })

  describe('Task 5 conflict and lifecycle resolution', () => {
    it('keeps local content against the latest authoritative active target', async () => {
      const controller = await enterConflict(adapter)
      const latestRemote = makeQuickNote({
        content: 'latest authoritative remote',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const committed = makeQuickNote({
        content: 'local revision',
        updated_at: '2026-07-12T06:00:01.000Z',
      })
      adapter.readTargetResult = { note: latestRemote, lifecycle: 'active' }
      adapter.updateResult = { kind: 'updated', note: committed }
      adapter.operationLog.length = 0

      await expect(controller.resolveConflict('keep-local')).resolves.toEqual({
        kind: 'resolved',
        strategy: 'keep-local',
      })

      expect(adapter.operationLog).toEqual([
        'read-target',
        'checkpoint:local revision',
        'update:local revision',
        'clear',
      ])
      expect(adapter.updateCalls.at(-1)).toEqual({
        noteId: 'quick-note-1',
        baseContent: latestRemote.content,
        baseUpdatedAt: latestRemote.updated_at,
        draft: 'local revision',
      })
      expect(controller.state).toMatchObject({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: committed,
        draft: 'local revision',
        conflict: null,
      })
    })

    it('downgrades keep-local durability until the replacement base checkpoint succeeds', async () => {
      const controller = await enterConflict(adapter)
      const latestRemote = makeQuickNote({
        content: 'replacement remote base',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const committed = makeQuickNote({
        content: 'local revision',
        updated_at: '2026-07-12T06:00:01.000Z',
      })
      const replacementCheckpoint = createDeferred<void>()
      const replacementUpdate = createDeferred<ExistingEditUpdateResult>()
      adapter.readTargetResult = { note: latestRemote, lifecycle: 'active' }
      adapter.checkpointEffects.push(() => replacementCheckpoint.promise)
      adapter.updateEffects.push(() => replacementUpdate.promise)

      const resolution = controller.resolveConflict('keep-local')
      await flushMicrotasks()

      expect(adapter.checkpointCalls.at(-1)).toMatchObject({
        baseContent: latestRemote.content,
        baseUpdatedAt: latestRemote.updated_at,
        draft: 'local revision',
      })
      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'memory-only',
        editingNote: latestRemote,
        draft: 'local revision',
        conflict: null,
      })
      expect(adapter.updateCalls).toHaveLength(1)

      const secondRemote = makeQuickNote({
        content: 'remote changed during replacement checkpoint',
        updated_at: '2026-07-12T06:00:00.500Z',
      })
      controller.observeProjection(
        projectionFor(secondRemote.id, 'active', secondRemote),
      )
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'memory-only',
        draft: 'local revision',
        conflict: {
          note: secondRemote,
          localDraft: 'local revision',
          remoteContent: secondRemote.content,
        },
      })

      replacementCheckpoint.resolve()
      await flushMicrotasks()
      expect(adapter.updateCalls).toHaveLength(2)
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        draft: 'local revision',
      })

      replacementUpdate.resolve({ kind: 'updated', note: committed })
      await expect(resolution).resolves.toEqual({
        kind: 'resolved',
        strategy: 'keep-local',
      })
      expect(controller.state).toMatchObject({
        phase: 'saved',
        durability: 'entity-durable',
      })
    })

    it('keeps failed keep-local replacement durability memory-only', async () => {
      const controller = await enterConflict(adapter)
      const latestRemote = makeQuickNote({
        content: 'unpersisted replacement base',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const replacementUpdate = createDeferred<ExistingEditUpdateResult>()
      adapter.readTargetResult = { note: latestRemote, lifecycle: 'active' }
      adapter.checkpointEffects.push(
        () => Promise.reject(new Error('replacement checkpoint blocked')),
      )
      adapter.updateEffects.push(() => replacementUpdate.promise)

      const resolution = controller.resolveConflict('keep-local')
      await flushMicrotasks()

      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'memory-only',
        editingNote: latestRemote,
        draft: 'local revision',
      })
      replacementUpdate.reject(new Error('replacement update blocked'))
      await expect(resolution).resolves.toEqual({
        kind: 'failed',
        issue: {
          code: 'checkpoint-failed',
          retryable: true,
          durability: 'memory-only',
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'failed',
        durability: 'memory-only',
        draft: 'local revision',
      })
    })

    it('returns conflict again when remote changes after keep-local reread', async () => {
      const controller = await enterConflict(adapter)
      const readRemote = makeQuickNote({
        content: 'remote seen by resolution',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const secondRemote = makeQuickNote({
        content: 'remote changed again',
        updated_at: '2026-07-12T06:00:01.000Z',
      })
      adapter.readTargetResult = { note: readRemote, lifecycle: 'active' }
      adapter.updateResult = { kind: 'conflict', note: secondRemote }

      await expect(controller.resolveConflict('keep-local')).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: secondRemote,
          localDraft: 'local revision',
          remoteContent: 'remote changed again',
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        draft: 'local revision',
        conflict: {
          note: secondRemote,
          localDraft: 'local revision',
          remoteContent: 'remote changed again',
        },
      })
    })

    it('accepts blank keep-local without claiming a clean save', async () => {
      const remote = makeQuickNote({
        content: 'remote current',
        updated_at: '2026-07-12T05:00:00.000Z',
      })
      adapter.loadResult = validRecoveredLoad({
        snapshot: {
          baseContent: 'old base',
          draft: '   ',
        },
        note: remote,
      })
      adapter.readTargetResult = { note: remote, lifecycle: 'active' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      expect(controller.state.phase).toBe('conflict')

      await expect(controller.resolveConflict('keep-local')).resolves.toEqual({
        kind: 'resolved',
        strategy: 'keep-local',
      })

      expect(adapter.updateCalls).toEqual([])
      expect(adapter.checkpointCalls).toHaveLength(1)
      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'recovery-durable',
        draft: '   ',
        conflict: null,
      })
    })

    it('uses authoritative remote only after ownership-safe cleanup', async () => {
      const onSaved = vi.fn((note: QuickNote): undefined => {
        adapter.operationLog.push(`projection:${note.content}`)
        return undefined
      })
      const controller = await enterConflict(adapter, { onSaved })
      const latestRemote = makeQuickNote({
        content: 'authoritative remote',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      adapter.readTargetResult = { note: latestRemote, lifecycle: 'active' }
      adapter.operationLog.length = 0

      await expect(controller.resolveConflict('use-remote')).resolves.toEqual({
        kind: 'resolved',
        strategy: 'use-remote',
      })

      expect(adapter.operationLog).toEqual([
        'read-target',
        'clear',
        'projection:authoritative remote',
      ])
      expect(adapter.updateCalls).toHaveLength(1)
      expect(onSaved).toHaveBeenCalledOnce()
      expect(controller.state).toEqual({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: latestRemote,
        draft: latestRemote.content,
        conflict: null,
        issue: null,
      })
    })

    it('updates use-remote identity before synchronous projection re-entry', async () => {
      const latestRemote = makeQuickNote({
        content: 'synchronously projected remote',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const controllerRef: { current: ExistingEditController | null } = {
        current: null,
      }
      const onSaved = vi.fn((note: QuickNote): undefined => {
        controllerRef.current?.observeProjection(
          projectionFor(note.id, 'active', { ...note }),
        )
        return undefined
      })
      const controller = await enterConflict(adapter, { onSaved })
      controllerRef.current = controller
      adapter.readTargetResult = { note: latestRemote, lifecycle: 'active' }
      const publications: QuickNoteExistingEditState[] = []
      controller.subscribe(() => publications.push(controller.getSnapshot()))

      await expect(controller.resolveConflict('use-remote')).resolves.toEqual({
        kind: 'resolved',
        strategy: 'use-remote',
      })

      expect(onSaved).toHaveBeenCalledOnce()
      expect(publications.map((state) => state.phase)).toEqual(['saved'])
      expect(publications.some((state) => state.conflict !== null)).toBe(false)
      expect(controller.state).toEqual({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: latestRemote,
        draft: latestRemote.content,
        conflict: null,
        issue: null,
      })
    })

    it.each(
      (['active-v3', 'missing'] as const).flatMap((authority) => (
        (['succeeds', 'rejects'] as const).map(
          (compensation) => [authority, compensation] as const,
        )
      )),
    )(
      'reconciles use-remote cleanup against %s when compensation %s',
      async (authority, compensation) => {
        const cleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const compensationCheckpoint = createDeferred<void>()
        const initialRemote = makeQuickNote({
          content: 'initial conflict remote',
          updated_at: '2026-07-12T05:00:00.000Z',
        })
        const remoteV2 = makeQuickNote({
          content: 'selected remote v2',
          updated_at: '2026-07-12T06:00:00.000Z',
        })
        const remoteV3 = makeQuickNote({
          content: 'authoritative remote v3',
          updated_at: '2026-07-12T06:00:01.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        const controller = await enterConflict(adapter, {
          remote: initialRemote,
          onSaved,
        })
        const recoveryBeforeCleanup = adapter.stored
        adapter.readTargetResult = { note: remoteV2, lifecycle: 'active' }
        adapter.clearEffects.push(() => cleanup.promise)

        const resolution = controller.resolveConflict('use-remote')
        await flushMicrotasks()
        expect(adapter.clearCalls).toEqual([[
          { kind: 'v1', editId: 'edit-1', revision: 1 },
        ]])

        adapter.readTargetResult = authority === 'active-v3'
          ? { note: remoteV3, lifecycle: 'active' }
          : { note: null, lifecycle: 'missing' }
        controller.observeProjection(authority === 'active-v3'
          ? projectionFor(remoteV3.id, 'active', remoteV3)
          : projectionFor(remoteV2.id, 'missing', null))
        adapter.checkpointEffects.push(() => compensationCheckpoint.promise)
        cleanup.resolve('cleared')
        await flushMicrotasks()

        expect(adapter.stored).toBeNull()
        expect(controller.state).toMatchObject({
          phase: authority === 'active-v3'
            ? 'conflict'
            : 'target-unavailable',
          durability: 'memory-only',
          draft: 'local revision',
        })
        if (compensation === 'succeeds') {
          compensationCheckpoint.resolve()
        } else {
          compensationCheckpoint.reject(new Error('compensation blocked'))
        }

        if (authority === 'active-v3') {
          await expect(resolution).resolves.toEqual({
            kind: 'conflict',
            conflict: {
              note: remoteV3,
              localDraft: 'local revision',
              remoteContent: remoteV3.content,
            },
          })
          expect(controller.state).toMatchObject({
            phase: 'conflict',
            editingNote: remoteV3,
            conflict: { note: remoteV3 },
          })
        } else {
          await expect(resolution).resolves.toEqual({
            kind: 'unavailable',
            lifecycle: 'missing',
          })
          expect(controller.state).toMatchObject({
            phase: 'target-unavailable',
            editingNote: initialRemote,
            conflict: null,
          })
        }
        expect(controller.state.durability).toBe(
          compensation === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
        )
        expect(adapter.readTargetCalls).toEqual([
          'quick-note-1',
          'quick-note-1',
        ])
        expect(adapter.checkpointCalls).toHaveLength(2)
        expect(adapter.checkpointCalls[1]).toEqual(recoveryBeforeCleanup)
        expect(adapter.updateCalls).toHaveLength(1)
        expect(onSaved).not.toHaveBeenCalled()
        if (compensation === 'succeeds') {
          expect(adapter.stored).toEqual(recoveryBeforeCleanup)
        } else {
          expect(adapter.stored).toBeNull()
        }
      },
    )

    it('reconciles use-remote when projection changes during its initial read', async () => {
      const initialRead = createDeferred<ControlledReadTargetResult>()
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const remoteV2 = makeQuickNote({
        content: 'stale read remote v2',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const remoteV3 = makeQuickNote({
        content: 'projection during read v3',
        updated_at: '2026-07-12T06:00:01.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      const controller = await enterConflict(adapter, { onSaved })
      adapter.readTargetEffects.push(() => initialRead.promise)
      adapter.clearEffects.push(() => cleanup.promise)

      const resolution = controller.resolveConflict('use-remote')
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(remoteV3.id, 'active', remoteV3),
      )
      adapter.readTargetResult = { note: remoteV3, lifecycle: 'active' }
      initialRead.resolve({ note: remoteV2, lifecycle: 'active' })
      await flushMicrotasks()
      cleanup.resolve('cleared')

      await expect(resolution).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: remoteV3,
          localDraft: 'local revision',
          remoteContent: remoteV3.content,
        },
      })
      expect(adapter.readTargetCalls).toEqual([
        'quick-note-1',
        'quick-note-1',
      ])
      expect(adapter.checkpointCalls).toHaveLength(2)
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 1,
        draft: 'local revision',
      })
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('drops use-remote recovery durability while post-cleanup authority read is pending', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const authorityRead = createDeferred<ControlledReadTargetResult>()
      const remoteV2 = makeQuickNote({
        content: 'use-remote pending authority v2',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const remoteV3 = makeQuickNote({
        content: 'use-remote pending authority v3',
        updated_at: '2026-07-12T06:00:01.000Z',
      })
      const remoteV4 = makeQuickNote({
        content: 'use-remote superseding projection v4',
        updated_at: '2026-07-12T06:00:02.000Z',
      })
      const controller = await enterConflict(adapter)
      adapter.readTargetResult = { note: remoteV2, lifecycle: 'active' }
      adapter.clearEffects.push(() => cleanup.promise)
      const resolution = controller.resolveConflict('use-remote')
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(remoteV3.id, 'active', remoteV3),
      )
      adapter.readTargetEffects.push(() => authorityRead.promise)
      cleanup.resolve('cleared')
      await flushMicrotasks()

      expect(adapter.stored).toBeNull()
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'memory-only',
        draft: 'local revision',
        conflict: { note: remoteV3 },
      })
      controller.observeProjection(
        projectionFor(remoteV4.id, 'active', remoteV4),
      )
      authorityRead.resolve({ note: remoteV3, lifecycle: 'active' })
      await expect(resolution).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: remoteV4,
          localDraft: 'local revision',
          remoteContent: remoteV4.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: remoteV4,
        conflict: { note: remoteV4 },
      })
    })

    it('treats an authoritative prior base as conflict after use-remote cleanup', async () => {
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const base = makeQuickNote()
      const remoteV2 = makeQuickNote({
        content: 'prior-base selected remote v2',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      const controller = await enterConflict(adapter, { onSaved })
      adapter.readTargetResult = { note: remoteV2, lifecycle: 'active' }
      adapter.clearEffects.push(() => cleanup.promise)
      const resolution = controller.resolveConflict('use-remote')
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )
      adapter.readTargetResult = { note: base, lifecycle: 'active' }
      cleanup.resolve('cleared')

      await expect(resolution).resolves.toEqual({
        kind: 'conflict',
        conflict: {
          note: base,
          localDraft: 'local revision',
          remoteContent: base.content,
        },
      })
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        editingNote: base,
        draft: 'local revision',
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: 'edit-1', revision: 1 },
      ]])
      expect(adapter.checkpointCalls).toHaveLength(2)
      expect(adapter.stored).toMatchObject({
        revision: 1,
        baseContent: base.content,
        baseUpdatedAt: base.updated_at,
        draft: 'local revision',
      })
      expect(onSaved).not.toHaveBeenCalled()
    })

    it.each(['rejected', 'different-edit'] as const)(
      'preserves exact controlled conflict when use-remote cleanup is %s',
      async (cleanupFailure) => {
        const controller = await enterConflict(adapter)
        const latestRemote = makeQuickNote({
          content: 'latest remote must stay hidden',
          updated_at: '2026-07-12T06:00:00.000Z',
        })
        adapter.readTargetResult = { note: latestRemote, lifecycle: 'active' }
        if (cleanupFailure === 'rejected') {
          adapter.clearEffects.push(
            () => Promise.reject(new Error('clear blocked')),
          )
        } else {
          adapter.clearResult = 'different-edit'
        }
        const before = controller.getSnapshot()

        await expect(controller.resolveConflict('use-remote')).resolves.toEqual({
          kind: 'failed',
          issue: {
            code: 'recovery-cleanup-failed',
            retryable: true,
            durability: 'recovery-durable',
          },
        })

        expect(controller.getSnapshot()).toBe(before)
        expect(controller.getSnapshot().draft).toBe(before.draft)
        expect(controller.getSnapshot().conflict).toEqual(before.conflict)
        expect(controller.getSnapshot().editingNote).toBe(before.editingNote)
      },
    )

    it('merges exact trimmed text, schedules both timers, and can conflict again', async () => {
      const localDraft = '本地草稿第一行\n本地草稿第二行   '
      const initialRemote = makeQuickNote({
        content: 'initial remote',
        updated_at: '2026-07-12T05:00:00.000Z',
      })
      const latestRemote = makeQuickNote({
        content: '  远端正文  ',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      const laterRemote = makeQuickNote({
        content: '远端再次变化',
        updated_at: '2026-07-12T06:00:01.000Z',
      })
      const merged =
        '本地草稿第一行\n本地草稿第二行\n\n--- 远端版本 ---\n远端正文'
      const controller = await enterConflict(adapter, {
        localDraft,
        remote: initialRemote,
      })
      adapter.readTargetResult = { note: latestRemote, lifecycle: 'active' }
      const checkpointsBefore = adapter.checkpointCalls.length
      const updatesBefore = adapter.updateCalls.length

      await expect(controller.resolveConflict('merge')).resolves.toEqual({
        kind: 'resolved',
        strategy: 'merge',
      })
      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'memory-only',
        editingNote: latestRemote,
        draft: merged,
        conflict: null,
      })

      await vi.advanceTimersByTimeAsync(499)
      expect(adapter.checkpointCalls).toHaveLength(checkpointsBefore)
      await vi.advanceTimersByTimeAsync(1)
      expect(adapter.checkpointCalls).toHaveLength(checkpointsBefore + 1)
      expect(adapter.checkpointCalls.at(-1)).toMatchObject({
        baseContent: latestRemote.content,
        baseUpdatedAt: latestRemote.updated_at,
        draft: merged,
      })
      await vi.advanceTimersByTimeAsync(399)
      expect(adapter.updateCalls).toHaveLength(updatesBefore)
      adapter.updateResult = { kind: 'conflict', note: laterRemote }
      await vi.advanceTimersByTimeAsync(1)

      expect(adapter.updateCalls).toHaveLength(updatesBefore + 1)
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        draft: merged,
        conflict: {
          note: laterRemote,
          localDraft: merged,
          remoteContent: laterRemote.content,
        },
      })
    })

    it('coalesces one conflict strategy and preserves conflict for another terminal call', async () => {
      const controller = await enterConflict(adapter)
      const read = createDeferred<ControlledReadTargetResult>()
      const latestRemote = makeQuickNote({
        content: 'coalesced remote',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      adapter.readTargetEffects.push(() => read.promise)
      const before = controller.getSnapshot()

      const first = controller.resolveConflict('use-remote')
      const second = controller.resolveConflict('use-remote')
      const other = controller.resolveConflict('merge')

      expect(second).toBe(first)
      await expect(other).resolves.toEqual({
        kind: 'conflict',
        conflict: before.conflict,
      })
      expect(controller.getSnapshot()).toBe(before)
      await flushMicrotasks()
      read.resolve({ note: latestRemote, lifecycle: 'active' })
      await expect(first).resolves.toEqual({
        kind: 'resolved',
        strategy: 'use-remote',
      })
    })

    it('keeps same-strategy resolution single-flight after target removal', async () => {
      const controller = await enterConflict(adapter)
      const read = createDeferred<ControlledReadTargetResult>()
      adapter.readTargetEffects.push(() => read.promise)

      const first = controller.resolveConflict('use-remote')
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor('quick-note-1', 'missing', null),
      )
      expect(controller.state.phase).toBe('target-unavailable')

      const second = controller.resolveConflict('use-remote')

      expect(second).toBe(first)
      expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
      read.resolve({ note: null, lifecycle: 'missing' })
      await expect(first).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'missing',
      })
    })

    it.each(['keep-local', 'merge'] as const)(
      'coalesces repeated %s resolution into one terminal flight',
      async (strategy) => {
        const controller = await enterConflict(adapter)
        const read = createDeferred<ControlledReadTargetResult>()
        const latestRemote = makeQuickNote({
          content: `${strategy} authoritative remote`,
          updated_at: '2026-07-12T06:00:00.000Z',
        })
        const committed = makeQuickNote({
          content: 'local revision',
          updated_at: '2026-07-12T06:00:01.000Z',
        })
        adapter.readTargetEffects.push(() => read.promise)
        adapter.updateResult = { kind: 'updated', note: committed }

        const first = controller.resolveConflict(strategy)
        const second = controller.resolveConflict(strategy)

        expect(second).toBe(first)
        await flushMicrotasks()
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        read.resolve({ note: latestRemote, lifecycle: 'active' })
        await expect(first).resolves.toEqual({
          kind: 'resolved',
          strategy,
        })
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
      },
    )

    it('blocks save and cancel while conflict resolution owns the terminal flight', async () => {
      const controller = await enterConflict(adapter)
      const read = createDeferred<ControlledReadTargetResult>()
      const latestRemote = makeQuickNote({
        content: 'terminal authoritative remote',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      adapter.readTargetEffects.push(() => read.promise)

      const resolution = controller.resolveConflict('merge')
      await flushMicrotasks()

      await expect(controller.save()).resolves.toEqual({
        kind: 'busy',
        operation: 'save',
      })
      await expect(controller.cancel()).resolves.toEqual({
        kind: 'busy',
        operation: 'save',
      })
      expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
      read.resolve({ note: latestRemote, lifecycle: 'active' })
      await expect(resolution).resolves.toEqual({
        kind: 'resolved',
        strategy: 'merge',
      })
    })

    it('preserves an observed conflict when save owns the lane', async () => {
      const update = createDeferred<ExistingEditUpdateResult>()
      adapter.updateEffects.push(() => update.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('saving local conflict')
      const save = controller.save()
      await flushMicrotasks()
      const projectedRemote = makeQuickNote({
        content: 'projected while saving',
        updated_at: '2026-07-12T06:00:00.000Z',
      })
      controller.observeProjection(
        projectionFor(projectedRemote.id, 'active', projectedRemote),
      )
      const conflict = controller.state.conflict

      await expect(controller.resolveConflict('keep-local')).resolves.toEqual({
        kind: 'conflict',
        conflict,
      })
      expect(adapter.readTargetCalls).toEqual([])
      update.resolve({ kind: 'conflict', note: projectedRemote })
      await expect(save).resolves.toMatchObject({ kind: 'conflict' })
    })

    it('preserves conflict when resolution is requested while cancel owns', async () => {
      const controller = await enterConflict(adapter)
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      adapter.clearEffects.push(() => cleanup.promise)
      const before = controller.getSnapshot()
      const cancel = controller.cancel()

      await expect(controller.resolveConflict('keep-local')).resolves.toEqual({
        kind: 'conflict',
        conflict: before.conflict,
      })
      expect(controller.getSnapshot()).toBe(before)
      cleanup.resolve('different-edit')
      await expect(cancel).resolves.toMatchObject({ kind: 'failed' })
    })

    it.each(
      (['keep-local', 'use-remote', 'merge'] as const).flatMap((strategy) => (
        (['missing', 'trashed', 'archived', 'converted', 'sync-deleted'] as const)
          .map((lifecycle) => [strategy, lifecycle] as const)
      )),
    )(
      'returns %s unavailable for authoritative %s without clearing local work',
      async (strategy, lifecycle) => {
        const controller = await enterConflict(adapter)
        const target = lifecycle === 'missing'
          ? null
          : makeQuickNote({ content: `${lifecycle} target` })
        adapter.readTargetResult = { note: target, lifecycle }
        const before = controller.getSnapshot()
        const clearCount = adapter.clearCalls.length
        const checkpointCount = adapter.checkpointCalls.length
        const updateCount = adapter.updateCalls.length

        await expect(controller.resolveConflict(strategy)).resolves.toEqual({
          kind: 'unavailable',
          lifecycle,
        })

        expect(adapter.clearCalls).toHaveLength(clearCount)
        expect(controller.getSnapshot()).not.toBe(before)
        expect(controller.state).toEqual({
          phase: 'target-unavailable',
          durability: 'recovery-durable',
          editingNote: before.editingNote,
          draft: 'local revision',
          conflict: null,
          issue: null,
        })
        expect(adapter.checkpointCalls).toHaveLength(checkpointCount)
        expect(adapter.updateCalls).toHaveLength(updateCount)
        await vi.advanceTimersByTimeAsync(901)
        expect(adapter.checkpointCalls).toHaveLength(checkpointCount)
        expect(adapter.updateCalls).toHaveLength(updateCount)
        expect(adapter.clearCalls).toHaveLength(clearCount)
      },
    )

    it.each(
      ['missing', 'trashed', 'archived', 'converted', 'sync-deleted'] as const,
    )('returns direct save unavailable for %s and preserves draft', async (lifecycle) => {
      adapter.updateResult = { kind: 'unavailable', lifecycle }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change(`local ${lifecycle}`)

      await expect(controller.save()).resolves.toEqual({
        kind: 'unavailable',
        lifecycle,
      })
      expect(controller.state).toMatchObject({
        phase: 'target-unavailable',
        durability: 'recovery-durable',
        draft: `local ${lifecycle}`,
      })
      expect(adapter.clearCalls).toEqual([])
    })

    it.each(['keep-local', 'use-remote', 'merge'] as const)(
      'short-circuits %s from target-unavailable without storage or timer work',
      async (strategy) => {
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        const base = makeQuickNote()
        controller.start(base)
        controller.change('copyable unavailable draft')
        controller.observeProjection(projectionFor(base.id, 'archived', base))
        const before = controller.getSnapshot()
        const operationCount = adapter.operationLog.length

        await expect(controller.resolveConflict(strategy)).resolves.toEqual({
          kind: 'unavailable',
          lifecycle: 'archived',
        })

        expect(controller.getSnapshot()).toBe(before)
        expect(adapter.operationLog).toHaveLength(operationCount)
        expect(adapter.readTargetCalls).toEqual([])
        expect(adapter.checkpointCalls).toEqual([])
        expect(adapter.updateCalls).toEqual([])
        expect(adapter.clearCalls).toEqual([])
        expect(onSaved).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(901)
        expect(adapter.operationLog).toHaveLength(operationCount)
      },
    )
  })

  describe('Task 5 projection observation', () => {
    it('adopts a clean active remote change as the next save base', async () => {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      const remote = makeQuickNote({
        content: 'clean remote update',
        updated_at: '2026-07-12T05:00:00.000Z',
      })

      controller.observeProjection(
        projectionFor(remote.id, 'active', remote),
      )

      expect(controller.state).toEqual({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: remote,
        draft: remote.content,
        conflict: null,
        issue: null,
      })

      const committed = makeQuickNote({
        content: 'local after remote',
        updated_at: '2026-07-12T05:00:01.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      controller.change('local after remote')
      await expect(controller.save()).resolves.toMatchObject({ kind: 'saved' })
      expect(adapter.updateCalls).toEqual([{
        noteId: remote.id,
        baseContent: remote.content,
        baseUpdatedAt: remote.updated_at,
        draft: 'local after remote',
      }])
    })

    it('turns a dirty content change into conflict and cancels autosave', async () => {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('local draft')
      const remote = makeQuickNote({
        content: 'remote changed content',
        updated_at: BASE_UPDATED_AT,
      })

      controller.observeProjection(
        projectionFor(remote.id, 'active', remote),
      )

      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'memory-only',
        draft: 'local draft',
        conflict: {
          note: remote,
          localDraft: 'local draft',
          remoteContent: 'remote changed content',
        },
      })
      await vi.advanceTimersByTimeAsync(901)
      expect(adapter.checkpointCalls).toEqual([])
      expect(adapter.updateCalls).toEqual([])
    })

    it('keeps checkpoint durability and conflict after an updated-at projection', async () => {
      const checkpoint = createDeferred<void>()
      adapter.checkpointEffects.push(() => checkpoint.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('checkpointing local')
      await vi.advanceTimersByTimeAsync(500)
      expect(controller.state.phase).toBe('checkpointing')
      const remote = makeQuickNote({
        content: 'base',
        updated_at: '2026-07-12T05:00:00.000Z',
      })

      controller.observeProjection(
        projectionFor(remote.id, 'active', remote),
      )
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'memory-only',
        draft: 'checkpointing local',
      })
      checkpoint.resolve()
      await flushMicrotasks()

      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        draft: 'checkpointing local',
        conflict: {
          note: remote,
          localDraft: 'checkpointing local',
          remoteContent: 'base',
        },
      })
      await vi.advanceTimersByTimeAsync(401)
      expect(adapter.updateCalls).toEqual([])
    })

    it('lets authoritative save success override an early saving projection conflict', async () => {
      const update = createDeferred<ExistingEditUpdateResult>()
      const committed = makeQuickNote({
        content: 'saving local',
        updated_at: '2026-07-12T05:00:01.000Z',
      })
      adapter.updateEffects.push(() => update.promise)
      adapter.readTargetResult = { note: committed, lifecycle: 'active' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('saving local')
      const save = controller.save()
      await flushMicrotasks()
      const projectedRemote = makeQuickNote({
        content: 'stale projected remote',
        updated_at: '2026-07-12T05:00:00.000Z',
      })

      controller.observeProjection(
        projectionFor(projectedRemote.id, 'active', projectedRemote),
      )
      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        draft: 'saving local',
      })

      update.resolve({ kind: 'updated', note: committed })
      await expect(save).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'refreshed',
      })
      expect(controller.state).toMatchObject({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: committed,
        draft: 'saving local',
        conflict: null,
      })
    })

    it.each(['active', 'missing'] as const)(
      'reconciles an updated in-flight save against authoritative %s target',
      async (authority) => {
        const update = createDeferred<ExistingEditUpdateResult>()
        const committed = makeQuickNote({
          content: 'committed after removal',
          updated_at: '2026-07-12T05:00:01.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.updateEffects.push(() => update.promise)
        adapter.readTargetResult = authority === 'active'
          ? { note: committed, lifecycle: 'active' }
          : { note: null, lifecycle: 'missing' }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('committed after removal')
        const save = controller.save()
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor('quick-note-1', 'missing', null),
        )
        const stored = adapter.stored

        update.resolve({ kind: 'updated', note: committed })
        if (authority === 'active') {
          await expect(save).resolves.toEqual({
            kind: 'saved',
            note: committed,
            visibility: 'refreshed',
          })
          expect(controller.state).toMatchObject({
            phase: 'saved',
            durability: 'entity-durable',
            editingNote: committed,
            draft: 'committed after removal',
          })
          expect(onSaved).toHaveBeenCalledOnce()
          expect(adapter.clearCalls).toHaveLength(1)
          expect(adapter.stored).toBeNull()
        } else {
          await expect(save).resolves.toEqual({
            kind: 'unavailable',
            lifecycle: 'missing',
          })
          expect(controller.state).toEqual({
            phase: 'target-unavailable',
            durability: 'entity-durable',
            editingNote: committed,
            draft: 'committed after removal',
            conflict: null,
            issue: null,
          })
          expect(onSaved).not.toHaveBeenCalled()
          expect(adapter.clearCalls).toEqual([])
          expect(adapter.stored).toBe(stored)
          await expect(controller.save()).resolves.toEqual({
            kind: 'unavailable',
            lifecycle: 'missing',
          })
          expect(adapter.updateCalls).toHaveLength(1)
        }
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        expect(adapter.updateCalls).toHaveLength(1)
      },
    )

    it('publishes committed entity durability before post-update authority becomes unavailable', async () => {
      const update = createDeferred<ExistingEditUpdateResult>()
      const base = makeQuickNote()
      const committed = makeQuickNote({
        content: 'committed before authority missing',
        updated_at: '2026-07-12T05:00:01.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      adapter.updateEffects.push(() => update.promise)
      adapter.readTargetResult = { note: null, lifecycle: 'missing' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.change('committed before authority missing')
      const save = controller.save()
      await flushMicrotasks()
      controller.observeProjection(projectionFor(base.id, 'missing', null))
      const stored = adapter.stored
      update.resolve({ kind: 'updated', note: committed })

      await expect(save).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'missing',
      })
      expect(controller.state).toEqual({
        phase: 'target-unavailable',
        durability: 'entity-durable',
        editingNote: committed,
        draft: 'committed before authority missing',
        conflict: null,
        issue: null,
      })
      expect(adapter.stored).toBe(stored)
      expect(adapter.clearCalls).toEqual([])
      expect(adapter.updateCalls).toHaveLength(1)
      expect(onSaved).not.toHaveBeenCalled()
      await expect(controller.save()).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'missing',
      })
      expect(adapter.updateCalls).toHaveLength(1)
    })

    it('retries post-update authority failure without repeating the entity update', async () => {
      const update = createDeferred<ExistingEditUpdateResult>()
      const base = makeQuickNote()
      const committed = makeQuickNote({
        content: 'committed before authority failure',
        updated_at: '2026-07-12T05:00:01.000Z',
      })
      const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
      adapter.updateEffects.push(() => update.promise)
      adapter.readTargetEffects.push(
        () => Promise.reject(new Error('post-update authority blocked')),
      )
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter, onSaved),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.change('committed before authority failure')
      const save = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )
      const stored = adapter.stored
      update.resolve({ kind: 'updated', note: committed })

      await expect(save).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'pending',
      })
      expect(controller.state).toEqual({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: committed,
        draft: 'committed before authority failure',
        conflict: null,
        issue: {
          code: 'projection-failed',
          retryable: false,
          durability: 'entity-durable',
        },
      })
      expect(adapter.stored).toBe(stored)
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toEqual([])
      expect(onSaved).not.toHaveBeenCalled()
      await flushMicrotasks()

      adapter.readTargetResult = { note: committed, lifecycle: 'active' }
      await expect(controller.save()).resolves.toEqual({
        kind: 'saved',
        note: committed,
        visibility: 'refreshed',
      })
      expect(adapter.readTargetCalls).toEqual([
        'quick-note-1',
        'quick-note-1',
      ])
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: 'edit-1', revision: 1 },
      ]])
      expect(adapter.stored).toBeNull()
      expect(onSaved).toHaveBeenCalledOnce()
      expect(controller.state).toEqual({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: committed,
        draft: committed.content,
        conflict: null,
        issue: null,
      })
    })

    it('keeps an in-flight save single-flight after target removal', async () => {
      const update = createDeferred<ExistingEditUpdateResult>()
      const committed = makeQuickNote({
        content: 'single-flight after removal',
        updated_at: '2026-07-12T05:00:01.000Z',
      })
      adapter.updateEffects.push(() => update.promise)
      adapter.readTargetResult = { note: null, lifecycle: 'missing' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('single-flight after removal')
      const first = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor('quick-note-1', 'missing', null),
      )

      const second = controller.save()

      expect(second).toBe(first)
      update.resolve({ kind: 'updated', note: committed })
      await expect(first).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'missing',
      })
      expect(adapter.updateCalls).toHaveLength(1)
      expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
    })

    it.each(['active', 'missing'] as const)(
      'reconciles an in-flight conflict against authoritative %s target',
      async (authority) => {
        const update = createDeferred<ExistingEditUpdateResult>()
        const remote = makeQuickNote({
          content: 'late update conflict',
          updated_at: '2026-07-12T05:00:01.000Z',
        })
        adapter.updateEffects.push(() => update.promise)
        adapter.readTargetResult = authority === 'active'
          ? { note: remote, lifecycle: 'active' }
          : { note: null, lifecycle: 'missing' }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local before removal')
        const save = controller.save()
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor('quick-note-1', 'missing', null),
        )
        const unavailable = controller.getSnapshot()
        const stored = adapter.stored

        update.resolve({ kind: 'conflict', note: remote })
        if (authority === 'active') {
          await expect(save).resolves.toEqual({
            kind: 'conflict',
            conflict: {
              note: remote,
              localDraft: 'local before removal',
              remoteContent: remote.content,
            },
          })
          expect(controller.state).toMatchObject({
            phase: 'conflict',
            durability: 'recovery-durable',
            draft: 'local before removal',
          })
        } else {
          await expect(save).resolves.toEqual({
            kind: 'unavailable',
            lifecycle: 'missing',
          })
          expect(controller.getSnapshot()).toBe(unavailable)
        }
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        expect(adapter.clearCalls).toEqual([])
        expect(adapter.stored).toBe(stored)
      },
    )

    it.each(['updated', 'conflict'] as const)(
      'uses authoritative active v2 after an in-flight %s result',
      async (updateOutcome) => {
        const update = createDeferred<ExistingEditUpdateResult>()
        const resultV1 = makeQuickNote({
          content: `${updateOutcome} result v1`,
          updated_at: '2026-07-12T05:00:01.000Z',
        })
        const authoritativeV2 = makeQuickNote({
          content: 'authoritative active v2',
          updated_at: '2026-07-12T05:00:02.000Z',
        })
        const onSaved = vi.fn((_note: QuickNote): undefined => undefined)
        adapter.updateEffects.push(() => update.promise)
        adapter.readTargetResult = {
          note: authoritativeV2,
          lifecycle: 'active',
        }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter, onSaved),
        )
        await flushMicrotasks()
        controller.start(makeQuickNote())
        controller.change('local before active v2')
        const save = controller.save()
        await flushMicrotasks()
        controller.observeProjection(
          projectionFor('quick-note-1', 'missing', null),
        )
        const stored = adapter.stored

        update.resolve(updateOutcome === 'updated'
          ? { kind: 'updated', note: resultV1 }
          : { kind: 'conflict', note: resultV1 })

        await expect(save).resolves.toEqual({
          kind: 'conflict',
          conflict: {
            note: authoritativeV2,
            localDraft: 'local before active v2',
            remoteContent: authoritativeV2.content,
          },
        })
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: updateOutcome === 'updated'
            ? 'entity-durable'
            : 'recovery-durable',
          editingNote: authoritativeV2,
          draft: 'local before active v2',
          conflict: {
            note: authoritativeV2,
            localDraft: 'local before active v2',
            remoteContent: authoritativeV2.content,
          },
        })
        expect(adapter.readTargetCalls).toEqual(['quick-note-1'])
        expect(adapter.updateCalls).toHaveLength(1)
        expect(adapter.clearCalls).toEqual([])
        expect(adapter.stored).toBe(stored)
        expect(onSaved).not.toHaveBeenCalled()
      },
    )

    it('keeps target removal authoritative when an in-flight update rejects', async () => {
      const update = createDeferred<ExistingEditUpdateResult>()
      adapter.updateEffects.push(() => update.promise)
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('local before removal')
      const save = controller.save()
      await flushMicrotasks()
      controller.observeProjection(
        projectionFor('quick-note-1', 'missing', null),
      )
      const unavailable = controller.getSnapshot()

      update.reject(new Error('late update rejected'))
      await expect(save).resolves.toMatchObject({ kind: 'failed' })

      expect(controller.getSnapshot()).toBe(unavailable)
      expect(adapter.readTargetCalls).toEqual([])
      expect(adapter.clearCalls).toEqual([])
    })

    it('preserves failed recovery durability when projection detects conflict', async () => {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('failed local')
      await vi.advanceTimersByTimeAsync(500)
      adapter.updateEffects.push(
        () => Promise.reject(new Error('entity blocked')),
      )
      await controller.save()
      expect(controller.state).toMatchObject({
        phase: 'failed',
        durability: 'recovery-durable',
      })
      const remote = makeQuickNote({
        content: 'base',
        updated_at: '2026-07-12T05:00:00.000Z',
      })

      controller.observeProjection(
        projectionFor(remote.id, 'active', remote),
      )

      expect(controller.state).toMatchObject({
        phase: 'conflict',
        durability: 'recovery-durable',
        draft: 'failed local',
        issue: null,
        conflict: {
          note: remote,
          localDraft: 'failed local',
          remoteContent: 'base',
        },
      })
    })

    it('treats an active projection equal to the owned base as a no-op', async () => {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      const base = makeQuickNote()
      controller.start(base)
      const before = controller.getSnapshot()
      const listener = vi.fn()
      controller.subscribe(listener)

      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )

      expect(controller.getSnapshot()).toBe(before)
      expect(listener).not.toHaveBeenCalled()
    })

    it.each(
      ['missing', 'trashed', 'archived', 'converted', 'sync-deleted'] as const,
    )('preserves local work when projection reports %s', async (lifecycle) => {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      const base = makeQuickNote({ id: `projected-${lifecycle}` })
      controller.start(base)
      controller.change(`local ${lifecycle} draft`)
      const target = lifecycle === 'missing'
        ? null
        : makeQuickNote({ id: base.id, content: `${lifecycle} target` })

      controller.observeProjection(
        projectionFor(base.id, lifecycle, target),
      )

      expect(controller.state).toMatchObject({
        phase: 'target-unavailable',
        durability: 'memory-only',
        editingNote: base,
        draft: `local ${lifecycle} draft`,
        conflict: null,
        issue: null,
      })
      const unavailable = controller.getSnapshot()
      controller.start(makeQuickNote({ id: 'replacement' }))
      expect(controller.getSnapshot()).toBe(unavailable)
      await vi.advanceTimersByTimeAsync(901)
      expect(adapter.checkpointCalls).toEqual([])
      expect(adapter.updateCalls).toEqual([])
    })

    it('resumes dirty checkpoint and autosave when an unavailable target returns at the owned base', async () => {
      const base = makeQuickNote()
      const committed = makeQuickNote({
        content: 'local work survives return',
        updated_at: '2026-07-12T05:00:00.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.change('local work survives return')
      controller.observeProjection(projectionFor(base.id, 'missing', null))
      expect(controller.state.phase).toBe('target-unavailable')

      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )

      expect(controller.state).toMatchObject({
        phase: 'dirty',
        durability: 'memory-only',
        editingNote: base,
        draft: 'local work survives return',
        conflict: null,
        issue: null,
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(adapter.checkpointCalls).toHaveLength(1)
      expect(controller.state.durability).toBe('recovery-durable')
      await vi.advanceTimersByTimeAsync(400)
      expect(adapter.updateCalls).toEqual([{
        noteId: base.id,
        baseContent: base.content,
        baseUpdatedAt: base.updated_at,
        draft: 'local work survives return',
      }])
      expect(controller.state).toMatchObject({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: committed,
        draft: 'local work survives return',
      })
    })

    it('adopts an active owned base and clears stale unavailable state for clean work', async () => {
      const base = makeQuickNote()
      adapter.updateResult = { kind: 'unavailable', lifecycle: 'archived' }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.change(base.content)
      await expect(controller.save()).resolves.toEqual({
        kind: 'unavailable',
        lifecycle: 'archived',
      })
      expect(adapter.stored).toMatchObject({
        editId: 'edit-1',
        revision: 1,
        draft: base.content,
      })

      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )

      expect(controller.state.phase).toBe('target-unavailable')
      expect(adapter.clearCalls).toEqual([])
      await flushMicrotasks()
      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: 'edit-1', revision: 1 },
      ]])
      expect(adapter.stored).toBeNull()
      expect(controller.state).toEqual({
        phase: 'saved',
        durability: 'entity-durable',
        editingNote: base,
        draft: base.content,
        conflict: null,
        issue: null,
      })
      await expect(controller.save()).resolves.toEqual({
        kind: 'saved',
        note: base,
        visibility: 'refreshed',
      })
    })

    it.each(['succeeds', 'rejects'] as const)(
      'waits for a pending clean checkpoint before reactivation when it %s',
      async (checkpointOutcome) => {
        const checkpoint = createDeferred<void>()
        const cleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const base = makeQuickNote()
        adapter.checkpointEffects.push(() => checkpoint.promise)
        adapter.clearEffects.push(() => cleanup.promise)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(base)
        controller.change(base.content)
        await vi.advanceTimersByTimeAsync(500)
        expect(adapter.checkpointCalls).toHaveLength(1)

        controller.observeProjection(projectionFor(base.id, 'missing', null))
        controller.observeProjection(
          projectionFor(base.id, 'active', { ...base }),
        )

        expect(controller.state).toMatchObject({
          phase: 'target-unavailable',
          durability: 'memory-only',
          draft: base.content,
        })
        expect(adapter.clearCalls).toEqual([])
        if (checkpointOutcome === 'succeeds') checkpoint.resolve()
        else checkpoint.reject(new Error('clean checkpoint blocked'))
        await flushMicrotasks()

        expect(adapter.clearCalls).toEqual([[
          { kind: 'v1', editId: 'edit-1', revision: 1 },
        ]])
        expect(controller.state).toMatchObject({
          phase: 'target-unavailable',
          durability: checkpointOutcome === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
        })
        if (checkpointOutcome === 'succeeds') {
          expect(adapter.stored).toMatchObject({
            editId: 'edit-1',
            revision: 1,
            draft: base.content,
          })
          cleanup.resolve('cleared')
        } else {
          expect(adapter.stored).toBeNull()
          cleanup.resolve('absent')
        }
        await flushMicrotasks()

        expect(adapter.stored).toBeNull()
        expect(controller.state).toEqual({
          phase: 'saved',
          durability: 'entity-durable',
          editingNote: base,
          draft: base.content,
          conflict: null,
          issue: null,
        })
      },
    )

    it('merges a pending checkpoint owner at clean-reactivation lane start', async () => {
      const checkpointV2 = createDeferred<void>()
      const cleanup = createDeferred<
        'cleared' | 'absent' | 'different-edit'
      >()
      const base = makeQuickNote()
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(base)
      controller.change('temporary revision one')
      await vi.advanceTimersByTimeAsync(500)
      expect(adapter.stored).toMatchObject({ revision: 1 })

      controller.change(base.content)
      adapter.checkpointEffects.push(() => checkpointV2.promise)
      adapter.clearEffects.push(() => cleanup.promise)
      await vi.advanceTimersByTimeAsync(500)
      controller.observeProjection(projectionFor(base.id, 'missing', null))
      controller.observeProjection(
        projectionFor(base.id, 'active', { ...base }),
      )
      expect(adapter.clearCalls).toEqual([])

      checkpointV2.resolve()
      await flushMicrotasks()

      expect(adapter.stored).toMatchObject({ revision: 2, draft: base.content })
      expect(adapter.clearCalls).toEqual([[
        { kind: 'v1', editId: 'edit-1', revision: 1 },
        { kind: 'v1', editId: 'edit-1', revision: 2 },
      ]])
      cleanup.resolve('cleared')
      await flushMicrotasks()
      expect(adapter.stored).toBeNull()
      expect(controller.state.phase).toBe('saved')
    })

    it.each(['succeeds', 'rejects'] as const)(
      'drops clean-reactivation durability while compensation %s',
      async (compensation) => {
        const initialCheckpoint = createDeferred<void>()
        const cleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const compensationCheckpoint = createDeferred<void>()
        const base = makeQuickNote()
        const remoteV2 = makeQuickNote({
          content: 'remote v2 during pending clean reactivation',
          updated_at: '2026-07-12T06:00:00.000Z',
        })
        adapter.checkpointEffects.push(() => initialCheckpoint.promise)
        adapter.clearEffects.push(() => cleanup.promise)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(base)
        controller.change(base.content)
        await vi.advanceTimersByTimeAsync(500)
        controller.observeProjection(projectionFor(base.id, 'missing', null))
        controller.observeProjection(
          projectionFor(base.id, 'active', { ...base }),
        )
        initialCheckpoint.resolve()
        await flushMicrotasks()
        const recoveryBeforeCleanup = adapter.stored
        expect(adapter.clearCalls).toHaveLength(1)

        controller.observeProjection(
          projectionFor(remoteV2.id, 'active', remoteV2),
        )
        adapter.checkpointEffects.push(() => compensationCheckpoint.promise)
        cleanup.resolve('cleared')
        await flushMicrotasks()

        expect(adapter.stored).toBeNull()
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: 'memory-only',
          draft: base.content,
          conflict: { note: remoteV2 },
        })
        if (compensation === 'succeeds') compensationCheckpoint.resolve()
        else compensationCheckpoint.reject(new Error('compensation blocked'))
        await flushMicrotasks()

        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: compensation === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
          draft: base.content,
          conflict: { note: remoteV2 },
        })
        expect(adapter.checkpointCalls).toHaveLength(2)
        if (compensation === 'succeeds') {
          expect(adapter.stored).toEqual(recoveryBeforeCleanup)
        } else {
          expect(adapter.stored).toBeNull()
        }
      },
    )

    it.each(['different-edit', 'rejects'] as const)(
      'preserves clean-reactivation recovery when cleanup %s after a remote change',
      async (cleanupOutcome) => {
        const initialCheckpoint = createDeferred<void>()
        const cleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const base = makeQuickNote()
        const remoteV2 = makeQuickNote({
          content: 'remote v2 before failed cleanup',
          updated_at: '2026-07-12T06:00:00.000Z',
        })
        adapter.checkpointEffects.push(() => initialCheckpoint.promise)
        adapter.clearEffects.push(() => cleanup.promise)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(base)
        controller.change(base.content)
        await vi.advanceTimersByTimeAsync(500)
        controller.observeProjection(projectionFor(base.id, 'missing', null))
        controller.observeProjection(
          projectionFor(base.id, 'active', { ...base }),
        )
        initialCheckpoint.resolve()
        await flushMicrotasks()
        const recoveryBeforeCleanup = adapter.stored
        controller.observeProjection(
          projectionFor(remoteV2.id, 'active', remoteV2),
        )

        if (cleanupOutcome === 'different-edit') cleanup.resolve('different-edit')
        else cleanup.reject(new Error('reactivation cleanup blocked'))
        await flushMicrotasks()

        expect(adapter.clearCalls).toEqual([[
          { kind: 'v1', editId: 'edit-1', revision: 1 },
        ]])
        expect(adapter.checkpointCalls).toHaveLength(1)
        expect(adapter.stored).toBe(recoveryBeforeCleanup)
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: 'recovery-durable',
          draft: base.content,
          conflict: { note: remoteV2 },
        })
      },
    )

    it.each(['rejected', 'different-edit'] as const)(
      'preserves clean unavailable recovery when reactivation cleanup is %s',
      async (cleanupFailure) => {
        const base = makeQuickNote()
        adapter.updateResult = { kind: 'unavailable', lifecycle: 'archived' }
        if (cleanupFailure === 'rejected') {
          adapter.clearEffects.push(
            () => Promise.reject(new Error('reactivation cleanup blocked')),
          )
        } else {
          adapter.clearResult = 'different-edit'
        }
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(base)
        controller.change(base.content)
        await controller.save()
        const unavailable = controller.getSnapshot()
        const stored = adapter.stored

        controller.observeProjection(
          projectionFor(base.id, 'active', { ...base }),
        )
        await flushMicrotasks()

        expect(adapter.clearCalls).toEqual([[
          { kind: 'v1', editId: 'edit-1', revision: 1 },
        ]])
        expect(controller.getSnapshot()).toBe(unavailable)
        expect(adapter.stored).toBe(stored)
        await expect(controller.save()).resolves.toEqual({
          kind: 'unavailable',
          lifecycle: 'archived',
        })
      },
    )

    it.each(['succeeds', 'rejects'] as const)(
      'compensates clean reactivation clear after remote v2 when checkpoint %s',
      async (compensation) => {
        const reactivationCleanup = createDeferred<
          'cleared' | 'absent' | 'different-edit'
        >()
        const base = makeQuickNote()
        const remoteV2 = makeQuickNote({
          content: 'remote v2 during cleanup',
          updated_at: '2026-07-12T06:00:00.000Z',
        })
        adapter.updateResult = { kind: 'unavailable', lifecycle: 'archived' }
        adapter.clearEffects.push(() => reactivationCleanup.promise)
        const controller = createQuickNoteExistingEditSessionController(
          controllerOptions(adapter),
        )
        await flushMicrotasks()
        controller.start(base)
        controller.change(base.content)
        await controller.save()
        const recoveryBeforeCleanup = adapter.stored

        controller.observeProjection(
          projectionFor(base.id, 'active', { ...base }),
        )
        await flushMicrotasks()
        expect(adapter.clearCalls).toHaveLength(1)
        controller.observeProjection(
          projectionFor(remoteV2.id, 'active', remoteV2),
        )
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: 'recovery-durable',
          draft: base.content,
          conflict: {
            note: remoteV2,
            localDraft: base.content,
            remoteContent: remoteV2.content,
          },
        })
        if (compensation === 'rejects') {
          adapter.checkpointEffects.push(
            () => Promise.reject(new Error('reactivation compensation blocked')),
          )
        }
        reactivationCleanup.resolve('cleared')
        await flushMicrotasks()

        expect(adapter.checkpointCalls).toHaveLength(2)
        expect(controller.state).toMatchObject({
          phase: 'conflict',
          durability: compensation === 'succeeds'
            ? 'recovery-durable'
            : 'memory-only',
          draft: base.content,
          conflict: {
            note: remoteV2,
            localDraft: base.content,
            remoteContent: remoteV2.content,
          },
        })
        if (compensation === 'succeeds') {
          expect(adapter.stored).toEqual(recoveryBeforeCleanup)
        } else {
          expect(adapter.stored).toBeNull()
        }
      },
    )

    it.each(
      ['missing', 'trashed', 'archived', 'converted', 'sync-deleted'] as const,
    )('settles a clean edit when projection reports %s', async (lifecycle) => {
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      const base = makeQuickNote({ id: `clean-${lifecycle}` })
      controller.start(base)
      const target = lifecycle === 'missing'
        ? null
        : makeQuickNote({ id: base.id, content: `${lifecycle} target` })

      controller.observeProjection(
        projectionFor(base.id, lifecycle, target),
      )

      expectIdle(controller.state)
    })

    it('does not self-conflict when projection repeats the committed entity', async () => {
      const committed = makeQuickNote({
        content: 'committed content',
        updated_at: '2026-07-12T05:00:00.000Z',
      })
      adapter.updateResult = { kind: 'updated', note: committed }
      const controller = createQuickNoteExistingEditSessionController(
        controllerOptions(adapter),
      )
      await flushMicrotasks()
      controller.start(makeQuickNote())
      controller.change('committed content')
      await controller.save()
      const before = controller.getSnapshot()

      controller.observeProjection(
        projectionFor(committed.id, 'active', { ...committed }),
      )

      expect(controller.getSnapshot()).toBe(before)
      expect(controller.state.phase).toBe('saved')
      expect(controller.state.conflict).toBeNull()
    })
  })

})
