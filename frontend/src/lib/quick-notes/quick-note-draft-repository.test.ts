import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import {
  QUICK_NOTE_NEW_DRAFT_KEY,
  createQuickNoteDraftRepository,
} from '@/lib/quick-notes/quick-note-draft-repository'

describe('quick-note-draft-repository', () => {
  let dbA: PomodoroXIDB
  let dbB: PomodoroXIDB

  beforeEach(async () => {
    dbA = new PomodoroXIDB(`quick-note-draft-a-${crypto.randomUUID()}`)
    dbB = new PomodoroXIDB(`quick-note-draft-b-${crypto.randomUUID()}`)
    await Promise.all([dbA.open(), dbB.open()])
  })

  afterEach(async () => {
    await Promise.all([dbA.delete(), dbB.delete()])
  })

  it('saves, loads, and clears a versioned new draft snapshot', async () => {
    const repository = createQuickNoteDraftRepository(dbA)

    await repository.save('尚未记录的小记', '2026-07-10T04:00:00.000Z')

    await expect(repository.load()).resolves.toEqual({
      version: 1,
      content: '尚未记录的小记',
      updatedAt: '2026-07-10T04:00:00.000Z',
    })

    await repository.clear()
    await expect(repository.load()).resolves.toBeNull()
  })

  it('clears an existing snapshot instead of saving blank content', async () => {
    const repository = createQuickNoteDraftRepository(dbA)
    await repository.save('先保存', '2026-07-10T04:00:00.000Z')

    await repository.save('   ', '2026-07-10T04:01:00.000Z')

    expect(await dbA.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)).toBeUndefined()
  })

  it('safely ignores and removes damaged JSON', async () => {
    await dbA.settings.put({
      key: QUICK_NOTE_NEW_DRAFT_KEY,
      value: '{damaged-json',
    })

    const repository = createQuickNoteDraftRepository(dbA)

    await expect(repository.load()).resolves.toBeNull()
    expect(await dbA.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)).toBeUndefined()
  })

  it('safely ignores and removes unsupported snapshot versions', async () => {
    await dbA.settings.put({
      key: QUICK_NOTE_NEW_DRAFT_KEY,
      value: JSON.stringify({
        version: 99,
        content: 'future format',
        updatedAt: '2026-07-10T04:00:00.000Z',
      }),
    })

    const repository = createQuickNoteDraftRepository(dbA)

    await expect(repository.load()).resolves.toBeNull()
    expect(await dbA.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)).toBeUndefined()
  })

  it('keeps Space A and Space B drafts strictly isolated', async () => {
    const repositoryA = createQuickNoteDraftRepository(dbA)
    const repositoryB = createQuickNoteDraftRepository(dbB)

    await repositoryA.save('Space A 草稿', '2026-07-10T04:00:00.000Z')
    await repositoryB.save('Space B 草稿', '2026-07-10T04:01:00.000Z')

    await expect(repositoryA.load()).resolves.toMatchObject({ content: 'Space A 草稿' })
    await expect(repositoryB.load()).resolves.toMatchObject({ content: 'Space B 草稿' })
  })

  it('does not create QuickNote entities or outbox events', async () => {
    const repository = createQuickNoteDraftRepository(dbA)

    await repository.save('只是一份本地草稿', '2026-07-10T04:00:00.000Z')

    expect(await dbA.quickNotes.count()).toBe(0)
    expect(await dbA.outbox.count()).toBe(0)
    expect(await dbA.settings.count()).toBe(1)
  })
})
