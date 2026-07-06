/**
 * Client-side sync layer types (F0-A §3.4 / §3.5, s0-1 plan D2–D4).
 *
 * - `SyncFields` applies to synced entity rows in per-space Dexie DBs.
 * - `deletion_state` is for the client sync engine (tombstones / outbox); S1 implements merge.
 * - `trashed_at` on Note/QuickNote/Folder is REST/UI soft-delete (Phase D); v16 upgrade does not clear it.
 */

/** Client sync layer fields; coexists with REST `trashed_at` on note entities. */
export interface SyncFields {
  content_hash?: string
  deletion_state: 'active' | 'deleted'
  version: number
  _dirty: boolean
}

/** Dexie tables that are local plumbing — no SyncFields, excluded from v16 upgrade. */
export const SYNC_PLUMBING_TABLES = ['outbox', 'settings', 'syncMeta'] as const

export type SyncPlumbingTable = (typeof SYNC_PLUMBING_TABLES)[number]
