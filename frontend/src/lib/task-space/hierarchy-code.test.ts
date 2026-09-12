import { describe, expect, it } from 'vitest'

import { buildHierarchyCodes } from './hierarchy-code'

const item = (id: string, parentId: string | null, childRank = 0) => ({ id, parentId, childRank })

describe('buildHierarchyCodes', () => {
  it('numbers siblings by childRank at every level', () => {
    const codes = buildHierarchyCodes([
      item('a', null, 0),
      item('b', null, 1),
      item('a2', 'a', 1),
      item('a1', 'a', 0),
      // childRank 有空洞（删除后遗留）也不产生编码空洞：取兄弟序数，1 起。
      item('a1x', 'a1', 2),
    ])
    expect(codes).toEqual({
      a: '1',
      b: '2',
      a1: '1.1',
      a2: '1.2',
      a1x: '1.1.1',
    })
  })

  it('keeps codes consistent when the same rank set is re-sorted by id', () => {
    const codes = buildHierarchyCodes([
      item('z', null, 0),
      item('a', null, 0),
    ])
    expect(codes.a).toBe('1')
    expect(codes.z).toBe('2')
  })

  it('treats an orphan as a root instead of dropping the branch', () => {
    const codes = buildHierarchyCodes([item('lost', 'missing-parent', 3)])
    expect(codes.lost).toBe('1')
  })

  it('renumbers a whole subtree after the parent moves (this is the point)', () => {
    const before = buildHierarchyCodes([
      item('r1', null, 0),
      item('r2', null, 1),
      item('child', 'r2', 0),
    ])
    expect(before.child).toBe('2.1')

    // 子树移到 r1 下：编码跟随新位置。
    const after = buildHierarchyCodes([
      item('r1', null, 0),
      item('r2', null, 1),
      item('child', 'r1', 0),
    ])
    expect(after.child).toBe('1.1')
  })

  it('returns an empty map for an empty set', () => {
    expect(buildHierarchyCodes([])).toEqual({})
  })
})
