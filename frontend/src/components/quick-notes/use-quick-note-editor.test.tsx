import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type {
  QuickNoteDraftDiscardResult,
  QuickNoteDraftIssue,
  QuickNoteDraftRecordResult,
} from '@/components/quick-notes/use-quick-note-draft-session'
import type { QuickNoteDraftSaveState } from '@/lib/quick-notes/quick-note-editor-status'
import type { QuickNoteUpdateInput } from '@/lib/quick-notes/quick-note-repository'
import { PomodoroXIDB } from '@/services/database'
import { db, spaceDBManager } from '@/services/space-db'
import type { QuickNote } from '@/types'

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn((_message: string) => undefined), {
    error: vi.fn((_message: string, _options?: { description?: string }) => undefined),
  }),
)

const sessionMocks = vi.hoisted(() => ({
  useQuickNoteDraftSession: vi.fn(),
  session: {
    draft: '',
    saveState: 'idle' as QuickNoteDraftSaveState,
    issue: null as QuickNoteDraftIssue | null,
    change: vi.fn<(next: string) => void>(),
    record: vi.fn<() => Promise<QuickNoteDraftRecordResult>>(),
    discard: vi.fn<() => Promise<QuickNoteDraftDiscardResult>>(),
  },
}))

vi.mock('sonner', () => ({
  toast: toastMock,
}))

vi.mock('@/components/quick-notes/use-quick-note-draft-session', () => ({
  useQuickNoteDraftSession: sessionMocks.useQuickNoteDraftSession,
}))

import { useQuickNoteEditor } from '@/components/quick-notes/use-quick-note-editor'

function createOptions(overrides: {
  quickNotes?: QuickNote[]
  trashedQuickNotes?: QuickNote[]
  projectRecordedQuickNote?: (note: QuickNote) => undefined
  updateQuickNote?: (id: string, data: QuickNoteUpdateInput) => Promise<void>
  describeQuickNoteError?: (error: unknown, fallback: string) => string
  lifecycleStateById?: Record<
    string,
    'active' | 'trashed' | 'archived' | 'converted' | 'sync-deleted'
  >
} = {}) {
  return {
    quickNotes: overrides.quickNotes ?? [],
    trashedQuickNotes: overrides.trashedQuickNotes ?? [],
    projectRecordedQuickNote:
      overrides.projectRecordedQuickNote ?? vi.fn((_note: QuickNote): undefined => undefined),
    updateQuickNote: overrides.updateQuickNote ?? vi.fn(async () => undefined),
    describeQuickNoteError:
      overrides.describeQuickNoteError ??
      vi.fn((_error: unknown, fallback: string) => fallback),
    lifecycleStateById: overrides.lifecycleStateById ?? {},
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

describe('useQuickNoteEditor', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    await spaceDBManager.switchTo(`quick-note-editor-${crypto.randomUUID()}`)

    toastMock.mockClear()
    toastMock.error.mockClear()
    sessionMocks.session.draft = ''
    sessionMocks.session.saveState = 'idle'
    sessionMocks.session.issue = null
    sessionMocks.session.change.mockReset()
    sessionMocks.session.record.mockReset()
    sessionMocks.session.record.mockResolvedValue({ kind: 'empty' })
    sessionMocks.session.discard.mockReset()
    sessionMocks.session.discard.mockResolvedValue({ kind: 'discarded' })
    sessionMocks.useQuickNoteDraftSession.mockReset()
    sessionMocks.useQuickNoteDraftSession.mockImplementation(() => sessionMocks.session)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await db.delete()
    spaceDBManager.close()
  })

  it('keeps the session draft separate from an existing-note edit', async () => {
    const existing = makeQuickNote()
    const updateQuickNote = vi.fn(async () => undefined)
    const projectRecordedQuickNote = vi.fn((_note: QuickNote): undefined => undefined)
    const options = createOptions({
      quickNotes: [existing],
      projectRecordedQuickNote,
      updateQuickNote,
    })
    sessionMocks.session.draft = 'untouched session draft'
    sessionMocks.session.saveState = 'restored'

    const { result } = renderHook(() => useQuickNoteEditor(options))

    expect(result.current.draft).toBe('untouched session draft')
    expect(result.current.draftSaveState).toBe('restored')
    expect(sessionMocks.useQuickNoteDraftSession).toHaveBeenCalledWith({
      onRecorded: projectRecordedQuickNote,
    })

    act(() => result.current.startEdit(existing))
    expect(result.current.draft).toBe('existing note')

    act(() => result.current.setDraft('edited existing note'))
    expect(result.current.draft).toBe('edited existing note')
    expect(sessionMocks.session.change).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.submitDraft(submitEvent())
    })
    expect(updateQuickNote).toHaveBeenCalledWith(existing.id, {
      content: 'edited existing note',
    })
    expect(sessionMocks.session.record).not.toHaveBeenCalled()

    act(() => result.current.cancelEdit())
    expect(result.current.editingId).toBeNull()
    expect(result.current.draft).toBe('untouched session draft')
    expect(sessionMocks.session.change).not.toHaveBeenCalled()
  })

  it('suppresses only projection-failed status for a consumed session draft', () => {
    sessionMocks.session.draft = ''
    sessionMocks.session.saveState = 'failed'
    sessionMocks.session.issue = { code: 'projection-failed', retryable: false }
    const { result, rerender } = renderHook(() => useQuickNoteEditor(createOptions()))

    expect(result.current.draftSaveState).toBe('idle')

    sessionMocks.session.draft = 'draft still retained'
    rerender()
    expect(result.current.draftSaveState).toBe('failed')

    sessionMocks.session.draft = ''
    sessionMocks.session.issue = { code: 'save-failed', retryable: true }
    rerender()
    expect(result.current.draftSaveState).toBe('failed')
  })

  it('maps a refreshed session record to success without a pending toast', async () => {
    sessionMocks.session.draft = 'record locally'
    sessionMocks.session.record.mockResolvedValueOnce({
      kind: 'recorded',
      note: makeQuickNote({ content: 'record locally' }),
      visibility: 'refreshed',
    })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    let submitted = false
    await act(async () => {
      submitted = await result.current.submitDraft(submitEvent())
    })

    expect(submitted).toBe(true)
    expect(sessionMocks.session.record).toHaveBeenCalledTimes(1)
    expect(toastMock).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('maps a pending session record to success with a visibility toast', async () => {
    sessionMocks.session.draft = 'record pending projection'
    sessionMocks.session.record.mockResolvedValueOnce({
      kind: 'recorded',
      note: makeQuickNote({ content: 'record pending projection' }),
      visibility: 'pending',
    })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    let submitted = false
    await act(async () => {
      submitted = await result.current.submitDraft(submitEvent())
    })

    expect(submitted).toBe(true)
    expect(sessionMocks.session.record).toHaveBeenCalledTimes(1)
    expect(toastMock).toHaveBeenCalledWith('小记已记录，列表将在稍后刷新')
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('maps an empty session record to the stable validation error', async () => {
    sessionMocks.session.draft = '   '
    sessionMocks.session.record.mockResolvedValueOnce({ kind: 'empty' })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    let submitted = true
    await act(async () => {
      submitted = await result.current.submitDraft(submitEvent())
    })

    expect(submitted).toBe(false)
    expect(sessionMocks.session.record).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('先写点内容再记录')
  })

  it('maps record-busy-on-discard to the stable busy error', async () => {
    sessionMocks.session.draft = 'record while discarding'
    sessionMocks.session.record.mockResolvedValueOnce({
      kind: 'busy',
      operation: 'discard',
    })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    let submitted = true
    await act(async () => {
      submitted = await result.current.submitDraft(submitEvent())
    })

    expect(submitted).toBe(false)
    expect(sessionMocks.session.record).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('草稿正在丢弃，请稍后再记录')
  })

  it('maps a failed record to the stable local-retry error and preserves input', async () => {
    sessionMocks.session.draft = 'preserve failed record input'
    sessionMocks.session.record.mockResolvedValueOnce({
      kind: 'failed',
      issue: { code: 'record-failed', retryable: true },
    })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    let submitted = true
    await act(async () => {
      submitted = await result.current.submitDraft(submitEvent())
    })

    expect(submitted).toBe(false)
    expect(sessionMocks.session.record).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('小记创建失败', {
      description: '草稿仍保留在本机，请稍后重试',
    })
    expect(result.current.draft).toBe('preserve failed record input')
  })

  it('does nothing when discard is superseded by newer input', async () => {
    sessionMocks.session.draft = 'newer input survives'
    sessionMocks.session.discard.mockResolvedValueOnce({ kind: 'superseded' })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    await act(async () => {
      await result.current.discardNewDraft()
    })

    expect(sessionMocks.session.discard).toHaveBeenCalledTimes(1)
    expect(sessionMocks.session.change).not.toHaveBeenCalled()
    expect(result.current.draft).toBe('newer input survives')
    expect(toastMock).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('clears typing state when the session discards the current draft', async () => {
    sessionMocks.session.draft = 'draft to discard'
    sessionMocks.session.discard.mockResolvedValueOnce({ kind: 'discarded' })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    act(() => result.current.setDraft('draft to discard'))
    expect(result.current.isTyping).toBe(true)
    expect(sessionMocks.session.change).toHaveBeenCalledTimes(1)
    expect(sessionMocks.session.change).toHaveBeenCalledWith('draft to discard')

    await act(async () => {
      await result.current.discardNewDraft()
    })

    expect(sessionMocks.session.discard).toHaveBeenCalledTimes(1)
    expect(result.current.isTyping).toBe(false)
    expect(sessionMocks.session.change).toHaveBeenCalledTimes(1)
    expect(toastMock).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('maps discard-busy-on-record to the stable busy error', async () => {
    sessionMocks.session.draft = 'discard while recording'
    sessionMocks.session.discard.mockResolvedValueOnce({
      kind: 'busy',
      operation: 'record',
    })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    await act(async () => {
      await result.current.discardNewDraft()
    })

    expect(sessionMocks.session.discard).toHaveBeenCalledTimes(1)
    expect(sessionMocks.session.change).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith('草稿正在记录，请稍后再丢弃')
  })

  it('maps a failed discard to the stable preserved-input error', async () => {
    sessionMocks.session.draft = 'preserve failed discard input'
    sessionMocks.session.discard.mockResolvedValueOnce({
      kind: 'failed',
      issue: { code: 'discard-failed', retryable: true },
    })
    const { result } = renderHook(() => useQuickNoteEditor(createOptions()))

    await act(async () => {
      await result.current.discardNewDraft()
    })

    expect(sessionMocks.session.discard).toHaveBeenCalledTimes(1)
    expect(sessionMocks.session.change).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith('丢弃草稿失败，输入已保留')
    expect(result.current.draft).toBe('preserve failed discard input')
  })

  it('invalidates an in-flight existing-note save that resolves after unmount', async () => {
    let releaseUpdate: (() => void) | null = null
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve
    })
    const existing = makeQuickNote()
    const updateQuickNote = vi.fn(() => updateGate)
    const { result, unmount } = renderHook(() =>
      useQuickNoteEditor(createOptions({ quickNotes: [existing], updateQuickNote })),
    )

    act(() => result.current.startEdit(existing))
    act(() => result.current.setDraft('save resolving after unmount'))
    let submitPromise: Promise<boolean> | null = null
    act(() => {
      submitPromise = result.current.submitDraft(submitEvent())
    })
    await waitFor(() => expect(updateQuickNote).toHaveBeenCalledTimes(1))
    const saveStateBeforeUnmount = result.current.saveState

    unmount()
    let submitted = true
    await act(async () => {
      releaseUpdate?.()
      await updateGate
      submitted = await submitPromise!
    })

    expect(submitted).toBe(false)
    expect(result.current.saveState).toBe(saveStateBeforeUnmount)
    expect(toastMock).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('suppresses failure publication when an in-flight save rejects after unmount', async () => {
    let rejectUpdate: ((error: Error) => void) | null = null
    const updateGate = new Promise<void>((_resolve, reject) => {
      rejectUpdate = reject
    })
    const existing = makeQuickNote()
    const updateQuickNote = vi.fn(() => updateGate)
    const { result, unmount } = renderHook(() =>
      useQuickNoteEditor(createOptions({ quickNotes: [existing], updateQuickNote })),
    )

    act(() => result.current.startEdit(existing))
    act(() => result.current.setDraft('save rejecting after unmount'))
    let submitPromise: Promise<boolean> | null = null
    act(() => {
      submitPromise = result.current.submitDraft(submitEvent())
    })
    await waitFor(() => expect(updateQuickNote).toHaveBeenCalledTimes(1))

    unmount()
    let submitted = true
    await act(async () => {
      rejectUpdate?.(new Error('late update failure'))
      submitted = await submitPromise!
    })

    expect(submitted).toBe(false)
    expect(toastMock).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('invalidates a queued existing-note save after a successful Space switch', async () => {
    let releaseFirstWrite: (() => void) | null = null
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    const existing = makeQuickNote()
    const updateQuickNote = vi
      .fn<(id: string, data: QuickNoteUpdateInput) => Promise<void>>()
      .mockImplementationOnce(async () => {
        await firstWriteGate
      })
      .mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useQuickNoteEditor(createOptions({ quickNotes: [existing], updateQuickNote })),
    )

    act(() => result.current.startEdit(existing))
    act(() => result.current.setDraft('first existing edit'))
    let firstSave: Promise<boolean> | null = null
    act(() => {
      firstSave = result.current.submitDraft(submitEvent())
    })
    await waitFor(() => expect(updateQuickNote).toHaveBeenCalledTimes(1))

    act(() => result.current.setDraft('second queued existing edit'))
    let secondSave: Promise<boolean> | null = null
    act(() => {
      secondSave = result.current.submitDraft(submitEvent())
    })

    await act(async () => {
      await spaceDBManager.switchTo(`quick-note-editor-target-${crypto.randomUUID()}`)
    })
    await waitFor(() => expect(result.current.editingId).toBeNull())

    await act(async () => {
      releaseFirstWrite?.()
      await firstWriteGate
      await Promise.all([firstSave, secondSave])
    })

    expect(updateQuickNote).toHaveBeenCalledTimes(1)
    expect(result.current.editingId).toBeNull()
    expect(result.current.saveState).toBe('saved')
  })

  it('keeps existing edit when target Space open fails', async () => {
    const existing = makeQuickNote()
    const { result } = renderHook(() =>
      useQuickNoteEditor(createOptions({ quickNotes: [existing] })),
    )

    act(() => result.current.startEdit(existing))
    act(() => result.current.setDraft('unsaved existing edit'))
    vi.spyOn(PomodoroXIDB.prototype, 'open').mockRejectedValueOnce(
      new Error('target open failed'),
    )

    await act(async () => {
      await expect(
        spaceDBManager.switchTo(`quick-note-editor-failed-${crypto.randomUUID()}`),
      ).rejects.toThrow('target open failed')
    })

    expect(result.current.editingId).toBe(existing.id)
    expect(result.current.draft).toBe('unsaved existing edit')
  })
})
