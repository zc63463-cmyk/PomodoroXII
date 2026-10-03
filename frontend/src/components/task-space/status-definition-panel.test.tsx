import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusDefinitionPanel } from './status-definition-panel'

/**
 * 状态定义管理面板 · 组件测试。
 *
 * ★ 重点是双轴的 UI 不变量，而不是"能渲染"：
 *   - 固定轴 5 类**永远可见、不可增删**（没有"新建category"入口）；
 *   - 系统行（system）**不可改名/不可归档** —— 它是语义锚点；
 *   - 用户行可以改名/归档/组内上下移；
 *   - 脏数据（非法行）不能让整面板崩。
 */

const row = (over: Record<string, unknown> = {}) => ({
  id: 'u-1',
  name: '等设计 review',
  category: 'waiting',
  icon: null,
  color: '#6d28d9',
  rank: 0,
  system: false,
  archivedAt: null,
  version: 1,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
  ...over,
})

const SYS = {
  not_started: row({ id: 'sys-status-not-started', name: '未开始', category: 'not_started', system: true, rank: 0 }),
  in_progress: row({ id: 'sys-status-in-progress', name: '进行中', category: 'in_progress', system: true, rank: 0 }),
  waiting: row({ id: 'sys-status-waiting', name: '等待', category: 'waiting', system: true, rank: 0 }),
  completed: row({ id: 'sys-status-completed', name: '已完成', category: 'completed', system: true, rank: 0 }),
  cancelled: row({ id: 'sys-status-cancelled', name: '已取消', category: 'cancelled', system: true, rank: 0 }),
}

const baseRows = Object.values(SYS)

describe('StatusDefinitionPanel · 固定轴', () => {
  it('★ 五个 category 分组恒可见（即使没有任何 status）', () => {
    render(<StatusDefinitionPanel rows={[]} />)
    for (const c of ['not_started', 'in_progress', 'waiting', 'completed', 'cancelled']) {
      expect(screen.getByTestId(`status-group-${c}`)).toBeTruthy()
    }
  })

  it('★ 没有"新建 category"入口 —— 固定轴不可由用户扩展', () => {
    render(<StatusDefinitionPanel rows={baseRows} />)
    // 每组只有"添加状态"，没有任何能新增 category 的控件
    for (const c of ['not_started', 'in_progress', 'waiting']) {
      expect(screen.getByTestId(`status-add-${c}`)).toBeTruthy()
    }
    expect(screen.queryByTestId('status-add-category')).toBeNull()
  })

  it('标题区展示"自定义了几个"', () => {
    render(
      <StatusDefinitionPanel
        rows={[...baseRows, row({ id: 'u-1' }), row({ id: 'u-2', name: '需要授权', rank: 1 })]}
      />,
    )
    expect(screen.getByText(/你自定义了 2 个/)).toBeTruthy()
  })
})

describe('StatusDefinitionPanel · 系统行保护', () => {
  it('★ 系统行标「系统」且无改名/归档按钮', () => {
    render(<StatusDefinitionPanel rows={baseRows} />)
    const li = screen.getByTestId('status-row-sys-status-waiting')
    expect(within(li).getByTestId('status-system-sys-status-waiting')).toBeTruthy()
    expect(within(li).queryByLabelText('重命名 等待')).toBeNull()
    expect(within(li).queryByLabelText('归档 等待')).toBeNull()
  })

  it('系统行仍可参与组内排序（它是组内第一项，向上应禁用）', () => {
    render(<StatusDefinitionPanel rows={baseRows} onReorder={vi.fn()} />)
    const li = screen.getByTestId('status-row-sys-status-waiting')
    const up = within(li).getByLabelText('上移 等待') as HTMLButtonElement
    expect(up.disabled).toBe(true)
  })

  it('★ 用户行有改名与归档按钮', () => {
    const onArchive = vi.fn()
    render(<StatusDefinitionPanel rows={[...baseRows, row({ id: 'u-1' })]} onArchive={onArchive} />)
    const li = screen.getByTestId('status-row-u-1')
    fireEvent.click(within(li).getByLabelText('归档 等设计 review'))
    expect(onArchive).toHaveBeenCalledWith({ statusId: 'u-1', expectedVersion: 1 })
  })
})

describe('StatusDefinitionPanel · 新建', () => {
  it('点「+ 添加」出现输入框，回车提交', async () => {
    const onCreate = vi.fn()
    render(<StatusDefinitionPanel rows={baseRows} onCreate={onCreate} />)
    fireEvent.click(screen.getByTestId('status-add-waiting'))
    const input = screen.getByTestId('status-create-input-waiting')
    fireEvent.change(input, { target: { value: '  等设计 review  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: '等设计 review', category: 'waiting' }),
    )
  })

  it('★ 名字为空时不提交（trim 后为空）', () => {
    const onCreate = vi.fn()
    render(<StatusDefinitionPanel rows={baseRows} onCreate={onCreate} />)
    fireEvent.click(screen.getByTestId('status-add-waiting'))
    const input = screen.getByTestId('status-create-input-waiting')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('Escape 取消新建', () => {
    render(<StatusDefinitionPanel rows={baseRows} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('status-add-waiting'))
    const input = screen.getByTestId('status-create-input-waiting')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('status-create-input-waiting')).toBeNull()
  })

  it('★ 创建入口只在该 category 下（category 是调用方决定的，不是猜的）', () => {
    render(<StatusDefinitionPanel rows={baseRows} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByTestId('status-add-cancelled'))
    expect(screen.getByTestId('status-create-input-cancelled')).toBeTruthy()
    expect(screen.queryByTestId('status-create-input-waiting')).toBeNull()
  })
})

describe('StatusDefinitionPanel · 改名', () => {
  it('改名提交带 expected_version', () => {
    const onRename = vi.fn()
    render(
      <StatusDefinitionPanel
        rows={[...baseRows, row({ id: 'u-1', version: 7 })]}
        onRename={onRename}
      />,
    )
    const li = screen.getByTestId('status-row-u-1')
    fireEvent.click(within(li).getByLabelText('重命名 等设计 review'))
    const input = screen.getByTestId('status-rename-input-u-1')
    fireEvent.change(input, { target: { value: '等设计评审' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith({ statusId: 'u-1', name: '等设计评审', expectedVersion: 7 })
  })

  it('★ 名字未变则不提交（避免无意义的 version bump）', () => {
    const onRename = vi.fn()
    render(<StatusDefinitionPanel rows={[...baseRows, row({ id: 'u-1' })]} onRename={onRename} />)
    const li = screen.getByTestId('status-row-u-1')
    fireEvent.click(within(li).getByLabelText('重命名 等设计 review'))
    fireEvent.keyDown(screen.getByTestId('status-rename-input-u-1'), { key: 'Enter' })
    expect(onRename).not.toHaveBeenCalled()
  })
})

describe('StatusDefinitionPanel · 组内排序', () => {
  it('★ 下移调用 onReorder 并传目标位次（不是 delta）', () => {
    const onReorder = vi.fn()
    render(
      <StatusDefinitionPanel
        rows={[
          ...baseRows,
          row({ id: 'u-a', name: 'A', rank: 1 }),
          row({ id: 'u-b', name: 'B', rank: 2 }),
        ]}
        onReorder={onReorder}
      />,
    )
    fireEvent.click(screen.getByLabelText('下移 A'))
    // 组内顺序：sys(0), A(1), B(2) ⇒ A 下移后的目标位次是 2
    expect(onReorder).toHaveBeenCalledWith({ statusId: 'u-a', rank: 2 })
  })

  it('★ 排序**不传** expectedVersion（集合级，后端刻意不锁行）', () => {
    const onReorder = vi.fn()
    render(
      <StatusDefinitionPanel
        rows={[
          ...baseRows,
          // ★ 必须给 A 后面留一个位置，否则「下移」是 disabled（它是组内末项）
          row({ id: 'u-a', name: 'A', rank: 1, version: 9 }),
          row({ id: 'u-b', name: 'B', rank: 2 }),
        ]}
        onReorder={onReorder}
      />,
    )
    fireEvent.click(screen.getByLabelText('下移 A'))
    expect(onReorder).toHaveBeenCalledTimes(1)
    const arg = onReorder.mock.calls[0][0]
    expect(arg).not.toHaveProperty('expectedVersion')
  })

  it('组内最后一项的「下移」禁用', () => {
    render(
      <StatusDefinitionPanel
        rows={[...baseRows, row({ id: 'u-a', name: 'A', rank: 1 })]}
        onReorder={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('下移 A') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('StatusDefinitionPanel · 健壮性', () => {
  it('★ 脏数据被跳过而不是让整面板崩', () => {
    render(
      <StatusDefinitionPanel
        rows={[null, undefined, { garbage: 1 }, 'x', ...baseRows] as unknown as readonly unknown[]}
      />,
    )
    expect(screen.getByTestId('status-group-waiting')).toBeTruthy()
  })

  it('★ 归档错误可展示（409 status_definition_in_use 的提示位）', () => {
    render(
      <StatusDefinitionPanel
        rows={baseRows}
        errorMessage="该状态仍被 3 个工作项引用，无法归档"
      />,
    )
    const alert = screen.getByTestId('status-definition-error')
    expect(alert.textContent).toContain('无法归档')
  })

  it('默认隐藏已归档行；showArchived 时显示', () => {
    const archived = row({ id: 'u-old', name: '旧状态', archivedAt: '2026-10-01T00:00:00.000Z' })
    const { unmount } = render(<StatusDefinitionPanel rows={[...baseRows, archived]} />)
    expect(screen.queryByTestId('status-row-u-old')).toBeNull()
    unmount()
    render(<StatusDefinitionPanel rows={[...baseRows, archived]} showArchived />)
    expect(screen.getByTestId('status-row-u-old')).toBeTruthy()
  })
})
