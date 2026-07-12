/**
 * Logout lifecycle (F0 §5.7).
 *
 * Order: flush draft → syncEngine.destroy → queryClient.clear → 17 store reset
 *        → auth/space/bootstrap reset → spaceDBManager.close
 *        → metaDB.clearSpaces → tokenStorage.clearAll → redirect
 */

import { queryClient } from '@/lib/query-client'
import { syncEngine } from '@/lib/sync'
import { useAuthStore } from '@/stores/auth-store'
import { useSpaceStore } from '@/stores/space-store'
import { useBootstrapStore } from '@/lib/bootstrap-store'
import { STORE_RESET_FNS } from '@/stores'
import { spaceDBManager } from '@/services/space-db'
import { metaDB } from '@/services/meta-database'
import { tokenStorage } from '@/lib/token-storage'

export async function performLogout(): Promise<void> {
  // 1. Flush while route listeners and current Space context are still active.
  await spaceDBManager.flushBeforeClose()

  // 2. Destroy sync engine (S0 stub no-op)
  syncEngine.destroy()

  // 3. Clear React Query cache
  queryClient.clear()

  // 4. Reset 17 business stores (F0 §6.3c / 附录 E — ordered reset)
  STORE_RESET_FNS.forEach((fn) => fn())

  // 4b. Reset auth-store + space-store + bootstrap-store (before token clearing)
  useAuthStore.getState().reset()
  useSpaceStore.getState().reset()
  useBootstrapStore.getState().reset()

  // 5. Close current Space after the flush and resets complete.
  spaceDBManager.close()

  // 6. Clear space list cache
  await metaDB.clearSpaces()

  // 7. Clear localStorage tokens (last — above steps may need token)
  tokenStorage.clearAll()

  // 8. Redirect to login
  window.location.href = '/login'
}
