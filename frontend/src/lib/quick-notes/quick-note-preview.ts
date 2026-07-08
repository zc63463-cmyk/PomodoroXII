'use client'

import { useBootstrapStore } from '@/lib/bootstrap-store'
import { PXII_STORAGE_KEYS } from '@/lib/platform'
import { spaceDBManager } from '@/services/space-db'

const PREVIEW_QUERY = 'quickNotePreview'
const PREVIEW_STORAGE_KEY = 'pxii_quick_notes_preview'
const PREVIEW_SPACE_ID = 'quick-notes-preview'
const PREVIEW_MASTER_TOKEN = 'quick-note-preview-master-token'
const PREVIEW_SPACE_TOKEN = 'quick-note-preview-space-token'
const PREVIEW_ROUTE_ALLOWLIST = new Set(['/quick-notes', '/settings'])

function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development'
}

function hasBrowserPreviewFlag(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  return (
    params.get(PREVIEW_QUERY) === '1' ||
    window.localStorage.getItem(PREVIEW_STORAGE_KEY) === '1'
  )
}

export function isQuickNotePreviewEnabled(): boolean {
  if (!isDevelopment()) return false
  return (
    process.env.NEXT_PUBLIC_QUICK_NOTES_PREVIEW === '1' ||
    hasBrowserPreviewFlag()
  )
}

export function isQuickNotePreviewRoute(pathname: string): boolean {
  return PREVIEW_ROUTE_ALLOWLIST.has(pathname)
}

export async function ensureQuickNotePreviewSpace(): Promise<void> {
  if (!isQuickNotePreviewEnabled()) return

  window.localStorage.setItem(PREVIEW_STORAGE_KEY, '1')
  clearLegacyPreviewTokens()

  if (spaceDBManager.currentSpaceId !== PREVIEW_SPACE_ID) {
    await spaceDBManager.switchTo(PREVIEW_SPACE_ID, { dispatchEvent: false })
  }

  useBootstrapStore.getState().setReady()
}

function clearLegacyPreviewTokens(): void {
  const { masterToken, spaceToken, currentSpaceId } = PXII_STORAGE_KEYS

  if (window.localStorage.getItem(masterToken) === PREVIEW_MASTER_TOKEN) {
    window.localStorage.removeItem(masterToken)
  }
  if (window.localStorage.getItem(spaceToken) === PREVIEW_SPACE_TOKEN) {
    window.localStorage.removeItem(spaceToken)
  }
  if (window.localStorage.getItem(currentSpaceId) === PREVIEW_SPACE_ID) {
    window.localStorage.removeItem(currentSpaceId)
  }
}
