import { PXII_STORAGE_KEYS } from '@/lib/platform'

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

export const tokenStorage = {
  getMasterToken(): string | null {
    if (!isBrowser()) return null
    return localStorage.getItem(PXII_STORAGE_KEYS.masterToken)
  },
  setMasterToken(token: string): void {
    if (!isBrowser()) return
    localStorage.setItem(PXII_STORAGE_KEYS.masterToken, token)
  },
  getSpaceToken(): string | null {
    if (!isBrowser()) return null
    return localStorage.getItem(PXII_STORAGE_KEYS.spaceToken)
  },
  setSpaceToken(token: string): void {
    if (!isBrowser()) return
    localStorage.setItem(PXII_STORAGE_KEYS.spaceToken, token)
  },
  getCurrentSpaceId(): string | null {
    if (!isBrowser()) return null
    return localStorage.getItem(PXII_STORAGE_KEYS.currentSpaceId)
  },
  setCurrentSpaceId(spaceId: string): void {
    if (!isBrowser()) return
    localStorage.setItem(PXII_STORAGE_KEYS.currentSpaceId, spaceId)
  },
  clearAll(): void {
    if (!isBrowser()) return
    localStorage.removeItem(PXII_STORAGE_KEYS.masterToken)
    localStorage.removeItem(PXII_STORAGE_KEYS.spaceToken)
    localStorage.removeItem(PXII_STORAGE_KEYS.currentSpaceId)
  },
  clearSpace(): void {
    if (!isBrowser()) return
    localStorage.removeItem(PXII_STORAGE_KEYS.spaceToken)
    localStorage.removeItem(PXII_STORAGE_KEYS.currentSpaceId)
  },
} as const
