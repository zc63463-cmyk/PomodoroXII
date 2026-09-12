import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { CachedRelation } from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'

vi.mock('lucide-react', () => ({}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) =>
    createElement('button', props, children as never),
}))
import { WorkItemRelationsCard } from './work-item-relations-card'

// 关系图视图渲染 React Flow 画布，jsdom 需要几何 API 最小桩。
// ResizeObserver 立即回调一次，节点完成测量后才会渲染进 DOM。
beforeAll(() => {
  window.ResizeObserver = class {
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
  } as unknown as typeof ResizeObserver
  ;(window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22 = 1
  }
  window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, toJSON: () => ({}) } as DOMRect
  }
})

const item = (id: string, overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id,
  projectId: 'project-1',
  displayKey: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: null,
  parentId: null,
  childRank: 0,
  depth: 2,
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
  // ★ D2 / ADR-0004：确认两列（默认未确认；用例可传 confirmed_not_required）。
  resolution,
  resolvedAt: resolution === null ? null : '2026-07-15T09:00:00.000Z',
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
})

const definitions = {
  statuses: [{ id: 'status-open', label: 'In progress', category: 'in_progress' }],
}

describe('WorkItemRelationsCard', () => {
  it('renders empty states for both directions', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
    }))
    expect(screen.getByText('暂无上游依赖')).toBeInTheDocument()
    expect(screen.getByText('暂无下游依赖')).toBeInTheDocument()
  })

  it('splits edges into upstream (blockers) and downstream (blocking)', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1'), edge('down1', 'l2')],
    }))
    expect(screen.getByText('up1')).toBeInTheDocument()
    expect(screen.getByText('down1')).toBeInTheDocument()
  })

  it('prefers the server minimal projection for the endpoint name', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      relationSet: {
        blockers: [{
          relation: { ...edge('l2', 'up1'), spaceId: 'space-a' },
          workItem: {
            id: 'up1', displayKey: 'OTHER-7', projectId: 'project-2',
            title: 'Foreign upstream', statusDefinitionId: 'status-open',
          },
        }],
        blocking: [],
      },
      definitions,
    }))
    expect(screen.getByText('OTHER-7 Foreign upstream')).toBeInTheDocument()
    // The status badge comes from the definitions, not from raw ids.
    expect(screen.getByText('In progress')).toBeInTheDocument()
  })

  it('marks non-blocking relation types explicitly', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1', 'relates_to')],
    }))
    expect(screen.getByText('不阻塞')).toBeInTheDocument()
  })

  it('resolves endpoint names from the local cache when the projection is absent', () => {
    // 回归：页面未传服务端最小投影时，边曾渲染成裸 UUID（8c24cd46…），
    // 用户完全无法分辨上游是谁。
    const upstreamId = '8c24cd464a025f41a5f744bf0ea77efe'
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', upstreamId)],
      nameById: {
        [upstreamId]: {
          displayKey: 'TASK-1',
          title: '测试一级的 workitem',
          statusDefinitionId: 'status-open',
        },
      },
      definitions,
    }))
    expect(screen.getByText('TASK-1 测试一级的 workitem')).toBeInTheDocument()
    expect(screen.queryByText(upstreamId)).toBeNull()
  })

  it('creates an edge through onAdd with the chosen endpoint', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      candidates: [item('cand')],
      onAdd,
    }))
    fireEvent.click(screen.getByText('添加依赖'))
    fireEvent.click(screen.getByRole('option', { name: 'RM-cand Item cand' }))
    fireEvent.click(screen.getByText('建立依赖'))

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({
      toWorkItemId: 'cand', relationType: 'depends_on',
    }))
  })

  it('keeps cross-project candidates out until explicitly included', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      candidates: [item('local')],
      crossProjectCandidates: [item('foreign', { projectId: 'p2', displayKey: 'XX-1', title: '别的项目' })],
      currentProjectId: 'project-1',
      onAdd: vi.fn(),
    }))
    fireEvent.click(screen.getByText('添加依赖'))

    expect(screen.getByRole('option', { name: /RM-local Item local/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /XX-1 别的项目/ })).toBeNull()

    fireEvent.click(screen.getByLabelText('包含跨项目候选'))
    const foreign = screen.getByRole('option', { name: /XX-1 别的项目/ })
    // 跨项目候选必须带标，让用户知道这不是本项目的东西。
    expect(foreign.textContent).toContain('跨项目')
  })

  it('switches to the graph view and hides the list sections', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      allRelations: [edge('l2', 'up1')],
      nameById: { up1: { displayKey: 'RM-up1', title: '上游' } },
    }))
    expect(document.querySelector('[data-dependency-canvas]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '关系图' }))
    expect(document.querySelector('[data-dependency-canvas]')).not.toBeNull()
    // 画布节点用层级编码/回退顺序号标识端点。
    expect(screen.getByText('RM-up1')).toBeInTheDocument()
    expect(screen.queryByText('被我依赖（上游）')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    expect(screen.getByText('被我依赖（上游）')).toBeInTheDocument()
  })

  it('allows adding a dependency while the graph view is active', async () => {
    // 回归：面板曾被限制在列表视图 —— 图上看到缺口时正是要补边的时候。
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      allRelations: [],
      candidates: [item('cand')],
      currentProjectId: 'project-1',
      onAdd,
    }))
    fireEvent.click(screen.getByRole('button', { name: '关系图' }))
    fireEvent.click(screen.getByText('添加依赖'))
    fireEvent.click(screen.getByRole('option', { name: /RM-cand Item cand/ }))
    fireEvent.click(screen.getByText('建立依赖'))

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({
      toWorkItemId: 'cand', relationType: 'depends_on',
    }))
  })

  it('filters candidates by title or display key', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      candidates: [item('alpha'), item('beta')],
      onAdd: vi.fn(),
    }))
    fireEvent.click(screen.getByText('添加依赖'))
    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: 'alp' } })
    const options = screen.getAllByRole('option').map((node) => node.textContent)
    expect(options).toContain('RM-alpha Item alpha')
    expect(options).not.toContain('RM-beta Item beta')
  })

  it('removes an edge through onRemove with the full logical identity', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      onRemove,
    }))
    fireEvent.click(screen.getByRole('button', { name: '解除与 up1 的依赖' }))

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith({
      fromWorkItemId: 'l2', toWorkItemId: 'up1', relationType: 'depends_on',
    }))
  })

  it('disables mutation actions for an archived item', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2', { archivedAt: '2026-08-01T00:00:00.000Z' }),
      relations: [edge('l2', 'up1')],
      onAdd: vi.fn(),
      onRemove: vi.fn(),
    }))
    const add = screen.getByText('添加依赖').closest('button') as HTMLButtonElement
    expect(add).toBeDisabled()
    // 禁用必须自带理由：归档 → 指向「恢复」，而不是让人以为按钮坏了。
    expect(add.getAttribute('title')).toContain('已归档')
    expect(screen.getByRole('button', { name: '解除与 up1 的依赖' })).toBeDisabled()
  })

  it('explains a locked add action while a mutation for this item is in flight', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      pending: true,
      onAdd: vi.fn(),
    }))
    const add = screen.getByText('添加依赖').closest('button') as HTMLButtonElement
    expect(add).toBeDisabled()
    expect(add.getAttribute('title')).toContain('上一次操作仍在处理中')
    // 挂起是临时态：明示「会自己恢复」，并给出卡死时的出路。
    expect(document.querySelector('[data-pending-hint]')?.textContent)
      .toContain('若长时间停留在此，请刷新页面')
  })

  it('keeps the panel open when a creation fails', async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('cycle_detected'))
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [],
      candidates: [item('cand')],
      onAdd,
    }))
    fireEvent.click(screen.getByText('添加依赖'))
    fireEvent.click(screen.getByRole('option', { name: 'RM-cand Item cand' }))
    fireEvent.click(screen.getByText('建立依赖'))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    expect(document.querySelector('[data-add-relation-panel]')).not.toBeNull()
  })

  it('explains the depth rule to a level-1 item with open upstreams', () => {
    // isBlocked is only defined for level-2 (relation-selectors), so a level-1
    // container with upstreams renders no lock and no confirmation dialog.
    // Without this note the user cannot tell why the dependency "does nothing".
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l1', { depth: 1 }),
      relations: [edge('l1', 'up1')],
    }))
    const note = document.querySelector('[data-depth-blocking-note]')
    expect(note).not.toBeNull()
    expect(note?.textContent).toContain('阻塞只在二级任务上生效')
    expect(note?.textContent).toContain('1 级任务虽有 1 个未完成上游')
  })

  it('explains the depth rule to a level-3 item with open upstreams', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l3', { depth: 3, parentId: 'l2' }),
      relations: [edge('l3', 'up1'), edge('l3', 'up2')],
    }))
    const note = document.querySelector('[data-depth-blocking-note]')
    expect(note).not.toBeNull()
    expect(note?.textContent).toContain('3 级任务虽有 2 个未完成上游')
  })

  it('does not explain the depth rule for a level-2 item (the lock works there)', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
    }))
    expect(document.querySelector('[data-depth-blocking-note]')).toBeNull()
  })

  it('does not explain the depth rule when there are no upstreams', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l1', { depth: 1 }),
      relations: [],
    }))
    expect(document.querySelector('[data-depth-blocking-note]')).toBeNull()
  })

  // ---- ★ D2 / ADR-0004：「需要解决」区块（确认动作的唯一写入口） ----------

  const cancelledDefinitions = {
    statuses: [
      { id: 'status-open', label: 'In progress', category: 'in_progress' },
      { id: 'status-cancelled', label: 'Cancelled', category: 'cancelled' },
    ],
  }
  const cancelledUpstream = {
    up1: {
      displayKey: 'RM-up1', title: 'Up',
      statusDefinitionId: 'status-cancelled',
    },
  }

  it('shows 需要解决 with a confirm button when the upstream is cancelled', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      definitions: cancelledDefinitions,
      nameById: cancelledUpstream,
      onResolve,
    }))

    const section = document.querySelector('[data-needs-resolution]')
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain('需要解决')
    expect(section?.textContent).toContain('已取消')
    const button = document.querySelector('[data-resolve-relation]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('确认不再需要')
  })

  it('confirms the edge through onResolve（唯一写入口）', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      definitions: cancelledDefinitions,
      nameById: cancelledUpstream,
      onResolve,
    }))

    fireEvent.click(document.querySelector('[data-resolve-relation]') as HTMLElement)

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    const passed = onResolve.mock.calls[0][0] as CachedRelation
    expect(passed.id).toBe('rel_l2_up1')
    expect(passed.fromWorkItemId).toBe('l2')
    expect(passed.toWorkItemId).toBe('up1')
  })

  it('hides 需要解决 once the cancellation is confirmed（resolution 已落库）', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1', 'depends_on', 'confirmed_not_required')],
      definitions: cancelledDefinitions,
      nameById: cancelledUpstream,
      onResolve: vi.fn(),
    }))
    expect(document.querySelector('[data-needs-resolution]')).toBeNull()
  })

  it('does not show 需要解决 for an open upstream（仅 cancelled 触发）', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      definitions: cancelledDefinitions,
      nameById: {
        up1: { displayKey: 'RM-up1', title: 'Up', statusDefinitionId: 'status-open' },
      },
      onResolve: vi.fn(),
    }))
    expect(document.querySelector('[data-needs-resolution]')).toBeNull()
  })

  it('marks an archived endpoint（合同 §3.4：归档只加提示，不改真值）', () => {
    render(createElement(WorkItemRelationsCard, {
      workItem: item('l2'),
      relations: [edge('l2', 'up1')],
      definitions: cancelledDefinitions,
      nameById: {
        up1: {
          displayKey: 'RM-up1', title: 'Up',
          statusDefinitionId: 'status-open',
          archivedAt: '2026-08-01T00:00:00.000Z',
        },
      },
    }))
    const rows = document.querySelector('[data-blockers]')
    expect(rows?.textContent).toContain('已归档')
  })
})
