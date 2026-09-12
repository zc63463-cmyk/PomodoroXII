import { describe, expect, it } from 'vitest'
import type { CachedRelation } from '@/lib/contracts/task-space'

import {
  buildDependencyGraph,
  layoutDependencyGraph,
} from './dependency-graph'

const edge = (
  fromWorkItemId: string,
  toWorkItemId: string,
  relationType: CachedRelation['relationType'] = 'depends_on',
  resolution: CachedRelation['resolution'] = null,
): CachedRelation => ({
  id: `rel_${fromWorkItemId}_${toWorkItemId}`,
  fromWorkItemId,
  toWorkItemId,
  relationType,
  // ★ D2 / ADR-0004：确认两列（默认未确认）。
  resolution,
  resolvedAt: resolution === null ? null : '2026-07-15T09:00:00.000Z',
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

function build(relations: CachedRelation[], categoryById: Record<string, string | undefined> = {}) {
  const names: Record<string, { displayKey: string; title: string }> = {
    me: { displayKey: 'RM-me', title: '焦点任务' },
    up1: { displayKey: 'RM-up1', title: '一级上游' },
    up2: { displayKey: 'RM-up2', title: '二级上游' },
    down1: { displayKey: 'RM-down1', title: '一级下游' },
  }
  return buildDependencyGraph({
    focusId: 'me',
    relations,
    categoryById,
    resolve: (id) => names[id],
  })
}

describe('buildDependencyGraph', () => {
  it('places upstream on the left, focus in the middle, downstream on the right', () => {
    const graph = build([edge('me', 'up1'), edge('down1', 'me')])
    const byId = Object.fromEntries(graph.nodes.map((node) => [node.id, node]))

    expect(byId.me).toMatchObject({ side: 'focus', column: 0 })
    expect(byId.up1).toMatchObject({ side: 'upstream', column: -1 })
    expect(byId.down1).toMatchObject({ side: 'downstream', column: 1 })
    expect(graph.edges).toHaveLength(2)
    expect(graph.truncated).toBe(false)
  })

  it('follows blocking edges transitively through the upstream chain', () => {
    const graph = build([edge('me', 'up1'), edge('up1', 'up2')])
    const byId = Object.fromEntries(graph.nodes.map((node) => [node.id, node]))
    expect(byId.up2).toMatchObject({ side: 'upstream', column: -2 })
  })

  it('marks nodes with an open upstream as blocked, tolerant of orphan edges', () => {
    const open = build([edge('me', 'up1')])
    expect(open.nodes.find((node) => node.id === 'me')?.blocked).toBe(true)

    const completed = build([edge('me', 'up1')], { up1: 'completed' })
    expect(completed.nodes.find((node) => node.id === 'me')?.blocked).toBe(false)

    // 孤儿边：上游尚未到达本地缓存 —— 按阻塞算，绝不能静默放行。
    const orphan = build([edge('me', 'ghost')])
    expect(orphan.nodes.find((node) => node.id === 'me')?.blocked).toBe(true)
  })

  it('keeps a cancelled-unconfirmed upstream blocking and flags the edge broken（D2）', () => {
    // ★ D2（ADR-0004）：terminal 上游不再包含"未确认的 cancelled"。
    const unconfirmed = build([edge('me', 'up1')], { up1: 'cancelled' })
    expect(unconfirmed.nodes.find((node) => node.id === 'me')?.blocked).toBe(true)
    expect(
      unconfirmed.edges.find((entry) => entry.from === 'me' && entry.to === 'up1')?.broken,
    ).toBe(true)

    // 确认「不再需要」后：不再阻塞、不再 broken（保留边）。
    const confirmed = build(
      [edge('me', 'up1', 'depends_on', 'confirmed_not_required')],
      { up1: 'cancelled' },
    )
    expect(confirmed.nodes.find((node) => node.id === 'me')?.blocked).toBe(false)
    expect(
      confirmed.edges.find((entry) => entry.from === 'me' && entry.to === 'up1')?.broken,
    ).toBe(false)
  })

  it('flags every node and edge on a dependency cycle — including the focus node', () => {
    const graph = build([edge('me', 'up1'), edge('up1', 'me')])
    const byId = Object.fromEntries(graph.nodes.map((node) => [node.id, node]))
    expect(byId.me.cyclic).toBe(true)
    expect(byId.up1.cyclic).toBe(true)
    expect(graph.edges.every((entry) => entry.cyclic)).toBe(true)
  })

  it('ignores non-blocking relation types', () => {
    const graph = build([edge('me', 'up1', 'relates_to')])
    expect(graph.nodes.map((node) => node.id)).toEqual(['me'])
    expect(graph.edges).toHaveLength(0)
  })
})

describe('layoutDependencyGraph', () => {
  it('orders columns left to right by graph column', () => {
    const graph = build([edge('me', 'up1'), edge('up1', 'up2'), edge('down1', 'me')])
    const layout = layoutDependencyGraph(graph)

    expect(layout.positions.up2.column).toBe(-2)
    expect(layout.positions.up1.column).toBe(-1)
    expect(layout.positions.me.column).toBe(0)
    expect(layout.positions.down1.column).toBe(1)
    expect(layout.positions.up2.x).toBeLessThan(layout.positions.up1.x)
    expect(layout.positions.up1.x).toBeLessThan(layout.positions.me.x)
    expect(layout.positions.me.x).toBeLessThan(layout.positions.down1.x)
  })

  it('keeps nodes in the same column from overlapping and centres sparse columns', () => {
    const graph = build([
      edge('me', 'up1'),
      edge('me', 'up2'),
      edge('down1', 'me'),
    ])
    const layout = layoutDependencyGraph(graph)

    expect(layout.positions.up1.y).not.toBe(layout.positions.up2.y)
    // 稀疏列相对中轴垂直居中：单节点列与 focus 同一水平线。
    expect(layout.positions.down1.y).toBeCloseTo(layout.positions.me.y)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('fans out anchors so multiple edges at one node never share a point', () => {
    // 首版最被诟病的渲染缺陷：所有连线都从节点中点出发，纠缠成一束。
    const graph = build([
      edge('me', 'up1'),
      edge('me', 'up2'),
      edge('down1', 'me'),
    ])
    const layout = layoutDependencyGraph(graph)
    const toUp1 = layout.anchors['me->up1']
    const toUp2 = layout.anchors['me->up2']
    const me = layout.positions.me

    expect(toUp1.y1).not.toBe(toUp2.y1)
    // 两条出边锚点都落在 me 的左缘范围内，不飘出节点框。
    for (const y of [toUp1.y1, toUp2.y1]) {
      expect(y).toBeGreaterThanOrEqual(me.y)
      expect(y).toBeLessThanOrEqual(me.y + 42)
    }
    // 下游边锚在 me 的右缘，与出边分属两侧。
    expect(layout.anchors['down1->me'].x2).toBeGreaterThan(toUp1.x1)
  })
})
