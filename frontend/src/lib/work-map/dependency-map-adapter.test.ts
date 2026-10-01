/**
 * 依赖域上图适配器（dependency-map-adapter）—— ADR-0008 D19-b。
 *
 * 断言锚在**契约可观察量**上：三节点链的树层级与中心结构、自由边端点恒为
 * ``@work_item:<id>`` 实体引用（红线 2）、环形输入的降级容错、读侧统计三映射。
 */
import { describe, expect, it } from 'vitest'

import type { GraphJsonPayload } from '@mindcanvas/kernel'

import { convertDependencyGraphToWorkMap } from './dependency-map-adapter'

/** B（已完成的上游）← A（进行中）← C（未开始）：后端归一后的上游→下游方向。 */
const CHAIN: GraphJsonPayload = {
  version: '1.0.0',
  domain: 'task_space',
  source_hash: 'a'.repeat(64),
  nodes: [
    { id: 'wi-b', label: '上游 B', level: 'L1', kind: 'work_item', metadata: { statusCategory: 'completed' } },
    { id: 'wi-a', label: '下游 A', level: 'L1', kind: 'work_item', metadata: { statusCategory: 'in_progress' } },
    { id: 'wi-c', label: '末端 C', level: 'L2', kind: 'work_item', metadata: { statusCategory: 'not_started' } },
  ],
  edges: [
    { from: 'wi-b', to: 'wi-a', kind: 'blocks', direction: 'fwd', metadata: { declaredAs: 'depends_on' } },
    { from: 'wi-a', to: 'wi-c', kind: 'blocks', direction: 'fwd', metadata: { declaredAs: 'blocks' } },
  ],
  indices: {
    in_degree: { 'wi-b': 0, 'wi-a': 1, 'wi-c': 1 },
    topological_order: ['wi-b', 'wi-a', 'wi-c'],
  },
}

describe('convertDependencyGraphToWorkMap（D19-b 前端适配器）', () => {
  it('★ 三节点依赖链：入度 0 的 B 成为森林中心，树沿因果边生长 B→A→C', () => {
    const result = convertDependencyGraphToWorkMap(CHAIN)

    // 合成根：domain 大写 + 知识拓扑；自由边全部挂在 root.note.edges
    expect(result.root.type).toBe('text')
    expect(result.root.text).toBe('TASK_SPACE 知识拓扑')

    // 森林中心 = 入度 0 的源头母材（B）；树沿 outgoing 边生长
    expect(result.centers).toHaveLength(1)
    const center = result.centers[0].node
    expect(center.type).toBe('entity')
    expect(center.ref).toEqual({ kind: 'work_item', id: 'wi-b' })
    expect(center.children).toHaveLength(1)
    expect(center.children[0].ref?.id).toBe('wi-a')
    expect(center.children[0].children[0].ref?.id).toBe('wi-c')
    // 树层级：B(L0) → A(L1) → C(L2)
    expect(center.children[0].children[0].children).toHaveLength(0)
  })

  it('★ 自由边端点恒为 @work_item:<id> 实体引用（红线 2），rel/direction 保真', () => {
    const result = convertDependencyGraphToWorkMap(CHAIN)
    expect(result.edges).toHaveLength(2)
    for (const edge of result.edges) {
      expect(edge.from).toMatch(/^@work_item:/)
      expect(edge.to).toMatch(/^@work_item:/)
    }
    expect(result.edges[0]).toMatchObject({ from: '@work_item:wi-b', to: '@work_item:wi-a', rel: 'blocks', dir: 'fwd' })
    // root.note.edges 与返回的 edges 同源（导出 .mm.md 时整树携带）
    const noteEdges = (result.root.note as Record<string, unknown>).edges
    expect(noteEdges).toEqual(result.edges)
  })

  it('★ 读侧统计：in_degree / upstream / downstream / 未完成上游 三映射一致', () => {
    const result = convertDependencyGraphToWorkMap(CHAIN)
    expect(Object.fromEntries(result.inDegreeByNodeId)).toEqual({
      'wi-b': 0, 'wi-a': 1, 'wi-c': 1,
    })
    expect(Object.fromEntries([...result.dependencyCounts].map(([id, v]) => [id, v]))).toEqual({
      'wi-b': { upstream: 0, downstream: 1 },
      'wi-a': { upstream: 1, downstream: 1 },
      'wi-c': { upstream: 1, downstream: 0 },
    })
    // B 已完成 → A 的未完成上游 0（映射缺省）；A 进行中 → C 的未完成上游 1
    expect(result.blockedUpstreamByNodeId.get('wi-a') ?? 0).toBe(0)
    expect(result.blockedUpstreamByNodeId.get('wi-c')).toBe(1)
  })

  it('★ indices 缺省时按边结构回算 in_degree（容错）', () => {
    const noIndices: GraphJsonPayload = { ...CHAIN, indices: {} }
    const result = convertDependencyGraphToWorkMap(noIndices)
    expect(result.inDegreeByNodeId.get('wi-a')).toBe(1)
    expect(result.inDegreeByNodeId.get('wi-b')).toBe(0)
  })

  it('★ 环形输入降级容错：不抛、不丢节点、自由边保留（kernel visited 剪枝 + 拓扑兜底）', () => {
    const cyclic: GraphJsonPayload = {
      version: '1.0.0',
      domain: 'task_space',
      source_hash: 'b'.repeat(64),
      nodes: [
        { id: 'wi-a', label: 'A', kind: 'work_item', metadata: { isCyclic: true } },
        { id: 'wi-b', label: 'B', kind: 'work_item', metadata: { isCyclic: true } },
      ],
      edges: [
        { from: 'wi-b', to: 'wi-a', kind: 'blocks', direction: 'fwd' },
        { from: 'wi-a', to: 'wi-b', kind: 'blocks', direction: 'fwd' },
      ],
      // 后端 Kahn 带环回退：残留节点按 id 稳定追加（全环时拓扑序仍覆盖全部节点）
      indices: { in_degree: { 'wi-a': 1, 'wi-b': 1 }, topological_order: ['wi-a', 'wi-b'] },
    }
    const result = convertDependencyGraphToWorkMap(cyclic)
    expect(result.root).toBeTruthy()
    // 全环无入度 0 → kernel 按拓扑序首元素兜底为主根，另一节点经边挂入或独立成中心
    const seenIds = new Set<string>()
    for (const center of result.centers) {
      seenIds.add(center.node.ref?.id ?? '')
      for (const child of center.node.children) seenIds.add(child.ref?.id ?? '')
    }
    expect(seenIds.has('wi-a')).toBe(true)
    expect(seenIds.has('wi-b')).toBe(true)
    expect(result.edges).toHaveLength(2)
    for (const edge of result.edges) {
      expect(edge.from).toMatch(/^@work_item:/)
      expect(edge.to).toMatch(/^@work_item:/)
    }
  })
})
