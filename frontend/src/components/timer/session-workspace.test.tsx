import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionWorkspace } from './session-workspace'

const session = { sessionId: 'session-a', sessionNote: '', clockState: 'running' } as never
const plans = [
  { id: 'plan-a', workItemId: 'l3-a', titleSnapshot: 'Verify output', currentDuringSession: true, completionDraft: false },
  { id: 'plan-b', workItemId: 'l3-b', titleSnapshot: 'Build output', currentDuringSession: false, completionDraft: false },
] as never
const candidates = [{ id: 'l3-c', title: 'Test output' }] as never

describe('SessionWorkspace', () => {
  it('switches current level 3 without reallocating Session minutes', () => {
    const setCurrent = vi.fn()
    const allocate = vi.fn()
    render(createElement(SessionWorkspace, { session, plans,
      onSetCurrent: setCurrent, onAllocateMinutes: allocate }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Verify output' }))

    expect(setCurrent).toHaveBeenCalledWith('l3-a')
    expect(allocate).not.toHaveBeenCalled()
  })

  it('states the empty plan instead of rendering a silent blank section', () => {
    // 回归：plans 为空时「Current plan」下什么都没有，用户只会判定"坏了"。
    render(createElement(SessionWorkspace, { session, plans: [] }))
    expect(screen.getByRole('status')).toHaveTextContent('这次会话还没有计划项')
  })

  it('points at the add control when candidates exist but the plan is empty', () => {
    render(createElement(SessionWorkspace, { session, plans: [], availableLevel3: candidates }))
    expect(screen.getByRole('status')).toHaveTextContent('用下面的「Add … to plan」')
  })

  it('keeps Session note separate from WorkItemNote', () => {
    const updateSessionNote = vi.fn()
    const updateWorkItemNote = vi.fn()
    render(createElement(SessionWorkspace, { session, plans,
      onUpdateSessionNote: updateSessionNote, onUpdateWorkItemNote: updateWorkItemNote }))

    fireEvent.change(screen.getByLabelText('Session note'), { target: { value: 'Felt focused' } })

    expect(updateSessionNote).toHaveBeenCalledWith('Felt focused')
    expect(updateWorkItemNote).not.toHaveBeenCalled()
  })

  it('exposes current, completion-draft, add, and remove as distinct plan commands', () => {
    const actions = {
      onSetCurrent: vi.fn(), onSetCompletionDraft: vi.fn(),
      onAddPlanItem: vi.fn(), onRemovePlanItem: vi.fn(),
    }
    render(createElement(SessionWorkspace, { session, plans,
      availableLevel3: candidates, ...actions }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Verify output' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Build output complete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Test output to plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Build output from plan' }))

    expect(actions.onSetCurrent).toHaveBeenCalledWith('l3-a')
    expect(actions.onSetCompletionDraft).toHaveBeenCalledWith('plan-b', true)
    expect(actions.onAddPlanItem).toHaveBeenCalledWith('l3-c')
    expect(actions.onRemovePlanItem).toHaveBeenCalledWith('plan-b')
  })

  it('keeps the previous current item when the Note switch flush fails', async () => {
    const setCurrent = vi.fn()
    render(createElement(SessionWorkspace, { session, plans,
      onSetCurrent: setCurrent,
      onSwitchWorkItemNote: vi.fn().mockRejectedValue(new Error('draft_flush_failed')) }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Build output' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('draft_flush_failed')
    expect(setCurrent).not.toHaveBeenCalled()
  })

  it('rolls the composer back when the authoritative current-item write fails', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined)
    const setCurrent = vi.fn().mockRejectedValue(new Error('current_item_conflict'))
    render(createElement(SessionWorkspace, { session, plans,
      onSetCurrent: setCurrent,
      onSwitchWorkItemNote: vi.fn().mockResolvedValue(rollback) }))

    fireEvent.click(screen.getByRole('button', { name: 'Work on Build output' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('current_item_conflict')
    expect(rollback).toHaveBeenCalledOnce()
  })
})

describe('SessionWorkspace 运行中拆解行动（工单②，文案 2026-10-01 升级）', () => {
  it('提供 onCreatePlanItem 时渲染内联新建控件，未提供时不渲染', () => {
    const withCreate = render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: vi.fn() }))
    expect(screen.getByRole('button', { name: '+ 拆解行动' })).toBeInTheDocument()
    withCreate.unmount()

    render(createElement(SessionWorkspace, { session, plans }))
    expect(screen.queryByRole('button', { name: '+ 拆解行动' })).toBeNull()
  })

  it('提交回调携带修剪后的标题，成功后清空输入', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: create }))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '  写验收报告  ' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 拆解行动' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith('写验收报告'))
    await waitFor(() => expect(screen.getByLabelText('新三级标题')).toHaveValue(''))
  })

  it('失败时保留输入并以 alert 呈现原因（离线创建被禁必须可见）', async () => {
    const create = vi.fn().mockRejectedValue(new Error('offline_formal_creation_forbidden'))
    render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: create }))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '离线想建' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 拆解行动' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('offline_formal_creation_forbidden')
    expect(screen.getByLabelText('新三级标题')).toHaveValue('离线想建')
  })

  it('空标题不提交', () => {
    const create = vi.fn()
    render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: create }))

    const submit = screen.getByRole('button', { name: '+ 拆解行动' })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)

    expect(create).not.toHaveBeenCalled()
  })

  it('拆解是连续动作：成功提交后焦点留在输入框，可直接敲下一条', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: create }))

    const input = screen.getByLabelText('新三级标题') as HTMLInputElement
    const form = input.closest('form')
    expect(form).not.toBeNull()
    input.focus()

    // 回车 = 表单隐式提交（jsdom 不实现隐式提交，直接派发 submit 走同一代码路径）
    fireEvent.change(input, { target: { value: '第一项' } })
    fireEvent.submit(form!)

    await waitFor(() => expect(create).toHaveBeenCalledWith('第一项'))
    await waitFor(() => expect(input).toHaveValue(''))
    // 焦点必须显式交还输入框：连续拆解不能要求用户每次点回输入框
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: '第二项' } })
    fireEvent.submit(form!)

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create).toHaveBeenNthCalledWith(2, '第二项')
    expect(document.activeElement).toBe(input)
  })

  it('在途防重：一次创建未落定前再按回车，不会造出第二个三级项', async () => {
    let release: () => void = () => undefined
    const create = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: create }))

    const input = screen.getByLabelText('新三级标题') as HTMLInputElement
    const form = input.closest('form')!
    // ★ 用**原生派发**而不是 fireEvent：fireEvent 每次都会把 React 的更新冲干净，
    //   两次提交之间必然夹着一次渲染，state 判重就"看起来够用"了。真实回车连击
    //   是两次 keydown 落在同一批渲染里 —— 那时 state 还没回流，只有 ref 拦得住
    //   （实测：把判重换成 state 时，这里会创建出两个 WorkItem）。
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    // 同一个 act 批次内的两次提交：状态更新要等批次结束才回流，
    // 第二次提交看到的 creating 仍是 false —— 与真实连击同形。
    act(() => {
      setValue.call(input, '只此一次')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      submit()
      submit()
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('只此一次')

    await act(async () => { release() })
    await waitFor(() => expect(input).toHaveValue(''))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('在途期间提交按钮禁用（可见反馈，不只是静默拦住）', async () => {
    let release: () => void = () => undefined
    const create = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: create }))

    const input = screen.getByLabelText('新三级标题')
    fireEvent.change(input, { target: { value: '在途' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '+ 拆解行动' })).toBeDisabled())

    await act(async () => { release() })
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('父级轻提示：有 parentTitle 时如实说明挂在哪，缺省 / 空白时整行不渲染', () => {
    const withParent = render(createElement(SessionWorkspace, {
      session, plans, onCreatePlanItem: vi.fn(), parentTitle: 'Ship feature',
    }))
    expect(screen.getByTestId('plan-create-parent-hint'))
      .toHaveTextContent('在「Ship feature」下新建行动项')
    withParent.unmount()

    const blank = render(createElement(SessionWorkspace, {
      session, plans, onCreatePlanItem: vi.fn(), parentTitle: '   ',
    }))
    expect(screen.queryByTestId('plan-create-parent-hint')).toBeNull()
    blank.unmount()

    render(createElement(SessionWorkspace, { session, plans, onCreatePlanItem: vi.fn() }))
    expect(screen.queryByTestId('plan-create-parent-hint')).toBeNull()
  })
})
