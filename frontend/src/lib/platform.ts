/**
 * Platform shell constants (F0-A §0.2 HC-7, 附录 B; S0-2+ consumes).
 */

/** localStorage keys for dual JWT auth */
export const PXII_STORAGE_KEYS = {
  masterToken: 'pxii_master_token',
  spaceToken: 'pxii_space_token',
  currentSpaceId: 'pxii_current_space_id',
} as const

/** Business REST prefix (next.config rewrites `/api/*` → backend) */
export const API_V1_PREFIX = '/api/v1'

/** Global meta IndexedDB for space list cache (F0 §3.3 D3) */
export const META_DB_NAME = 'pxii_meta'

/** Per-space Dexie database name (F0 §3.1 HC-3) */
export function dexieDbNameForSpace(spaceId: string): string {
  return `pomodoroxi_${spaceId}`
}

/** CustomEvent name dispatched after SpaceDBManager.switchTo (F0 §6.3) */
export const PXII_SPACE_SWITCHED_EVENT = 'pxii:space-switched'
