import { describe, expect, it, vi } from 'vitest'
import { MarkerType } from '@xyflow/react'

import { buildDependencyGraph } from '@/lib/task-space/dependency-graph'
import type { CachedRelation } from '@/lib/contracts/task-space'
import { toCanvasGraph } from './graph-adapter'

const edge = (fromWorkItemId: string, toWorkItemId: string): CachedRelation => ({
  id: `rel_${fromWorkItemId}_${toWorkItemId}`,
  fromWorkItemId,
  toWorkItemId,
  relationType: 'depends_on',
  // ★ D2 / ADR-0004：确认两列。
  resolution: null,
  resolvedAt: null,
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

function toCanvas(
  relations: CachedRelation[],
  onRemoveEdge?: (input: { from: string; to: string }) => void,
) {
  const names: Record<string, { displayKey: string; title: string }> = {
    me: { displayKey: '2.1', title: '焦点' },
    up1: { displayKey: '2', title: '上游' },
    up2: { displayKey: '1', title: '上游的上游' },
    down1: { displayKey: '2.1.1', title: '下游' },
    down2: { displayKey: '2.1.2', title: '下游二' },
  }
  const graph = buildDependencyGraph({
    focusId: 'me',
    relations,
    categoryById: {},
    resolve: (id) => names[id],
  })
  return toCanvasGraph(graph, 'me', null, { onRemoveEdge })
}

describe('toCanvasGraph 连线锚点数据', () => {
  it('边携带四个候选侧的锚点比例与类型 dependency', () => {
    const { edges } = toCanvas([edge('me', 'up1'), edge('down1', 'me')])
    for (const edge of edges) {
      expect(edge.type).toBe('dependency')
      // 选侧在边组件按实时几何做；适配层只提供每个候选侧的分布比例。
      for (const side of ['left', 'right', 'top', 'bottom']) {
        expect(edge.data?.sourceFractions?.[side]).toBeGreaterThan(0)
        expect(edge.data?.targetFractions?.[side]).toBeGreaterThan(0)
        expect(edge.data?.sourceFractions?.[side]).toBeLessThan(1)
      }
    }
  })

  it('同一节点同一侧的多条边获得互异且有序的锚点比例', () => {
    // me 的两条出边对端都在左侧（上游列）→ me:left 组内按对端 y 排序均分。
    const { edges } = toCanvas([edge('me', 'up1'), edge('me', 'up2')])
    const fractions = edges
      .filter((edge) => edge.source === 'me')
      .map((edge) => edge.data?.sourceFractions?.left ?? 0)
      .sort((left, right) => left - right)
    expect(fractions).toHaveLength(2)
    expect(fractions[1] - fractions[0]).toBeGreaterThan(0)
  })

  it('每条边都有方向箭头 —— 环边为红色', () => {
    // 回归：改造路由时边对象丢了 markerEnd，BaseEdge 不画箭头，
    // 依赖方向（被阻塞方 → 上游阻塞方）完全不可读。
    const single = toCanvas([edge('me', 'up1')])
    expect(single.edges[0]?.markerEnd)
      .toMatchObject({ type: MarkerType.ArrowClosed, color: '#94a3b8' })

    // 环内所有边（含 me→up1）都属同一强连通分量 → 全部红色。
    const cycle = toCanvas([edge('me', 'up1'), edge('up1', 'me')])
    for (const edge of cycle.edges) {
      expect(edge.markerEnd).toMatchObject({ type: MarkerType.ArrowClosed, color: '#dc2626' })
    }
  })

  it('环边红虚线、普通边灰实线 —— 图例与实现一致', () => {
    // 回归：重写 React Flow 边时 style 随 markerEnd 一起丢失，
    // 图例宣称「红色虚线 = 依赖环」但实现是默认灰实线。
    const single = toCanvas([edge('me', 'up1')])
    expect(single.edges[0]?.style).toMatchObject({ stroke: '#94a3b8' })

    const cycle = toCanvas([edge('me', 'up1'), edge('up1', 'me')])
    for (const edge of cycle.edges) {
      expect(edge.style).toMatchObject({ stroke: '#dc2626', strokeDasharray: '6 4' })
    }
  })

  it('broken 边橙色短虚线（上游已取消未确认）—— 只读标注', () => {
    // ★ D2 / ADR-0004：broken 只影响样式与角标；画布不加任何写动作。
    const graph = buildDependencyGraph({
      focusId: 'me',
      relations: [edge('me', 'up1')],
      categoryById: { up1: 'cancelled' },
      resolve: (id) => ({ displayKey: id, title: id }),
    })
    const canvas = toCanvasGraph(graph, 'me', null, {})
    const broken = canvas.edges[0]
    expect(broken?.data?.broken).toBe(true)
    expect(broken?.style).toMatchObject({ stroke: '#d97706', strokeDasharray: '2 3' })
    expect(broken?.markerEnd).toMatchObject({ type: MarkerType.ArrowClosed, color: '#d97706' })

    // 已确认的取消上游：不 broken、样式回到常规灰。
    const confirmedGraph = buildDependencyGraph({
      focusId: 'me',
      relations: [
        {
          ...edge('me', 'up1'),
          resolution: 'confirmed_not_required',
          resolvedAt: '2026-07-15T09:00:00.000Z',
        },
      ],
      categoryById: { up1: 'cancelled' },
      resolve: (id) => ({ displayKey: id, title: id }),
    })
    const confirmed = toCanvasGraph(confirmedGraph, 'me', null, {})
    expect(confirmed.edges[0]?.data?.broken).toBe(false)
    expect(confirmed.edges[0]?.style).toMatchObject({ stroke: '#94a3b8' })
  })

  it('重复关系与自环不会产生重复边 id', () => {
    // 同一对端点可挂两条阻塞边（depends_on + blocks）；自环在服务端被
    // 环检测拒绝，但同步脏数据不可信。React Flow 对重复 id 行为未定义。
    const duplicated = toCanvas([
      edge('me', 'up1'),
      { ...edge('me', 'up1'), id: 'rel_duplicate_blocks', relationType: 'blocks' },
    ])
    expect(duplicated.edges).toHaveLength(1)

    const selfLoop = toCanvas([{ ...edge('me', 'me'), id: 'rel_self' }])
    expect(selfLoop.edges).toHaveLength(0)
  })

  it('onRemoveEdge 注入边数据 —— 图上 ✕ 的解除链路', () => {
    const spy = vi.fn()
    const { edges } = toCanvas([edge('me', 'up1')], spy)
    expect(edges[0]?.data?.onRemoveEdge).toBeTypeOf('function')
    edges[0]?.data?.onRemoveEdge?.({ from: edges[0]!.source, to: edges[0]!.target })
    expect(spy).toHaveBeenCalledWith({ from: 'me', to: 'up1' })
  })
})
