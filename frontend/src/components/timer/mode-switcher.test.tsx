import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModeSwitcher } from './mode-switcher'

describe('ModeSwitcher（双体系兼容）', () => {
  it('渲染 5 个模式按钮，当前模式呈选中态（aria-pressed）', () => {
    render(createElement(ModeSwitcher, { mode: 'work', onChange: vi.fn() }))

    const group = screen.getByRole('group', { name: '模式切换' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', 'true')
    for (const label of ['短休息', '长休息', '自由计时', '倒计时']) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('点击其它模式只回调目标模式（不自行改状态）', () => {
    const onChange = vi.fn()
    render(createElement(ModeSwitcher, { mode: 'work', onChange }))

    fireEvent.click(screen.getByRole('button', { name: '短休息' }))
    expect(onChange).toHaveBeenCalledWith('short_break')
    // 受控组件：未收到新 props 前选中态不变
    expect(screen.getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('受控更新后选中态跟随 props', () => {
    const view = render(createElement(ModeSwitcher, { mode: 'work', onChange: vi.fn() }))
    view.rerender(createElement(ModeSwitcher, { mode: 'long_break', onChange: vi.fn() }))

    expect(screen.getByRole('button', { name: '长休息' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '专注' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('disabled 时按钮全部不可点', () => {
    const onChange = vi.fn()
    render(createElement(ModeSwitcher, { mode: 'work', onChange, disabled: true }))

    const button = screen.getByRole('button', { name: '自由计时' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('modes 子集只渲染给定模式（子集外不出现）', () => {
    render(createElement(ModeSwitcher, {
      mode: 'work', onChange: vi.fn(), modes: ['work', 'short_break'] as const,
    }))

    expect(screen.getByRole('button', { name: '专注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '短休息' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '倒计时' })).toBeNull()
  })
})
