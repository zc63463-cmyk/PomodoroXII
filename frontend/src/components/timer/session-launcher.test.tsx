import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionLauncher, deriveLaunchSelection } from './session-launcher'
import { useSettingsStore } from '@/stores/settings-store'

/**
 * ② 任务选择 Modal 落地后（外派单 2026-10-02）：启动器是受控视图 ——
 * 归属/三级计划的状态源在页面（Modal 写、本组件读），派生映射单独锁在
 * `deriveLaunchSelection` 的纯函数用例里。归属 select / 三级 checkbox /
 * 内联新建三级的交互断言在 `task-picker-modal.test.tsx`。
 */

const items = [
  { id: 'l1', depth: 1, parentId: null, title: 'Project goal', displayKey: 'P-1', childRank: 0 },
  { id: 'l2', depth: 2, parentId: 'l1', title: 'Ship feature', displayKey: 'P-2', childRank: 0 },
  { id: 'l3-a', depth: 3, parentId: 'l2', title: 'Verify output', displayKey: 'P-3', childRank: 0 },
  { id: 'l3-b', depth: 3, parentId: 'l2', title: 'Record evidence', displayKey: 'P-4', childRank: 1 },
] as never

describe('deriveLaunchSelection（store 选中项 → 启动选择映射）', () => {
  it('三级选中 → 映射到二级父项 + 本身进计划', () => {
    expect(deriveLaunchSelection(items, 'l3-a')).toEqual({
      level2Id: 'l2', level3Ids: ['l3-a'], requiresLevel2: false,
    })
  })

  it('二级选中 → 归属自身、计划为空', () => {
    expect(deriveLaunchSelection(items, 'l2')).toEqual({
      level2Id: 'l2', level3Ids: [], requiresLevel2: false,
    })
  })

  it('一级选中 → requiresLevel2（页面据此提示先去选二级）', () => {
    expect(deriveLaunchSelection(items, 'l1')).toEqual({
      level2Id: null, level3Ids: [], requiresLevel2: true,
    })
  })

  it('未选中 → 全空', () => {
    expect(deriveLaunchSelection(items, null)).toEqual({
      level2Id: null, level3Ids: [], requiresLevel2: false,
    })
  })
})

function renderLauncher({
  level2Id = 'l2',
  level3Ids = [],
  onLevel3IdsChange,
  onStart,
}: {
  level2Id?: string | null
  level3Ids?: string[]
  onLevel3IdsChange?: (next: string[]) => void
  onStart?: (selection: unknown) => Promise<void> | void
} = {}) {
  // ★ 解构默认值只对 undefined 生效 —— level2Id: null 必须原样透传（测"未选归属"）。
  return render(createElement(SessionLauncher, {
    items,
    level2Id,
    level3Ids,
    onLevel3IdsChange,
    onStart: onStart ?? vi.fn(),
  }))
}

describe('SessionLauncher', () => {
  it('受控提交：level2Id + level3Ids 原样进入启动载荷（休息判定之外的直通）', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    renderLauncher({ level2Id: 'l2', level3Ids: ['l3-a', 'l3-b'], onStart: start })

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      level2WorkItemId: 'l2', level3WorkItemIds: ['l3-a', 'l3-b'],
    }))
  })

  it('已选摘要可见：归属标题 + 三级计划计数（关掉 Modal 不失忆，外派单验收 3）', () => {
    renderLauncher({ level2Id: 'l2', level3Ids: ['l3-a'] })

    expect(screen.getByTestId('launcher-attribution-summary')).toHaveTextContent('归属：Ship feature')
    expect(screen.getByTestId('launcher-attribution-summary')).toHaveTextContent('三级计划 1 项')
  })

  it('未选归属时摘要明说去哪挑', () => {
    renderLauncher({ level2Id: null })

    expect(screen.getByTestId('launcher-attribution-summary')).toHaveTextContent('归属：未选择')
  })

  it('requires 二级但未选：CTA 禁用 + status 指向「浏览全部任务」入口（Level 2 attribution 口径保留）', () => {
    renderLauncher({ level2Id: null })

    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/Level 2 attribution/)
    expect(screen.getByRole('status')).toHaveTextContent(/浏览全部任务/)
  })

  it('explains why Start is disabled when no level-2 exists to attribute to', () => {
    const onlyLevel1 = [
      { id: 'l1', depth: 1, parentId: null, title: 'Project goal', displayKey: 'P-1', childRank: 0 },
    ] as never
    // 页面对 L1 选中项派生出的 level2Id 是 null（deriveLaunchSelection），据此渲染
    render(createElement(SessionLauncher, {
      items: onlyLevel1, level2Id: null, level3Ids: [], onStart: vi.fn(),
    }))

    // 按钮必须仍然禁用，但页面要说明「为什么」以及「去哪补」
    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeDisabled()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(/还没有「二级工作项」/)
    expect(status).toHaveTextContent(/任务/)
  })

  it('shows no explanatory status once a level-2 is selected', () => {
    renderLauncher({ level2Id: 'l2' })

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('disables the start button while a start is pending and submits only once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const start = vi.fn().mockImplementation(() => gate)
    renderLauncher({ level2Id: 'l2', onStart: start })
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
    renderLauncher({ level2Id: 'l2', onStart: start })

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(45)
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ plannedSeconds: 2700 }))
  })

  it('点击预设同步输入与提交载荷，命中项呈选中态（aria-pressed）', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    renderLauncher({ level2Id: 'l2', onStart: start })

    fireEvent.click(screen.getByRole('button', { name: '90 分钟' }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(90)
    expect(screen.getByRole('button', { name: '90 分钟' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ plannedSeconds: 5400 }))
  })

  it('自定义输入后无预设呈选中态，自定义值照常进入载荷', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    renderLauncher({ level2Id: 'l2', onStart: start })

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
    renderLauncher({ level2Id: 'l2', onStart: start })

    expect(screen.getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionType: 'work' }))
  })

  it('切到短休：默认时长取 shortBreakDuration、环下文案改「休息时长」、载荷带短休模式', () => {
    const start = vi.fn().mockResolvedValue(undefined)
    renderLauncher({ level2Id: 'l2', level3Ids: ['l3-a'], onStart: start })

    fireEvent.click(screen.getByRole('button', { name: '短休息' }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(5)
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('05:00')
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('休息时长')

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'short_break', plannedSeconds: 300, level3WorkItemIds: [],
    }))
  })

  it('切到长休：取 longBreakDuration；清空三级勾选写回页面状态源（休息不带计划）', () => {
    const onLevel3IdsChange = vi.fn()
    const start = vi.fn().mockResolvedValue(undefined)
    renderLauncher({ level2Id: 'l2', level3Ids: ['l3-a'], onLevel3IdsChange, onStart: start })

    fireEvent.click(screen.getByRole('button', { name: '长休息' }))

    expect(screen.getByLabelText('Planned minutes')).toHaveValue(15)
    expect(screen.getByTestId('break-plan-note')).toHaveTextContent('只记录休息时长')
    // 三级勾选清空写回页面（Modal 再打开时不会看到过期勾选）
    expect(onLevel3IdsChange).toHaveBeenCalledWith([])

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'long_break', plannedSeconds: 900, level3WorkItemIds: [],
    }))
  })

  it('休息模式的时长预设换成分模式预设（5/10/15），work 预设不再出现', () => {
    renderLauncher({ level2Id: 'l2' })

    fireEvent.click(screen.getByRole('button', { name: '短休息' }))

    for (const minutes of [5, 10, 15]) {
      expect(screen.getByRole('button', { name: `${minutes} 分钟` })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: '25 分钟' })).toBeNull()
    expect(screen.getByRole('button', { name: '5 分钟' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('从休息切回工作：恢复 work 默认时长与 work 预设', () => {
    renderLauncher({ level2Id: 'l2' })

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
    renderLauncher({ level2Id: 'l2' })

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
    renderLauncher({ level2Id: 'l2' })

    fireEvent.click(screen.getByRole('button', { name: '90 分钟' }))
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('90:00')

    fireEvent.change(screen.getByLabelText('Planned minutes'), { target: { value: '150' } })
    expect(screen.getByTestId('launcher-ring-preview')).toHaveTextContent('150:00')
  })
})
