// PomodoroXII platform constants — smoke tests (F0 appendix B / HC-7).

import { describe, it, expect } from 'vitest'
import {
  API_V1_PREFIX,
  META_DB_NAME,
  PXII_SPACE_SWITCHED_EVENT,
  PXII_STORAGE_KEYS,
  dexieDbNameForSpace,
} from '@/lib/platform'

describe('platform constants (F0 alignment)', () => {
  it('exposes HC-7 localStorage keys', () => {
    expect(PXII_STORAGE_KEYS.masterToken).toBe('pxii_master_token')
    expect(PXII_STORAGE_KEYS.spaceToken).toBe('pxii_space_token')
    expect(PXII_STORAGE_KEYS.currentSpaceId).toBe('pxii_current_space_id')
  })

  it('uses /api/v1 REST prefix', () => {
    expect(API_V1_PREFIX).toBe('/api/v1')
  })

  it('names meta and per-space Dexie DBs per F0', () => {
    expect(META_DB_NAME).toBe('pxii_meta')
    expect(dexieDbNameForSpace('space-1')).toBe('pomodoroxi_space-1')
  })

  it('defines space-switched event for on-space-switch (S0-4)', () => {
    expect(PXII_SPACE_SWITCHED_EVENT).toBe('pxii:space-switched')
  })
})
