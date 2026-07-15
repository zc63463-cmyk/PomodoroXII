import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import {
  createDexieQuickNoteExistingEditRecoveryAdapter,
  type QuickNoteExistingEditRecoverySnapshotV1,
} from '@/lib/quick-notes/quick-note-existing-edit-recovery'

const SPACE_ID = 'space-a'
const NOTE_ID = 'note-1'

function snapshot(overrides: Partial<QuickNoteExistingEditRecoverySnapshotV1> = {}): QuickNoteExistingEditRecoverySnapshotV1 {
  return { version: 1, editId: 'edit-1', revision: 1, spaceId: SPACE_ID, noteId: NOTE_ID, baseContent: 'base', baseUpdatedAt: '2026-07-15T00:00:00.000Z', draft: 'draft', checkpointedAt: '2026-07-15T00:00:01.000Z', ...overrides }
}

describe('quick-note-existing-edit-recovery', () => {
  let database: PomodoroXIDB
  beforeEach(async () => { database = new PomodoroXIDB(`existing-edit-${crypto.randomUUID()}`); await database.open() })
  afterEach(async () => { await database.delete() })

  it('round-trips a valid same-Space snapshot', async () => {
    const adapter = createDexieQuickNoteExistingEditRecoveryAdapter(database, SPACE_ID)
    const value = snapshot()
    await adapter.save(value)
    await expect(adapter.load(NOTE_ID)).resolves.toEqual({ kind: 'valid', snapshot: value, raw: JSON.stringify(value) })
  })

  it('rejects malformed and foreign-Space rows without deleting them', async () => {
    const key = `quickNote:existingEdit:v1:${NOTE_ID}`
    await database.settings.put({ key, value: JSON.stringify(snapshot({ spaceId: 'space-b' })) })
    const adapter = createDexieQuickNoteExistingEditRecoveryAdapter(database, SPACE_ID)
    await expect(adapter.load(NOTE_ID)).resolves.toEqual({ kind: 'invalid', raw: expect.any(String) })
    expect((await database.settings.get(key))?.value).toContain('space-b')
  })

  it('does not let an old owner clear a successor revision', async () => {
    const adapter = createDexieQuickNoteExistingEditRecoveryAdapter(database, SPACE_ID)
    await adapter.save(snapshot())
    await adapter.save(snapshot({ editId: 'edit-2', revision: 2, draft: 'newer' }))
    await expect(adapter.clearIfOwned(NOTE_ID, 'edit-1', 1)).resolves.toBe('different-owner')
    await expect(adapter.load(NOTE_ID)).resolves.toMatchObject({ kind: 'valid', snapshot: { editId: 'edit-2', draft: 'newer' } })
  })
})
