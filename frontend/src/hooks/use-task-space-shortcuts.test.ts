import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTaskSpaceShortcuts } from './use-task-space-shortcuts'

function Harness({ handlers }: { handlers: { create: () => void; toggle: () => void; focus: () => void } }) {
  useTaskSpaceShortcuts({
    onCreateWorkItem: handlers.create,
    onToggleCollapse: handlers.toggle,
    onStartFocus: handlers.focus,
  })
  return null
}

describe('useTaskSpaceShortcuts', () => {
  it('n opens create, e toggles collapse, s clicks the launch button', () => {
    const create = vi.fn()
    const toggle = vi.fn()
    const focus = vi.fn()
    render(createElement('div', null,
      createElement(Harness, { handlers: { create, toggle, focus } }),
      createElement('button', { 'data-launch-session': true, onClick: focus }, 'Start focus session'),
    ))

    fireEvent.keyDown(window, { key: 'n' })
    fireEvent.keyDown(window, { key: 'e' })
    fireEvent.keyDown(window, { key: 's' })

    expect(create).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('ignores shortcuts while typing in a form field', () => {
    const create = vi.fn()
    const toggle = vi.fn()
    render(createElement('div', null,
      createElement(Harness, { handlers: { create, toggle, focus: vi.fn() } }),
      createElement('input', { 'aria-label': 'title input' }),
    ))
    const input = screen.getByLabelText('title input')
    fireEvent.keyDown(input, { key: 'n' })
    fireEvent.keyDown(input, { key: 'e' })
    expect(create).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('ignores modifier combos and a disabled launch button', () => {
    const create = vi.fn()
    const focus = vi.fn()
    render(createElement('div', null,
      createElement(Harness, { handlers: { create, toggle: vi.fn(), focus } }),
      createElement('button', { 'data-launch-session': true, disabled: true, onClick: focus }, 'Start focus session'),
    ))
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    fireEvent.keyDown(window, { key: 's' })
    expect(create).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
