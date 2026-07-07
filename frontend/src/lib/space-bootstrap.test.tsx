/**
 * SpaceBootstrap tests (S1-4).
 *
 * Verifies bootstrapSyncEngine is called after hydrateSpace succeeds,
 * and NOT called when hydrate fails or no master token exists.
 *
 * Uses React.createElement instead of JSX because vitest config lacks
 * a React JSX transform plugin (tsconfig jsx: preserve).
 *
 * Note: vi.hoisted is required because vi.mock factories are hoisted
 * above const declarations (temporal dead zone).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  bootstrapSyncEngine: vi.fn(),
  hydrateAuth: vi.fn(),
  hydrateSpace: vi.fn().mockResolvedValue(undefined),
  setReady: vi.fn(),
  setFailed: vi.fn(),
  getMasterToken: vi.fn().mockReturnValue('master-token'),
}))

vi.mock('@/lib/sync', () => ({
  bootstrapSyncEngine: mocks.bootstrapSyncEngine,
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (sel: (s: { hydrate: () => void }) => unknown) =>
    sel({ hydrate: mocks.hydrateAuth }),
}))

// ★关键：useSpaceStore 既可调用又有 getState（D14）
vi.mock('@/stores/space-store', () => {
  const store = (
    sel: (s: {
      hydrate: () => Promise<void>
      currentSpaceId: string | null
    }) => unknown,
  ) => sel({ hydrate: mocks.hydrateSpace, currentSpaceId: 'space-1' })
  store.getState = () => ({
    hydrate: mocks.hydrateSpace,
    currentSpaceId: 'space-1',
  })
  return { useSpaceStore: store }
})

vi.mock('@/lib/bootstrap-store', () => {
  const store = (
    sel: (s: { setReady: () => void; setFailed: (m: string) => void }) => unknown,
  ) => sel({ setReady: mocks.setReady, setFailed: mocks.setFailed })
  return { useBootstrapStore: store }
})

vi.mock('@/lib/token-storage', () => ({
  tokenStorage: { getMasterToken: () => mocks.getMasterToken() },
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { SpaceBootstrap } from '@/lib/space-bootstrap'

describe('SpaceBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hydrateSpace.mockResolvedValue(undefined)
    mocks.getMasterToken.mockReturnValue('master-token')
  })

  it('SB1: hydrate 成功后调用 bootstrapSyncEngine 并 setReady', async () => {
    render(createElement(SpaceBootstrap, null, 'test'))
    await waitFor(() => {
      expect(mocks.bootstrapSyncEngine).toHaveBeenCalledWith('space-1')
      expect(mocks.setReady).toHaveBeenCalledTimes(1)
    })
  })

  it('SB2: hydrate 失败时不调 bootstrapSyncEngine，调 setFailed', async () => {
    mocks.hydrateSpace.mockRejectedValueOnce(new Error('db broken'))
    render(createElement(SpaceBootstrap, null, 'test'))
    await waitFor(() => {
      expect(mocks.bootstrapSyncEngine).not.toHaveBeenCalled()
      expect(mocks.setFailed).toHaveBeenCalledWith('db broken')
    })
  })

  it('SB3: 无 master token 时不调 bootstrapSyncEngine', async () => {
    mocks.getMasterToken.mockReturnValue(null)
    render(createElement(SpaceBootstrap, null, 'test'))
    await waitFor(() => expect(mocks.setReady).toHaveBeenCalledTimes(1))
    expect(mocks.bootstrapSyncEngine).not.toHaveBeenCalled()
  })
})
