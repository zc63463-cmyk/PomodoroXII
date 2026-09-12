import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
