/**
 * ConflictPanel tests (S1-4).
 *
 * Verifies the conflict panel renders when status='conflict' + conflicts
 * non-empty, and that resolveConflict is called with correct args.
 * S1-Hard-3: outboxId=-1 (pre-push dirty) buttons must be clickable.
 *
 * Uses React.createElement instead of JSX because vitest config lacks
 * a React JSX transform plugin (tsconfig jsx: preserve).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

const mockUseSync = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-sync', () => ({
  useSync: () => mockUseSync(),
}))

// D17: mock ui primitives 以避免加载含 JSX 的源文件（vitest 无 JSX transform）
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) => children,
  DialogHeader: ({ children }: { children: React.ReactNode }) => children,
  DialogTitle: ({ children }: { children: React.ReactNode }) => children,
  DialogDescription: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@/components/ui/button', () => ({
  Button: (props: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => {
    const { children, onClick, disabled, ...rest } = props
    return createElement('button', { onClick, disabled, ...rest }, children)
  },
}))

import { ConflictPanel } from '@/components/sync/conflict-panel'

const conflict = {
  outboxId: 1,
  entityType: 'task',
  entityId: 't1',
  localVersion: {},
  remoteVersion: {},
  conflictType: 'version' as const,
}

describe('ConflictPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('CP1: status=conflict + conflicts 非空 → 渲染条目与按钮', () => {
    mockUseSync.mockReturnValue({ status: 'conflict', conflicts: [conflict], resolveConflict: vi.fn() })
    render(createElement(ConflictPanel))
    expect(screen.getByText(/task/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /接受远端/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保留本地/ })).toBeInTheDocument()
  })

  it('CP2: status != conflict → 不渲染条目', () => {
    mockUseSync.mockReturnValue({ status: 'idle', conflicts: [], resolveConflict: vi.fn() })
    const { container } = render(createElement(ConflictPanel))
    expect(container.textContent).not.toMatch(/task/)
  })

  it('CP3: 点击"接受远端"调 resolveConflict(outboxId, accept-remote)', () => {
    const resolveConflict = vi.fn()
    mockUseSync.mockReturnValue({ status: 'conflict', conflicts: [conflict], resolveConflict })
    render(createElement(ConflictPanel))
    fireEvent.click(screen.getByRole('button', { name: /接受远端/ }))
    expect(resolveConflict).toHaveBeenCalledWith(
      1,
      'accept-remote',
      { entityType: 'task', entityId: 't1' },
    )
  })

  it('CP4: outboxId=-1（pre-push dirty）按钮可点（S1-Hard-3）', () => {
    const prePush = { ...conflict, outboxId: -1 }
    mockUseSync.mockReturnValue({ status: 'conflict', conflicts: [prePush], resolveConflict: vi.fn() })
    render(createElement(ConflictPanel))
    expect(screen.getByRole('button', { name: /接受远端/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /保留本地/ })).not.toBeDisabled()
  })
})
