/**
 * SpaceSwitcher tests.
 *
 * Regression: previously the only loadSpaces call site was /select-space,
 * so spaces created after store hydration never appeared in the dropdown
 * (2026-09-12, engineering-debt item #1). The fix refreshes the list every
 * time the dropdown opens; failure must be silent (stale cache stays).
 *
 * The ui/dropdown-menu module is stubbed: the test captures the
 * onOpenChange prop and invokes it directly, avoiding base-ui positioning
 * in jsdom while still pinning the wiring (removing the prop fails SW2).
 *
 * createElement usage: vitest lacks JSX transform.
 * vi.hoisted: vi.mock factories hoisted above const declarations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'

const mockPush = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

const mockToastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { error: mockToastError },
}))

// Mock lucide-react to avoid heavy imports + JSX
vi.mock('lucide-react', () => ({
  CheckIcon: () => createElement('span', { 'data-testid': 'check-icon' }),
  ChevronDownIcon: () => createElement('span', { 'data-testid': 'chevron-icon' }),
  PlusIcon: () => createElement('span', { 'data-testid': 'plus-icon' }),
}))

interface MockSpace {
  id: string
  name: string
  has_password: boolean
}

const mockStore = vi.hoisted(() => ({
  spaces: [] as MockSpace[],
  currentSpaceId: null as string | null,
  isLoading: false,
  loadSpaces: vi.fn(),
  selectSpace: vi.fn(),
}))
vi.mock('@/stores/space-store', () => ({
  useSpaceStore: (selector: (s: typeof mockStore) => unknown) =>
    selector(mockStore),
  selectCurrentSpace: (s: typeof mockStore): MockSpace | null =>
    s.spaces.find((sp) => sp.id === s.currentSpaceId) ?? null,
}))

const dropdownMock = vi.hoisted(() => ({
  onOpenChange: undefined as undefined | ((open: boolean) => void),
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: (props: {
    onOpenChange?: (open: boolean) => void
    children?: ReactNode
  }) => {
    dropdownMock.onOpenChange = props.onOpenChange
    return createElement('div', { 'data-testid': 'dropdown-root' }, props.children)
  },
  DropdownMenuTrigger: (props: { children?: ReactNode }) =>
    createElement('div', {}, props.children),
  DropdownMenuContent: (props: { children?: ReactNode }) =>
    createElement('div', {}, props.children),
  DropdownMenuItem: (props: { onClick?: () => void; children?: ReactNode }) =>
    createElement('button', { onClick: props.onClick }, props.children),
  DropdownMenuSeparator: () => createElement('hr'),
}))

import { SpaceSwitcher } from '@/components/layout/space-switcher'

const SPACES: MockSpace[] = [
  { id: 'sp-1', name: '主空间', has_password: false },
  { id: 'sp-2', name: '工作', has_password: false },
]

describe('SpaceSwitcher', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    dropdownMock.onOpenChange = undefined
    mockStore.spaces = [...SPACES]
    mockStore.currentSpaceId = 'sp-1'
    mockStore.isLoading = false
    mockStore.loadSpaces.mockResolvedValue(undefined)
    mockStore.selectSpace.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it('SW1: 渲染缓存空间列表 + 当前空间打勾', () => {
    render(createElement(SpaceSwitcher))
    // 当前空间名同时出现在 trigger 与列表项中
    expect(screen.getAllByText('主空间')).toHaveLength(2)
    expect(screen.getByText('工作')).toBeInTheDocument()
    expect(screen.getByTestId('check-icon')).toBeInTheDocument()
  })

  it('SW2: 打开下拉 → loadSpaces 刷新 1 次（回归：新空间曾永不出现）', async () => {
    render(createElement(SpaceSwitcher))
    expect(mockStore.loadSpaces).not.toHaveBeenCalled()
    await act(async () => {
      dropdownMock.onOpenChange?.(true)
    })
    expect(mockStore.loadSpaces).toHaveBeenCalledTimes(1)
  })

  it('SW3: 关闭下拉 → 不触发 loadSpaces', async () => {
    render(createElement(SpaceSwitcher))
    await act(async () => {
      dropdownMock.onOpenChange?.(false)
    })
    expect(mockStore.loadSpaces).not.toHaveBeenCalled()
  })

  it('SW4: 刷新失败静默 —— 不抛出、缓存列表仍可见', async () => {
    mockStore.loadSpaces.mockRejectedValue(new Error('network down'))
    render(createElement(SpaceSwitcher))
    await act(async () => {
      dropdownMock.onOpenChange?.(true)
    })
    expect(mockStore.loadSpaces).toHaveBeenCalledTimes(1)
    // stale cache still rendered, no error surfaced
    expect(screen.getAllByText('主空间')).toHaveLength(2)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('SW5: 点击空间项 → selectSpace（既有行为保持）', async () => {
    render(createElement(SpaceSwitcher))
    await act(async () => {
      screen.getByText('工作').click()
    })
    expect(mockStore.selectSpace).toHaveBeenCalledWith('sp-2')
  })
})
