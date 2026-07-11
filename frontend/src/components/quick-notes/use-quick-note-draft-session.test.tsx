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
    return makeQuickNote({ id: snapshot.draftId, content: snapshot.content })
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
})
