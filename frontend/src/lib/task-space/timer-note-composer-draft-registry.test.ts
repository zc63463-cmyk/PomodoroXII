import { describe, expect, it, vi } from 'vitest'
import {
  TimerNoteComposerDraftController,
  createMemoryTimerNoteDraftDatabase,
  paragraphComposerDraft,
  checklistComposerDraft,
} from './timer-note-composer-draft-registry'

describe('TimerNoteComposerDraftController', () => {
  it('flushes a structured composer draft and restores it after reopen', async () => {
    const database = createMemoryTimerNoteDraftDatabase('space-a')
    const append = vi.fn().mockResolvedValue(undefined)
    const first = new TimerNoteComposerDraftController(database, { spaceId: 'space-a', workItemId: 'wi-a' }, append, vi.fn().mockResolvedValue(false))
    await first.update(paragraphComposerDraft('Keep across switch'))
    await first.flush('space-switch')

    const reopened = new TimerNoteComposerDraftController(database, { spaceId: 'space-a', workItemId: 'wi-a' }, append, vi.fn().mockResolvedValue(false))
    expect(await reopened.hydrate()).toEqual(paragraphComposerDraft('Keep across switch'))
  })

  it('persists A before hydrating B and never appends A content to B', async () => {
    const database = createMemoryTimerNoteDraftDatabase('space-a')
    const append = vi.fn().mockResolvedValue(undefined)
    const controller = new TimerNoteComposerDraftController(database, { spaceId: 'space-a', workItemId: 'wi-a' }, append, vi.fn().mockResolvedValue(false))
    await controller.update(paragraphComposerDraft('Draft A'))
    await controller.switchTo({ spaceId: 'space-a', workItemId: 'wi-b' })
    await controller.update(paragraphComposerDraft('Draft B'))
    await controller.switchTo({ spaceId: 'space-a', workItemId: 'wi-a' })

    expect(controller.currentDraft()).toEqual(paragraphComposerDraft('Draft A'))
    await controller.appendExplicitly()
    expect(append).toHaveBeenCalledWith('wi-a', [expect.objectContaining({ type: 'paragraph', text: 'Draft A' })], expect.any(String))
    expect(append).not.toHaveBeenCalledWith('wi-b', expect.anything(), expect.any(String))
  })

  it('clears only after append succeeds and retains the exact structured draft on failure', async () => {
    const database = createMemoryTimerNoteDraftDatabase('space-a')
    const append = vi.fn().mockRejectedValueOnce(new Error('offline append failed')).mockResolvedValueOnce(undefined)
    const controller = new TimerNoteComposerDraftController(database, { spaceId: 'space-a', workItemId: 'wi-a' }, append, vi.fn().mockResolvedValue(false))
    const draft = checklistComposerDraft('Verify', 'Record evidence')
    await controller.update(draft)

    await expect(controller.appendExplicitly()).rejects.toThrow('offline append failed')
    expect(await controller.hydrate()).toEqual(draft)
    await controller.appendExplicitly()
    expect(await controller.hydrate()).toEqual(paragraphComposerDraft(''))
  })

  it('reconciles committed evidence after local draft cleanup fails without replaying the append', async () => {
    const database = createMemoryTimerNoteDraftDatabase('space-a')
    const applied = new Set<string>()
    const append = vi.fn(async (_workItemId: string, blocks: Array<{ blockId: string }>) => {
      applied.add(blocks[0]!.blockId)
    })
    const hasApplied = vi.fn(async (_workItemId: string, blockId: string) => applied.has(blockId))
    const controller = new TimerNoteComposerDraftController(
      database, { spaceId: 'space-a', workItemId: 'wi-a' }, append, hasApplied,
    )
    await controller.update(paragraphComposerDraft('Append once', 'append-block'))
    const deleteDraft = database.timerNoteComposerDrafts.delete
    let deleteCalls = 0
    database.timerNoteComposerDrafts.delete = async (key) => {
      deleteCalls += 1
      if (deleteCalls === 1) throw new Error('injected_draft_delete_failure')
      return deleteDraft(key)
    }

    await expect(controller.appendExplicitly()).rejects.toThrow('injected_draft_delete_failure')
    expect(await database.timerNoteComposerDrafts.get(['space-a', 'wi-a'])).toMatchObject({
      appendState: 'committed', appendOperationId: expect.any(String),
    })

    await controller.appendExplicitly()

    expect(append).toHaveBeenCalledOnce()
    expect(hasApplied).toHaveBeenCalledWith('wi-a', 'append-block', expect.any(String))
    expect(await database.timerNoteComposerDrafts.get(['space-a', 'wi-a'])).toBeUndefined()
  })

  it('reconciles a submitted append after reopen when the Note already contains its block', async () => {
    const database = createMemoryTimerNoteDraftDatabase('space-a')
    await database.timerNoteComposerDrafts.put({
      spaceId: 'space-a', workItemId: 'wi-a', contentVersion: 1,
      draftJson: JSON.stringify(paragraphComposerDraft('Recover me', 'recover-block')),
      appendState: 'submitting', appendOperationId: 'recover-op',
      submittedBlockJson: JSON.stringify({ type: 'paragraph', blockId: 'recover-block', text: 'Recover me' }),
      updatedAt: '2026-07-15T08:00:00.000Z',
    })
    const append = vi.fn().mockResolvedValue(undefined)
    const reopened = new TimerNoteComposerDraftController(
      database, { spaceId: 'space-a', workItemId: 'wi-a' }, append,
      vi.fn().mockResolvedValue(true),
    )

    expect(await reopened.hydrate()).toEqual(paragraphComposerDraft(''))
    expect(append).not.toHaveBeenCalled()
    expect(await database.timerNoteComposerDrafts.get(['space-a', 'wi-a'])).toBeUndefined()
  })
})
