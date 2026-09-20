import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionLauncher } from './session-launcher'
import { useSettingsStore } from '@/stores/settings-store'

const items = [
  { id: 'l1', depth: 1, parentId: null, title: 'Project goal', displayKey: 'P-1', childRank: 0 },
  { id: 'l2', depth: 2, parentId: 'l1', title: 'Ship feature', displayKey: 'P-2', childRank: 0 },
  { id: 'l3-a', depth: 3, parentId: 'l2', title: 'Verify output', displayKey: 'P-3', childRank: 0 },
  { id: 'l3-b', depth: 3, parentId: 'l2', title: 'Record evidence', displayKey: 'P-4', childRank: 1 },
] as never

describe('SessionLauncher', () => {
  it('maps a level-3 start to its level-2 parent and freezes the selected level 3', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l3-a', onStart: start }))

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3-a'],
    }))
  })

  it('allows a level-2 Session with no level-3 plan', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ level3WorkItemIds: [] }))
  })

  it('requires selecting or creating a level-2 child for a level-1 start', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l1', onStart: vi.fn() }))

    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeDisabled()
    expect(screen.getByLabelText('Level 2 attribution')).toBeRequired()
  })

  it('explains why Start is disabled when no level-2 exists to attribute to', () => {
    const onlyLevel1 = [
      { id: 'l1', depth: 1, parentId: null, title: 'Project goal', displayKey: 'P-1', childRank: 0 },
    ] as never
    render(createElement(SessionLauncher, { items: onlyLevel1, initialWorkItemId: 'l1', onStart: vi.fn() }))

    // 按钮必须仍然禁用，但页面要说明「为什么」以及「去哪补」
    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeDisabled()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(/还没有「二级工作项」/)
    expect(status).toHaveTextContent(/任务/)
  })

  it('prompts the user to pick a level-2 when options exist but none is chosen', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: null, onStart: vi.fn() }))

    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/Level 2 attribution/)
  })

  it('shows no explanatory status once a level-2 is selected', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn() }))

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('rebinds attribution when the selected WorkItem changes after mount', () => {
    const start = vi.fn()
    const view = render(createElement(SessionLauncher, { items, initialWorkItemId: null, onStart: start }))

    view.rerender(createElement(SessionLauncher, { items, initialWorkItemId: 'l3-b', onStart: start }))
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3-b'],
    }))
  })

  it('disables the start button while a start is pending and submits only once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const start = vi.fn().mockImplementation(() => gate)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))
    const button = screen.getByRole('button', { name: 'Start focus session' })

    fireEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())
    fireEvent.click(button)
    expect(start).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect(button).not.toBeDisabled())
  })
})

describe('SessionLauncher 时长预设（工单④）', () => {
  beforeEach(() => {
    useSettingsStore.setState({ pomodoroDuration: 25 })
  })

  it('默认时长来自设置而非硬编码（45 分钟设置 → 载荷 2700s）', () => {
    useSettingsStore.setState({ pomodoroDuration: 45 })
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(45)
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ plannedSeconds: 2700 }))
  })

  it('点击预设同步输入与提交载荷，命中项呈选中态（aria-pressed）', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))

    fireEvent.click(screen.getByRole('button', { name: '90 分钟' }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(90)
    expect(screen.getByRole('button', { name: '90 分钟' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ plannedSeconds: 5400 }))
  })

  it('自定义输入后无预设呈选中态，自定义值照常进入载荷', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))

    fireEvent.change(screen.getByLabelText('Planned minutes'), { target: { value: '30' } })
    for (const minutes of [25, 45, 60, 90]) {
      expect(screen.getByRole('button', { name: `${minutes} 分钟` })).toHaveAttribute('aria-pressed', 'false')
    }

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ plannedSeconds: 1800 }))
  })
})

// ── 双体系兼容 2026-09-16：模式切换与休息节奏入口 ───────────────────────────
describe('SessionLauncher 模式切换（双体系兼容）', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      pomodoroDuration: 25, shortBreakDuration: 5, longBreakDuration: 15,
    })
  })

  it('默认 work：提交载荷显式携带 sessionType=work（旧行为语义不变）', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))

    expect(screen.getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionType: 'work' }))
  })

  it('切到短休：默认时长取 shortBreakDuration、环下文案改「休息时长」、载荷带短休模式', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start }))

    fireEvent.click(screen.getByRole('button', { name: '短休息' }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(5)
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('05:00')
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('休息时长')

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'short_break', plannedSeconds: 300, level3WorkItemIds: [],
    }))
  })

  it('切到长休：取 longBreakDuration；三级计划控件整组换成说明（服务端拒绝休息带计划）', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, {
      items, initialWorkItemId: 'l3-a', onStart: start, onCreateLevel3: vi.fn(),
    }))

    // 切到长休前：三级计划区存在，且初始选中项已冻结进计划
    expect(screen.queryByTestId('break-plan-note')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '长休息' }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(15)
    expect(screen.getByTestId('break-plan-note')).toHaveTextContent('只记录休息时长')
    // 三级清单/内联新建整组消失（不是"点了必被拒"）
    expect(screen.queryByText('Level 3 plan')).toBeNull()
    expect(screen.queryByLabelText('新三级标题')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'long_break', plannedSeconds: 900, level3WorkItemIds: [],
    }))
  })

  it('休息模式的时长预设换成分模式预设（5/10/15），work 预设不再出现', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn() }))

    fireEvent.click(screen.getByRole('button', { name: '短休息' }))

    for (const minutes of [5, 10, 15]) {
      expect(screen.getByRole('button', { name: `${minutes} 分钟` })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: '25 分钟' })).toBeNull()
    expect(screen.getByRole('button', { name: '5 分钟' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('从休息切回工作：恢复 work 默认时长与 work 预设', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn() }))

    fireEvent.click(screen.getByRole('button', { name: '短休息' }))
    fireEvent.click(screen.getByRole('button', { name: '专注' }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(25)
    expect(screen.getByRole('button', { name: '90 分钟' })).toBeInTheDocument()
  })
})

// ── 工单② 2026-09-14：准备态静止环预览 ─────────────────────────────────────
describe('SessionLauncher 准备态静止环预览（工单②）', () => {
  beforeEach(() => {
    useSettingsStore.setState({ pomodoroDuration: 25 })
  })

  it('静止环：空弧（dashoffset=C）、无 live/overtime 类；数字与「专注时长」在预览容器内', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn() }))

    const preview = screen.getByTestId('launcher-ring-preview')
    expect(preview).toHaveTextContent('25:00')
    expect(preview).toHaveTextContent('专注时长')

    // 环在预览容器里且静止：复用运行态的 testid/几何，但不带任何运行态类
    const ring = screen.getByTestId('timer-ring')
    expect(preview.contains(ring)).toBe(true)
    expect(ring).not.toHaveClass('timer-ring-live')
    expect(ring).not.toHaveClass('timer-ring--overtime')
    const circumference = 2 * Math.PI * 88
    expect(Number(screen.getByTestId('timer-ring-progress').getAttribute('stroke-dashoffset')))
      .toBeCloseTo(circumference, 5)
  })

  it('随预设点击与分钟输入实时更新（与运行态同格式；分钟不封顶）', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn() }))

    fireEvent.click(screen.getByRole('button', { name: '90 分钟' }))
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('90:00')

    fireEvent.change(screen.getByLabelText('Planned minutes'), { target: { value: '150' } })
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('150:00')
  })
})

// ── 工单③ 2026-09-14：准备态内联新建三级（自动加入计划） ───────────────────
describe('SessionLauncher 准备态内联新建三级（工单③）', () => {
  beforeEach(() => {
    useSettingsStore.setState({ pomodoroDuration: 25 })
  })

  it('未提供 onCreateLevel3 时不渲染新建控件（与运行态同约定）', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn() }))

    expect(screen.queryByRole('button', { name: '+ 新建三级' })).toBeNull()
    expect(screen.queryByLabelText('新三级标题')).toBeNull()
  })

  it('未选 L2：整组随 fieldset 禁用；选中后空标题仍禁提交', () => {
    render(createElement(SessionLauncher, { items, initialWorkItemId: null, onStart: vi.fn(), onCreateLevel3: vi.fn() }))

    const input = screen.getByLabelText('新三级标题')
    const submit = screen.getByRole('button', { name: '+ 新建三级' })
    expect(input).toBeDisabled()
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Level 2 attribution'), { target: { value: 'l2' } })
    expect(input).not.toBeDisabled()
    expect(submit).toBeDisabled()
  })

  it('成功：修剪标题后提交、返回 id 自动加入本轮计划（不在 candidates 也先收下）、输入清空', async () => {
    const create = vi.fn().mockResolvedValue('l3-new')
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start, onCreateLevel3: create }))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '  写验收报告  ' } })
    // 点击后的 resolve 续体（清输入 + 追加计划）在 act 边界内冲刷，
    // 与既有 waitFor 模式等价、但不额外制造 act 提示噪声。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))
    })

    await waitFor(() => expect(create).toHaveBeenCalledWith('l2', '写验收报告'))
    await waitFor(() => expect(screen.getByLabelText('新三级标题')).toHaveValue(''))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3-new'],
    }))
  })

  it('空标题或纯空格不提交', () => {
    const create = vi.fn()
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn(), onCreateLevel3: create }))

    const submit = screen.getByRole('button', { name: '+ 新建三级' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '   ' } })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)

    expect(create).not.toHaveBeenCalled()
  })

  it('失败：role="alert" 呈现原因、输入保留（离线创建禁令必须可见）', async () => {
    const create = vi.fn().mockRejectedValue(new Error('offline_formal_creation_forbidden'))
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: vi.fn(), onCreateLevel3: create }))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '离线想建' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('offline_formal_creation_forbidden')
    expect(screen.getByLabelText('新三级标题')).toHaveValue('离线想建')
  })

  it('提交期间切换 L2：完成后的新项不误挂进新 L2 的计划（防错挂）', async () => {
    const twoLevel2Items = [
      { id: 'l1', depth: 1, parentId: null, title: 'Project goal', displayKey: 'P-1', childRank: 0 },
      { id: 'l2', depth: 2, parentId: 'l1', title: 'Ship feature', displayKey: 'P-2', childRank: 0 },
      { id: 'l2-b', depth: 2, parentId: 'l1', title: 'Second feature', displayKey: 'P-5', childRank: 1 },
      { id: 'l3-a', depth: 3, parentId: 'l2', title: 'Verify output', displayKey: 'P-3', childRank: 0 },
    ] as never
    let settle: (id: string) => void = () => undefined
    const create = vi.fn().mockImplementation(() => new Promise<string>((resolve) => { settle = resolve }))
    const start = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionLauncher, {
      items: twoLevel2Items, initialWorkItemId: 'l2', onStart: start, onCreateLevel3: create,
    }))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '晚到的三级' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith('l2', '晚到的三级'))

    // 创建还悬着，用户切到另一个 L2
    fireEvent.change(screen.getByLabelText('Level 2 attribution'), { target: { value: 'l2-b' } })

    await act(async () => {
      settle('l3-late')
    })
    await waitFor(() => expect(screen.getByLabelText('新三级标题')).toHaveValue(''))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      level2WorkItemId: 'l2-b', level3WorkItemIds: [],
    }))
  })

  it('输入框回车等效内联提交，且不会误触外层「开始专注」', async () => {
    const create = vi.fn().mockResolvedValue('l3-enter')
    const start = vi.fn()
    render(createElement(SessionLauncher, { items, initialWorkItemId: 'l2', onStart: start, onCreateLevel3: create }))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '回车新建' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('新三级标题'), { key: 'Enter' })
    })

    await waitFor(() => expect(create).toHaveBeenCalledWith('l2', '回车新建'))
    expect(start).not.toHaveBeenCalled()
  })
})
