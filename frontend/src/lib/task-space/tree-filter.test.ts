import { describe, expect, it } from 'vitest'
import type { CachedWorkItem } from '@/types'

import {
  countOpenChildren,
  EMPTY_TREE_FILTER,
  filterWorkItemTree,
  isTreeFilterActive,
} from './tree-filter'

const item = (
  id: string,
  overrides: Partial<CachedWorkItem> = {},
): CachedWorkItem => ({
  id,
  projectId: 'p1',
  displayKey: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: null,
  parentId: null,
  childRank: 0,
  depth: 1,
  completionWindowStart: null,
  completionWindowEnd: null,
  reviewPoint: null,
  hardDeadline: null,
  effortEstimateLowerSeconds: null,
  effortEstimateUpperSeconds: null,
  effortActualSeconds: 0,
  confidence: null,
  completedAt: null,
  cancelledAt: null,
  archivedAt: null,
  markedAsAttention: false,
  labelIds: [],
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
  ...overrides,
})

// root(1) ── parent(2) ── leaf(3)
const items = [
  item('root', { title: 'Container root', depth: 1 }),
  item('parent', { title: 'Design review', parentId: 'root', depth: 2 }),
  item('leaf', { title: 'Ship it', parentId: 'parent', depth: 3 }),
  item('done', { title: 'Already done', depth: 1, statusDefinitionId: 'status-done' }),
]

const context = {
  categoryById: {
    root: 'in_progress',
    parent: 'in_progress',
    leaf: 'in_progress',
    done: 'completed',
  },
  isBlockedById: { parent: true },
}

describe('isTreeFilterActive', () => {
  it('is inactive only when every dimension is at its default', () => {
    expect(isTreeFilterActive(EMPTY_TREE_FILTER)).toBe(false)
    expect(isTreeFilterActive({ ...EMPTY_TREE_FILTER, query: '  ' })).toBe(false)
    expect(isTreeFilterActive({ ...EMPTY_TREE_FILTER, labelIds: [] })).toBe(false)
    expect(isTreeFilterActive({ ...EMPTY_TREE_FILTER, status: 'open' })).toBe(true)
    expect(isTreeFilterActive({ ...EMPTY_TREE_FILTER, blockedOnly: true })).toBe(true)
  })

  // ★ P3：labelIds 是新增维度，空数组必须仍算「未激活」——
  //   否则默认筛选会突然把整棵树收成空（本文件最贵的回归）。
  it('★ labelIds 非空即激活（空数组不算）', () => {
    expect(isTreeFilterActive({ ...EMPTY_TREE_FILTER, labelIds: ['lbl-a'] })).toBe(true)
  })
})

describe('filterWorkItemTree', () => {
  it('returns the input untouched when the filter is inactive', () => {
    expect(filterWorkItemTree(items, EMPTY_TREE_FILTER, context)).toEqual(items)
  })

  // ---- P3（2026-10-04）：标签维度 ----------------------------------------
  //
  // 三条口径（与 tree-filter.ts 注释一一对应）：
  //   ① 命中项保留**完整祖先链**（既有不变量，标签维度不得破坏它）；
  //   ② 多标签是 **AND**（须同时具备），不是 OR；
  //   ③ 与 query / status / blockedOnly 是**同一套 AND 叠加**，不是另一套规则。
  const tagCtx = { categoryById: {}, isBlockedById: {} }

  it('★ P3：按单个标签筛，命中项保留完整祖先链', () => {
    const tagged = [
      item('root', { title: 'Root' }),
      item('mid', { title: 'Mid', parentId: 'root', depth: 2, labelIds: ['lbl-a'] }),
      item('leaf', { title: 'Leaf', parentId: 'mid', depth: 3, labelIds: ['lbl-a'] }),
      item('other', { title: 'Other', labelIds: ['lbl-b'] }),
    ]
    const result = filterWorkItemTree(
      tagged, { ...EMPTY_TREE_FILTER, labelIds: ['lbl-a'] }, tagCtx,
    )
    // root 是 mid 的祖先，必须留下；other 不命中也不需要留下
    expect(result.map((i) => i.id)).toEqual(['root', 'mid', 'leaf'])
  })

  it('★ P3：多标签是 AND 语义（须同时具备，不是 OR）', () => {
    const tagged = [
      item('both', { labelIds: ['a', 'b'] }),
      item('only-a', { labelIds: ['a'] }),
    ]
    const result = filterWorkItemTree(
      tagged, { ...EMPTY_TREE_FILTER, labelIds: ['a', 'b'] }, tagCtx,
    )
    expect(result.map((i) => i.id)).toEqual(['both'])
  })

  it('★ P3：标签与 query / status 是同一套 AND 叠加', () => {
    const tagged = [
      item('hit', { title: 'Ship it', labelIds: ['a'] }),
      item('wrong-title', { title: 'Other', labelIds: ['a'] }),
      item('no-label', { title: 'Ship it' }),
    ]
    const result = filterWorkItemTree(
      tagged, { ...EMPTY_TREE_FILTER, query: 'ship', labelIds: ['a'] }, tagCtx,
    )
    expect(result.map((i) => i.id)).toEqual(['hit'])
  })

  it('★ P3：标签无命中时返回空数组（不留孤儿祖先）', () => {
    const tagged = [
      item('root', { title: 'Root' }),
      item('mid', { parentId: 'root', depth: 2, labelIds: ['a'] }),
    ]
    expect(
      filterWorkItemTree(tagged, { ...EMPTY_TREE_FILTER, labelIds: ['zzz'] }, tagCtx),
    ).toEqual([])
  })

  it('★ P3：labelIds 为空数组时不做任何过滤（默认路径不受影响）', () => {
    const tagged = [item('a', { labelIds: ['x'] }), item('b', {})]
    expect(
      filterWorkItemTree(tagged, { ...EMPTY_TREE_FILTER, labelIds: [] }, tagCtx).map((i) => i.id),
    ).toEqual(['a', 'b'])
  })

  it('keeps the full ancestor chain of a deep match', () => {
    const result = filterWorkItemTree(
      items,
      { ...EMPTY_TREE_FILTER, query: 'ship' },
      context,
    )
    expect(result.map((entry) => entry.id)).toEqual(['root', 'parent', 'leaf'])
  })

  it('matches on displayKey as well as title, case-insensitively', () => {
    expect(
      filterWorkItemTree(items, { ...EMPTY_TREE_FILTER, query: 'rm-leaf' }, context)
        .map((entry) => entry.id),
    ).toEqual(['root', 'parent', 'leaf'])
  })

  it('status=open hides completed items and status=completed keeps only them', () => {
    const open = filterWorkItemTree(
      items, { ...EMPTY_TREE_FILTER, status: 'open' }, context,
    ).map((entry) => entry.id)
    expect(open).not.toContain('done')

    const completed = filterWorkItemTree(
      items, { ...EMPTY_TREE_FILTER, status: 'completed' }, context,
    ).map((entry) => entry.id)
    expect(completed).toEqual(['done'])
  })

  it('blockedOnly keeps only blocked nodes plus their ancestors', () => {
    expect(
      filterWorkItemTree(items, { ...EMPTY_TREE_FILTER, blockedOnly: true }, context)
        .map((entry) => entry.id),
    ).toEqual(['root', 'parent'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(
      filterWorkItemTree(items, { ...EMPTY_TREE_FILTER, query: 'nope' }, context),
    ).toEqual([])
  })
})

describe('countOpenChildren', () => {
  it('counts only unfinished direct children per parent', () => {
    const tree = [
      ...items,
      item('leaf2', { title: 'Cancelled child', parentId: 'parent', depth: 3 }),
      item('leaf3', { title: 'Another open child', parentId: 'parent', depth: 3 }),
    ]
    const categories = {
      ...context.categoryById,
      leaf2: 'cancelled',
      leaf3: 'in_progress',
    }
    // leaf 与 leaf3 未完成计入；已取消的 leaf2 不计入。
    expect(countOpenChildren(tree, categories)).toEqual({ root: 1, parent: 2 })
  })

  it('ignores root-level items', () => {
    expect(countOpenChildren(items, context.categoryById)).toEqual({ root: 1, parent: 1 })
  })
})
