import { describe, expect, it } from 'vitest'
import {
  buildFolderTree,
  collectFolderSubtree,
  countUnfiledNotes,
  flattenFolderTree,
} from './folder-selectors'
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

describe('buildFolderTree', () => {
  it('组装父子层级', () => {
    const tree = buildFolderTree([
      folder({ id: 'a', name: 'A' }),
      folder({ id: 'b', name: 'B', parent_id: 'a' }),
    ])

    expect(tree).toHaveLength(1)
    expect(tree[0].folder.id).toBe('a')
    expect(tree[0].children.map((c) => c.folder.id)).toEqual(['b'])
  })

  it('孤儿文件夹提到根层级，不丢弃', () => {
    const tree = buildFolderTree([
      folder({ id: 'orphan', parent_id: 'missing' }),
    ])

    expect(tree).toHaveLength(1)
    expect(tree[0].folder.id).toBe('orphan')
  })

  it('自引用不成环', () => {
    const tree = buildFolderTree([folder({ id: 'self', parent_id: 'self' })])

    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(0)
  })

  it('互相成环时中断，两个节点都在根层级', () => {
    const tree = buildFolderTree([
      folder({ id: 'a', parent_id: 'b' }),
      folder({ id: 'b', parent_id: 'a' }),
    ])

    expect(tree.map((n) => n.folder.id).sort()).toEqual(['a', 'b'])
    // 不能无限递归，也不能互相嵌套
    expect(tree.every((n) => n.children.length === 0)).toBe(true)
  })

  it('更长的环（a→b→c→a）也能中断', () => {
    const tree = buildFolderTree([
      folder({ id: 'a', parent_id: 'b' }),
      folder({ id: 'b', parent_id: 'c' }),
      folder({ id: 'c', parent_id: 'a' }),
    ])

    expect(tree.map((n) => n.folder.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('按 sort_order 再按名称排序', () => {
    const tree = buildFolderTree([
      folder({ id: 'z', name: 'Z', sort_order: 1 }),
      folder({ id: 'a', name: 'A', sort_order: 1 }),
      folder({ id: 'first', name: 'First', sort_order: 0 }),
    ])

    expect(tree.map((n) => n.folder.id)).toEqual(['first', 'a', 'z'])
  })

  it('系统文件夹排在同级最前（可关闭）', () => {
    const folders = [
      folder({ id: 'normal', name: 'B' }),
      folder({ id: 'sys', name: 'Z', is_system: true }),
    ]

    expect(buildFolderTree(folders).map((n) => n.folder.id)).toEqual(['sys', 'normal'])
    expect(
      buildFolderTree(folders, [], { systemFirst: false }).map((n) => n.folder.id),
    ).toEqual(['normal', 'sys'])
  })

  it('统计笔记数，且不计回收站中的', () => {
    const tree = buildFolderTree(
      [folder({ id: 'a' })],
      [
        note({ id: 'n1', folder_id: 'a' }),
        note({ id: 'n2', folder_id: 'a' }),
        note({ id: 'n3', folder_id: 'a', trashed_at: '2026-09-02T00:00:00.000Z' }),
      ],
    )

    expect(tree[0].noteCount).toBe(2)
  })
})

describe('collectFolderSubtree', () => {
  it('收集自身与后代', () => {
    const ids = collectFolderSubtree(
      [
        folder({ id: 'a' }),
        folder({ id: 'b', parent_id: 'a' }),
        folder({ id: 'c', parent_id: 'b' }),
        folder({ id: 'other' }),
      ],
      'a',
    )

    expect([...ids].sort()).toEqual(['a', 'b', 'c'])
  })

  it('成环时不死循环', () => {
    const ids = collectFolderSubtree(
      [
        folder({ id: 'a', parent_id: 'b' }),
        folder({ id: 'b', parent_id: 'a' }),
      ],
      'a',
    )

    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('孤儿的父引用不影响收集', () => {
    const ids = collectFolderSubtree([folder({ id: 'solo' })], 'solo')
    expect([...ids]).toEqual(['solo'])
  })
})

describe('countUnfiledNotes', () => {
  it('只数未回收且无文件夹的', () => {
    const count = countUnfiledNotes([
      note({ id: 'n1', folder_id: null }),
      note({ id: 'n2', folder_id: 'a' }),
      note({ id: 'n3', folder_id: null, trashed_at: '2026-09-02T00:00:00.000Z' }),
    ])

    expect(count).toBe(1)
  })
})

describe('flattenFolderTree', () => {
  it('输出带层级的扁平列表', () => {
    const tree = buildFolderTree([
      folder({ id: 'a' }),
      folder({ id: 'b', parent_id: 'a' }),
      folder({ id: 'c', parent_id: 'b' }),
    ])

    const flat = flattenFolderTree(tree)

    expect(flat.map((f) => [f.folder.id, f.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
  })
})
