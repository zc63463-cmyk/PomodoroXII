import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createQuickNote,
  moveQuickNoteToTrash,
  purgeQuickNote,
  resetQuickNoteOutboxHook,
  updateQuickNote,
} from '@/lib/quick-notes/quick-note-repository'
import { db, spaceDBManager } from '@/services/space-db'

describe('quick-note sync authority integration', () => {
  beforeEach(async () => {
    resetQuickNoteOutboxHook()
    await spaceDBManager.switchTo(`quick-note-sync-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    resetQuickNoteOutboxHook()
    await db.delete()
    spaceDBManager.close()
  })

  it('merges a local create/update into one ready outbox post-image', async () => {
    const note = await createQuickNote({ content: 'capture #Draft' })
    await updateQuickNote(note.id, { content: 'polished #Done' })
    const pending = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: 'quickNote', entityId: note.id, action: 'create',
      synced: false, transportState: 'ready',
    })
    expect(JSON.parse(pending[0]!.payload)).toMatchObject({
      id: note.id, content: 'polished #Done', tags: ['done'],
    })
  })

  it('records a delete post-image after trash purge', async () => {
    const note = await createQuickNote({ content: 'remote synced #Trash' })
    await moveQuickNoteToTrash(note.id)
    await db.outbox.clear()
    await purgeQuickNote(note.id)
    const rows = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entityType: 'quickNote', entityId: note.id, action: 'delete',
      synced: false, transportState: 'ready',
    })
    expect(JSON.parse(rows[0]!.payload)).toEqual({ id: note.id })
    expect(await db.quickNotes.get(note.id)).toBeUndefined()
  })
})
