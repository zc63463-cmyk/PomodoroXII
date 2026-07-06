import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tokenStorage } from '@/lib/token-storage'
import { PXII_STORAGE_KEYS } from '@/lib/platform'

describe('tokenStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null for all getters when nothing is set', () => {
    expect(tokenStorage.getMasterToken()).toBeNull()
    expect(tokenStorage.getSpaceToken()).toBeNull()
    expect(tokenStorage.getCurrentSpaceId()).toBeNull()
  })

  it('sets and gets master token using PXII_STORAGE_KEYS', () => {
    tokenStorage.setMasterToken('master-abc')
    expect(tokenStorage.getMasterToken()).toBe('master-abc')
    expect(localStorage.getItem(PXII_STORAGE_KEYS.masterToken)).toBe('master-abc')
  })

  it('sets and gets space token', () => {
    tokenStorage.setSpaceToken('space-xyz')
    expect(tokenStorage.getSpaceToken()).toBe('space-xyz')
  })

  it('sets and gets current space id', () => {
    tokenStorage.setCurrentSpaceId('space-1')
    expect(tokenStorage.getCurrentSpaceId()).toBe('space-1')
  })

  it('clearAll removes all three keys', () => {
    tokenStorage.setMasterToken('m')
    tokenStorage.setSpaceToken('s')
    tokenStorage.setCurrentSpaceId('id')
    tokenStorage.clearAll()
    expect(tokenStorage.getMasterToken()).toBeNull()
    expect(tokenStorage.getSpaceToken()).toBeNull()
    expect(tokenStorage.getCurrentSpaceId()).toBeNull()
  })

  it('clearSpace removes only space token and space id, keeps master', () => {
    tokenStorage.setMasterToken('m')
    tokenStorage.setSpaceToken('s')
    tokenStorage.setCurrentSpaceId('id')
    tokenStorage.clearSpace()
    expect(tokenStorage.getMasterToken()).toBe('m')
    expect(tokenStorage.getSpaceToken()).toBeNull()
    expect(tokenStorage.getCurrentSpaceId()).toBeNull()
  })

  it('SSR-safe: returns null / no-op when window is undefined', () => {
    const originalWindow = globalThis.window
    vi.stubGlobal('window', undefined)
    try {
      expect(tokenStorage.getMasterToken()).toBeNull()
      expect(tokenStorage.getSpaceToken()).toBeNull()
      expect(tokenStorage.getCurrentSpaceId()).toBeNull()
      expect(() => tokenStorage.setMasterToken('x')).not.toThrow()
      expect(() => tokenStorage.clearAll()).not.toThrow()
      expect(() => tokenStorage.clearSpace()).not.toThrow()
    } finally {
      vi.stubGlobal('window', originalWindow)
    }
  })
})
