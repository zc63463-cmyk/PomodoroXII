import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  locate: vi.fn().mockResolvedValue(null),
  device: vi.fn().mockResolvedValue('device-a'),
  tab: vi.fn().mockResolvedValue({ deviceId: 'device-a', tabId: 'tab-a' }),
  close: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/active-session-api', () => ({
  activeSessionApi: {
    locate: mocks.locate,
    start: vi.fn(), heartbeat: vi.fn(), takeover: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    end: vi.fn(), updateNote: vi.fn(), setCurrentPlanItem: vi.fn(), setCompletionDraft: vi.fn(),
    addPlanItem: vi.fn(), removePlanItem: vi.fn(),
  },
}))
vi.mock('@/services/meta-database', () => ({ metaDB: {} }))
vi.mock('./tab-identity', () => ({
  getDeviceIdentity: mocks.device,
  openTabIdentity: mocks.tab,
  closeTabIdentity: mocks.close,
}))

import { ActiveSessionProvider, useActiveSessionCoordinator } from './active-session-provider'

function Consumer() {
  const coordinator = useActiveSessionCoordinator()
  return createElement('span', { 'data-testid': 'ready' }, coordinator ? 'ready' : 'missing')
}

describe('ActiveSessionProvider', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('bootstraps one coordinator and closes the Tab on pagehide/unmount', async () => {
    const view = render(createElement(
      ActiveSessionProvider,
      null,
      createElement(Consumer),
    ))
    await waitFor(() => expect(view.getByTestId('ready')).toHaveTextContent('ready'))
    expect(mocks.locate).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('pagehide'))
    view.unmount()
    expect(mocks.close).toHaveBeenCalled()
  })
})
