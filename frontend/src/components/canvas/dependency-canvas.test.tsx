import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeAll } from 'vitest'

// React Flow 依赖浏览器几何 API，jsdom 需要最小桩（官方测试指引同款）。
// ResizeObserver 必须立刻回调一次，节点才能完成测量并真正渲染进 DOM。
class ResizeObserverStub {
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(target: Element): void {
    // XYPanZoom 会读 entry.contentRect.width —— 必须给足几何信息。
    this.callback([{
      target,
      contentRect: { width: 800, height: 400, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400 },
    } as ResizeObserverEntry], this)
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  ;(window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22 = 1
  }
  window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, toJSON: () => ({}) } as DOMRect
  }
})

import { DependencyCanvas } from './dependency-canvas'
import { buildDependencyGraph } from '@/lib/task-space/dependency-graph'
import type { CachedRelation } from '@/lib/contracts/task-space'

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

const names: Record<string, { displayKey: string; title: string }> = {
  me: { displayKey: '2.1', title: '焦点任务' },
  up1: { displayKey: '2', title: '上游任务' },
  down1: { displayKey: '2.1.1', title: '下游子项' },
}

function build() {
  return buildDependencyGraph({
    focusId: 'me',
    relations: [edge('me', 'up1'), edge('down1', 'me')],
    categoryById: {},
    resolve: (id) => names[id],
  })
}

function renderCanvas(overrides: Record<string, unknown> = {}) {
  return render(createElement(DependencyCanvas, {
    graph: build(),
    focusId: 'me',
    onSelectNode: vi.fn(),
    ...overrides,
  }))
}

describe('DependencyCanvas', () => {
  it('renders the free canvas with minimap and every node code', () => {
    renderCanvas()
    expect(document.querySelector('[data-dependency-canvas]')).not.toBeNull()
    // me 有未完成上游（孤儿边按阻塞算）→ 锁前缀；up1 无上游 → 裸编码。
    expect(screen.getByText('🔒 2.1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('🔒 2.1.1')).toBeInTheDocument()
    // 全局视图（MiniMap）与视口控件是自由画布的标配。
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull()
    expect(document.querySelector('.react-flow__controls')).not.toBeNull()
  })

  it('marks the focus node and propagates clicks on other nodes', () => {
    const onSelectNode = vi.fn()
    renderCanvas({ onSelectNode })

    const focusNode = document.querySelector('[data-id="me"]')
    expect(focusNode).not.toBeNull()
    expect(focusNode?.textContent).toContain('焦点任务')

    fireEvent.click(screen.getByText('上游任务'))
    expect(onSelectNode).toHaveBeenCalledWith('up1')
  })

  // ✕ 解除依赖的交互在 dependency-edge.test.tsx 里覆盖 —— React Flow 的
  // 边层依赖完整节点测量管线，jsdom 中整条链路无法闭合，画布级测不到。

  it('节点宽度锁定为布局常量 —— 长标题不会撑爆布局网格', () => {
    // 布局 / 锚点 / 避障全按 GRAPH_NODE_WIDTH=150 计算；节点若随内容
    // 变宽，自动布局下相邻列节点会重叠。
    renderCanvas()
    const node = document.querySelector<HTMLElement>('[data-dependency-node]')
    expect(node).not.toBeNull()
    expect(node?.style.width).toBe('150px')
  })
})
