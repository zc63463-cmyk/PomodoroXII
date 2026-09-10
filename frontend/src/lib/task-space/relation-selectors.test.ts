import { describe, expect, it } from 'vitest'
import type { CachedRelation } from '@/lib/contracts/task-space'
import {
  computeIsBlocked,
  countOpenBlockers,
  deriveBlockedByDependency,
  deriveBlockedSignals,
  selectRelationCandidates,
} from './relation-selectors'
import { relationId } from './relation-id'

const edge = (
  fromWorkItemId: string,
  toWorkItemId: string,
  relationType: CachedRelation['relationType'] = 'depends_on',
): CachedRelation => ({
  id: `rel_${fromWorkItemId}_${toWorkItemId}_${relationType}`,
  fromWorkItemId,
  toWorkItemId,
  relationType,
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

describe('deriveBlockedByDependency', () => {
  it('blocks while any upstream is open (AND semantics)', () => {
    const relations = [edge('c', 'a'), edge('c', 'b')]
    expect(deriveBlockedByDependency(relations, { a: 'in_progress', b: 'not_started' })).toEqual({ c: true })
    // The classic regression: closing ONE of two upstreams must not unblock.
    expect(deriveBlockedByDependency(relations, { a: 'completed', b: 'in_progress' })).toEqual({ c: true })
    expect(deriveBlockedByDependency(relations, { a: 'completed', b: 'cancelled' })).toEqual({})
  })

  it('treats a not-yet-hydrated upstream as open (orphan-edge tolerance)', () => {
    expect(deriveBlockedByDependency([edge('c', 'a')], {})).toEqual({ c: true })
  })

  it('ignores non-blocking relation types', () => {
    expect(deriveBlockedByDependency([edge('c', 'a', 'relates_to')], { a: 'in_progress' })).toEqual({})
    expect(deriveBlockedByDependency([edge('c', 'a', 'blocks')], { a: 'in_progress' })).toEqual({ c: true })
  })
})

describe('computeIsBlocked', () => {
  it('is defined only for level-2 items', () => {
    expect(computeIsBlocked(2, true)).toBe(true)
    expect(computeIsBlocked(1, true)).toBe(false)
    expect(computeIsBlocked(3, true)).toBe(false)
    expect(computeIsBlocked(2, false)).toBe(false)
  })
})

describe('deriveBlockedSignals', () => {
  it('combines the dependency signal with the depth rule', () => {
    const result = deriveBlockedSignals(
      [edge('l2', 'up')],
      { up: 'in_progress' },
      { l2: 2 },
    )
    expect(result).toEqual({ l2: { blockedByDependency: true, isBlocked: true } })
  })
})

describe('countOpenBlockers', () => {
  it('counts only still-open upstreams of one item', () => {
    const relations = [edge('c', 'a'), edge('c', 'b'), edge('d', 'a')]
    expect(countOpenBlockers(relations, 'c', { a: 'completed', b: 'in_progress' })).toBe(1)
    expect(countOpenBlockers(relations, 'd', { a: 'completed' })).toBe(0)
    // Orphan edge: 'z' has not hydrated -> counted as open.
    expect(countOpenBlockers([edge('c', 'z')], 'c', {})).toBe(1)
  })
})

describe('selectRelationCandidates', () => {
  const items = [
    { id: 'root', parentId: null, archivedAt: null },
    { id: 'l2', parentId: 'root', archivedAt: null },
    { id: 'l3', parentId: 'l2', archivedAt: null },
    { id: 'other', parentId: 'root', archivedAt: null },
    { id: 'gone', parentId: 'root', archivedAt: '2026-08-01T00:00:00.000Z' },
  ]

  it('excludes self, descendants, archived items, and existing edges', () => {
    const candidates = selectRelationCandidates(items, 'l2', [edge('l2', 'other')])
    expect(candidates).toEqual(['root'])
  })

  it('returns nothing without a source', () => {
    expect(selectRelationCandidates(items, null, [])).toEqual([])
  })
})

describe('relationId', () => {
  it('matches the backend derivation byte for byte', async () => {
    // Golden value produced by app.task_space.contracts.relation_id("s1","a","b","depends_on").
    await expect(relationId('s1', 'a', 'b', 'depends_on'))
      .resolves.toBe('rel_2c61ac46bb2d74811301ed31af4947c1')
  })

  it('is stable and direction/type/space sensitive', async () => {
    const base = await relationId('s1', 'a', 'b', 'depends_on')
    await expect(relationId('s1', 'a', 'b', 'depends_on')).resolves.toBe(base)
    await expect(relationId('s1', 'b', 'a', 'depends_on')).resolves.not.toBe(base)
    await expect(relationId('s2', 'a', 'b', 'depends_on')).resolves.not.toBe(base)
    expect(base).toMatch(/^rel_[0-9a-f]{32}$/)
  })
})
