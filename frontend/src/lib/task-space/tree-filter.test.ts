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
    expect(isTreeFilterActive({ ...EMPTY_TREE_FILTER, status: 'open' })).toBe(true)
    expect(isTreeFilterActive({ ...EMPTY_TREE_FILTER, blockedOnly: true })).toBe(true)
  })
})

describe('filterWorkItemTree', () => {
  it('returns the input untouched when the filter is inactive', () => {
    expect(filterWorkItemTree(items, EMPTY_TREE_FILTER, context)).toEqual(items)
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
