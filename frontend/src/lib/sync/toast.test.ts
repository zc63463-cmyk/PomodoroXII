/**
 * Sync toast tests (S1-4).
 *
 * Verifies notifyRemoteWin/notifyCircularRef invoke sonner toast
 * with correct level (info/warning) and Chinese message.
 * D19: count <= 0 → no toast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockToast = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: mockToast,
}))

import { notifyRemoteWin, notifyCircularRef } from '@/lib/sync/toast'

describe('sync toast', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T1: notifyRemoteWin(3) 调 toast.info 含 "远端胜出" + "3"', () => {
    notifyRemoteWin(3)
    expect(mockToast.info).toHaveBeenCalledTimes(1)
    expect(mockToast.info.mock.calls[0][0]).toMatch(/远端胜出/)
    expect(mockToast.info.mock.calls[0][0]).toMatch(/3/)
  })

  it('T2: notifyCircularRef(2) 调 toast.warning 含 "循环引用" + "2"', () => {
    notifyCircularRef(2)
    expect(mockToast.warning).toHaveBeenCalledTimes(1)
    expect(mockToast.warning.mock.calls[0][0]).toMatch(/循环引用/)
    expect(mockToast.warning.mock.calls[0][0]).toMatch(/2/)
  })

  it('T3: notifyRemoteWin(0) 不调 toast（D19）', () => {
    notifyRemoteWin(0)
    expect(mockToast.info).not.toHaveBeenCalled()
  })

  it('T4: notifyCircularRef(0) 不调 toast（D19）', () => {
    notifyCircularRef(0)
    expect(mockToast.warning).not.toHaveBeenCalled()
  })
})
