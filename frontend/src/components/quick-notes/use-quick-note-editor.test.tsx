import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useQuickNoteEditor } from '@/components/quick-notes/use-quick-note-editor'
import {
  createQuickNoteDraftRepository,
} from '@/lib/quick-notes/quick-note-draft-repository'
import { db, spaceDBManager } from '@/services/space-db'
import type { QuickNote } from '@/types'

function createOptions(overrides: {
  quickNotes?: QuickNote[]
  createQuickNote?: (data: { content: string }) => Promise<QuickNote>
} = {}) {
  return {
    quickNotes: overrides.quickNotes ?? [],
    trashedQuickNotes: [],
    createQuickNote: overrides.createQuickNote ?? vi.fn(async ({ content }) => makeQuickNote({ content })),
    updateQuickNote: vi.fn(async () => undefined),
    describeQuickNoteError: vi.fn((_error: unknown, fallback: string) => fallback),
  }
}

function makeQuickNote(overrides: Partial<QuickNote> = {}): QuickNote {
  const now = '2026-07-10T04:00:00.000Z'
  return {
    id: 'quick-note-1',
    content: 'existing note',
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

function submitEvent() {
  return { preventDefault: vi.fn() } as unknown as React.FormEvent<HTMLFormElement>
}

describe('useQuickNoteEditor new draft persistence', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    await spaceDBManager.switchTo(`quick-note-editor-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await db.delete()
    spaceDBManager.close()
  })

  it('debounces saving a new draft and clears it when the input becomes blank', async () => {
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    act(() => result.current.setDraft('自动保存的新草稿'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await spaceDBManager.current.settings.count()).toBe(0)

    await waitFor(() => expect(result.current.draftSaveState).toBe('saved'), { timeout: 1200 })
    await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toMatchObject({
      content: '自动保存的新草稿',
    })

    act(() => result.current.setDraft('   '))
    await waitFor(async () => {
      await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toBeNull()
    }, { timeout: 1200 })
  })

  it('does not let cleanup overwrite an already saved draft with stale React state', async () => {
    const { result, unmount } = renderHook(() => useQuickNoteEditor(createOptions()))

    act(() => result.current.setDraft('卸载前已保存草稿'))
    await waitFor(() => expect(result.current.draftSaveState).toBe('saved'), { timeout: 1200 })
    unmount()

    await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toMatchObject({
      content: '卸载前已保存草稿',
    })
  })

  it('restores a persisted draft on mount and reports the one-time restored state', async () => {
    await createQuickNoteDraftRepository(spaceDBManager.current).save('刷新后恢复我')

    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    await waitFor(() => expect(result.current.draft).toBe('刷新后恢复我'))
    expect(result.current.draftSaveState).toBe('restored')
  })

  it('does not overwrite input typed while a delayed persisted draft is loading', async () => {
    const repository = createQuickNoteDraftRepository(spaceDBManager.current)
    let releaseLoad: (() => void) | null = null
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    await repository.save('旧持久化草稿')
    const load = repository.load
    vi.spyOn(repository, 'load').mockImplementationOnce(async () => {
      await loadGate
      return load()
    })
    const repositoryFactory = vi.spyOn(
      await import('@/lib/quick-notes/quick-note-draft-repository'),
      'createQuickNoteDraftRepository',
    )
    repositoryFactory.mockReturnValueOnce(repository)

    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))
    act(() => result.current.setDraft('用户刚输入的新内容'))
    await act(async () => {
      releaseLoad?.()
      await loadGate
    })

    expect(result.current.draft).toBe('用户刚输入的新内容')
  })

  it('keeps the newest save from reviving a draft after successful creation clears it', async () => {
    let releaseSave: (() => void) | null = null
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const repository = createQuickNoteDraftRepository(spaceDBManager.current)
    const save = repository.save
    vi.spyOn(repository, 'save').mockImplementationOnce(async (...args) => {
      await saveGate
      return save(...args)
    })
    const repositoryFactory = vi.spyOn(
      await import('@/lib/quick-notes/quick-note-draft-repository'),
      'createQuickNoteDraftRepository',
    )
    repositoryFactory.mockReturnValueOnce(repository)
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    act(() => result.current.setDraft('与创建并发的草稿'))
    await new Promise((resolve) => setTimeout(resolve, 550))
    let submitPromise: Promise<boolean> | null = null
    act(() => {
      submitPromise = result.current.submitDraft(submitEvent())
    })
    await act(async () => {
      releaseSave?.()
      await saveGate
      await submitPromise
    })

    await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toBeNull()
  })

  it('clears the persisted draft only after a successful create and keeps it on failure', async () => {
    const createQuickNote = vi
      .fn<(data: { content: string }) => Promise<QuickNote>>()
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce(makeQuickNote({ content: '创建重试草稿' }))
    const { result } = renderHook(() => useQuickNoteEditor(createOptions({ createQuickNote })))

    act(() => result.current.setDraft('创建重试草稿'))
    await act(async () => {
      await result.current.flushNewDraft()
    })

    await act(async () => {
      await result.current.submitDraft(submitEvent())
    })
    await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toMatchObject({
      content: '创建重试草稿',
    })

    await act(async () => {
      await result.current.submitDraft(submitEvent())
    })
    await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toBeNull()
    expect(result.current.draft).toBe('')
  })

  it('keeps new draft storage isolated while editing an existing QuickNote', async () => {
    const existing = makeQuickNote()
    const options = createOptions({ quickNotes: [existing] })
    const { result } = renderHook(() => useQuickNoteEditor(options))

    act(() => result.current.setDraft('未提交的新建草稿'))
    await waitFor(() => expect(result.current.draftSaveState).toBe('saved'), { timeout: 1200 })

    act(() => result.current.startEdit(existing))
    act(() => result.current.setDraft('已有小记的编辑内容'))
    await waitFor(() => expect(options.updateQuickNote).toHaveBeenCalled(), { timeout: 1400 })

    expect(await spaceDBManager.current.settings.toArray()).toEqual([
      expect.objectContaining({ key: 'quickNote:newDraft:v1' }),
    ])

    act(() => result.current.cancelEdit())
    expect(result.current.draft).toBe('未提交的新建草稿')
  })

  it('invalidates a pending existing-note autosave when the Space changes', async () => {
    let releaseUpdate: (() => void) | null = null
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve
    })
    const existing = makeQuickNote()
    const options = createOptions({ quickNotes: [existing] })
    options.updateQuickNote.mockImplementationOnce(async () => {
      await updateGate
    })
    const { result } = renderHook(() => useQuickNoteEditor(options))

    act(() => result.current.startEdit(existing))
    act(() => result.current.setDraft('Space A 已有小记改动'))
    await waitFor(() => expect(options.updateQuickNote).toHaveBeenCalled(), { timeout: 1400 })
    await act(async () => {
      await spaceDBManager.switchTo('quick-note-editor-existing-edit-b')
    })
    await waitFor(() => expect(result.current.editingId).toBeNull())

    await act(async () => {
      releaseUpdate?.()
      await updateGate
    })

    expect(result.current.editingId).toBeNull()
    expect(result.current.draft).toBe('')
    expect(result.current.saveState).toBe('saved')
  })

  it('flushes Space A before switching and restores each Space draft independently', async () => {
    const spaceAId = spaceDBManager.currentSpaceId!
    const spaceADB = spaceDBManager.current
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    act(() => result.current.setDraft('Space A 最新草稿'))
    await act(async () => {
      await spaceDBManager.switchTo('quick-note-editor-space-b')
    })
    await spaceADB.open()
    await expect(createQuickNoteDraftRepository(spaceADB).load()).resolves.toMatchObject({
      content: 'Space A 最新草稿',
    })
    spaceADB.close()
    await waitFor(() => expect(result.current.draft).toBe(''))

    act(() => result.current.setDraft('Space B 草稿'))
    await act(async () => {
      await result.current.flushNewDraft()
      await spaceDBManager.switchTo(spaceAId)
    })
    await waitFor(() => expect(result.current.draft).toBe('Space A 最新草稿'))

    await act(async () => {
      await spaceDBManager.switchTo('quick-note-editor-space-b')
    })
    await waitFor(() => expect(result.current.draft).toBe('Space B 草稿'))
  })

  it('keeps the draft in memory when discard fails to clear persisted storage', async () => {
    const repository = createQuickNoteDraftRepository(spaceDBManager.current)
    const repositoryFactory = vi.spyOn(
      await import('@/lib/quick-notes/quick-note-draft-repository'),
      'createQuickNoteDraftRepository',
    )
    repositoryFactory.mockReturnValueOnce(repository)
    vi.spyOn(repository, 'clear').mockRejectedValueOnce(new Error('indexeddb locked'))

    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))
    act(() => result.current.setDraft('准备丢弃但失败的草稿'))
    await waitFor(() => expect(result.current.draftSaveState).toBe('saved'), { timeout: 1200 })

    await act(async () => {
      await result.current.discardNewDraft()
    })

    expect(result.current.draft).toBe('准备丢弃但失败的草稿')
    expect(result.current.draftSaveState).toBe('failed')
  })

  it('transitions from restored to dirty to saved after the user types following recovery', async () => {
    await createQuickNoteDraftRepository(spaceDBManager.current).save('恢复后继续编辑')

    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    await waitFor(() => expect(result.current.draftSaveState).toBe('restored'))

    act(() => result.current.setDraft('恢复后继续编辑 + 新增'))
    expect(result.current.draftSaveState).toBe('dirty')

    await waitFor(() => expect(result.current.draftSaveState).toBe('saved'), { timeout: 1200 })
    expect(result.current.draftSaveState).not.toBe('restored')
  })

  it('preserves input typed while QuickNote creation is pending', async () => {
    let releaseCreate: (() => void) | null = null
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const createQuickNote = vi.fn(async ({ content }: { content: string }) => {
      await createGate
      return makeQuickNote({ content })
    })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions({ createQuickNote })))

    act(() => result.current.setDraft('正在创建的内容'))
    let submitPromise: Promise<boolean> | null = null
    act(() => {
      submitPromise = result.current.submitDraft(submitEvent())
    })
    act(() => result.current.setDraft('创建期间继续输入的新草稿'))

    await act(async () => {
      releaseCreate?.()
      await createGate
      await submitPromise
    })

    expect(result.current.draft).toBe('创建期间继续输入的新草稿')
    await waitFor(async () => {
      await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toMatchObject({
        content: '创建期间继续输入的新草稿',
      })
    }, { timeout: 1200 })
  })

  it('preserves input typed while discard storage clearing is pending', async () => {
    const repository = createQuickNoteDraftRepository(spaceDBManager.current)
    let releaseClear: (() => void) | null = null
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve
    })
    const clear = repository.clear
    vi.spyOn(repository, 'clear').mockImplementationOnce(async () => {
      await clearGate
      await clear()
    })
    vi.spyOn(
      await import('@/lib/quick-notes/quick-note-draft-repository'),
      'createQuickNoteDraftRepository',
    ).mockReturnValueOnce(repository)
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    act(() => result.current.setDraft('准备丢弃'))
    await waitFor(() => expect(result.current.draftSaveState).toBe('saved'), { timeout: 1200 })
    let discardPromise: Promise<void> | null = null
    act(() => {
      discardPromise = result.current.discardNewDraft()
    })
    act(() => result.current.setDraft('丢弃期间的新输入'))

    await act(async () => {
      releaseClear?.()
      await clearGate
      await discardPromise
    })

    expect(result.current.draft).toBe('丢弃期间的新输入')
    await waitFor(async () => {
      await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toMatchObject({
        content: '丢弃期间的新输入',
      })
    }, { timeout: 1200 })
  })

  it('keeps Space B draft saving independent after Space A flush times out', async () => {
    const spaceARepository = createQuickNoteDraftRepository(spaceDBManager.current)
    const hangingSave = new Promise<void>(() => undefined)
    vi.spyOn(spaceARepository, 'save').mockImplementation(() => hangingSave)
    vi.spyOn(
      await import('@/lib/quick-notes/quick-note-draft-repository'),
      'createQuickNoteDraftRepository',
    ).mockReturnValueOnce(spaceARepository)
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    act(() => result.current.setDraft('Space A 永久挂起'))
    await act(async () => {
      await spaceDBManager.switchTo('quick-note-editor-independent-b')
    })
    act(() => result.current.setDraft('Space B 必须可保存'))

    await waitFor(() => expect(result.current.draftSaveState).toBe('saved'), { timeout: 1500 })
    await expect(createQuickNoteDraftRepository(spaceDBManager.current).load()).resolves.toMatchObject({
      content: 'Space B 必须可保存',
    })
  }, 7000)

  it('does not freeze Space switching when the before-switch flush hangs', async () => {
    const repository = createQuickNoteDraftRepository(spaceDBManager.current)
    const saveGate = new Promise<void>(() => undefined)
    const save = repository.save
    vi.spyOn(repository, 'save').mockImplementation(async (...args) => {
      await saveGate
      return save(...args)
    })
    const repositoryFactory = vi.spyOn(
      await import('@/lib/quick-notes/quick-note-draft-repository'),
      'createQuickNoteDraftRepository',
    )
    repositoryFactory.mockReturnValueOnce(repository)

    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))
    act(() => result.current.setDraft('persist 挂起的草稿'))

    const switchPromise = act(async () => {
      await spaceDBManager.switchTo('quick-note-editor-hang-target')
    })
    await Promise.race([
      switchPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('switchTo timed out')), 6000),
      ),
    ])

    expect(spaceDBManager.currentSpaceId).toBe('quick-note-editor-hang-target')
  })
})
