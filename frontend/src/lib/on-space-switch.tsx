'use client'

/**
 * SpaceSwitchProvider (F0 §6.3 / F1-D15).
 *
 * Listens for pxii:space-switched event and executes the hard order:
 * ② syncEngine.destroy() → ③ queryClient.clear() → ④ STORE_RESET_FNS.forEach()
 * → ⑥ bootstrapSyncEngine(spaceId)
 *
 * Note: ① switchTo is already completed in space-store.selectSpace() before
 * the event is dispatched. ⑤ CrossTabSyncProvider handles cross-tab notification.
 */

import { type ReactNode, createElement, Fragment, useEffect } from 'react'
import { queryClient } from '@/lib/query-client'
import { syncEngine, bootstrapSyncEngine } from '@/lib/sync'
import { useSpaceStore } from '@/stores/space-store'
import { STORE_RESET_FNS } from '@/stores'
import { PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'

export function SpaceSwitchProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const handler = () => {
      // ② syncEngine.destroy() — destroy old sync engine
      syncEngine.destroy()

      // ③ queryClient.clear() — clear all React Query cache
      queryClient.clear()

      // ④ Ordered reset — execute 17 store resets per STORE_RESET_ORDER (附录 E)
      STORE_RESET_FNS.forEach((fn) => fn())

      // ⑥ bootstrap 新引擎（F1-D15 硬顺序：destroy → clear → reset → bootstrap）
      const spaceId = useSpaceStore.getState().currentSpaceId
      if (spaceId) bootstrapSyncEngine(spaceId)
    }

    window.addEventListener(PXII_SPACE_SWITCHED_EVENT, handler)
    return () => window.removeEventListener(PXII_SPACE_SWITCHED_EVENT, handler)
  }, [])

  return createElement(Fragment, null, children)
}
