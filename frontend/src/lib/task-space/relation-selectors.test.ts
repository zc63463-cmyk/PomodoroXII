import { describe, expect, it } from 'vitest'
import type { CachedRelation } from '@/lib/contracts/task-space'
import {
  computeIsBlocked,
  countOpenBlockers,
  deriveBlockedByDependency,
  deriveBlockedSignals,
  deriveRelationEdgeState,
  selectOpenBlockers,
  selectRelationCandidates,
  selectWaitingResumeSuggestion,
} from './relation-selectors'
import { relationId } from './relation-id'

const edge = (
  fromWorkItemId: string,
  toWorkItemId: string,
  relationType: CachedRelation['relationType'] = 'depends_on',
  resolution: CachedRelation['resolution'] = null,
): CachedRelation => ({
  id: `rel_${fromWorkItemId}_${toWorkItemId}_${relationType}`,
  fromWorkItemId,
  toWorkItemId,
  relationType,
  // ★ D2 / ADR-0004：确认两列（默认未确认；用例可传 confirmed_not_required）。
  resolution,
  resolvedAt: resolution === null ? null : '2026-07-15T09:00:00.000Z',
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

describe('deriveRelationEdgeState（D2 真值表矩阵，与后端 queries.py 逐条对齐）', () => {
  it('covers completed / cancelled / cancelled+confirmed / orphan × blocking types', () => {
    for (const relationType of ['depends_on', 'blocks'] as const) {
      const row = (resolution: CachedRelation['resolution'] = null) =>
        edge('d', 'u', relationType, resolution)
      expect(deriveRelationEdgeState(row(), 'completed')).toBe('satisfied')
      // ★ 病灶行：cancelled 未确认 → broken（仍阻塞）。
      expect(deriveRelationEdgeState(row(), 'cancelled')).toBe('broken_requires_resolution')
      // 确认后 → satisfied。
      expect(deriveRelationEdgeState(row('confirmed_not_required'), 'cancelled')).toBe('satisfied')
      // 活动类目与孤儿边 → open。
      for (const category of ['not_started', 'in_progress', 'paused', 'waiting'] as const) {
        expect(deriveRelationEdgeState(row(), category)).toBe('open')
      }
      expect(deriveRelationEdgeState(row(), undefined)).toBe('open')
      // 孤儿边 + 确认：无证据的确认不能视为 satisfied（合同：不可把未知端点当 satisfied）。
      expect(deriveRelationEdgeState(row('confirmed_not_required'), undefined)).toBe('open')
    }
  })

  it('relates_to is outside the truth table', () => {
    expect(deriveBlockedByDependency([edge('c', 'a', 'relates_to')], { a: 'cancelled' })).toEqual({})
  })
})

describe('deriveBlockedByDependency', () => {
  it('blocks while any upstream is open (AND semantics)', () => {
    const relations = [edge('c', 'a'), edge('c', 'b')]
    expect(deriveBlockedByDependency(relations, { a: 'in_progress', b: 'not_started' })).toEqual({ c: true })
    // The classic regression: closing ONE of two upstreams must not unblock.
    expect(deriveBlockedByDependency(relations, { a: 'completed', b: 'in_progress' })).toEqual({ c: true })
    // ★ D2（ADR-0004）：cancelled 未确认 → broken_requires_resolution，仍阻塞。
    expect(deriveBlockedByDependency(relations, { a: 'completed', b: 'cancelled' })).toEqual({ c: true })
    // 确认「不再需要」后才解除（只影响被确认的那条边）。
    const confirmed = [edge('c', 'a'), edge('c', 'b', 'depends_on', 'confirmed_not_required')]
    expect(deriveBlockedByDependency(confirmed, { a: 'completed', b: 'cancelled' })).toEqual({})
    // 未确认的另一条边仍阻塞。
    expect(deriveBlockedByDependency(confirmed, { a: 'cancelled', b: 'cancelled' })).toEqual({ c: true })
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

describe('selectOpenBlockers', () => {
  it('lists open upstream ids, deduplicated by upstream', () => {
    // 同一对端点挂两条阻塞边（depends_on + blocks）→ 只算一个上游。
    const relations = [edge('c', 'a'), edge('c', 'a', 'blocks'), edge('c', 'b')]
    expect(selectOpenBlockers(relations, 'c', { a: 'in_progress', b: 'completed' }))
      .toEqual(['a'])
  })

  it('never lists terminal upstreams or non-blocking relation types', () => {
    const relations = [
      edge('c', 'a'),
      edge('c', 'b', 'relates_to'),
    ]
    expect(selectOpenBlockers(relations, 'c', { a: 'completed' })).toEqual([])
    expect(selectOpenBlockers([edge('c', 'b', 'relates_to')], 'c', { b: 'in_progress' })).toEqual([])
  })

  it('treats a not-yet-hydrated upstream as open', () => {
    expect(selectOpenBlockers([edge('c', 'ghost')], 'c', {})).toEqual(['ghost'])
  })
})

describe('selectWaitingResumeSuggestion', () => {
  const base = {
    workItemId: 'l2',
    depth: 2,
    statusCategory: 'waiting',
    statusCategoryById: {} as Record<string, string | undefined>,
  }

  it('suggests a resume only when every upstream is completed', () => {
    const relations = [edge('l2', 'up1'), edge('l2', 'up2')]
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations,
      statusCategoryById: { up1: 'completed', up2: 'completed' },
    })).toEqual({ upstreamCount: 2 })
  })

  it('stays silent while any upstream is still open', () => {
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations: [edge('l2', 'up1'), edge('l2', 'up2')],
      statusCategoryById: { up1: 'completed', up2: 'in_progress' },
    })).toBeNull()
  })

  it('stays silent on a cancelled upstream without confirmation（回归锁定）', () => {
    // 现状已严格（cancelled 属 broken_requires_resolution 不算解除）——
    // D2 不得改坏它：未确认的取消上游 → 不提示。
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations: [edge('l2', 'up1')],
      statusCategoryById: { up1: 'cancelled' },
    })).toBeNull()
  })

  it('suggests once the cancelled upstream is confirmed not required（D2 新行为）', () => {
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations: [edge('l2', 'up1', 'depends_on', 'confirmed_not_required')],
      statusCategoryById: { up1: 'cancelled' },
    })).toEqual({ upstreamCount: 1 })
  })

  it('同一上游挂两条阻塞边时，每条都必须 satisfied', () => {
    // depends_on 已确认、blocks 未确认 → 仍有未 satisfied 的边 → 不提示。
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations: [
        edge('l2', 'up1', 'depends_on', 'confirmed_not_required'),
        edge('l2', 'up1', 'blocks'),
      ],
      statusCategoryById: { up1: 'cancelled' },
    })).toBeNull()
    // 两条都确认 → 提示（上游去重后只算 1 个）。
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations: [
        edge('l2', 'up1', 'depends_on', 'confirmed_not_required'),
        edge('l2', 'up1', 'blocks', 'confirmed_not_required'),
      ],
      statusCategoryById: { up1: 'cancelled' },
    })).toEqual({ upstreamCount: 1 })
  })

  it('孤儿上游保持不提示（无证据的确认不能解除）', () => {
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations: [edge('l2', 'ghost')],
      statusCategoryById: {},
    })).toBeNull()
  })

  it('requires an actual waiting item with blocking upstreams', () => {
    // 非 waiting 状态不提示。
    expect(selectWaitingResumeSuggestion({
      ...base,
      statusCategory: 'in_progress',
      relations: [edge('l2', 'up1')],
      statusCategoryById: { up1: 'completed' },
    })).toBeNull()
    // 从未挂过阻塞依赖的 waiting 不是「因依赖进入」——没有可恢复的对象。
    expect(selectWaitingResumeSuggestion({
      ...base,
      relations: [edge('l2', 'up1', 'relates_to')],
      statusCategoryById: { up1: 'completed' },
    })).toBeNull()
    // 只对二级项判定（与 isBlocked 的层级口径一致）。
    expect(selectWaitingResumeSuggestion({
      ...base,
      depth: 3,
      relations: [edge('l2', 'up1')],
      statusCategoryById: { up1: 'completed' },
    })).toBeNull()
  })
})

describe('selectRelationCandidates', () => {
  const items = [
    { id: 'root', parentId: null, archivedAt: null, projectId: 'p1' },
    { id: 'l2', parentId: 'root', archivedAt: null, projectId: 'p1' },
    { id: 'l3', parentId: 'l2', archivedAt: null, projectId: 'p1' },
    { id: 'other', parentId: 'root', archivedAt: null, projectId: 'p1' },
    { id: 'gone', parentId: 'root', archivedAt: '2026-08-01T00:00:00.000Z', projectId: 'p1' },
    { id: 'foreign', parentId: null, archivedAt: null, projectId: 'p2' },
  ]

  it('excludes self, descendants, archived items, and existing edges', () => {
    const candidates = selectRelationCandidates(items, 'l2', [edge('l2', 'other')], { projectId: 'p1' })
    expect(candidates).toEqual(['root'])
  })

  it('returns nothing without a source', () => {
    expect(selectRelationCandidates(items, null, [])).toEqual([])
  })

  it('scopes candidates to the source project by default', () => {
    const candidates = selectRelationCandidates(items, 'l2', [], { projectId: 'p1' })
    expect(candidates).toContain('root')
    expect(candidates).not.toContain('foreign')
  })

  it('admits cross-project candidates only when explicitly requested', () => {
    const candidates = selectRelationCandidates(items, 'l2', [], {
      projectId: 'p1',
      includeCrossProject: true,
    })
    expect(candidates).toContain('root')
    expect(candidates).toContain('foreign')
  })

  it('stays unscoped when no project is given (historical behaviour)', () => {
    const candidates = selectRelationCandidates(items, 'l2', [])
    expect(candidates).toContain('foreign')
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
