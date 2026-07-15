import type { PomodoroXIDB } from '@/services/database'

export type QuickNoteExistingEditRecoverySnapshotV1 = Readonly<{
  version: 1
  editId: string
  revision: number
  spaceId: string
  noteId: string
  baseContent: string
  baseUpdatedAt: string
  draft: string
  checkpointedAt: string
}>

export type QuickNoteExistingEditRecoveryLoadResult =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'valid'; snapshot: QuickNoteExistingEditRecoverySnapshotV1; raw: string }>
  | Readonly<{ kind: 'invalid'; raw: string }>

export interface QuickNoteExistingEditRecoveryAdapter {
  load(noteId: string): Promise<QuickNoteExistingEditRecoveryLoadResult>
  save(snapshot: QuickNoteExistingEditRecoverySnapshotV1): Promise<void>
  clearIfOwned(noteId: string, editId: string, maxRevision: number): Promise<'cleared' | 'absent' | 'different-owner'>
}

export function createDexieQuickNoteExistingEditRecoveryAdapter(database: PomodoroXIDB, spaceId: string): QuickNoteExistingEditRecoveryAdapter {
  return {
    async load(noteId) {
      const row = await database.settings.get(key(noteId))
      if (!row) return { kind: 'absent' }
      const snapshot = decode(row.value, spaceId, noteId)
      return snapshot ? { kind: 'valid', snapshot, raw: row.value } : { kind: 'invalid', raw: row.value }
    },
    async save(snapshot) { await database.settings.put({ key: key(snapshot.noteId), value: JSON.stringify(snapshot) }) },
    async clearIfOwned(noteId, editId, maxRevision) {
      return database.transaction('rw', database.settings, async () => {
        const row = await database.settings.get(key(noteId))
        if (!row) return 'absent'
        const current = decode(row.value, spaceId, noteId)
        if (!current || current.editId !== editId || current.revision > maxRevision) return 'different-owner'
        await database.settings.delete(key(noteId))
        return 'cleared'
      })
    },
  }
}

function key(noteId: string) { return `quickNote:existingEdit:v1:${noteId}` }
function nonblank(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function decode(raw: string, spaceId: string, noteId: string): QuickNoteExistingEditRecoverySnapshotV1 | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const item = value as Record<string, unknown>
    if (item.version !== 1 || item.spaceId !== spaceId || item.noteId !== noteId || !Number.isInteger(item.revision) || (item.revision as number) < 0) return null
    const strings = ['editId', 'spaceId', 'noteId', 'baseContent', 'baseUpdatedAt', 'draft', 'checkpointedAt'] as const
    if (!strings.every((name) => nonblank(item[name]))) return null
    return item as unknown as QuickNoteExistingEditRecoverySnapshotV1
  } catch { return null }
}
