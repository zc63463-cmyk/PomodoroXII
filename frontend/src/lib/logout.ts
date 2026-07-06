/**
 * Logout lifecycle (F0 §5.7).
 *
 * Order: syncEngine.destroy → queryClient.clear → 17 store reset
 *        → auth/space/bootstrap reset → spaceDBManager.close
 *        → metaDB.clearSpaces → tokenStorage.clearAll → redirect
 */

import { queryClient } from '@/lib/query-client'
import { syncEngineStub as syncEngine } from '@/lib/sync/types'
import { useAuthStore } from '@/stores/auth-store'
import { useSpaceStore } from '@/stores/space-store'
import { useBootstrapStore } from '@/lib/bootstrap-store'
import { STORE_RESET_FNS } from '@/stores'
import { spaceDBManager } from '@/services/space-db'
import { metaDB } from '@/services/meta-database'
import { tokenStorage } from '@/lib/token-storage'

export async function performLogout(): Promise<void> {
  // 1. Destroy sync engine (S0 stub no-op)
  syncEngine.destroy()

  // 2. Clear React Query cache
  queryClient.clear()

  // 3. Reset 17 business stores (F0 §6.3c / 附录 E — ordered reset)
  STORE_RESET_FNS.forEach((fn) => fn())

  // 3b. Reset auth-store + space-store + bootstrap-store (before token clearing)
  useAuthStore.getState().reset()
  useSpaceStore.getState().reset()
  useBootstrapStore.getState().reset()

  // 4. Close current Dexie DB connection
  spaceDBManager.close()

  // 5. Clear space list cache
  await metaDB.clearSpaces()

  // 6. Clear localStorage tokens (last — above steps may need token)
  tokenStorage.clearAll()

  // 7. Redirect to login
  window.location.href = '/login'
}
