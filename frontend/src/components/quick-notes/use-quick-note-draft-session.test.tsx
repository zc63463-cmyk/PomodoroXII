import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createQuickNoteDraftSessionController,
} from '@/components/quick-notes/use-quick-note-draft-session'
import {
  QUICK_NOTE_NEW_DRAFT_VERSION_V2,
  type QuickNoteDraftLoadResult,
  type QuickNoteDraftRowOwner,
  type QuickNoteDraftStorageAdapter,
  type QuickNoteNewDraftSnapshotV2,
} from '@/lib/quick-notes/quick-note-draft-repository'
import type { QuickNote } from '@/types'

type ControllerInput = Parameters<typeof createQuickNoteDraftSessionController>[0]

expectTypeOf<ControllerInput['onRecorded']>()
  .toEqualTypeOf<(note: QuickNote) => undefined>()

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

type AdapterEffect = () => Promise<void>
type StoredDraft = QuickNoteNewDraftSnapshotV2 | string | null

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
  const now = '2026-07-11T04:00:00.000Z'
  return {
    id: 'quick-note-1',
    content: 'recorded draft',
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    session_id: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function ownerMatches(owner: QuickNoteDraftRowOwner, stored: StoredDraft): boolean {
  if (stored === null) return false
  if (owner.kind === 'raw') {
    return typeof stored === 'string' && owner.value === stored
  }
  if (typeof stored !== 'string') return owner.draftId === stored.draftId

  try {
    const parsed: unknown = JSON.parse(stored)
    return Boolean(
      parsed
      && typeof parsed === 'object'
      && (parsed as { version?: unknown }).version === QUICK_NOTE_NEW_DRAFT_VERSION_V2
      && (parsed as { draftId?: unknown }).draftId === owner.draftId,
    )
  } catch {
    return false
  }
}

class ControlledQuickNoteDraftAdapter implements QuickNoteDraftStorageAdapter {
  loadResult: QuickNoteDraftLoadResult = { kind: 'absent' }
  loadEffect: AdapterEffect | null = null
  saveEffects: AdapterEffect[] = []
  clearEffects: AdapterEffect[] = []
  recordEffects: AdapterEffect[] = []
  afterRecord: (() => void) | null = null
  stored: StoredDraft = null
  readonly startedSaves: QuickNoteNewDraftSnapshotV2[] = []
  readonly clearCalls: Array<readonly QuickNoteDraftRowOwner[]> = []
  readonly recordCalls: QuickNoteNewDraftSnapshotV2[] = []

  async load(): Promise<QuickNoteDraftLoadResult> {
    const result = this.loadResult
    await this.loadEffect?.()
    return result
  }

  async save(snapshot: QuickNoteNewDraftSnapshotV2): Promise<void> {
    this.startedSaves.push(snapshot)
    await this.saveEffects.shift()?.()
    this.stored = snapshot
  }

  async clearIfOwned(
    owners: readonly QuickNoteDraftRowOwner[],
  ): Promise<'cleared' | 'absent' | 'different-draft'> {
    this.clearCalls.push(owners)
    await this.clearEffects.shift()?.()
    if (this.stored === null) return 'absent'
    if (!owners.some((owner) => ownerMatches(owner, this.stored))) {
      return 'different-draft'
    }
    this.stored = null
    return 'cleared'
  }

  async record(snapshot: QuickNoteNewDraftSnapshotV2): Promise<QuickNote> {
    this.recordCalls.push(snapshot)
    await this.recordEffects.shift()?.()
    this.stored = null
    const note = makeQuickNote({ id: snapshot.draftId, content: snapshot.content })
    this.afterRecord?.()
    return note
  }
}

function controllerOptions(
  adapter: ControlledQuickNoteDraftAdapter,
): ControllerInput {
  let nextDraftId = 1
  return {
    spaceId: 'space-a',
    adapter,
    onRecorded: () => undefined,
    createDraftId: () => `draft-${nextDraftId++}`,
    nowIso: () => '2026-07-11T04:00:00.000Z',
    debounceMs: 500,
    flushTimeoutMs: 3_000,
  }
}

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve()
  }
}

describe('QuickNote draft session controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('serializes a newer revision behind a pending older save', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const saveA = createDeferred<void>()
    adapter.saveEffects.push(() => saveA.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('revision A')
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.startedSaves.map(({ content }) => content)).toEqual(['revision A'])

    controller.change('revision B')
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.startedSaves.map(({ content }) => content)).toEqual(['revision A'])

    saveA.resolve(undefined)
    await flushMicrotasks()

    expect(adapter.startedSaves.map(({ content }) => content)).toEqual([
      'revision A',
      'revision B',
    ])
    expect(adapter.stored).toMatchObject({ content: 'revision B' })
    expect(controller.draft).toBe('revision B')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('restores v1 immediately and migrates it once with a stable draftId', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const raw = '{"version":1,"content":"legacy draft","updatedAt":"2026-07-10T04:00:00.000Z"}'
    const migration = createDeferred<void>()
    adapter.stored = raw
    adapter.loadResult = {
      kind: 'valid',
      snapshot: {
        version: 1,
        content: 'legacy draft',
        updatedAt: '2026-07-10T04:00:00.000Z',
      },
      owner: { kind: 'raw', value: raw },
    }
    adapter.saveEffects.push(() => migration.promise)

    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    expect(controller.draft).toBe('legacy draft')
    expect(controller.saveState).toBe('restored')
    expect(controller.issue).toBeNull()
    expect(adapter.startedSaves).toEqual([{
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'draft-1',
      content: 'legacy draft',
      updatedAt: '2026-07-11T04:00:00.000Z',
    }])

    migration.resolve(undefined)
    await flushMicrotasks()
    controller.change('legacy draft edited')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()

    expect(adapter.startedSaves).toHaveLength(2)
    expect(adapter.startedSaves[1]).toMatchObject({
      draftId: 'draft-1',
      content: 'legacy draft edited',
    })
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-1',
      content: 'legacy draft edited',
    })
    controller.deactivate()
  })

  it('catches invalid-row cleanup failure and never restores damaged content', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const raw = '{damaged-json'
    adapter.stored = raw
    adapter.loadResult = { kind: 'invalid', owner: { kind: 'raw', value: raw } }
    adapter.clearEffects.push(async () => {
      throw new Error('cleanup failed')
    })

    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('failed')
    expect(controller.issue).toEqual({
      code: 'invalid-record-cleanup-failed',
      retryable: true,
    })
    expect(adapter.stored).toBe(raw)
    controller.deactivate()
  })

  it('reconciles current blank input after a delayed v2 restore', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const load = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => load.promise

    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    controller.change('new input')
    controller.change('')
    await flushMicrotasks()
    expect(controller.draft).toBe('')

    load.resolve(undefined)
    await flushMicrotasks()

    expect(controller.draft).toBe('')
    expect(adapter.stored).toBeNull()
    expect(adapter.clearCalls.at(-1)).toContainEqual({
      kind: 'v2',
      draftId: persisted.draftId,
    })
    controller.deactivate()
  })

  it('settles blank input when an external draft supersedes the owned row', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('owned content')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-1',
      content: 'owned content',
    })

    const externalDraft: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'external-successor',
      content: 'external content',
      updatedAt: '2026-07-11T05:00:00.000Z',
    }
    const externalBytes = JSON.stringify(externalDraft)
    adapter.stored = externalDraft

    controller.change('')
    await flushMicrotasks()

    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    expect(adapter.stored).toBe(externalDraft)
    expect(JSON.stringify(adapter.stored)).toBe(externalBytes)
    controller.deactivate()
  })

  it('ignores changes and subscriptions after deactivation', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    const activeListener = vi.fn()
    const unsubscribeActive = controller.subscribe(activeListener)
    const snapshotBeforeDeactivation = controller.getSnapshot()
    controller.deactivate()

    const retiredListener = vi.fn()
    const unsubscribeRetired = controller.subscribe(retiredListener)
    controller.change('late input')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()

    expect(controller.getSnapshot()).toBe(snapshotBeforeDeactivation)
    expect(adapter.startedSaves).toEqual([])
    expect(adapter.clearCalls).toEqual([])
    expect(adapter.recordCalls).toEqual([])
    expect(activeListener).not.toHaveBeenCalled()
    expect(retiredListener).not.toHaveBeenCalled()
    expect(unsubscribeActive()).toBeUndefined()
    expect(unsubscribeRetired()).toBeUndefined()
  })

  it('skips a queued non-forced capture made durable by earlier lane work', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const load = createDeferred<void>()
    const firstSave = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'stale persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    const redundantSave = vi.fn(async () => {
      throw new Error('redundant save should not run')
    })
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => load.promise
    adapter.saveEffects.push(() => firstSave.promise, redundantSave)

    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    controller.change('current')
    load.resolve(undefined)
    await flushMicrotasks()
    expect(adapter.startedSaves).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    expect(adapter.startedSaves).toHaveLength(1)

    firstSave.resolve(undefined)
    await flushMicrotasks()

    expect(adapter.startedSaves).toHaveLength(1)
    expect(redundantSave).not.toHaveBeenCalled()
    expect(controller.draft).toBe('current')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('preserves a newer v2 save when delayed invalid raw cleanup loses ownership', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const load = createDeferred<void>()
    const raw = '{damaged-json'
    adapter.stored = raw
    adapter.loadResult = { kind: 'invalid', owner: { kind: 'raw', value: raw } }
    adapter.loadEffect = () => load.promise

    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    controller.change('newer content')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-1',
      content: 'newer content',
    })

    load.resolve(undefined)
    await flushMicrotasks()

    expect(adapter.clearCalls).toContainEqual([{ kind: 'raw', value: raw }])
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-1',
      content: 'newer content',
    })
    expect(controller.draft).toBe('newer content')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('restores v1 content when migration save fails', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const raw = '{"version":1,"content":"legacy survives","updatedAt":"2026-07-10T04:00:00.000Z"}'
    const migration = createDeferred<void>()
    adapter.stored = raw
    adapter.loadResult = {
      kind: 'valid',
      snapshot: {
        version: 1,
        content: 'legacy survives',
        updatedAt: '2026-07-10T04:00:00.000Z',
      },
      owner: { kind: 'raw', value: raw },
    }
    adapter.saveEffects.push(() => migration.promise)

    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    expect(controller.draft).toBe('legacy survives')
    expect(controller.saveState).toBe('restored')
    migration.reject(new Error('migration failed'))
    await flushMicrotasks()

    expect(controller.draft).toBe('legacy survives')
    expect(controller.saveState).toBe('failed')
    expect(controller.issue).toEqual({
      code: 'migration-save-failed',
      retryable: true,
    })
    controller.deactivate()
  })

  it('shares one record Promise transaction and projection per generation', async () => {
    vi.useRealTimers()
    const adapter = new ControlledQuickNoteDraftAdapter()
    const recordGate = createDeferred<void>()
    const onRecorded = vi.fn((_note: QuickNote): undefined => undefined)
    adapter.recordEffects.push(() => recordGate.promise)
    const options = controllerOptions(adapter)
    options.onRecorded = onRecorded
    const controller = createQuickNoteDraftSessionController(options)
    await flushMicrotasks()

    controller.change('record once')
    const first = controller.record()
    const second = controller.record()

    expect(second).toBe(first)
    await expect(controller.discard()).resolves.toEqual({
      kind: 'busy',
      operation: 'record',
    })
    await flushMicrotasks()
    expect(adapter.recordCalls).toEqual([expect.objectContaining({
      draftId: 'draft-1',
      content: 'record once',
    })])

    recordGate.resolve(undefined)
    const result = await first

    expect(result).toEqual({
      kind: 'recorded',
      note: makeQuickNote({ id: 'draft-1', content: 'record once' }),
      visibility: 'refreshed',
    })
    expect(adapter.recordCalls).toHaveLength(1)
    expect(onRecorded).toHaveBeenCalledOnce()
    expect(onRecorded).toHaveBeenCalledWith(result.kind === 'recorded' ? result.note : null)
    const repeated = controller.record()
    expect(repeated).toBe(first)
    await expect(repeated).resolves.toEqual(result)
    controller.deactivate()
  })

  it('lets the first discard own a generation and makes record busy', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const clearGate = createDeferred<void>()
    adapter.clearEffects.push(() => clearGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('discard once')
    const first = controller.discard()
    const second = controller.discard()

    expect(second).toBe(first)
    await expect(controller.record()).resolves.toEqual({
      kind: 'busy',
      operation: 'discard',
    })
    await flushMicrotasks()
    expect(adapter.clearCalls).toHaveLength(1)

    clearGate.resolve(undefined)
    await expect(first).resolves.toEqual({ kind: 'discarded' })
    expect(adapter.clearCalls).toHaveLength(1)
    controller.deactivate()
  })

  it('preserves and persists input typed while record is pending', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const recordGate = createDeferred<void>()
    adapter.recordEffects.push(() => recordGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('revision A')
    const operation = controller.record()
    await flushMicrotasks()
    expect(adapter.recordCalls).toHaveLength(1)

    controller.change('revision B')
    expect(controller.draft).toBe('revision B')
    expect(controller.saveState).toBe('dirty')

    recordGate.resolve(undefined)
    await expect(operation).resolves.toMatchObject({
      kind: 'recorded',
      visibility: 'refreshed',
    })
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()

    expect(controller.draft).toBe('revision B')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-2',
      content: 'revision B',
    })
    controller.deactivate()
  })

  it('clears a blank successor after its predecessor record fails', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const recordGate = createDeferred<void>()
    adapter.recordEffects.push(() => recordGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('revision A')
    const operation = controller.record()
    await flushMicrotasks()
    controller.change('')

    recordGate.reject(new Error('record failed'))
    await expect(operation).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'record-failed', retryable: true },
    })
    await flushMicrotasks()

    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    expect(adapter.stored).toBeNull()
    controller.deactivate()
  })

  it('retries a failed record with the same stable draftId', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    adapter.recordEffects.push(async () => {
      throw new Error('first record failed')
    })
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('retry me')
    await expect(controller.record()).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'record-failed', retryable: true },
    })
    await expect(controller.record()).resolves.toMatchObject({
      kind: 'recorded',
      visibility: 'refreshed',
    })

    expect(adapter.recordCalls.map(({ draftId }) => draftId)).toEqual([
      'draft-1',
      'draft-1',
    ])
    controller.deactivate()
  })

  it('reports pending after projection throws and never replays the committed record', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const onRecorded = vi.fn((_note: QuickNote): undefined => {
      throw new Error('projection failed')
    })
    const options = controllerOptions(adapter)
    options.onRecorded = onRecorded
    const controller = createQuickNoteDraftSessionController(options)
    await flushMicrotasks()

    controller.change('commit once')
    const first = controller.record()

    await expect(first).resolves.toMatchObject({
      kind: 'recorded',
      visibility: 'pending',
    })
    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('failed')
    expect(controller.issue).toEqual({
      code: 'projection-failed',
      retryable: false,
    })
    const repeated = controller.record()
    expect(repeated).toBe(first)
    await expect(repeated).resolves.toMatchObject({
      kind: 'recorded',
      visibility: 'pending',
    })
    expect(adapter.recordCalls).toHaveLength(1)
    expect(onRecorded).toHaveBeenCalledOnce()
    controller.deactivate()
  })

  it('fails before record when the pre-record save rejects and remains retryable', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    adapter.saveEffects.push(async () => {
      throw new Error('save failed')
    })
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('save first')
    const first = controller.record()
    await expect(first).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'save-failed', retryable: true },
    })
    expect(adapter.recordCalls).toEqual([])
    expect(controller.draft).toBe('save first')
    expect(controller.saveState).toBe('failed')

    const retry = controller.record()
    expect(retry).not.toBe(first)
    await expect(retry).resolves.toMatchObject({ kind: 'recorded' })
    expect(adapter.startedSaves.map(({ draftId }) => draftId)).toEqual([
      'draft-1',
      'draft-1',
    ])
    expect(adapter.recordCalls).toHaveLength(1)
    controller.deactivate()
  })

  it('releases terminal ownership after a record adapter rejection', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    adapter.recordEffects.push(async () => {
      throw new Error('record failed')
    })
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('record retry')
    const first = controller.record()
    await expect(first).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'record-failed', retryable: true },
    })
    expect(controller.draft).toBe('record retry')
    expect(controller.saveState).toBe('failed')
    expect(controller.issue).toEqual({
      code: 'record-failed',
      retryable: true,
    })

    const retry = controller.record()
    expect(retry).not.toBe(first)
    await expect(retry).resolves.toMatchObject({ kind: 'recorded' })
    expect(adapter.recordCalls.map(({ draftId }) => draftId)).toEqual([
      'draft-1',
      'draft-1',
    ])
    controller.deactivate()
  })

  it('preserves input typed while discard is pending as a successor', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const clearGate = createDeferred<void>()
    adapter.clearEffects.push(() => clearGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('discarded predecessor')
    const operation = controller.discard()
    await flushMicrotasks()
    controller.change('successor content')

    clearGate.resolve(undefined)
    await expect(operation).resolves.toEqual({ kind: 'superseded' })
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()

    expect(controller.draft).toBe('successor content')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-2',
      content: 'successor content',
    })
    controller.deactivate()
  })

  it('does not let a failed predecessor record overwrite a nonblank successor', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const recordGate = createDeferred<void>()
    adapter.recordEffects.push(() => recordGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('predecessor')
    const operation = controller.record()
    await flushMicrotasks()
    controller.change('successor')

    recordGate.reject(new Error('predecessor failed'))
    await expect(operation).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'record-failed', retryable: true },
    })
    expect(controller.draft).toBe('successor')
    expect(controller.saveState).toBe('dirty')
    expect(controller.issue).toBeNull()

    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    expect(controller.draft).toBe('successor')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-2',
      content: 'successor',
    })
    controller.deactivate()
  })

  it('discards a restored v2 row from the ownership frontier', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'restored content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    expect(controller.saveState).toBe('restored')
    await expect(controller.discard()).resolves.toEqual({ kind: 'discarded' })

    expect(adapter.clearCalls).toEqual([[
      { kind: 'v2', draftId: 'persisted-v2' },
    ]])
    expect(adapter.stored).toBeNull()
    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('skips projection when deactivated after the local record commit', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const onRecorded = vi.fn((_note: QuickNote): undefined => undefined)
    const options = controllerOptions(adapter)
    options.onRecorded = onRecorded
    const controller = createQuickNoteDraftSessionController(options)
    adapter.afterRecord = () => controller.deactivate()
    await flushMicrotasks()

    controller.change('commit before deactivate')
    await expect(controller.record()).resolves.toMatchObject({
      kind: 'recorded',
      visibility: 'pending',
    })

    expect(adapter.recordCalls).toHaveLength(1)
    expect(adapter.stored).toBeNull()
    expect(onRecorded).not.toHaveBeenCalled()
  })

  it('does not let projection failure replace a newer successor state', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const options = controllerOptions(adapter)
    const onRecorded = vi.fn((_note: QuickNote): undefined => {
      controller.change('projection successor')
      throw new Error('projection failed after successor')
    })
    options.onRecorded = onRecorded
    const controller = createQuickNoteDraftSessionController(options)
    await flushMicrotasks()

    controller.change('recorded predecessor')
    await expect(controller.record()).resolves.toMatchObject({
      kind: 'recorded',
      visibility: 'pending',
    })

    expect(controller.draft).toBe('projection successor')
    expect(controller.saveState).toBe('dirty')
    expect(controller.issue).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    expect(controller.draft).toBe('projection successor')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-2',
      content: 'projection successor',
    })
    controller.deactivate()
  })

  it('waits for delayed restore before record and never resurrects the commit', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const loadGate = createDeferred<void>()
    const recordGate = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => loadGate.promise
    adapter.recordEffects.push(() => recordGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))

    controller.change('typed A')
    const operation = controller.record()
    await flushMicrotasks()

    loadGate.resolve(undefined)
    await flushMicrotasks()
    expect(adapter.recordCalls).toHaveLength(1)

    recordGate.resolve(undefined)
    await expect(operation).resolves.toMatchObject({
      kind: 'recorded',
      visibility: 'refreshed',
    })
    await flushMicrotasks()

    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    expect(adapter.stored).toBeNull()
    expect(adapter.startedSaves).toEqual([expect.objectContaining({
      draftId: 'draft-1',
      content: 'typed A',
    })])
    controller.deactivate()
  })

  it('waits for delayed restore before discard and clears the restored owner', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const loadGate = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => loadGate.promise
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))

    const first = controller.discard()
    const second = controller.discard()
    const settled = vi.fn()
    void first.then(settled)
    expect(second).toBe(first)
    await flushMicrotasks()
    const settlementsBeforeLoad = settled.mock.calls.length

    loadGate.resolve(undefined)
    const result = await first

    expect(settlementsBeforeLoad).toBe(0)
    expect(result).toEqual({ kind: 'discarded' })
    expect(adapter.clearCalls).toEqual([[
      { kind: 'v2', draftId: 'persisted-v2' },
    ]])
    expect(adapter.stored).toBeNull()
    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    const repeated = controller.discard()
    expect(repeated).toBe(first)
    await expect(repeated).resolves.toEqual({ kind: 'discarded' })
    controller.deactivate()
  })

  it('orders a successor save after delayed restore and record terminal work', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const loadGate = createDeferred<void>()
    const recordGate = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => loadGate.promise
    adapter.recordEffects.push(() => recordGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))

    controller.change('predecessor A')
    const operation = controller.record()
    controller.change('successor B')
    await vi.advanceTimersByTimeAsync(500)

    loadGate.resolve(undefined)
    await flushMicrotasks()
    expect(adapter.recordCalls).toEqual([expect.objectContaining({
      draftId: 'draft-1',
      content: 'predecessor A',
    })])

    recordGate.resolve(undefined)
    await expect(operation).resolves.toMatchObject({ kind: 'recorded' })
    await flushMicrotasks()

    expect(adapter.startedSaves.map(({ content }) => content)).toEqual([
      'predecessor A',
      'successor B',
    ])
    expect(adapter.stored).toMatchObject({
      draftId: 'draft-2',
      content: 'successor B',
    })
    expect(controller.draft).toBe('successor B')
    expect(controller.saveState).toBe('saved')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('does not record a nonblank snapshot after deactivation', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('inactive record')
    const snapshotBeforeDeactivation = controller.getSnapshot()
    controller.deactivate()

    await expect(controller.record()).resolves.toEqual({ kind: 'empty' })
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()

    expect(controller.getSnapshot()).toBe(snapshotBeforeDeactivation)
    expect(adapter.startedSaves).toEqual([])
    expect(adapter.recordCalls).toEqual([])
    expect(adapter.clearCalls).toEqual([])
  })

  it('does not discard a nonblank snapshot after deactivation', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('inactive discard')
    const snapshotBeforeDeactivation = controller.getSnapshot()
    controller.deactivate()

    await expect(controller.discard()).resolves.toEqual({ kind: 'discarded' })
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()

    expect(controller.getSnapshot()).toBe(snapshotBeforeDeactivation)
    expect(adapter.startedSaves).toEqual([])
    expect(adapter.recordCalls).toEqual([])
    expect(adapter.clearCalls).toEqual([])
  })

  it('retries discard with a new Promise after clear failure', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    adapter.clearEffects.push(async () => {
      throw new Error('clear failed')
    })
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('discard retry')
    const first = controller.discard()
    await expect(first).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'discard-failed', retryable: true },
    })
    expect(controller.draft).toBe('discard retry')
    expect(controller.saveState).toBe('failed')
    expect(controller.issue).toEqual({
      code: 'discard-failed',
      retryable: true,
    })

    const retry = controller.discard()
    expect(retry).not.toBe(first)
    await expect(retry).resolves.toEqual({ kind: 'discarded' })
    expect(adapter.clearCalls).toEqual([
      [{ kind: 'v2', draftId: 'draft-1' }],
      [{ kind: 'v2', draftId: 'draft-1' }],
    ])
    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('suppresses load failure publication for a pre-restore discard', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const loadGate = createDeferred<void>()
    const clearGate = createDeferred<void>()
    adapter.loadEffect = () => loadGate.promise
    adapter.clearEffects.push(() => clearGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))

    const operation = controller.discard()
    loadGate.reject(new Error('load failed'))
    await flushMicrotasks()
    expect(adapter.clearCalls).toHaveLength(1)
    const stateBeforeTerminalSettles = {
      draft: controller.draft,
      saveState: controller.saveState,
      issue: controller.issue,
    }

    clearGate.resolve(undefined)
    await expect(operation).resolves.toEqual({ kind: 'discarded' })

    expect(stateBeforeTerminalSettles).toEqual({
      draft: '',
      saveState: 'idle',
      issue: null,
    })
    controller.deactivate()
  })

  it('lets a blank successor clear a late restored owner after record save failure', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const loadGate = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => loadGate.promise
    adapter.saveEffects.push(async () => {
      throw new Error('pre-record save failed')
    })
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))

    controller.change('predecessor A')
    const operation = controller.record()
    controller.change('')
    loadGate.resolve(undefined)

    await expect(operation).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'save-failed', retryable: true },
    })
    await flushMicrotasks()

    expect(adapter.clearCalls.at(-1)).toEqual([
      { kind: 'v2', draftId: 'draft-1' },
      { kind: 'v2', draftId: 'persisted-v2' },
    ])
    expect(adapter.stored).toBeNull()
    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('lets a blank successor clear a late restored owner after discard failure', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const loadGate = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => loadGate.promise
    adapter.clearEffects.push(async () => {
      throw new Error('predecessor clear failed')
    })
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))

    controller.change('predecessor A')
    const operation = controller.discard()
    controller.change('')
    loadGate.resolve(undefined)

    await expect(operation).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'discard-failed', retryable: true },
    })
    await flushMicrotasks()

    expect(adapter.clearCalls).toHaveLength(2)
    expect(adapter.clearCalls.at(-1)).toEqual([
      { kind: 'v2', draftId: 'draft-1' },
      { kind: 'v2', draftId: 'persisted-v2' },
    ])
    expect(adapter.stored).toBeNull()
    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })

  it('does not reauthorize a retired restored owner from a queued successor', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const loadGate = createDeferred<void>()
    const saveGate = createDeferred<void>()
    const persisted: QuickNoteNewDraftSnapshotV2 = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'persisted-v2',
      content: 'persisted content',
      updatedAt: '2026-07-10T04:00:00.000Z',
    }
    adapter.stored = persisted
    adapter.loadResult = {
      kind: 'valid',
      snapshot: persisted,
      owner: { kind: 'v2', draftId: persisted.draftId },
    }
    adapter.loadEffect = () => loadGate.promise
    adapter.saveEffects.push(() => saveGate.promise)
    adapter.recordEffects.push(async () => {
      adapter.stored = persisted
      throw new Error('record lost ownership')
    })
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))

    controller.change('predecessor A')
    const operation = controller.record()
    loadGate.resolve(undefined)
    await flushMicrotasks()
    expect(adapter.startedSaves).toHaveLength(1)
    expect(adapter.recordCalls).toEqual([])

    controller.change('')
    saveGate.resolve(undefined)
    await expect(operation).resolves.toEqual({
      kind: 'failed',
      issue: { code: 'record-failed', retryable: true },
    })
    await flushMicrotasks()

    expect(adapter.clearCalls.at(-1)).toEqual([
      { kind: 'v2', draftId: 'draft-1' },
    ])
    expect(adapter.stored).toBe(persisted)
    expect(controller.draft).toBe('')
    expect(controller.saveState).toBe('idle')
    expect(controller.issue).toBeNull()
    controller.deactivate()
  })
})
