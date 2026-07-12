import type { PomodoroXIDB } from '@/services/database'
import type { QuickNote } from '@/types'
import {
  getQuickNoteLifecycleState,
  stripSyncFields,
  updateQuickNoteInTransaction,
  type QuickNoteLifecycleState,
} from '@/lib/quick-notes/quick-note-repository'

export const QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY =
  'quickNote:existingEditRecovery:v1'
export const QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION = 1 as const

export interface QuickNoteExistingEditSnapshotV1 {
  version: typeof QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION
  editId: string
  revision: number
  noteId: string
  baseContent: string
  baseUpdatedAt: string
  draft: string
  updatedAt: string
}

export type ExistingEditRowOwner =
  | { kind: 'v1'; editId: string; revision: number }
  | { kind: 'raw'; value: string }

export type ExistingEditLoadResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; owner: ExistingEditRowOwner }
  | {
    kind: 'valid'
    snapshot: QuickNoteExistingEditSnapshotV1
    owner: Extract<ExistingEditRowOwner, { kind: 'v1' }>
    note: QuickNote | null
    lifecycle: QuickNoteLifecycleState | 'missing'
  }

export interface ExistingEditSaveCapture {
  noteId: string
  baseContent: string
  baseUpdatedAt: string
  draft: string
}

export type ExistingEditUpdateResult =
  | { kind: 'updated'; note: QuickNote }
  | { kind: 'conflict'; note: QuickNote }
  | {
    kind: 'unavailable'
    lifecycle: QuickNoteLifecycleState | 'missing'
  }

export interface QuickNoteExistingEditStorageAdapter {
  load(): Promise<ExistingEditLoadResult>
  readTarget(noteId: string): Promise<{
    note: QuickNote | null
    lifecycle: QuickNoteLifecycleState | 'missing'
  }>
  checkpoint(snapshot: QuickNoteExistingEditSnapshotV1): Promise<void>
  updateEntity(capture: ExistingEditSaveCapture): Promise<ExistingEditUpdateResult>
  clearIfOwned(
    owners: readonly ExistingEditRowOwner[],
  ): Promise<'cleared' | 'absent' | 'different-edit'>
}

type ExistingEditTarget = {
  note: QuickNote | null
  lifecycle: QuickNoteLifecycleState | 'missing'
}

type DecodedExistingEditRow =
  | { kind: 'invalid'; owner: ExistingEditRowOwner }
  | {
    kind: 'valid'
    snapshot: QuickNoteExistingEditSnapshotV1
    owner: Extract<ExistingEditRowOwner, { kind: 'v1' }>
  }

export function createDexieQuickNoteExistingEditAdapter(
  database: PomodoroXIDB,
): QuickNoteExistingEditStorageAdapter {
  return {
    async load(): Promise<ExistingEditLoadResult> {
      return database.transaction(
        'r',
        database.settings,
        database.quickNotes,
        async (): Promise<ExistingEditLoadResult> => {
          const row = await database.settings.get(
            QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY,
          )
          if (!row) return { kind: 'absent' }

          const decoded = decodeExistingEditRow(row.value)
          if (decoded.kind === 'invalid') return decoded

          const target = await readTargetFromDatabase(
            database,
            decoded.snapshot.noteId,
          )
          return { ...decoded, ...target }
        },
      )
    },

    readTarget(noteId) {
      return readTargetFromDatabase(database, noteId)
    },

    async checkpoint(snapshot) {
      await database.settings.put({
        key: QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY,
        value: JSON.stringify(snapshot),
      })
    },

    async updateEntity(capture) {
      return database.transaction(
        'rw',
        database.quickNotes,
        database.outbox,
        async (): Promise<ExistingEditUpdateResult> => {
          const existing = await database.quickNotes.get(capture.noteId)
          if (!existing) {
            return { kind: 'unavailable', lifecycle: 'missing' }
          }

          const lifecycle = getQuickNoteLifecycleState(existing)
          if (lifecycle !== 'active') {
            return { kind: 'unavailable', lifecycle }
          }

          const current = stripSyncFields(existing)
          if (
            current.content !== capture.baseContent ||
            current.updated_at !== capture.baseUpdatedAt
          ) {
            return { kind: 'conflict', note: current }
          }

          const note = await updateQuickNoteInTransaction(database, existing, {
            content: capture.draft,
          })
          return { kind: 'updated', note }
        },
      )
    },

    async clearIfOwned(owners) {
      return database.transaction('rw', database.settings, async () => {
        const row = await database.settings.get(
          QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY,
        )
        if (!row) return 'absent'
        if (!owners.some((owner) => ownerMatchesValue(owner, row.value))) {
          return 'different-edit'
        }

        await database.settings.delete(QUICK_NOTE_EXISTING_EDIT_RECOVERY_KEY)
        return 'cleared'
      })
    },
  }
}

async function readTargetFromDatabase(
  database: PomodoroXIDB,
  noteId: string,
): Promise<ExistingEditTarget> {
  const row = await database.quickNotes.get(noteId)
  if (!row) return { note: null, lifecycle: 'missing' }

  return {
    note: stripSyncFields(row),
    lifecycle: getQuickNoteLifecycleState(row),
  }
}

function decodeExistingEditRow(value: string): DecodedExistingEditRow {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { kind: 'invalid', owner: { kind: 'raw', value } }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'invalid', owner: { kind: 'raw', value } }
  }

  const row = parsed as Record<string, unknown>
  const valid =
    row.version === QUICK_NOTE_EXISTING_EDIT_RECOVERY_VERSION &&
    typeof row.editId === 'string' &&
    row.editId.trim() !== '' &&
    Number.isInteger(row.revision) &&
    (row.revision as number) > 0 &&
    typeof row.noteId === 'string' &&
    row.noteId.trim() !== '' &&
    typeof row.baseContent === 'string' &&
    typeof row.baseUpdatedAt === 'string' &&
    row.baseUpdatedAt.trim() !== '' &&
    typeof row.draft === 'string' &&
    typeof row.updatedAt === 'string' &&
    row.updatedAt.trim() !== ''

  if (!valid) {
    return { kind: 'invalid', owner: { kind: 'raw', value } }
  }

  const snapshot = row as unknown as QuickNoteExistingEditSnapshotV1
  return {
    kind: 'valid',
    snapshot,
    owner: {
      kind: 'v1',
      editId: snapshot.editId,
      revision: snapshot.revision,
    },
  }
}

function ownerMatchesValue(owner: ExistingEditRowOwner, value: string): boolean {
  if (owner.kind === 'raw') return owner.value === value

  const decoded = decodeExistingEditRow(value)
  return (
    decoded.kind === 'valid' &&
    decoded.owner.editId === owner.editId &&
    decoded.owner.revision === owner.revision
  )
}
