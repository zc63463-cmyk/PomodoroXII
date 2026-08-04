'use client'

/**
 * CrossTabSyncProvider (F0 §3.6).
 *
 * Listens for storage events on pxii_current_space_id and reloads the page
 * when another tab switches spaces. S0 accepts full page reload.
 */

import { type ReactNode, createElement, Fragment, useEffect } from 'react'
import { PXII_STORAGE_KEYS } from '@/lib/platform'

export const PXII_ACTIVE_SESSION_INVALIDATED_EVENT = 'pxii:active-session-invalidated'

export function CrossTabSyncProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === PXII_STORAGE_KEYS.currentSpaceId && e.newValue) {
        window.location.reload()
      }
    }

    window.addEventListener('storage', onStorage)
    const channel = typeof BroadcastChannel === 'undefined'
      ? null : new BroadcastChannel('pxii:active-session')
    const onActiveSessionMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null
      if (data?.type !== 'locator-changed') return
      // Cross-tab transport carries only an invalidation signal. The coordinator performs locate().
      window.dispatchEvent(new CustomEvent(PXII_ACTIVE_SESSION_INVALIDATED_EVENT))
    }
    if (channel) {
      if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onActiveSessionMessage)
      else channel.onmessage = onActiveSessionMessage
    }
    return () => {
      window.removeEventListener('storage', onStorage)
      if (channel) {
        if (typeof channel.removeEventListener === 'function') channel.removeEventListener('message', onActiveSessionMessage)
        else channel.onmessage = null
      }
      channel?.close()
    }
  }, [])

  return createElement(Fragment, null, children)
}
