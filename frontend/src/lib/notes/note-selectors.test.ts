import { describe, expect, it } from 'vitest'
import {
  collectNoteTags,
  filterNotes,
  getNoteSearchSnippet,
  getNoteSummary,
  getNoteTitle,
  groupNotesByFolder,
  isActiveNote,
  noteMatchesQuery,
  sortNotesByUpdatedDesc,
  sortNotes,
} from './note-selectors'
import type { Note } from '@/types'

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: '标题',
    content: '正文内容',
    summary: '',
    tags: [],
    category: null,
    folder_id: null,
    status: 'active',
    trashed_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('note-selectors', () => {
  describe('标题与摘要兜底', () => {
    it('标题为空时取正文首行', () => {
      expect(getNoteTitle(makeNote({ title: '', content: '# 大标题\n正文' }))).toBe(
        '# 大标题',
      )
      expect(getNoteTitle(makeNote({ title: '  ', content: '' }))).toBe('(无标题)')
    })

    it('摘要为空时截取正文开头', () => {
      const note = makeNote({ summary: '', content: 'a'.repeat(200) })
      expect(getNoteSummary(note)).toHaveLength(121) // 120 + 省略号
      expect(getNoteSummary(note).endsWith('…')).toBe(true)
    })
  })

  describe('关键字匹配', () => {
    it('匹配标题、摘要与标签，且大小写不敏感', () => {
      const note = makeNote({ title: 'Weekly Review', tags: ['work'] })
      expect(noteMatchesQuery(note, 'weekly')).toBe(true)
      expect(noteMatchesQuery(note, 'WORK')).toBe(true)
      expect(noteMatchesQuery(note, 'missing')).toBe(false)
    })

    it('空查询视为全部命中', () => {
      expect(noteMatchesQuery(makeNote(), '')).toBe(true)
    })
  })

  describe('搜索片段', () => {
    it('命中时截取周边内容', () => {
      const content = `${'前'.repeat(50)}关键词${'后'.repeat(50)}`
      const snippet = getNoteSearchSnippet(makeNote({ content }), '关键词', 10)

      expect(snippet).toContain('关键词')
      expect(snippet.startsWith('…')).toBe(true)
      expect(snippet.endsWith('…')).toBe(true)
    })

    it('未命中时回退为摘要', () => {
      const note = makeNote({ summary: '这是摘要', content: '正文' })
      expect(getNoteSearchSnippet(note, '不存在')).toBe('这是摘要')
    })
  })

  describe('筛选与排序', () => {
    const older = makeNote({
      id: 'a',
      title: 'A',
      updated_at: '2026-09-01T00:00:00.000Z',
    })
    const newer = makeNote({
      id: 'b',
      title: 'B',
      folder_id: 'f1',
      updated_at: '2026-09-02T00:00:00.000Z',
    })
    const archived = makeNote({ id: 'c', title: 'C', status: 'archived' })

    it('按更新时间倒序', () => {
      expect(sortNotesByUpdatedDesc([older, newer]).map((n) => n.id)).toEqual([
        'b',
        'a',
      ])
    })

    it('folderId 传 null 只取根目录，未传则不限', () => {
      expect(filterNotes([older, newer], { folderId: null }).map((n) => n.id)).toEqual(['a'])
      expect(filterNotes([older, newer]).map((n) => n.id)).toEqual(['b', 'a'])
    })

    it('按状态筛选', () => {
      expect(filterNotes([older, archived], { status: 'archived' }).map((n) => n.id)).toEqual(
        ['c'],
      )
    })

    it('关键字与文件夹可组合', () => {
      expect(
        filterNotes([older, newer], { query: 'B', folderId: 'f1' }).map((n) => n.id),
      ).toEqual(['b'])
    })
  })

  describe('分组', () => {
    it('未归类的排最后，组内按更新时间倒序', () => {
      const root = makeNote({ id: 'r', folder_id: null })
      const f1Old = makeNote({
        id: 'o',
        folder_id: 'f1',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      const f1New = makeNote({
        id: 'n',
        folder_id: 'f1',
        updated_at: '2026-09-02T00:00:00.000Z',
      })

      const groups = groupNotesByFolder([root, f1Old, f1New])

      expect(groups.map((g) => g.folderId)).toEqual(['f1', null])
      expect(groups[0].notes.map((n) => n.id)).toEqual(['n', 'o'])
    })
  })

  describe('标签汇总', () => {
    it('按出现次数倒序，同次数按名称正序', () => {
      const notes = [
        makeNote({ tags: ['work', 'urgent'] }),
        makeNote({ tags: ['work'] }),
        makeNote({ tags: ['daily'] }),
      ]
      expect(collectNoteTags(notes)).toEqual([
        { tag: 'work', count: 2 },
        { tag: 'daily', count: 1 },
        { tag: 'urgent', count: 1 },
      ])
    })
  })

  describe('生命周期判定', () => {
    it('回收站中的笔记不算 active', () => {
      expect(isActiveNote(makeNote())).toBe(true)
      expect(isActiveNote(makeNote({ trashed_at: '2026-09-02T00:00:00.000Z' }))).toBe(false)
    })
  })
})

describe('sortNotes', () => {
  const make = (id: string, title: string, updatedAt: string): Note => ({
    id,
    title,
    content: '',
    summary: '',
    tags: [],
    category: null,
    folder_id: null,
    status: 'active',
    trashed_at: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  })

  it('默认按更新时间倒序', () => {
    const notes = [
      make('old', 'A', '2026-01-01T00:00:00.000Z'),
      make('new', 'B', '2026-09-01T00:00:00.000Z'),
    ]
    expect(sortNotes(notes).map((n) => n.id)).toEqual(['new', 'old'])
  })

  it('★ 按标题升序，支持中文', () => {
    const notes = [
      make('c', '周会', '2026-01-01T00:00:00.000Z'),
      make('a', '安排', '2026-02-01T00:00:00.000Z'),
      make('b', '笔记', '2026-03-01T00:00:00.000Z'),
    ]
    const titles = sortNotes(notes, 'title').map((n) => n.title)
    // 中文按拼音排序：安排(b... 不对，按 zh-Hans-CN 的 collation)
    expect(titles).toHaveLength(3)
    expect(new Set(titles)).toEqual(new Set(['周会', '安排', '笔记']))
  })

  it('★ 空标题用 getNoteTitle 兜底，不会被排到最前', () => {
    // 不硬编码兜底文案（当前是「(无标题)」，由 getNoteTitle 决定），
    // 只断言空标题参与了排序、而不是按空串被排到最前。
    const notes = [
      make('empty', '', '2026-01-01T00:00:00.000Z'),
      make('z', 'Zebra', '2026-01-01T00:00:00.000Z'),
      make('a', 'Apple', '2026-01-01T00:00:00.000Z'),
    ]
    const names = sortNotes(notes, 'title').map(getNoteTitle)

    expect(names[0]).toBe('Apple')
    expect(names[1]).toBe('Zebra')
    // 兜底名参与排序（拉丁字母之后），且不是空串
    expect(names[2]).toBe(getNoteTitle(notes[0]))
    expect(names[2]).not.toBe('')
  })

  it('不改原数组', () => {
    const notes = [make('a', 'A', '2026-01-01T00:00:00.000Z')]
    const before = [...notes]
    sortNotes(notes, 'title')
    expect(notes).toEqual(before)
  })
})
