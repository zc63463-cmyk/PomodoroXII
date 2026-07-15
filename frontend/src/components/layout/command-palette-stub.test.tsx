import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigationMocks = vi.hoisted(() => ({
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    push: navigationMocks.push,
  }),
}))

import { CommandPaletteStub } from '@/components/layout/command-palette-stub'

describe('CommandPaletteStub', () => {
  beforeEach(() => {
    navigationMocks.push.mockReset()
  })

  it('filters and opens the Notes workspace', () => {
    const onOpenChange = vi.fn()
    render(createElement(CommandPaletteStub, { open: true, onOpenChange }))

    fireEvent.change(screen.getByRole('combobox', { name: '搜索命令' }), {
      target: { value: '打开笔记' },
    })
    fireEvent.click(screen.getByRole('option', { name: /打开笔记/ }))

    expect(navigationMocks.push).toHaveBeenCalledWith('/notes')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses ArrowDown and Enter to start a new Quick Note', () => {
    const onOpenChange = vi.fn()
    render(createElement(CommandPaletteStub, { open: true, onOpenChange }))
    const search = screen.getByRole('combobox', { name: '搜索命令' })

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(navigationMocks.push).toHaveBeenCalledWith(
      expect.stringMatching(/^\/notes\?compose=\d+$/),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reports when no command matches', () => {
    render(createElement(CommandPaletteStub, { open: true, onOpenChange: vi.fn() }))

    fireEvent.change(screen.getByRole('combobox', { name: '搜索命令' }), {
      target: { value: '全文搜索不存在的内容' },
    })

    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的命令')
  })
})
