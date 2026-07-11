import type { PomodoroXIDB } from '@/services/database'
import type { QuickNote } from '@/types'
import { createQuickNoteInTransaction } from '@/lib/quick-notes/quick-note-repository'

export const QUICK_NOTE_NEW_DRAFT_KEY = 'quickNote:newDraft:v1'
export const QUICK_NOTE_NEW_DRAFT_VERSION = 1 as const
export const QUICK_NOTE_NEW_DRAFT_VERSION_V2 = 2 as const

export interface QuickNoteNewDraftSnapshot {
  version: typeof QUICK_NOTE_NEW_DRAFT_VERSION
  content: string
  updatedAt: string
}

export interface QuickNoteNewDraftSnapshotV2 {
  version: typeof QUICK_NOTE_NEW_DRAFT_VERSION_V2
  draftId: string
  content: string
  updatedAt: string
}

export type QuickNoteDraftRowOwner =
  | { kind: 'v2'; draftId: string }
  | { kind: 'raw'; value: string }

export type QuickNoteDraftLoadResult =
  | { kind: 'absent' }
  | {
    kind: 'valid'
    snapshot: QuickNoteNewDraftSnapshot | QuickNoteNewDraftSnapshotV2
    owner: QuickNoteDraftRowOwner
  }
  | { kind: 'invalid'; owner: QuickNoteDraftRowOwner }

/** @internal production + deterministic session-test seam; do not barrel-export */
export interface QuickNoteDraftStorageAdapter {
  load(): Promise<QuickNoteDraftLoadResult>
  save(snapshot: QuickNoteNewDraftSnapshotV2): Promise<void>
  clearIfOwned(
    owners: readonly QuickNoteDraftRowOwner[],
  ): Promise<'cleared' | 'absent' | 'different-draft'>
  record(snapshot: QuickNoteNewDraftSnapshotV2): Promise<QuickNote>
}

export interface QuickNoteDraftRepository {
  load: () => Promise<QuickNoteNewDraftSnapshot | null>
  save: (content: string, updatedAt?: string) => Promise<void>
  clear: () => Promise<void>
}

export function createQuickNoteDraftRepository(
  database: PomodoroXIDB,
): QuickNoteDraftRepository {
  return {
    async load() {
      const row = await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)
      if (!row) return null

      try {
        const snapshot: unknown = JSON.parse(row.value)
        if (!isSupportedSnapshot(snapshot)) {
          await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
          return null
        }
        if (!snapshot.content.trim()) {
          await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
          return null
        }
        return snapshot
      } catch {
        await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
        return null
      }
    },

    async save(content, updatedAt = new Date().toISOString()) {
      if (!content.trim()) {
        await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
        return
      }

      const snapshot: QuickNoteNewDraftSnapshot = {
        version: QUICK_NOTE_NEW_DRAFT_VERSION,
        content,
        updatedAt,
      }
      await database.settings.put({
        key: QUICK_NOTE_NEW_DRAFT_KEY,
        value: JSON.stringify(snapshot),
      })
    },

    async clear() {
      await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
    },
  }
}

export function createDexieQuickNoteDraftAdapter(
  database: PomodoroXIDB,
): QuickNoteDraftStorageAdapter {
  return {
    async load() {
      const row = await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)
      return row ? decodeDraftRow(row.value) : { kind: 'absent' }
    },

    async save(snapshot) {
      await database.settings.put({
        key: QUICK_NOTE_NEW_DRAFT_KEY,
        value: JSON.stringify(snapshot),
      })
    },

    async clearIfOwned(owners) {
      return database.transaction('rw', database.settings, async () => {
        const row = await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)
        if (!row) return 'absent'
        if (!owners.some((owner) => ownerMatchesRow(owner, row.value))) {
          return 'different-draft'
        }

        await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
        return 'cleared'
      })
    },

    async record(snapshot) {
      return database.transaction(
        'rw',
        database.quickNotes,
        database.outbox,
        database.settings,
        async () => {
          const row = await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)
          const current = row ? decodeV2Snapshot(row.value) : null
          if (!current || current.draftId !== snapshot.draftId) {
            throw new Error('QuickNote draft ownership changed before record')
          }

          const note = await createQuickNoteInTransaction(database, {
            id: snapshot.draftId,
            content: snapshot.content,
          })
          await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
          return note
        },
      )
    },
  }
}

function decodeDraftRow(raw: string): QuickNoteDraftLoadResult {
  const rawOwner = { kind: 'raw' as const, value: raw }

  try {
    const snapshot: unknown = JSON.parse(raw)
    if (isValidV1Snapshot(snapshot)) {
      return { kind: 'valid', snapshot, owner: rawOwner }
    }
    if (isValidV2Snapshot(snapshot)) {
      return {
        kind: 'valid',
        snapshot,
        owner: { kind: 'v2', draftId: snapshot.draftId },
      }
    }
  } catch {
    return { kind: 'invalid', owner: rawOwner }
  }

  return { kind: 'invalid', owner: rawOwner }
}

function decodeV2Snapshot(raw: string): QuickNoteNewDraftSnapshotV2 | null {
  try {
    const snapshot: unknown = JSON.parse(raw)
    return isValidV2Snapshot(snapshot) ? snapshot : null
  } catch {
    return null
  }
}

function ownerMatchesRow(owner: QuickNoteDraftRowOwner, raw: string): boolean {
  if (owner.kind === 'raw') return owner.value === raw
  return decodeV2Snapshot(raw)?.draftId === owner.draftId
}

function isValidV1Snapshot(value: unknown): value is QuickNoteNewDraftSnapshot {
  return isSupportedSnapshot(value) && Boolean(value.content.trim())
}

function isValidV2Snapshot(value: unknown): value is QuickNoteNewDraftSnapshotV2 {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.version === QUICK_NOTE_NEW_DRAFT_VERSION_V2 &&
    typeof candidate.draftId === 'string' &&
    Boolean(candidate.draftId.trim()) &&
    typeof candidate.content === 'string' &&
    Boolean(candidate.content.trim()) &&
    typeof candidate.updatedAt === 'string'
  )
}

function isSupportedSnapshot(value: unknown): value is QuickNoteNewDraftSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.version === QUICK_NOTE_NEW_DRAFT_VERSION &&
    typeof candidate.content === 'string' &&
    typeof candidate.updatedAt === 'string'
  )
}
