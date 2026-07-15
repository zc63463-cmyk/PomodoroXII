import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as quickNoteRepository from '@/lib/quick-notes/quick-note-repository'
import { db, spaceDBManager } from '@/services/space-db'
import { useQuickNoteStore } from '@/stores/quick-note-store'
import type { QuickNote } from '@/types'

function makeQuickNote(overrides: Partial<QuickNote> = {}): QuickNote {
  const now = '2026-07-11T04:00:00.000Z'
  return {
    id: 'projected',
    content: 'projected note',
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

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

describe('useQuickNoteStore', () => {
  beforeEach(async () => {
    useQuickNoteStore.getState().reset()
    await spaceDBManager.switchTo(`quick-note-store-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    useQuickNoteStore.getState().reset()
    await db.delete()
    spaceDBManager.close()
  })

  it('projects a recorded QuickNote synchronously through current filters without reads', () => {
    const repositoryReads = [
      vi.spyOn(quickNoteRepository, 'listQuickNotes'),
      vi.spyOn(quickNoteRepository, 'listTrashedQuickNotes'),
      vi.spyOn(quickNoteRepository, 'listQuickNoteSyncStates'),
      vi.spyOn(quickNoteRepository, 'listQuickNoteLifecycleStates'),
    ]
    const quickNotesTable = spaceDBManager.current.quickNotes
    const tableRead = vi.spyOn(quickNotesTable, 'toArray')
    const directTableReads = [
      vi.spyOn(quickNotesTable, 'get'),
      vi.spyOn(quickNotesTable, 'count'),
      vi.spyOn(quickNotesTable, 'where'),
    ]
    useQuickNoteStore.setState({
      allQuickNotes: [],
      quickNotes: [],
      searchQuery: 'release',
      selectedTagFilters: ['work'],
      selectedDate: '2026-07-11',
    })
    const first = makeQuickNote({
      content: 'release plan #work',
      tags: ['work'],
    })

    const result = useQuickNoteStore.getState().projectCommittedQuickNote(first)

    expect(result).toBeUndefined()
    expect(useQuickNoteStore.getState()).toMatchObject({
      allQuickNotes: [first],
      quickNotes: [first],
      lifecycleStateById: { projected: 'active' },
      syncStatusById: { projected: 'pending' },
      error: null,
    })

    const replacement = makeQuickNote({
      content: 'personal note',
      tags: ['personal'],
      updated_at: '2026-07-11T04:01:00.000Z',
    })

    expect(
      useQuickNoteStore.getState().projectCommittedQuickNote(replacement),
    ).toBeUndefined()
    expect(useQuickNoteStore.getState().allQuickNotes).toEqual([replacement])
    expect(useQuickNoteStore.getState().quickNotes).toEqual([])
    for (const repositoryRead of repositoryReads) {
      expect(repositoryRead).not.toHaveBeenCalled()
    }
    expect(tableRead).not.toHaveBeenCalled()
    for (const directTableRead of directTableReads) {
      expect(directTableRead).not.toHaveBeenCalled()
    }
  })

  it('reruns a stale same-epoch refresh before publishing over a recorded projection', async () => {
    const realListQuickNotes = quickNoteRepository.listQuickNotes
    const staleReadCaptured = createDeferred<void>()
    const releaseStaleRead = createDeferred<void>()
    const listQuickNotes = vi
      .spyOn(quickNoteRepository, 'listQuickNotes')
      .mockImplementation(async (query = '') => {
        const notes = await realListQuickNotes(query)
        if (listQuickNotes.mock.calls.length === 1) {
          staleReadCaptured.resolve(undefined)
          await releaseStaleRead.promise
        }
        return notes
      })

    const refresh = useQuickNoteStore.getState().refreshQuickNotesFromRepository()
    await staleReadCaptured.promise

    const note = await quickNoteRepository.createQuickNote({
      id: 'recorded-during-refresh',
      content: 'recorded while an old refresh is gated',
    })
    useQuickNoteStore.getState().projectCommittedQuickNote(note)
    expect(useQuickNoteStore.getState()).toMatchObject({
      allQuickNotes: [note],
      quickNotes: [note],
      lifecycleStateById: { [note.id]: 'active' },
      syncStatusById: { [note.id]: 'pending' },
    })

    releaseStaleRead.resolve(undefined)
    await refresh

    expect(listQuickNotes).toHaveBeenCalledTimes(2)
    expect(useQuickNoteStore.getState()).toMatchObject({
      allQuickNotes: [note],
      quickNotes: [note],
      lifecycleStateById: { [note.id]: 'active' },
      syncStatusById: { [note.id]: 'pending' },
      error: null,
    })
  })

  it('discards a stale refresh result after reset establishes a new epoch', async () => {
    const existing = await quickNoteRepository.createQuickNote({
      id: 'old-epoch-note',
      content: 'must not cross reset',
    })
    const realListQuickNotes = quickNoteRepository.listQuickNotes
    const staleReadCaptured = createDeferred<void>()
    const releaseStaleRead = createDeferred<void>()
    vi.spyOn(quickNoteRepository, 'listQuickNotes').mockImplementationOnce(
      async (query = '') => {
        const notes = await realListQuickNotes(query)
        staleReadCaptured.resolve(undefined)
        await releaseStaleRead.promise
        return notes
      },
    )

    const load = useQuickNoteStore.getState().loadQuickNotes({ query: 'old epoch' })
    await staleReadCaptured.promise
    useQuickNoteStore.getState().reset()
    expect(useQuickNoteStore.getState()).toMatchObject({
      allQuickNotes: [],
      quickNotes: [],
      isLoading: false,
      error: null,
      searchQuery: '',
    })

    releaseStaleRead.resolve(undefined)
    await load

    expect(useQuickNoteStore.getState()).toMatchObject({
      allQuickNotes: [],
      quickNotes: [],
      trashedQuickNotes: [],
      syncStatusById: {},
      lifecycleStateById: {},
      isLoading: false,
      error: null,
      searchQuery: '',
    })
    expect(useQuickNoteStore.getState().allQuickNotes).not.toContainEqual(existing)
  })

  it('does not publish or rethrow a stale refresh failure after reset', async () => {
    const readEntered = createDeferred<void>()
    const staleFailure = createDeferred<QuickNote[]>()
    vi.spyOn(quickNoteRepository, 'listQuickNotes').mockImplementationOnce(async () => {
      readEntered.resolve(undefined)
      return staleFailure.promise
    })

    const load = useQuickNoteStore.getState().loadQuickNotes({ query: 'old epoch' })
    await readEntered.promise
    useQuickNoteStore.getState().reset()

    staleFailure.reject(new Error('late old-Space read failure'))
    await expect(load).resolves.toBeUndefined()
    expect(useQuickNoteStore.getState()).toMatchObject({
      allQuickNotes: [],
      quickNotes: [],
      isLoading: false,
      error: null,
      searchQuery: '',
    })
  })

  it('loads active notes filtered by search and sorted by pinned/updated', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'old',
      content: 'old memo',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'new',
      content: 'new memo',
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'pin',
      content: 'memo pin',
      pinned: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })

    await useQuickNoteStore.getState().loadQuickNotes({ query: 'memo' })

    expect(useQuickNoteStore.getState().quickNotes.map((note) => note.id)).toEqual([
      'pin',
      'new',
      'old',
    ])
  })

  it('keeps all active quick notes while deriving visible notes from search filters', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'release',
      content: 'release memo #work',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'personal',
      content: 'personal memo #life',
      created_at: '2026-07-02T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
    })

    await useQuickNoteStore.getState().loadQuickNotes({ query: 'release' })

    expect(useQuickNoteStore.getState().quickNotes.map((note) => note.id)).toEqual([
      'release',
    ])
    expect(useQuickNoteStore.getState().allQuickNotes.map((note) => note.id)).toEqual([
      'personal',
      'release',
    ])
  })

  it('derives visible notes with single and multi tag filters', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'frontend',
      content: 'ship ui #work #frontend',
      tags: ['work', 'frontend'],
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'backend',
      content: 'ship api #work #backend',
      tags: ['work', 'backend'],
      created_at: '2026-07-02T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
    })

    useQuickNoteStore.getState().toggleTagFilter('work')
    expect(useQuickNoteStore.getState().selectedTagFilters).toEqual(['work'])
    expect(useQuickNoteStore.getState().quickNotes.map((note) => note.id)).toEqual([
      'backend',
      'frontend',
    ])

    useQuickNoteStore.getState().setTagFilterMode('multi')
    useQuickNoteStore.getState().toggleTagFilter('frontend')
    expect(useQuickNoteStore.getState().selectedTagFilters).toEqual(['work', 'frontend'])
    expect(useQuickNoteStore.getState().quickNotes.map((note) => note.id)).toEqual([
      'frontend',
    ])
  })

  it('renames a tag across active quick notes and keeps selected filters in sync', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'release',
      content: 'ship #work today',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'merge-target',
      content: 'already tagged #project',
      tags: ['work', 'project'],
      created_at: '2026-07-02T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
    })
    useQuickNoteStore.getState().toggleTagFilter('work')

    await useQuickNoteStore.getState().renameQuickNoteTag('work', 'project')

    const state = useQuickNoteStore.getState()
    expect(state.selectedTagFilters).toEqual(['project'])
    expect(state.quickNotes.map((note) => note.id).sort()).toEqual(['merge-target', 'release'])
    expect(state.allQuickNotes.find((note) => note.id === 'release')).toMatchObject({
      content: 'ship #project today',
      tags: ['project'],
    })
    expect(state.allQuickNotes.find((note) => note.id === 'merge-target')?.tags).toEqual([
      'project',
    ])
  })

  it('does not rewrite content for active notes that mention a renamed tag without carrying it', async () => {
    const matching = await useQuickNoteStore.getState().createQuickNote({
      id: 'matching-tag',
      content: 'matching #work mention',
      tags: ['work'],
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    const mentionOnly = await useQuickNoteStore.getState().createQuickNote({
      id: 'mention-only',
      content: 'mentions #work but belongs elsewhere',
      tags: ['other'],
      created_at: '2026-07-02T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
    })
    await db.quickNotes.update(mentionOnly.id, { tags: ['other'] })
    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    await useQuickNoteStore.getState().renameQuickNoteTag('work', 'project')

    expect(useQuickNoteStore.getState().allQuickNotes.find((note) => note.id === matching.id)).toMatchObject({
      content: 'matching #project mention',
      tags: ['project'],
    })
    expect(useQuickNoteStore.getState().allQuickNotes.find((note) => note.id === mentionOnly.id)).toMatchObject({
      content: 'mentions #work but belongs elsewhere',
      tags: ['other'],
    })
  })

  it('renames slash tags in tags only without rewriting content', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'slash-tag',
      content: 'slash tag stays readable',
      tags: ['work/frontend'],
    })

    await useQuickNoteStore.getState().renameQuickNoteTag('work/frontend', 'project/frontend')

    expect(useQuickNoteStore.getState().allQuickNotes[0]).toMatchObject({
      content: 'slash tag stays readable',
      tags: ['project/frontend'],
    })
  })

  it('cleans dirty tags on active notes without changing content or inactive notes', async () => {
    const active = await useQuickNoteStore.getState().createQuickNote({
      id: 'dirty-active',
      content: 'keep content #work',
    })
    const clean = await useQuickNoteStore.getState().createQuickNote({
      id: 'clean-active',
      content: 'already clean #life',
    })
    const trashed = await useQuickNoteStore.getState().createQuickNote({
      id: 'dirty-trash',
      content: 'trash content #work',
    })
    const converted = await useQuickNoteStore.getState().createQuickNote({
      id: 'dirty-converted',
      content: 'converted content #work',
    })
    await useQuickNoteStore.getState().deleteQuickNote(trashed.id)
    await useQuickNoteStore.getState().migrateToNote(converted.id)
    await db.quickNotes.update(active.id, { tags: ['', '#', ' Work ', '#work', 'life'] })
    await db.quickNotes.update(clean.id, { tags: ['life'] })
    await db.quickNotes.update(trashed.id, { tags: ['', '#trash'] })
    await db.quickNotes.update(converted.id, { tags: ['', '#converted'] })
    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()
    useQuickNoteStore.getState().toggleTagFilter('missing')
    expect(useQuickNoteStore.getState().selectedTagFilters).toEqual(['missing'])

    const changedCount = await useQuickNoteStore.getState().cleanupQuickNoteTags()

    expect(changedCount).toBe(1)
    expect(useQuickNoteStore.getState().selectedTagFilters).toEqual([])
    expect(useQuickNoteStore.getState().allQuickNotes.find((note) => note.id === active.id)).toMatchObject({
      content: 'keep content #work',
      tags: ['work', 'life'],
    })
    expect(useQuickNoteStore.getState().allQuickNotes.find((note) => note.id === clean.id)?.tags).toEqual([
      'life',
    ])
    expect((await db.quickNotes.get(trashed.id))?.tags).toEqual(['', '#trash'])
    expect((await db.quickNotes.get(converted.id))?.tags).toEqual(['', '#converted'])
  })

  it('derives visible notes from created_at date filters and clears filters on reset', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'day-one',
      content: 'day one memo',
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-07-03T10:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'day-two',
      content: 'day two memo',
      created_at: '2026-07-02T10:00:00.000Z',
      updated_at: '2026-07-02T10:00:00.000Z',
    })

    useQuickNoteStore.getState().toggleSelectedDate('2026-07-01')

    expect(useQuickNoteStore.getState().selectedDate).toBe('2026-07-01')
    expect(useQuickNoteStore.getState().quickNotes.map((note) => note.id)).toEqual([
      'day-one',
    ])

    useQuickNoteStore.getState().reset()

    expect(useQuickNoteStore.getState()).toMatchObject({
      allQuickNotes: [],
      quickNotes: [],
      selectedTagFilters: [],
      tagFilterMode: 'single',
      selectedDate: null,
    })
  })

  it('toggles pin for active notes that are hidden by current explorer filters', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({
      id: 'hidden-pin',
      content: 'Hidden while searching #work',
    })

    await useQuickNoteStore.getState().loadQuickNotes({ query: 'no-match' })
    expect(useQuickNoteStore.getState().quickNotes).toEqual([])
    expect(useQuickNoteStore.getState().allQuickNotes.map((item) => item.id)).toContain(note.id)

    await useQuickNoteStore.getState().togglePin(note.id)
    await useQuickNoteStore.getState().loadQuickNotes({ query: '' })

    expect(useQuickNoteStore.getState().quickNotes[0]).toMatchObject({
      id: note.id,
      pinned: true,
    })
  })

  it('soft deletes and restores through store actions', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({ content: 'delete me' })

    await useQuickNoteStore.getState().deleteQuickNote(note.id)
    expect(useQuickNoteStore.getState().quickNotes).toEqual([])
    expect(useQuickNoteStore.getState().trashedQuickNotes.map((item) => item.id)).toEqual([note.id])

    await useQuickNoteStore.getState().restoreQuickNote(note.id)
    expect(useQuickNoteStore.getState().quickNotes.map((item) => item.id)).toEqual([note.id])
    expect(useQuickNoteStore.getState().trashedQuickNotes).toEqual([])
  })

  it('switches focus modes and clears selection on exit/reset', () => {
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().toggleFocusEdit()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'focus-edit',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().toggleFocusEdit()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })

    expect('enterFocusRead' in useQuickNoteStore.getState()).toBe(false)

    useQuickNoteStore.getState().enterDetailRead('quick-note-b')
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'detail-read',
      selectedQuickNoteId: 'quick-note-b',
    })

    useQuickNoteStore.getState().toggleFocusEdit()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'focus-edit',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().enterDetailRead('quick-note-c')
    useQuickNoteStore.getState().exitFocus()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })

    useQuickNoteStore.getState().reset()
    expect(useQuickNoteStore.getState()).toMatchObject({
      focusMode: 'normal',
      selectedQuickNoteId: null,
    })
  })

  it('silently refreshes after sync tombstones without hiding local trash', async () => {
    const active = await useQuickNoteStore.getState().createQuickNote({
      id: 'active-sync',
      content: 'active memo',
    })
    const trashed = await useQuickNoteStore.getState().createQuickNote({
      id: 'local-trash',
      content: 'local trash memo',
    })
    await useQuickNoteStore.getState().deleteQuickNote(trashed.id)
    await db.quickNotes.update(active.id, {
      deletion_state: 'deleted',
      _dirty: false,
    })

    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    expect(useQuickNoteStore.getState().quickNotes.map((item) => item.id)).toEqual([])
    expect(useQuickNoteStore.getState().trashedQuickNotes.map((item) => item.id)).toEqual([
      trashed.id,
    ])
    expect(useQuickNoteStore.getState().isLoading).toBe(false)
  })

  it('derives pending and failed sync status from dirty rows and outbox events', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({
      id: 'sync-status',
      content: 'pending sync memo',
    })
    const other = await useQuickNoteStore.getState().createQuickNote({
      id: 'sync-status-other',
      content: 'another pending sync memo',
    })

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBe('pending')
    expect(useQuickNoteStore.getState().syncStatusById[other.id]).toBe('pending')

    const failedOutbox = await db.outbox
      .where('entityId')
      .equals(note.id)
      .first()
    await db.outbox.update(failedOutbox!.id!, {
      lastError: 'server_rejected_quick_note',
      lastErrorCode: 'push_error',
      failedAt: '2026-07-07T13:10:00.000Z',
      attemptCount: 1,
    })
    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBe('failed')
    expect(useQuickNoteStore.getState().syncStatusById[other.id]).toBe('pending')

    await db.outbox.clear()
    await db.quickNotes.update(note.id, { _dirty: false })
    await db.quickNotes.update(other.id, { _dirty: false })
    await useQuickNoteStore.getState().refreshQuickNotesFromRepository()

    expect(useQuickNoteStore.getState().syncStatusById[note.id]).toBeUndefined()
    expect(useQuickNoteStore.getState().syncStatusById[other.id]).toBeUndefined()
  })

  it('migrates a quick note to a note and refreshes visible lifecycle state', async () => {
    const note = await useQuickNoteStore.getState().createQuickNote({
      id: 'store-convert',
      content: 'Store convert\nbody',
    })
    await db.outbox.clear()

    const noteId = await useQuickNoteStore.getState().migrateToNote(note.id)

    expect(await db.notes.get(noteId)).toMatchObject({
      title: 'Store convert',
      content: 'Store convert\nbody',
    })
    expect(useQuickNoteStore.getState().quickNotes.map((item) => item.id)).not.toContain(note.id)
    expect(useQuickNoteStore.getState().lifecycleStateById[note.id]).toBe('converted')
  })
})
