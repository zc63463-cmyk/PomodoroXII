import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useQuickNoteExistingEditRecovery } from '@/components/quick-notes/use-quick-note-existing-edit-recovery'
import type { QuickNote } from '@/types'
import { spaceDBManager } from '@/services/space-db'
import { createQuickNote, updateQuickNote } from '@/lib/quick-notes/quick-note-repository'

const note: QuickNote = {
  id: 'note-1', content: 'before', mood: null, tags: [], pinned: false,
  archived_at: null, session_id: null, folder_id: null, trashed_at: null,
  migrated_to_note_id: null, created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
}

describe('useQuickNoteExistingEditRecovery', () => {
  beforeEach(async () => { await spaceDBManager.switchTo(`existing-session-${crypto.randomUUID()}`) })
  afterEach(async () => { await spaceDBManager.current.delete(); spaceDBManager.close() })
  it('opens an existing note and keeps changed input as unsaved state', async () => {
    const { result } = renderHook(() => useQuickNoteExistingEditRecovery())
    await act(async () => { await result.current.start(note) })
    act(() => result.current.change('local change'))
    expect(result.current).toMatchObject({ editingId: note.id, draft: 'local change', saveState: 'unsaved' })
  })

  it('checkpoints input and restores it after remount in the same Space', async () => {
    const first = renderHook(() => useQuickNoteExistingEditRecovery())
    await act(async () => { await first.result.current.start(note) })
    act(() => { first.result.current.change('checkpointed') })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)) })
    first.unmount()

    const restored = renderHook(() => useQuickNoteExistingEditRecovery())
    await act(async () => { await restored.result.current.start(note) })
    expect(restored.result.current).toMatchObject({ editingId: note.id, draft: 'checkpointed', saveState: 'unsaved' })
  })

  it('saves through CAS and clears its checkpoint', async () => {
    const stored = await createQuickNote({ id: note.id, content: note.content })
    const hook = renderHook(() => useQuickNoteExistingEditRecovery())
    await act(async () => { await hook.result.current.start(stored) })
    act(() => { hook.result.current.change('saved content') })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); await hook.result.current.save() })
    expect(hook.result.current).toMatchObject({ draft: 'saved content', saveState: 'saved' })
    expect(await spaceDBManager.current.quickNotes.get(note.id)).toMatchObject({ content: 'saved content' })
  })

  it('does not publish or write into Space B after an A to B switch with the same note ID', async () => {
    const fixed = '2026-07-15T00:00:00.000Z'
    const source = await createQuickNote({ id: note.id, content: 'A source', created_at: fixed, updated_at: fixed })
    const hook = renderHook(() => useQuickNoteExistingEditRecovery())
    await act(async () => { await hook.result.current.start(source) })
    act(() => { hook.result.current.change('A local') })
    await act(async () => { await spaceDBManager.switchTo(`existing-target-${crypto.randomUUID()}`) })
    await createQuickNote({ id: note.id, content: 'B source', created_at: fixed, updated_at: fixed })

    await expect(hook.result.current.save()).resolves.toBe(false)
    expect(hook.result.current.editingId).toBeNull()
    expect(await spaceDBManager.current.quickNotes.get(note.id)).toMatchObject({ content: 'B source' })
  })

  it('preserves local input on CAS conflict and can adopt the remote version', async () => {
    const stored = await createQuickNote({ id: note.id, content: note.content })
    const hook = renderHook(() => useQuickNoteExistingEditRecovery())
    await act(async () => { await hook.result.current.start(stored) })
    act(() => { hook.result.current.change('local') })
    await updateQuickNote(note.id, { content: 'remote' })
    await act(async () => { await hook.result.current.save() })
    expect(hook.result.current).toMatchObject({ draft: 'local', conflict: { remoteContent: 'remote' }, saveState: 'unsaved' })
    await act(async () => { await hook.result.current.useRemote() })
    expect(hook.result.current).toMatchObject({ draft: 'remote', conflict: null, saveState: 'saved' })
  })
})
