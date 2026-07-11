import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import {
  createQuickNoteDraftSessionController,
  useQuickNoteDraftSession,
} from '@/components/quick-notes/use-quick-note-draft-session'
import {
  QUICK_NOTE_NEW_DRAFT_KEY,
  QUICK_NOTE_NEW_DRAFT_VERSION_V2,
  createDexieQuickNoteDraftAdapter,
  type QuickNoteDraftLoadResult,
  type QuickNoteDraftRowOwner,
  type QuickNoteDraftStorageAdapter,
  type QuickNoteNewDraftSnapshotV2,
} from '@/lib/quick-notes/quick-note-draft-repository'
import {
  moveQuickNoteToTrash,
  purgeQuickNote,
  resetQuickNoteOutboxHook,
} from '@/lib/quick-notes/quick-note-repository'
import { PomodoroXIDB } from '@/services/database'
import { spaceDBManager } from '@/services/space-db'
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

  it('drains a newer revision after the captured older tail without copying the lane', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const saveA = createDeferred<void>()
    adapter.saveEffects.push(() => saveA.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('revision A')
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.startedSaves.map(({ content }) => content)).toEqual(['revision A'])

    const drain = controller.drainBeforeSwitch()
    controller.change('revision B')
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.startedSaves.map(({ content }) => content)).toEqual(['revision A'])

    saveA.resolve(undefined)
    await drain

    expect(adapter.startedSaves.map(({ content }) => content)).toEqual([
      'revision A',
      'revision B',
    ])
    expect(adapter.stored).toMatchObject({ content: 'revision B' })
    controller.deactivate()
  })

  it('times out one controller drain without poisoning an independent controller lane', async () => {
    const adapterA = new ControlledQuickNoteDraftAdapter()
    const saveA = createDeferred<void>()
    adapterA.saveEffects.push(() => saveA.promise)
    const controllerA = createQuickNoteDraftSessionController(controllerOptions(adapterA))
    await flushMicrotasks()

    controllerA.change('Space A')
    await vi.advanceTimersByTimeAsync(500)
    const drainA = controllerA.drainBeforeSwitch()
    await vi.advanceTimersByTimeAsync(3_000)
    await drainA

    expect(controllerA.draft).toBe('Space A')
    expect(controllerA.saveState).toBe('failed')
    expect(controllerA.issue).toEqual({
      code: 'switch-flush-timeout',
      retryable: true,
    })

    controllerA.deactivate()
    const adapterB = new ControlledQuickNoteDraftAdapter()
    const controllerB = createQuickNoteDraftSessionController({
      ...controllerOptions(adapterB),
      spaceId: 'space-b',
    })
    await flushMicrotasks()
    controllerB.change('Space B')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()

    expect(adapterB.stored).toMatchObject({ content: 'Space B' })
    expect(controllerB.draft).toBe('Space B')
    expect(controllerB.saveState).toBe('saved')

    saveA.resolve(undefined)
    await flushMicrotasks()
    expect(controllerB.draft).toBe('Space B')
    expect(controllerB.saveState).toBe('saved')
    controllerB.deactivate()
  })

  it('keeps draining when a same-capture retry replaces a failed forced tail', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const firstSave = createDeferred<void>()
    const retrySave = createDeferred<void>()
    adapter.saveEffects.push(
      () => firstSave.promise,
      () => retrySave.promise,
    )
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('same capture')
    const drain = controller.drainBeforeSwitch()
    const drainSettled = vi.fn()
    void drain.then(drainSettled)
    await flushMicrotasks()
    expect(adapter.startedSaves).toHaveLength(1)

    controller.requestBestEffortFlush()
    firstSave.reject(new Error('first forced save failed'))
    await flushMicrotasks()

    expect(adapter.startedSaves).toHaveLength(2)
    expect(drainSettled).not.toHaveBeenCalled()

    retrySave.resolve(undefined)
    await drain
    expect(adapter.stored).toMatchObject({ content: 'same capture' })
    expect(controller.saveState).toBe('saved')
    controller.deactivate()
  })

  it('times out a blank drain when an external draft supersedes its owned row', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('owned content')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    adapter.stored = {
      version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
      draftId: 'external-draft',
      content: 'external content',
      updatedAt: '2026-07-11T05:00:00.000Z',
    }

    controller.change('')
    await flushMicrotasks()
    expect(adapter.clearCalls).toHaveLength(1)

    const drainClear = createDeferred<void>()
    adapter.clearEffects.push(() => drainClear.promise)
    const drain = controller.drainBeforeSwitch()
    const drainSettled = vi.fn()
    void drain.then(drainSettled)
    await flushMicrotasks()
    expect(adapter.clearCalls).toHaveLength(2)

    drainClear.resolve(undefined)
    await flushMicrotasks(20)
    expect(drainSettled).not.toHaveBeenCalled()
    expect(adapter.clearCalls).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(drainSettled).not.toHaveBeenCalled()
    expect(controller.issue).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    await drain

    expect(drainSettled).toHaveBeenCalledTimes(1)
    expect(adapter.clearCalls).toHaveLength(2)
    expect(adapter.stored).toMatchObject({
      draftId: 'external-draft',
      content: 'external content',
    })
    expect(controller.saveState).toBe('failed')
    expect(controller.issue).toEqual({
      code: 'switch-flush-timeout',
      retryable: true,
    })
    controller.deactivate()
  })

  it('does not let best-effort flush revive a successfully recorded terminal draft', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const recordGate = createDeferred<void>()
    adapter.recordEffects.push(() => recordGate.promise)
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('record terminal')
    const operation = controller.record()
    controller.requestBestEffortFlush()
    await flushMicrotasks()
    expect(adapter.recordCalls).toHaveLength(1)

    recordGate.resolve(undefined)
    await expect(operation).resolves.toMatchObject({ kind: 'recorded' })
    await flushMicrotasks()

    expect(adapter.startedSaves).toHaveLength(1)
    expect(adapter.stored).toBeNull()
    controller.deactivate()
  })

  it('does not let best-effort flush revive a successfully discarded terminal draft', async () => {
    const adapter = new ControlledQuickNoteDraftAdapter()
    const controller = createQuickNoteDraftSessionController(controllerOptions(adapter))
    await flushMicrotasks()

    controller.change('discard terminal')
    const clearGate = createDeferred<void>()
    adapter.clearEffects.push(() => clearGate.promise)

    const operation = controller.discard()
    controller.requestBestEffortFlush()
    await flushMicrotasks()
    expect(adapter.clearCalls).toHaveLength(1)

    clearGate.resolve(undefined)
    await expect(operation).resolves.toEqual({ kind: 'discarded' })
    await flushMicrotasks()

    expect(adapter.startedSaves).toHaveLength(0)
    expect(adapter.stored).toBeNull()
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

async function deleteTestDatabases(
  ...databases: Array<PomodoroXIDB | null>
): Promise<void> {
  spaceDBManager.close()
  const uniqueDatabases = [...new Set(
    databases.filter((database): database is PomodoroXIDB => database !== null),
  )]
  await Promise.all(uniqueDatabases.map(async (database) => {
    database.close()
    await database.delete()
  }))
}

async function readStoredV2Draft(
  database: PomodoroXIDB,
): Promise<QuickNoteNewDraftSnapshotV2> {
  const row = await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)
  expect(row).toBeDefined()
  return JSON.parse(row!.value) as QuickNoteNewDraftSnapshotV2
}

describe('QuickNote draft session Space lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetQuickNoteOutboxHook()
    spaceDBManager.close()
  })

  afterEach(() => {
    resetQuickNoteOutboxHook()
    spaceDBManager.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('flushBeforeClose persists the mounted hook draft as an exact v2 row', async () => {
    let database: PomodoroXIDB | null = null
    let unmount: (() => void) | null = null

    try {
      const spaceId = `quick-note-session-flush-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceId)
      database = spaceDBManager.current
      const hook = renderHook(() => useQuickNoteDraftSession({
        onRecorded: () => undefined,
      }))
      unmount = hook.unmount

      act(() => hook.result.current.change('flush current text'))
      await act(async () => {
        await spaceDBManager.flushBeforeClose()
      })

      const stored = await readStoredV2Draft(database)
      expect(stored).toEqual({
        version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
        draftId: expect.any(String),
        content: 'flush current text',
        updatedAt: expect.any(String),
      })
      expect(stored.draftId.trim()).not.toBe('')
    } finally {
      unmount?.()
      await flushMicrotasks()
      await deleteTestDatabases(database)
    }
  })

  it('migrates a real v1 row to v2 and remounts with the stable migrated draftId', async () => {
    let database: PomodoroXIDB | null = null
    let unmountCurrent: (() => void) | null = null

    try {
      const spaceId = `quick-note-session-migrate-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceId)
      database = spaceDBManager.current
      await database.settings.put({
        key: QUICK_NOTE_NEW_DRAFT_KEY,
        value: JSON.stringify({
          version: 1,
          content: 'legacy mounted draft',
          updatedAt: '2026-07-10T04:00:00.000Z',
        }),
      })

      const first = renderHook(() => useQuickNoteDraftSession({
        onRecorded: () => undefined,
      }))
      unmountCurrent = first.unmount
      await waitFor(() => expect(first.result.current.draft).toBe('legacy mounted draft'))
      await waitFor(async () => {
        expect((await readStoredV2Draft(database!)).version).toBe(
          QUICK_NOTE_NEW_DRAFT_VERSION_V2,
        )
      })
      const migrated = await readStoredV2Draft(database)

      first.unmount()
      unmountCurrent = null
      await flushMicrotasks()

      const second = renderHook(() => useQuickNoteDraftSession({
        onRecorded: () => undefined,
      }))
      unmountCurrent = second.unmount
      await waitFor(() => expect(second.result.current.draft).toBe('legacy mounted draft'))
      expect(second.result.current.saveState).toBe('restored')
      expect(await readStoredV2Draft(database)).toEqual(migrated)
      expect(migrated).toMatchObject({
        version: QUICK_NOTE_NEW_DRAFT_VERSION_V2,
        draftId: expect.any(String),
        content: 'legacy mounted draft',
      })
    } finally {
      unmountCurrent?.()
      await flushMicrotasks()
      await deleteTestDatabases(database)
    }
  })

  it('single-flights one real default record transaction and projection', async () => {
    let database: PomodoroXIDB | null = null
    let controller: ReturnType<typeof createQuickNoteDraftSessionController> | null = null

    try {
      const spaceId = `quick-note-session-record-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceId)
      database = spaceDBManager.current
      const onRecorded = vi.fn((_note: QuickNote): undefined => undefined)
      controller = createQuickNoteDraftSessionController({
        spaceId,
        adapter: createDexieQuickNoteDraftAdapter(database),
        onRecorded,
        createDraftId: () => 'real-record-draft',
        nowIso: () => '2026-07-11T04:00:00.000Z',
      })
      await flushMicrotasks()

      controller.change('record once')
      const first = controller.record()
      const second = controller.record()

      expect(second).toBe(first)
      await expect(first).resolves.toMatchObject({
        kind: 'recorded',
        visibility: 'refreshed',
      })
      expect(await database.quickNotes.count()).toBe(1)
      expect(await database.outbox.count()).toBe(1)
      expect(await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)).toBeUndefined()
      expect(onRecorded).toHaveBeenCalledTimes(1)
    } finally {
      controller?.deactivate()
      await deleteTestDatabases(database)
    }
  })

  it('does not revive a consumed real draft after its note is trashed and purged', async () => {
    let database: PomodoroXIDB | null = null
    let firstController: ReturnType<typeof createQuickNoteDraftSessionController> | null = null
    let secondController: ReturnType<typeof createQuickNoteDraftSessionController> | null = null

    try {
      const spaceId = `quick-note-session-purge-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceId)
      database = spaceDBManager.current
      firstController = createQuickNoteDraftSessionController({
        spaceId,
        adapter: createDexieQuickNoteDraftAdapter(database),
        onRecorded: () => undefined,
        createDraftId: () => 'purged-draft',
      })
      await flushMicrotasks()

      firstController.change('consume then purge')
      await expect(firstController.record()).resolves.toMatchObject({ kind: 'recorded' })
      await moveQuickNoteToTrash('purged-draft')
      await purgeQuickNote('purged-draft')
      firstController.deactivate()

      secondController = createQuickNoteDraftSessionController({
        spaceId,
        adapter: createDexieQuickNoteDraftAdapter(database),
        onRecorded: () => undefined,
      })
      await secondController.drainBeforeSwitch()

      expect(secondController.draft).toBe('')
      expect(secondController.saveState).toBe('idle')
      expect(secondController.issue).toBeNull()
      expect(await database.quickNotes.get('purged-draft')).toBeUndefined()
      expect(await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)).toBeUndefined()
    } finally {
      firstController?.deactivate()
      secondController?.deactivate()
      await deleteTestDatabases(database)
    }
  })

  it('installs one controller per successful Space switch and late Space A completion cannot publish into Space B', async () => {
    let databaseA: PomodoroXIDB | null = null
    let databaseB: PomodoroXIDB | null = null
    let unmount: (() => void) | null = null
    let putSpy: ReturnType<typeof vi.spyOn> | null = null
    const saveA = createDeferred<void>()

    try {
      const spaceAId = `quick-note-session-epoch-a-${crypto.randomUUID()}`
      const spaceBId = `quick-note-session-epoch-b-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceAId)
      databaseA = spaceDBManager.current
      putSpy = vi.spyOn(databaseA.settings, 'put').mockImplementationOnce((row) => (
        Dexie.Promise.resolve(saveA.promise).then(() => row.key)
      ))

      const hook = renderHook(() => useQuickNoteDraftSession({
        onRecorded: () => undefined,
      }))
      unmount = hook.unmount
      act(() => hook.result.current.change('Space A pending'))
      await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1), { timeout: 1_500 })

      await act(async () => {
        await spaceDBManager.switchTo(spaceBId)
      })
      databaseB = spaceDBManager.current
      await waitFor(() => expect(hook.result.current.draft).toBe(''))

      act(() => hook.result.current.change('Space B durable'))
      await waitFor(() => expect(hook.result.current.saveState).toBe('saved'), {
        timeout: 1_500,
      })
      const storedB = await readStoredV2Draft(databaseB)

      saveA.resolve(undefined)
      await flushMicrotasks()

      expect(hook.result.current.draft).toBe('Space B durable')
      expect(hook.result.current.saveState).toBe('saved')
      expect(await readStoredV2Draft(databaseB)).toEqual(storedB)
      expect(storedB.content).toBe('Space B durable')
    } finally {
      saveA.resolve(undefined)
      putSpy?.mockRestore()
      unmount?.()
      await flushMicrotasks()
      await deleteTestDatabases(databaseA, databaseB)
    }
  }, 8_000)

  it('does not install or deactivate the current controller when target database open fails', async () => {
    let databaseA: PomodoroXIDB | null = null
    let unmount: (() => void) | null = null
    let unsubscribeSwitch: (() => void) | null = null
    let openSpy: ReturnType<typeof vi.spyOn> | null = null

    try {
      const spaceAId = `quick-note-session-open-a-${crypto.randomUUID()}`
      const failedSpaceId = `quick-note-session-open-failed-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceAId)
      databaseA = spaceDBManager.current
      const hook = renderHook(() => useQuickNoteDraftSession({
        onRecorded: () => undefined,
      }))
      unmount = hook.unmount
      const onSwitch = vi.fn()
      unsubscribeSwitch = spaceDBManager.onSwitch(onSwitch)

      act(() => hook.result.current.change('current Space remains'))
      openSpy = vi.spyOn(PomodoroXIDB.prototype, 'open').mockImplementationOnce(() => {
        throw new Error('target open failed')
      })

      await expect(act(async () => {
        await spaceDBManager.switchTo(failedSpaceId)
      })).rejects.toThrow('target open failed')

      expect(onSwitch).not.toHaveBeenCalled()
      expect(spaceDBManager.currentSpaceId).toBe(spaceAId)
      expect(spaceDBManager.current).toBe(databaseA)
      expect(hook.result.current.draft).toBe('current Space remains')

      act(() => hook.result.current.change('current controller still usable'))
      await waitFor(() => expect(hook.result.current.saveState).toBe('saved'), {
        timeout: 1_500,
      })
      expect((await readStoredV2Draft(databaseA)).content).toBe(
        'current controller still usable',
      )
    } finally {
      openSpy?.mockRestore()
      unsubscribeSwitch?.()
      unmount?.()
      await flushMicrotasks()
      await deleteTestDatabases(databaseA)
    }
  })

  it('pagehide observes a rejected best-effort save without unhandledrejection', async () => {
    let database: PomodoroXIDB | null = null
    let unmount: (() => void) | null = null
    const onUnhandled = vi.fn((event: PromiseRejectionEvent) => {
      event.preventDefault()
    })

    try {
      const spaceId = `quick-note-session-pagehide-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceId)
      database = spaceDBManager.current
      const putSpy = vi.spyOn(database.settings, 'put')
        .mockRejectedValueOnce(new Error('pagehide save failed'))
      const hook = renderHook(() => useQuickNoteDraftSession({
        onRecorded: () => undefined,
      }))
      unmount = hook.unmount
      window.addEventListener('unhandledrejection', onUnhandled)

      act(() => hook.result.current.change('pagehide current draft'))
      act(() => window.dispatchEvent(new Event('pagehide')))

      await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(hook.result.current.issue).toEqual({
        code: 'save-failed',
        retryable: true,
      }))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      unmount?.()
      await flushMicrotasks()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      window.removeEventListener('unhandledrejection', onUnhandled)
      expect(onUnhandled).not.toHaveBeenCalled()
      await deleteTestDatabases(database)
    }
  })

  it('unmount requests one best-effort flush then deactivates the epoch', async () => {
    let database: PomodoroXIDB | null = null
    let unmount: (() => void) | null = null
    const save = createDeferred<void>()

    try {
      const spaceId = `quick-note-session-unmount-${crypto.randomUUID()}`
      await spaceDBManager.switchTo(spaceId)
      database = spaceDBManager.current
      const putSpy = vi.spyOn(database.settings, 'put').mockImplementationOnce((row) => (
        Dexie.Promise.resolve(save.promise).then(() => row.key)
      ))
      const hook = renderHook(() => useQuickNoteDraftSession({
        onRecorded: () => undefined,
      }))
      unmount = hook.unmount

      act(() => hook.result.current.change('unmount current revision'))
      const publishedBeforeUnmount = hook.result.current
      hook.unmount()
      unmount = null

      await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1))
      expect(hook.result.current).toBe(publishedBeforeUnmount)

      save.resolve(undefined)
      await flushMicrotasks()
      await new Promise<void>((resolve) => setTimeout(resolve, 550))

      expect(putSpy).toHaveBeenCalledTimes(1)
      expect(hook.result.current).toBe(publishedBeforeUnmount)
      expect(hook.result.current.draft).toBe('unmount current revision')
    } finally {
      save.resolve(undefined)
      unmount?.()
      await flushMicrotasks()
      await deleteTestDatabases(database)
    }
  })
})
