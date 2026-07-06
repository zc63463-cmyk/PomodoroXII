'use client'

/**
 * CrossTabSyncProvider (F0 §3.6).
 *
 * Listens for storage events on pxii_current_space_id and reloads the page
 * when another tab switches spaces. S0 accepts full page reload.
 */

import { type ReactNode, createElement, Fragment, useEffect } from 'react'
import { PXII_STORAGE_KEYS } from '@/lib/platform'

export function CrossTabSyncProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === PXII_STORAGE_KEYS.currentSpaceId && e.newValue) {
        window.location.reload()
      }
    }

    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return createElement(Fragment, null, children)
}
