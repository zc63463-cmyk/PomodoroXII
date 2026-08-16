import Dexie from 'dexie'

import type { PomodoroXIDB } from '@/services/database'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'

export const SYNC_CLIENT_META_KEY = 'sync_v2_client_id' as const

export async function getOrCreateClientId(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<string> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  return db.transaction('rw', db.syncMeta, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const existing = await db.syncMeta.get(SYNC_CLIENT_META_KEY)
    if (existing?.value) return existing.value
    const candidate = crypto.randomUUID()
    try {
      await db.syncMeta.add({ key: SYNC_CLIENT_META_KEY, value: candidate })
    } catch (error: unknown) {
      if (!(error instanceof Dexie.ConstraintError)) throw error
    }
    const winner = await db.syncMeta.get(SYNC_CLIENT_META_KEY)
    if (!winner?.value) throw new Error('sync client ID creation lost without a winner')
    return winner.value
  })
}
