import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as noteRepository from '@/lib/notes/note-repository'
import { useNoteStore } from '@/stores/note-store'
import type { Note } from '@/types'

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'n1',
    title: 'T',
    content: 'body',
    summary: '',
    tags: [],
    category: null,
    folder_id: null,
    status: 'active',
    trashed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

/**
 * Store 的职责是编排：调用哪个仓储函数、如何维护状态。
 * 因此这里 mock 掉仓储（真实仓储由 note-repository.test.ts 覆盖），
 * 只断言编排行为 —— 尤其是「正文与元数据分两条写」这条容易写错的分派。
 */
describe('note-store', () => {
  beforeEach(() => {
    useNoteStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('loadNotes 填充列表并维护 isLoading', async () => {
    const list = vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([makeNote()])

    const pending = useNoteStore.getState().loadNotes()
    expect(useNoteStore.getState().isLoading).toBe(true)

    await pending

    expect(list).toHaveBeenCalledTimes(1)
    expect(useNoteStore.getState().notes).toHaveLength(1)
    expect(useNoteStore.getState().isLoading).toBe(false)
  })

  it('createNote 未给 id 时自行生成', async () => {
    const create = vi
      .spyOn(noteRepository, 'createNote')
      .mockImplementation(async (input) => makeNote({ id: input.id, title: input.title ?? '' }))
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([makeNote()])

    const note = await useNoteStore.getState().createNote({ title: '新笔记' })

    expect(create).toHaveBeenCalledTimes(1)
    const passed = create.mock.calls[0][0]
    expect(passed.id).toBeTruthy()
    expect(useNoteStore.getState().currentNoteId).toBe(note.id)
  })

  it('updateNote 只带正文 → 走 updateNoteContent', async () => {
    const contentUpdate = vi
      .spyOn(noteRepository, 'updateNoteContent')
      .mockResolvedValue(makeNote())
    const metadataUpdate = vi
      .spyOn(noteRepository, 'updateNote')
      .mockResolvedValue(makeNote())
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])

    await useNoteStore.getState().updateNote('n1', { content: '新正文' })

    expect(contentUpdate).toHaveBeenCalledWith('n1', '新正文')
    expect(metadataUpdate).not.toHaveBeenCalled()
  })

  it('updateNote 只带元数据 → 走 updateNote（元数据）', async () => {
    const contentUpdate = vi
      .spyOn(noteRepository, 'updateNoteContent')
      .mockResolvedValue(makeNote())
    const metadataUpdate = vi
      .spyOn(noteRepository, 'updateNote')
      .mockResolvedValue(makeNote())
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])

    await useNoteStore.getState().updateNote('n1', { title: '新标题' })

    expect(metadataUpdate).toHaveBeenCalledWith('n1', { title: '新标题' })
    expect(contentUpdate).not.toHaveBeenCalled()
  })

  it('updateNote 同时带正文与元数据 → 两条都写', async () => {
    const contentUpdate = vi
      .spyOn(noteRepository, 'updateNoteContent')
      .mockResolvedValue(makeNote())
    const metadataUpdate = vi
      .spyOn(noteRepository, 'updateNote')
      .mockResolvedValue(makeNote())
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])

    await useNoteStore.getState().updateNote('n1', { content: 'c2', title: 't2' })

    expect(contentUpdate).toHaveBeenCalledWith('n1', 'c2')
    expect(metadataUpdate).toHaveBeenCalledWith('n1', { title: 't2' })
  })

  it('deleteNote 是软删除（moveNoteToTrash），不是 purge', async () => {
    const trash = vi.spyOn(noteRepository, 'moveNoteToTrash').mockResolvedValue(makeNote())
    const purge = vi.spyOn(noteRepository, 'purgeNote').mockResolvedValue(undefined)
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])

    await useNoteStore.getState().deleteNote('n1')

    expect(trash).toHaveBeenCalledWith('n1')
    expect(purge).not.toHaveBeenCalled()
  })

  it('删除当前笔记后清空 currentNoteId', async () => {
    vi.spyOn(noteRepository, 'moveNoteToTrash').mockResolvedValue(makeNote())
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])

    useNoteStore.setState({ currentNoteId: 'n1' })
    await useNoteStore.getState().deleteNote('n1')

    expect(useNoteStore.getState().currentNoteId).toBeNull()
  })

  it('仓储抛错时记录 error 并向上冒泡', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockRejectedValue(new Error('boom'))

    await expect(useNoteStore.getState().loadNotes()).resolves.toBeUndefined()
    expect(useNoteStore.getState().error).toBe('boom')
    expect(useNoteStore.getState().isLoading).toBe(false)
  })
})
