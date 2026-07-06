'use client'

import { useMemo } from 'react'
import { useSpaceStore } from '@/stores/space-store'
import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'

/**
 * Hook for accessing the current space's Dexie DB (F0 §3.2.2).
 *
 * Returns spaceDBManager.current (real DB, not Proxy) so that React's
 * useMemo dependency on spaceId triggers re-computation on space switch.
 *
 * @throws if no space is selected
 */
export function useDexieDB(): PomodoroXIDB {
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  return useMemo(() => {
    if (!spaceId) {
      throw new Error('useDexieDB: No space selected. Call selectSpace first.')
    }
    return spaceDBManager.current
  }, [spaceId])
}
