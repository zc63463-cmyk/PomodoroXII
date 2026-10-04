import { createElement, type ReactNode } from 'react'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedWorkItem } from '@/types'

vi.mock('lucide-react', () => ({
  Plus: (props: Record<string, unknown>) => createElement('span', props),
  ChevronRight: (props: Record<string, unknown>) => createElement('span', props),
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))
import { WorkItemTree } from './work-item-tree'

const item = (id: string, title: string, parentId: string | null, depth: 1 | 2 | 3, overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: null,
  parentId,
  childRank: 0,
  depth,
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

const definitions = {
  statuses: [{ id: 'status-open', label: 'Open', category: 'in_progress' }],
  types: [{ id: 'type-task', label: 'Task' }],
  labels: [],
}

describe('WorkItemTree', () => {
  it('renders semantic levels and exposes only a valid next-level create action', () => {
    const createChild = vi.fn()
    render(createElement(WorkItemTree, {
      items: [
        item('l1', 'L1 Alpha', null, 1),
        item('l2', 'L2 Build', 'l1', 2),
        item('l3', 'L3 Verify', 'l2', 3),
      ],
      selectedId: 'l2',
      onSelect: vi.fn(),
      onCreateChild: createChild,
    }))

    expect(screen.getByRole('treeitem', { name: /L1 Alpha/ })).toHaveAttribute('aria-level', '1')
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toHaveAttribute('aria-level', '2')
    expect(screen.getByRole('treeitem', { name: /L3 Verify/ })).toHaveAttribute('aria-level', '3')
    fireEvent.click(screen.getByRole('button', { name: 'Create child under L2 Build' }))
    expect(createChild).toHaveBeenCalledWith('l2')
    expect(screen.queryByRole('button', { name: 'Create child under L3 Verify' })).toBeNull()
  })

  it('orders siblings by childRank and does not leak old nodes after a data switch', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: [
        item('l2', 'Second', null, 1, { childRank: 1 }),
        item('l1', 'First', null, 1, { childRank: 0 }),
      ],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
    }))
    const labels = screen.getAllByRole('treeitem').map((node) => node.getAttribute('aria-label'))
    expect(labels).toEqual(['RM-l1 First', 'RM-l2 Second'])

    rerender(createElement(WorkItemTree, {
      items: [item('other', 'Other Project', null, 1)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
    }))
    expect(screen.queryByRole('treeitem', { name: /First/ })).toBeNull()
    expect(screen.getByRole('treeitem', { name: /Other Project/ })).toBeInTheDocument()
  })

  it('shows type, status and priority labels on every node', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Labelled', null, 1, { priority: 'high' })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions,
    }))
    const node = screen.getByRole('treeitem', { name: /Labelled/ })
    expect(node).toHaveTextContent('Task')
    expect(node).toHaveTextContent('Open')
    expect(node).toHaveTextContent('high')
  })

  it('renders distinct empty, loading and failure states', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: [], selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
    }))
    expect(screen.getByText('No work items')).toBeInTheDocument()

    rerender(createElement(WorkItemTree, {
      items: [], selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), isLoading: true,
    }))
    expect(screen.getByText('Loading work items')).toBeInTheDocument()
    expect(screen.queryByText('No work items')).toBeNull()

    rerender(createElement(WorkItemTree, {
      items: [], selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
      error: '无法加载工作项，请检查服务连接后重试。',
    }))
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载工作项，请检查服务连接后重试。')
  })

  it('disables the create-child button while that parent has a pending mutation', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Busy', null, 1)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      pendingMutations: { l1: true },
    }))
    expect(screen.getByRole('button', { name: 'Create child under Busy' })).toBeDisabled()
  })

  it('still renders the cached tree when a refresh error occurs with data present', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Cached Row', null, 1)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      error: '部分本地操作未能同步，请刷新后重试。',
    }))
    expect(screen.getByRole('treeitem', { name: /Cached Row/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('WorkItemTree collapse', () => {
  const baseItems = [
    item('l1', 'L1 Alpha', null, 1),
    item('l2', 'L2 Build', 'l1', 2),
  ]

  it('toggles a single branch collapsed and expanded via the chevron', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
    }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse children of L1 Alpha' }))
    expect(screen.queryByRole('treeitem', { name: /L2 Build/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand children of L1 Alpha' }))
      .toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Expand children of L1 Alpha' }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()
    void rerender
  })

  it('honours a collapse/expand signal from the page shortcuts', () => {
    const { rerender } = render(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
    }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()

    rerender(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
      collapseSignal: { seq: 1, mode: 'collapse' },
    }))
    expect(screen.queryByRole('treeitem', { name: /L2 Build/ })).toBeNull()

    rerender(createElement(WorkItemTree, {
      items: baseItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(),
      collapseSignal: { seq: 2, mode: 'expand' },
    }))
    expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toBeInTheDocument()
  })
})

describe('WorkItemTree drag & drop move', () => {
  const dragItems = [
    item('l1', 'L1 Alpha', null, 1),
    item('l2a', 'L2 One', 'l1', 2),
    item('l2b', 'L2 Two', 'l1', 2),
  ]

  const rowOf = (name: string): HTMLElement => {
    const li = screen.getByRole('treeitem', { name: new RegExp(name) })
    const row = li.querySelector('div[draggable="true"]')
    if (!row) throw new Error(`no draggable row for ${name}`)
    return row as HTMLElement
  }

  const dragStart = (row: HTMLElement) => fireEvent.dragStart(row, {
    dataTransfer: { setData: vi.fn(), effectAllowed: '' },
  })

  it('moves an item under a valid sibling parent on drop', () => {
    const onMove = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove,
    }))
    dragStart(rowOf('L2 One'))
    const target = rowOf('L2 Two')
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    expect(onMove).toHaveBeenCalledWith('l2a', 'l2b')
  })

  it('moves an item to the top level when dropped on the tree background', () => {
    const onMove = vi.fn()
    const { container } = render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove,
    }))
    dragStart(rowOf('L2 One'))
    const tree = container.querySelector('ul[role="tree"]') as HTMLElement
    fireEvent.dragOver(tree)
    fireEvent.drop(tree)
    expect(onMove).toHaveBeenCalledWith('l2a', null)
  })

  it('never moves onto the dragged item itself or its descendant', () => {
    const onMove = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove,
    }))
    // Self drop: invalid.
    dragStart(rowOf('L1 Alpha'))
    fireEvent.dragOver(rowOf('L1 Alpha'))
    fireEvent.drop(rowOf('L1 Alpha'))
    // Descendant drop: invalid.
    dragStart(rowOf('L1 Alpha'))
    fireEvent.dragOver(rowOf('L2 One'))
    fireEvent.drop(rowOf('L2 One'))
    expect(onMove).not.toHaveBeenCalled()
  })

  it('rejects a drop that would push the subtree past three levels', () => {
    const onMove = vi.fn()
    render(createElement(WorkItemTree, {
      items: [
        item('r1', 'R One', null, 1),
        item('d2', 'Deep Two', 'r1', 2),
        item('l1', 'L1 Alpha', null, 1),
        item('l2a', 'L2 One', 'l1', 2),
        item('l3', 'L3 Leaf', 'l2a', 3),
      ],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      onMove,
    }))
    // L1 Alpha carries a depth-3 leaf (relative depth 2): under Deep Two
    // (depth 2) the subtree would reach depth 5 > 3.
    dragStart(rowOf('L1 Alpha'))
    fireEvent.dragOver(rowOf('Deep Two'))
    fireEvent.drop(rowOf('Deep Two'))
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('WorkItemTree drag & drop reorder (工单②)', () => {
  const dragItems = [
    item('l1', 'L1 Alpha', null, 1),
    item('l2a', 'L2 One', 'l1', 2),
    item('l2b', 'L2 Two', 'l1', 2),
    item('l3a', 'L3 Leaf A', 'l2b', 3),
    item('l3b', 'L3 Leaf B', 'l2b', 3),
  ]

  const rowOf = (name: string): HTMLElement => {
    const li = screen.getByRole('treeitem', { name: new RegExp(name) })
    const row = li.querySelector('div[draggable="true"]')
    if (!row) throw new Error(`no draggable row for ${name}`)
    return row as HTMLElement
  }

  const dragStart = (row: HTMLElement) => fireEvent.dragStart(row, {
    dataTransfer: { setData: vi.fn(), effectAllowed: '' },
  })

  // jsdom 没有布局：把目标行 rect 钉成 top=0 / height=100，用 clientY 选分区。
  const pinRect = (row: HTMLElement) => {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 100, height: 100, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
  }

  // jsdom 的 DragEvent 初始化不消费 clientY（实测 undefined）—— 用 createEvent
  // 构造后强制注入，模拟真实浏览器的指针位置。
  const dropAt = (row: HTMLElement, clientY: number) => {
    pinRect(row)
    const over = createEvent.dragOver(row, { clientY })
    Object.defineProperty(over, 'clientY', { value: clientY })
    fireEvent(row, over)
    const drop = createEvent.drop(row, { clientY })
    Object.defineProperty(drop, 'clientY', { value: clientY })
    fireEvent(row, drop)
  }

  it('emits reorder(before) for a drop on the upper quarter of a same-parent sibling', () => {
    const onMove = vi.fn()
    const onReorder = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove, onReorder,
    }))
    dragStart(rowOf('L2 Two'))
    dropAt(rowOf('L2 One'), 10)
    expect(onReorder).toHaveBeenCalledWith('l2b', 'l2a', 'before')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('emits reorder(after) for a drop on the lower quarter', () => {
    const onMove = vi.fn()
    const onReorder = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove, onReorder,
    }))
    dragStart(rowOf('L2 One'))
    dropAt(rowOf('L2 Two'), 90)
    expect(onReorder).toHaveBeenCalledWith('l2a', 'l2b', 'after')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('keeps child semantics for a drop in the middle band', () => {
    const onMove = vi.fn()
    const onReorder = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove, onReorder,
    }))
    dragStart(rowOf('L2 One'))
    dropAt(rowOf('L2 Two'), 50)
    expect(onMove).toHaveBeenCalledWith('l2a', 'l2b')
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('accepts before/after drops on depth-3 rows (same-parent insertion)', () => {
    const onMove = vi.fn()
    const onReorder = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove, onReorder,
    }))
    dragStart(rowOf('L3 Leaf A'))
    dropAt(rowOf('L3 Leaf B'), 10)
    expect(onReorder).toHaveBeenCalledWith('l3a', 'l3b', 'before')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('emits reorder for a cross-parent before drop (page layer splits into move+reorder)', () => {
    const onMove = vi.fn()
    const onReorder = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove, onReorder,
    }))
    dragStart(rowOf('L2 One'))
    dropAt(rowOf('L3 Leaf A'), 10)
    expect(onReorder).toHaveBeenCalledWith('l2a', 'l3a', 'before')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('refuses before/after drops without an onReorder handler (legacy consumers unchanged)', () => {
    const onMove = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove,
    }))
    dragStart(rowOf('L2 Two'))
    dropAt(rowOf('L2 One'), 10)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('refuses a reorder drop onto the dragged row itself', () => {
    const onReorder = vi.fn()
    render(createElement(WorkItemTree, {
      items: dragItems, selectedId: null, onSelect: vi.fn(), onCreateChild: vi.fn(), onMove: vi.fn(), onReorder,
    }))
    dragStart(rowOf('L2 One'))
    dropAt(rowOf('L2 One'), 10)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('refuses a cross-parent before drop whose insert-parent sits in the dragged subtree', () => {
    const onMove = vi.fn()
    const onReorder = vi.fn()
    render(createElement(WorkItemTree, {
      items: [
        item('r1', 'Big Root', null, 1),
        item('m2', 'Mid Child', 'r1', 2),
        item('g3', 'Deep Leaf', 'm2', 3),
        item('peer', 'Other Root', null, 1),
        item('p2', 'Peer Child', 'peer', 2),
      ],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      onMove,
      onReorder,
    }))
    // 拖 Big Root 到它自己的孙子 Deep Leaf 的上缘：插入点父 = Deep Leaf 的父
    // Mid Child —— 在被拖子树里 ⇒ 环（把自己挂到自己孩子之下），必须拒。
    dragStart(rowOf('Big Root'))
    dropAt(rowOf('Deep Leaf'), 10)
    expect(onReorder).not.toHaveBeenCalled()
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('WorkItemTree blocking indicator', () => {
  it('renders a lock with a hover hint for a blocked item', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1), item('l2', 'Blocked', 'l1', 2)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      blockedSignals: { l2: { isBlocked: true, openBlockerCount: 2 } },
    }))
    const lock = document.querySelector('[data-blocked-lock]')
    expect(lock).not.toBeNull()
    expect(lock?.getAttribute('title')).toBe('被 2 个未完成依赖项阻塞')
    expect(lock?.textContent).toBe('🔒')
  })

  it('renders no lock when nothing is blocked', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1)],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      blockedSignals: { l1: { isBlocked: false, openBlockerCount: 0 } },
    }))
    expect(document.querySelector('[data-blocked-lock]')).toBeNull()
  })
})

/**
 * ★ P3（2026-10-04）：标签 chip 在树上的可见性。
 *
 * 分配标签的 UI 在详情面板，但树是全局视角 —— 分配完在树上看不见，
 * 用户会以为没生效。重点是几条**不该崩 / 不该骗人**的口径：
 *   - 没有标签 ⇒ 一行都不渲染（不占位、不显示空 chip）；
 *   - labelIds 里有 definitions 中查不到的 id ⇒ **不显示裸 id**
 *     （显示 "lbl-999" 只会让用户以为系统里真有这么个标签）；
 *   - 超过 2 个 ⇒ 末位显示「+N」，不静默丢；
 *   - 已归档标签仍显示但划线淡化（它还挂在工作项上，静默消失像数据丢了）。
 */
describe('WorkItemTree · 标签 chip（P3）', () => {
  const withLabels = (labels: unknown[]) => ({ statuses: [], types: [], labels })

  it('★ 有标签时树上出现 chip（分配后要看得见）', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1, { labelIds: ['lbl-a'] })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions: withLabels([{ id: 'lbl-a', name: '重要', color: '#dc2626' }]) as never,
    }))
    const chip = screen.getByTestId('tree-label-lbl-a')
    expect(chip.textContent).toBe('重要')
    expect(chip.getAttribute('title')).toBe('重要')
  })

  it('没有标签时一个 chip 都不渲染', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1, { labelIds: [] })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions: withLabels([{ id: 'lbl-a', name: '重要' }]) as never,
    }))
    expect(document.querySelector('[data-testid^="tree-label-"]')).toBeNull()
  })

  it('★ definitions 里查不到的 id 不显示裸 id', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1, { labelIds: ['lbl-missing'] })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions: withLabels([{ id: 'lbl-a', name: '重要' }]) as never,
    }))
    expect(screen.queryByTestId('tree-label-lbl-missing')).toBeNull()
    expect(document.body.textContent).not.toContain('lbl-missing')
  })

  it('★ 超过 2 个时末位显示「+N」而不是静默丢掉', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1, { labelIds: ['a', 'b', 'c', 'd'] })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions: withLabels([
        { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
        { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
      ]) as never,
    }))
    expect(screen.getByTestId('tree-label-a')).toBeTruthy()
    expect(screen.getByTestId('tree-label-b')).toBeTruthy()
    expect(screen.queryByTestId('tree-label-c')).toBeNull()
    expect(screen.getByTestId('tree-label-b').textContent).toBe('B +2')
  })

  it('★ 已归档标签仍显示但淡化（还挂在工作项上，不能静默消失）', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1, { labelIds: ['old'] })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions: withLabels([
        { id: 'old', name: '旧标签', archivedAt: '2026-10-04T01:00:00.000Z' },
      ]) as never,
    }))
    const chip = screen.getByTestId('tree-label-old')
    expect(chip.textContent).toContain('旧标签')
    expect(chip.getAttribute('title')).toContain('已归档')
    expect(chip.className).toContain('line-through')
  })

  it('★ 脏标签行（缺 name / name 为 null）不崩，也不显示 undefined', () => {
    // 注意只给 2 个：max=2，第 3 个起会被计进 overflow（截断口径已由上一条钉死）
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1, { labelIds: ['bad', 'nullish'] })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions: withLabels([
        { id: 'bad' },
        { id: 'nullish', name: null },
      ]) as never,
    }))
    // 缺 name / name 为 null ⇒ 回落成 id 本身是可接受的，但不能是 "undefined" 或空
    const bad = screen.getByTestId('tree-label-bad')
    const nullish = screen.getByTestId('tree-label-nullish')
    expect(bad.textContent).not.toContain('undefined')
    expect(nullish.textContent).not.toContain('undefined')
    expect(bad.textContent).toBe('bad')
    expect(nullish.textContent).toBe('nullish')
  })

  it('definitions 整个为 null 时不崩（labels 分支要能扛脏输入）', () => {
    render(createElement(WorkItemTree, {
      items: [item('l1', 'Root', null, 1, { labelIds: ['lbl-a'] })],
      selectedId: null,
      onSelect: vi.fn(),
      onCreateChild: vi.fn(),
      definitions: null,
    }))
    expect(screen.queryByTestId('tree-label-lbl-a')).toBeNull()
  })
})
