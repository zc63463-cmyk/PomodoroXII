import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskPickerModal, type TaskPickerModalProps } from './task-picker-modal'
import { useSettingsStore } from '@/stores/settings-store'

/**
 * ② 任务选择 Modal（外派单 2026-10-02）：
 * 复用 ui/dialog + tree-filter 纯函数的受控视图 —— 选中状态全走回调（页面状态源），
 * 这里只断言"交互 → 回调载荷"与"筛选 → tree-filter 收敛/复原"两条链路。
 */

const items = [
  { id: 'l1', depth: 1, parentId: null, title: 'Project goal', displayKey: 'P-1', childRank: 0 },
  { id: 'l2', depth: 2, parentId: 'l1', title: 'Ship feature', displayKey: 'P-2', childRank: 0 },
  { id: 'l2-b', depth: 2, parentId: 'l1', title: 'Second feature', displayKey: 'P-5', childRank: 1 },
  { id: 'l3-a', depth: 3, parentId: 'l2', title: 'Verify output', displayKey: 'P-3', childRank: 0 },
  { id: 'l3-b', depth: 3, parentId: 'l2', title: 'Record evidence', displayKey: 'P-4', childRank: 1 },
] as never

function renderModal(overrides: Partial<TaskPickerModalProps> = {}) {
  const props: TaskPickerModalProps = {
    open: true,
    onOpenChange: vi.fn(),
    items,
    level2Id: 'l2',
    level3Ids: [],
    onAttributionChange: vi.fn(),
    onLevel3IdsChange: vi.fn(),
    ...overrides,
  }
  const view = render(createElement(TaskPickerModal, props))
  return { view, props }
}

describe('TaskPickerModal 结构（外派单验收 1）', () => {
  it('打开即含：归属 select（required，列全部二级项）+ 三级 checkbox + 筛选输入 + 状态筛选', () => {
    renderModal()

    // DialogTitle 关联可访问名（aria/Esc/焦点陷阱由 ui/dialog 原语自带）
    const dialog = screen.getByRole('dialog', { name: '任务选择' })
    expect(dialog).toBeInTheDocument()

    const select = screen.getByLabelText('Level 2 attribution')
    expect(select).toBeRequired()
    expect(select).toHaveValue('l2')
    // 归属下拉列出全部二级项（浏览全部任务的入口）
    expect(screen.getByRole('option', { name: 'Ship feature' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Second feature' })).toBeInTheDocument()

    // 三级候选 = 归属项下的三级项（树形：组头 + 缩进行）
    const list = screen.getByTestId('task-picker-list')
    expect(list.querySelector('[data-group-header="true"]')).toHaveTextContent('Ship feature')
    expect(screen.getByRole('checkbox', { name: 'Verify output' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Record evidence' })).toBeInTheDocument()

    expect(screen.getByLabelText('搜索工作项')).toBeInTheDocument()
    expect(screen.getByLabelText('按状态筛选')).toBeInTheDocument()
  })

  it('未打开时不渲染任何内容', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('底部：已选计数随 level3Ids；「完成」回调 onOpenChange(false)', () => {
    const { props } = renderModal({ level3Ids: ['l3-a', 'l3-b'] })

    expect(screen.getByTestId('task-picker-selected-count')).toHaveTextContent('已选：2 项')
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('TaskPickerModal 交互 → 回调（外派单验收 3）', () => {
  it('改归属：select change → onAttributionChange(新二级 id)', () => {
    const { props } = renderModal()

    fireEvent.change(screen.getByLabelText('Level 2 attribution'), { target: { value: 'l2-b' } })

    expect(props.onAttributionChange).toHaveBeenCalledWith('l2-b')
  })

  it('清空归属：select 回到占位项 → onAttributionChange(null)', () => {
    const { props } = renderModal()

    fireEvent.change(screen.getByLabelText('Level 2 attribution'), { target: { value: '' } })

    expect(props.onAttributionChange).toHaveBeenCalledWith(null)
  })

  it('勾选三级 → onLevel3IdsChange(追加)；取消勾选 → onLevel3IdsChange(移除)', () => {
    const { view, props } = renderModal({ level3Ids: ['l3-a'] })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Record evidence' }))
    expect(props.onLevel3IdsChange).toHaveBeenCalledWith(['l3-a', 'l3-b'])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Verify output' }))
    expect(props.onLevel3IdsChange).toHaveBeenCalledWith([])

    // 受控视图：rerender 携带新 level3Ids 后行内勾选态随之刷新
    view.rerender(createElement(TaskPickerModal, { ...props, level3Ids: ['l3-a'] }))
    expect(screen.getByRole('checkbox', { name: 'Verify output' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Record evidence' })).not.toBeChecked()
  })

  it('来自 store 选中项派生的三级（frozenLevel3Ids）不许反选', () => {
    renderModal({ level3Ids: ['l3-a'], frozenLevel3Ids: ['l3-a'] })

    expect(screen.getByRole('checkbox', { name: 'Verify output' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Record evidence' })).toBeEnabled()
  })
})

describe('TaskPickerModal 筛选（外派单验收 2：走 filterWorkItemTree，不自造过滤）', () => {
  const categoryById: Record<string, string | undefined> = { 'l3-b': 'completed' }

  it('关键字收敛：命中项留下、未命中项消失；清空复原', () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: 'Verify' } })
    expect(screen.getByRole('checkbox', { name: 'Verify output' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Record evidence' })).toBeNull()
    expect(screen.getByTestId('task-picker-filter-count')).toHaveTextContent('命中 1 个三级项')

    // 按编号命中（displayKey，任务页同款口径）
    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: 'P-4' } })
    expect(screen.getByRole('checkbox', { name: 'Record evidence' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Verify output' })).toBeNull()

    // 清空 → 复原
    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: '' } })
    expect(screen.getByRole('checkbox', { name: 'Verify output' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Record evidence' })).toBeInTheDocument()
    expect(screen.queryByTestId('task-picker-filter-count')).toBeNull()
  })

  it('状态筛选：已完成 → 只剩已完成项；未完成 → 只剩未完成项', () => {
    renderModal({ categoryById })

    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'completed' } })
    expect(screen.getByRole('checkbox', { name: 'Record evidence' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Verify output' })).toBeNull()

    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'open' } })
    expect(screen.getByRole('checkbox', { name: 'Verify output' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Record evidence' })).toBeNull()
  })

  it('「清除筛选」一键复位（与任务页同款按钮）', () => {
    renderModal({ categoryById })

    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: 'Verify' } })
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))

    expect(screen.getByLabelText('搜索工作项')).toHaveValue('')
    expect(screen.getByLabelText('按状态筛选')).toHaveValue('all')
    expect(screen.getByRole('checkbox', { name: 'Verify output' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Record evidence' })).toBeInTheDocument()
  })

  it('每次打开重置筛选（上一次的关键字不悄悄收敛本次列表）', () => {
    const { view, props } = renderModal()
    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: 'Verify' } })
    view.rerender(createElement(TaskPickerModal, { ...props, open: false }))
    view.rerender(createElement(TaskPickerModal, { ...props, open: true }))

    expect(screen.getByLabelText('搜索工作项')).toHaveValue('')
  })
})

describe('TaskPickerModal 空态（外派单边界）', () => {
  it('整个 Space 无工作项 → 「去任务页补」的既有口径说明', () => {
    renderModal({ items: [] as never, level2Id: null })

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('这个 Space 里还没有工作项')
    expect(status).toHaveTextContent('去「任务」页新建项目与工作项')
  })

  it('未选归属 → 「先选二级工作项」，不渲染组头', () => {
    renderModal({ level2Id: null })

    expect(screen.getByText('先选二级工作项')).toBeInTheDocument()
    expect(screen.queryByTestId('task-picker-filter-count')).toBeNull()
  })

  it('归属项下没有三级 → 既有口径空行', () => {
    renderModal({ level2Id: 'l2-b' })

    expect(screen.getByText('这条二级项下还没有三级工作项')).toBeInTheDocument()
  })

  it('筛选无命中 → 明说没有匹配（区分于"没有三级项"）', () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('搜索工作项'), { target: { value: '不存在的关键字' } })
    expect(screen.getByText(/没有匹配的三级工作项/)).toBeInTheDocument()
  })
})

// ── 准备态内联新建三级（工单③，自原启动器逐字迁移）──────────────────────────
describe('TaskPickerModal 内联新建三级（工单③）', () => {
  beforeEach(() => {
    useSettingsStore.setState({ pomodoroDuration: 25 })
  })

  it('未提供 onCreateLevel3 时不渲染新建控件（与运行态同约定）', () => {
    renderModal()

    expect(screen.queryByRole('button', { name: '+ 新建三级' })).toBeNull()
    expect(screen.queryByLabelText('新三级标题')).toBeNull()
  })

  it('未选 L2：输入随 fieldset 禁用；选中后空标题仍禁提交', () => {
    const { view, props } = renderModal({ level2Id: null, onCreateLevel3: vi.fn() })

    const input = screen.getByLabelText('新三级标题')
    const submit = screen.getByRole('button', { name: '+ 新建三级' })
    expect(input).toBeDisabled()
    expect(submit).toBeDisabled()

    view.rerender(createElement(TaskPickerModal, { ...props, level2Id: 'l2' }))
    expect(input).not.toBeDisabled()
    expect(submit).toBeDisabled()
  })

  it('成功：修剪标题后提交、返回 id 自动加入本轮计划（不在 candidates 也先收下）、输入清空', async () => {
    const create = vi.fn().mockResolvedValue('l3-new')
    const { props } = renderModal({ onCreateLevel3: create })

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '  写验收报告  ' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))
    })

    await waitFor(() => expect(create).toHaveBeenCalledWith('l2', '写验收报告'))
    await waitFor(() => expect(screen.getByLabelText('新三级标题')).toHaveValue(''))
    expect(props.onLevel3IdsChange).toHaveBeenCalledWith(['l3-new'])
  })

  it('空标题或纯空格不提交', () => {
    const create = vi.fn()
    renderModal({ onCreateLevel3: create })

    const submit = screen.getByRole('button', { name: '+ 新建三级' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '   ' } })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)

    expect(create).not.toHaveBeenCalled()
  })

  it('失败：role="alert" 呈现原因、输入保留（离线创建禁令必须可见）', async () => {
    const create = vi.fn().mockRejectedValue(new Error('offline_formal_creation_forbidden'))
    renderModal({ onCreateLevel3: create })

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '离线想建' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('offline_formal_creation_forbidden')
    expect(screen.getByLabelText('新三级标题')).toHaveValue('离线想建')
  })

  it('提交期间切换 L2：完成后的新项不误挂进新 L2 的计划（防错挂）', async () => {
    let settle: (id: string) => void = () => undefined
    const create = vi.fn().mockImplementation(() => new Promise<string>((resolve) => { settle = resolve }))
    const { view, props } = renderModal({ onCreateLevel3: create })

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '晚到的三级' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith('l2', '晚到的三级'))

    // 创建还悬着，用户把归属切到另一个 L2
    view.rerender(createElement(TaskPickerModal, { ...props, level2Id: 'l2-b' }))

    await act(async () => {
      settle('l3-late')
    })
    await waitFor(() => expect(screen.getByLabelText('新三级标题')).toHaveValue(''))

    expect(props.onLevel3IdsChange).not.toHaveBeenCalled()
  })

  it('输入框回车等效内联提交', async () => {
    const create = vi.fn().mockResolvedValue('l3-enter')
    renderModal({ onCreateLevel3: create })

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '回车新建' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('新三级标题'), { key: 'Enter' })
    })

    await waitFor(() => expect(create).toHaveBeenCalledWith('l2', '回车新建'))
  })
})
