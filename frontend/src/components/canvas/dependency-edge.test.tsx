import { createElement, type ReactNode } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useInternalNode } from '@xyflow/react'

import { DependencyEdge } from './dependency-edge'
import type { DependencyEdgeData } from '@/lib/canvas/graph-adapter'

// ★ 为什么 mock useInternalNode 而不是整张 React Flow 画布：
//   React Flow 的边层依赖完整的节点测量管线（ResizeObserver 回调 →
//   尺寸入 store → 边才渲染），jsdom 里整条链路无法闭合 —— 画布级测试
//   证明过边层根本不出现。边组件只读 internals.positionAbsolute 与
//   measured 两个槽位，mock 掉之后即可确定性测试选侧、避障与交互。
// EdgeLabelRenderer 内部同样读 flow store，这里替换为直通渲染
//（它只负责 portal，inline 渲染不影响被测逻辑）。
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInternalNode: vi.fn(),
  EdgeLabelRenderer: (props: { children?: ReactNode }) => props.children ?? null,
}))

const useInternalNodeMock = vi.mocked(useInternalNode)

const flowNode = (id: string, x: number, y: number) => ({
  id,
  internals: { positionAbsolute: { x, y } },
  measured: { width: 150, height: 42 },
})

describe('DependencyEdge', () => {
  const onRemoveEdge = vi.fn()
  const data: DependencyEdgeData = {
    cyclic: false,
    // ★ D2 / ADR-0004：broken 边数据位（本用例为常规边）。
    broken: false,
    sourceFractions: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 },
    targetFractions: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 },
    onRemoveEdge,
  }
  // me（被阻塞方）在右，up1（上游）在左 → 水平路由：me:right → up1:left。
  // 锚点：me 右缘 (450, 21)，up1 左缘 (150, 21)，主干中线 y=21。
  beforeEach(() => {
    onRemoveEdge.mockReset()
    useInternalNodeMock.mockImplementation(((id?: string) => {
      if (id === 'me') return flowNode('me', 300, 0)
      if (id === 'up1') return flowNode('up1', 0, 0)
      return undefined
    }) as never)
  })

  const renderEdge = (overrides: Record<string, unknown> = {}) => render(
    createElement(DependencyEdge, {
      id: 'me->up1',
      source: 'me',
      target: 'up1',
      data,
      ...overrides,
    } as never),
  )

  it('✕ 调用 onRemoveEdge 并携带依赖方向（from=被阻塞方，to=上游）', () => {
    const { container } = renderEdge()
    const button = container.querySelector('[data-remove-relation-edge]')
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    expect(onRemoveEdge).toHaveBeenCalledWith({ from: 'me', to: 'up1' })
  })

  it('主干被障碍挡住时通道平移（✕ 随通道上移），无障碍时走中线', () => {
    const plain = renderEdge()
    expect(plain.container.querySelector<HTMLElement>('[data-remove-relation-edge]')?.style.top)
      .toBe('21px')

    // 障碍 y 10..30 跨越中线 21 → 通道挪到障碍下缘 +12 = 42（离中线更近的一侧）。
    const detoured = renderEdge({
      data: {
        ...data,
        obstaclesFor: () => [{ x: 200, y: 10, width: 100, height: 20 }],
      },
    })
    expect(detoured.container.querySelector<HTMLElement>('[data-remove-relation-edge]')?.style.top)
      .toBe('42px')
  })

  it('环边样式透传给 BaseEdge（红虚线），没有 onRemoveEdge 时不渲染 ✕', () => {
    const { container } = renderEdge({
      style: { stroke: '#dc2626', strokeDasharray: '6 4' },
      data: { ...data, onRemoveEdge: undefined },
    })
    const path = container.querySelector('path')
    expect(path).not.toBeNull()
    // jsdom 会把 style 序列化成 rgb() 形式。
    expect(path?.getAttribute('style')).toContain('rgb(220, 38, 38)')
    expect(path?.getAttribute('style')).toContain('stroke-dasharray: 6 4')
    expect(container.querySelector('[data-remove-relation-edge]')).toBeNull()
  })

  it('broken 边渲染只读「需解决」角标（画布零写动作）', () => {
    const plain = renderEdge()
    expect(plain.container.querySelector('[data-broken-edge-badge]')).toBeNull()

    const broken = renderEdge({ data: { ...data, broken: true, onRemoveEdge: undefined } })
    const badge = broken.container.querySelector('[data-broken-edge-badge]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe('需解决')
    // 只读标注：不是按钮，不承载任何确认/解除动作。
    expect(badge?.tagName.toLowerCase()).toBe('span')
    expect(broken.container.querySelector('[data-remove-relation-edge]')).toBeNull()
  })

  it('端点节点缺失时不渲染（防御）', () => {
    useInternalNodeMock.mockImplementation((() => undefined) as never)
    const { container } = renderEdge()
    expect(container.querySelector('path')).toBeNull()
  })
})
