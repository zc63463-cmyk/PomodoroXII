/**
 * Logout lifecycle (F0 §5.7).
 *
 * S0-3 skeleton — no 17 store reset (S0-4 adds).
 * Order: syncEngine.destroy → queryClient.clear → auth/space reset
 *        → spaceDBManager.close → metaDB.clearSpaces → tokenStorage.clearAll → redirect
 */

import { queryClient } from '@/lib/query-client'
import { syncEngineStub as syncEngine } from '@/lib/sync/types'
import { useAuthStore } from '@/stores/auth-store'
import { useSpaceStore } from '@/stores/space-store'
import { spaceDBManager } from '@/services/space-db'
import { metaDB } from '@/services/meta-database'
import { tokenStorage } from '@/lib/token-storage'

export async function performLogout(): Promise<void> {
  // 1. Destroy sync engine (S0 stub no-op)
  syncEngine.destroy()

  // 2. Clear React Query cache
  queryClient.clear()

  // 3. (S0-4: 17 business store reset — STORE_RESET_ORDER)
  //    S0-3 skips this step

  // 3b. Reset auth-store + space-store (before token clearing)
  useAuthStore.getState().reset()
  useSpaceStore.getState().reset()

  // 4. Close current Dexie DB connection
  spaceDBManager.close()

  // 5. Clear space list cache
  await metaDB.clearSpaces()

  // 6. Clear localStorage tokens (last — above steps may need token)
  tokenStorage.clearAll()

  // 7. Redirect to login
  window.location.href = '/login'
}
