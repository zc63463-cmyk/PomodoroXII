/**
 * SyncStatusBar tests (S1-4 / S1-4.1).
 *
 * Verifies status→icon/text mapping, pendingCount, lastSyncedAt, error display,
 * click-to-sync, and local time formatting.
 *
 * createElement usage: vitest lacks JSX transform.
 * vi.hoisted: vi.mock factories hoisted above const declarations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

const mockUseSync = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-sync', () => ({
  useSync: () => mockUseSync(),
}))

// Mock lucide-react to avoid heavy imports + JSX
vi.mock('lucide-react', () => ({
  CheckIcon: () => createElement('span', { 'data-testid': 'check-icon' }),
  CloudOffIcon: () => createElement('span', { 'data-testid': 'off-icon' }),
  AlertCircleIcon: () =>
    createElement('span', { 'data-testid': 'alert-icon' }),
  Loader2Icon: () => createElement('span', { 'data-testid': 'loader-icon' }),
}))

import { SyncStatusBar } from '@/components/layout/sync-status-bar'

describe('SyncStatusBar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('SSB1: idle + lastSyncedAt 显示 "已同步 HH:mm"', () => {
    mockUseSync.mockReturnValue({
      status: 'idle',
      lastSyncedAt: '2026-07-07T08:30:00Z',
      pendingCount: 0,
      error: null,
      sync: vi.fn(),
    })
    render(createElement(SyncStatusBar))
    expect(screen.getByText(/已同步.*08:30/)).toBeInTheDocument()
  })

  it('SSB2: syncing 显示 "同步中" + pendingCount', () => {
    mockUseSync.mockReturnValue({
      status: 'syncing',
      lastSyncedAt: null,
      pendingCount: 2,
      error: null,
      sync: vi.fn(),
    })
    render(createElement(SyncStatusBar))
    expect(screen.getByText(/同步中/)).toBeInTheDocument()
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument()
  })

  it('SSB3: error 显示 error 文案', () => {
    mockUseSync.mockReturnValue({
      status: 'error',
      lastSyncedAt: null,
      pendingCount: 0,
      error: '同步出错',
      sync: vi.fn(),
    })
    render(createElement(SyncStatusBar))
    expect(screen.getByText(/同步出错/)).toBeInTheDocument()
  })

  it('SSB4: infra-error 显示 "网络异常，同步暂停"', () => {
    mockUseSync.mockReturnValue({
      status: 'infra-error',
      lastSyncedAt: null,
      pendingCount: 0,
      error: '网络异常，同步暂停',
      sync: vi.fn(),
    })
    render(createElement(SyncStatusBar))
    expect(screen.getByText(/网络异常，同步暂停/)).toBeInTheDocument()
  })

  it('SSB5: 点击 status bar → sync 调 1 次（idle 时可点）', () => {
    const sync = vi.fn()
    mockUseSync.mockReturnValue({
      status: 'idle',
      lastSyncedAt: null,
      pendingCount: 0,
      error: null,
      sync,
    })
    render(createElement(SyncStatusBar))
    const bar = screen.getByRole('button')
    fireEvent.click(bar)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('SSB6: lastSyncedAt=2026-07-07T08:30:00Z TZ=UTC → 显示 08:30', () => {
    mockUseSync.mockReturnValue({
      status: 'idle',
      lastSyncedAt: '2026-07-07T08:30:00Z',
      pendingCount: 0,
      error: null,
      sync: vi.fn(),
    })
    render(createElement(SyncStatusBar))
    expect(screen.getByText(/已同步.*08:30/)).toBeInTheDocument()
  })
})
