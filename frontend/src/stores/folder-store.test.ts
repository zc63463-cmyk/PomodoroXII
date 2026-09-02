import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as folderRepository from '@/lib/folders/folder-repository'
import * as noteRepository from '@/lib/notes/note-repository'
import { useFolderStore } from '@/stores/folder-store'
import type { Folder, Note } from '@/types'

function folder(overrides: Partial<Folder> = {}): Folder {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'f1',
    name: 'F1',
    parent_id: null,
    icon: null,
    color: null,
    sort_order: 0,
    is_system: false,
    trashed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function note(overrides: Partial<Note> = {}): Note {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'n1',
    title: 'T',
    content: '',
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
 * Store 的职责是编排，故 mock 掉仓储（真实持久化由 folder-repository.test.ts 覆盖）。
 */
describe('folder-store', () => {
  beforeEach(() => {
    useFolderStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(folderRepository, 'listFolders').mockResolvedValue([])
    // deleteFolder 会读笔记以清空其 folder_id，默认给空列表
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([])
  })

  it('loadFolders 填充列表', async () => {
    vi.spyOn(folderRepository, 'listFolders').mockResolvedValue([
      folder({ id: 'a', name: '工作' }),
    ])

    const pending = useFolderStore.getState().loadFolders()
    expect(useFolderStore.getState().isLoading).toBe(true)
    await pending

    expect(useFolderStore.getState().folders.map((f) => f.name)).toEqual(['工作'])
    expect(useFolderStore.getState().isLoading).toBe(false)
  })

  it('createFolder 自行生成 id 并落空父级', async () => {
    const create = vi
      .spyOn(folderRepository, 'createFolder')
      .mockImplementation(async (input) => folder({ id: input.id, name: input.name }))

    const created = await useFolderStore.getState().createFolder('灵感')

    expect(create).toHaveBeenCalledTimes(1)
    const passed = create.mock.calls[0][0]
    expect(passed.id).toBeTruthy()
    expect(passed.name).toBe('灵感')
    expect(passed.parent_id).toBeNull()
    expect(created.id).toBe(passed.id)
  })

  it('rename / move 直接透传给仓储', async () => {
    const rename = vi.spyOn(folderRepository, 'renameFolder').mockResolvedValue(folder())
    const move = vi.spyOn(folderRepository, 'moveFolder').mockResolvedValue(folder())

    await useFolderStore.getState().renameFolder('f1', '新名字')
    await useFolderStore.getState().moveFolder('f1', 'parent-1')

    expect(rename).toHaveBeenCalledWith('f1', '新名字')
    expect(move).toHaveBeenCalledWith('f1', 'parent-1')
  })

  it('deleteFolder 是软删除，不是 purge', async () => {
    const trash = vi.spyOn(folderRepository, 'trashFolder').mockResolvedValue(folder())
    const purge = vi.spyOn(folderRepository, 'purgeFolder').mockResolvedValue(undefined)

    await useFolderStore.getState().deleteFolder('f1')

    expect(trash).toHaveBeenCalledWith('f1')
    expect(purge).not.toHaveBeenCalled()
  })

  it('删除文件夹时把子树内的笔记改为未归类', async () => {
    // 服务端 FolderDomainPolicy 会拒绝 folder_id 指向已回收文件夹的笔记
    // （relation_endpoint_missing），不清则这些笔记永久无法同步。
    vi.spyOn(folderRepository, 'trashFolder').mockResolvedValue(folder())
    const updateNote = vi.spyOn(noteRepository, 'updateNote').mockResolvedValue(note())
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      note({ id: 'n1', folder_id: 'a' }), // 直接在该文件夹
      note({ id: 'n2', folder_id: 'b' }), // 在子文件夹 —— 也必须清
      note({ id: 'n3', folder_id: 'z' }), // 无关文件夹 —— 不动
      note({ id: 'n4', folder_id: null }), // 本就未归类 —— 不动
    ])

    useFolderStore.setState({
      folders: [
        folder({ id: 'a' }),
        folder({ id: 'b', parent_id: 'a' }),
        folder({ id: 'z' }),
      ],
    })

    await useFolderStore.getState().deleteFolder('a')

    expect(updateNote).toHaveBeenCalledTimes(2)
    expect(updateNote).toHaveBeenCalledWith('n1', { folder_id: null })
    expect(updateNote).toHaveBeenCalledWith('n2', { folder_id: null })
    expect(updateNote).not.toHaveBeenCalledWith('n3', { folder_id: null })
  })

  it('refreshNoteCounts 只数未回收且已归类的笔记', async () => {
    vi.spyOn(noteRepository, 'listNotes').mockResolvedValue([
      note({ id: 'n1', folder_id: 'a' }),
      note({ id: 'n2', folder_id: 'a' }),
      note({ id: 'n3', folder_id: 'b' }),
      note({ id: 'n4', folder_id: null }), // 未归类，不计入任何文件夹
      note({ id: 'n5', folder_id: 'a', trashed_at: '2026-09-02T00:00:00.000Z' }), // 已回收
    ])

    await useFolderStore.getState().refreshNoteCounts()

    expect(useFolderStore.getState().noteCounts).toEqual({ a: 2, b: 1 })
  })
})
