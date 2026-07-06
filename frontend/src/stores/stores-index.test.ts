/**
 * stores/index.ts tests (F0 §6.3c / 附录 E).
 *
 * Verifies STORE_RESET_ORDER and STORE_RESET_FNS correctness.
 */

import { describe, it, expect } from 'vitest'
import { STORE_RESET_ORDER, STORE_RESET_FNS } from '@/stores'

describe('stores/index.ts', () => {
  it('STORE_RESET_ORDER has 17 items matching F0 appendix E', () => {
    expect(STORE_RESET_ORDER).toEqual([
      'sync',
      'timer',
      'session',
      'task',
      'note',
      'quick-note',
      'folder',
      'habit',
      'schedule',
      'time-block',
      'reflection',
      'stats',
      'search',
      'trash',
      'settings',
      'ui',
      'app',
    ])
  })

  it('STORE_RESET_FNS has 17 functions', () => {
    expect(STORE_RESET_FNS).toHaveLength(17)
  })

  it('STORE_RESET_FNS all callable without throw', () => {
    STORE_RESET_FNS.forEach((fn) => {
      expect(() => fn()).not.toThrow()
    })
  })
})
