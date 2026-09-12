import { describe, expect, it } from 'vitest'
import type { CachedRelation } from '@/lib/contracts/task-space'

import { evaluateSessionLaunch } from './session-launch-guard'

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
  // ★ D2 / ADR-0004：确认两列。
  resolution,
  resolvedAt: resolution === null ? null : '2026-07-15T09:00:00.000Z',
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

const items = [
  { id: 'root', depth: 1 },
  { id: 'l2', depth: 2 },
  { id: 'l3', depth: 3 },
]

const run = (
  input: Partial<Parameters<typeof evaluateSessionLaunch>[0]> & { level2WorkItemId: string },
) => evaluateSessionLaunch({
  workItems: items,
  relations: [],
  statusCategoryById: {},
  ...input,
})

describe('evaluateSessionLaunch', () => {
  it('allows a level-2 item with no blocking upstream', () => {
    expect(run({ level2WorkItemId: 'l2' })).toEqual({ status: 'allowed', openBlockerIds: [] })
  })

  it('blocks a level-2 item while any upstream is open, reporting the ids', () => {
    const decision = run({
      level2WorkItemId: 'l2',
      relations: [edge('l2', 'up1'), edge('l2', 'up2')],
      statusCategoryById: { up1: 'completed', up2: 'in_progress' },
    })
    expect(decision).toEqual({ status: 'blocked', openBlockerIds: ['up2'] })
  })

  it('allows once every upstream is satisfied（completed；cancelled 需确认）', () => {
    expect(run({
      level2WorkItemId: 'l2',
      relations: [edge('l2', 'up1'), edge('l2', 'up2')],
      statusCategoryById: { up1: 'completed', up2: 'completed' },
    }).status).toBe('allowed')
  })

  it('keeps blocking on a cancelled upstream until it is explicitly confirmed（D2）', () => {
    // ★ D2（ADR-0004）：cancelled 未确认 = broken_requires_resolution → 启动判定
    //   走 BlockerAck 流程（fail-closed），而不是静默放行。
    expect(run({
      level2WorkItemId: 'l2',
      relations: [edge('l2', 'up1'), edge('l2', 'up2')],
      statusCategoryById: { up1: 'completed', up2: 'cancelled' },
    })).toEqual({ status: 'blocked', openBlockerIds: ['up2'] })

    // 确认「不再需要」后才放行。
    expect(run({
      level2WorkItemId: 'l2',
      relations: [edge('l2', 'up1'), edge('l2', 'up2', 'depends_on', 'confirmed_not_required')],
      statusCategoryById: { up1: 'completed', up2: 'cancelled' },
    }).status).toBe('allowed')
  })

  it('never blocks containers (L1) or leaf items (L3)', () => {
    const relations = [edge('root', 'up1'), edge('l3', 'up1')]
    const categories = { up1: 'in_progress' }
    expect(run({ level2WorkItemId: 'root', relations, statusCategoryById: categories }).status)
      .toBe('allowed')
    expect(run({ level2WorkItemId: 'l3', relations, statusCategoryById: categories }).status)
      .toBe('allowed')
  })

  it('treats a not-yet-hydrated upstream as open (fail-closed)', () => {
    expect(run({ level2WorkItemId: 'l2', relations: [edge('l2', 'ghost')] }))
      .toEqual({ status: 'blocked', openBlockerIds: ['ghost'] })
  })

  it('ignores non-blocking relation types', () => {
    expect(run({
      level2WorkItemId: 'l2',
      relations: [edge('l2', 'up1', 'relates_to')],
      statusCategoryById: { up1: 'in_progress' },
    }).status).toBe('allowed')
  })

  it('allows when the item is unknown — depth cannot be asserted', () => {
    // 未水合的 id 无法确认是二级项；判定必须"证明阻塞"，不能靠猜。
    expect(run({
      level2WorkItemId: 'missing',
      relations: [edge('missing', 'up1')],
      statusCategoryById: { up1: 'in_progress' },
    }).status).toBe('allowed')
  })
})
