import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusSessionStore } from './focus-session-store'

describe('focus-session-store', () => {
  beforeEach(() => useFocusSessionStore.getState().reset())

  it('hydrates cached history before refreshing the repository projection', async () => {
    const cached = [{ sessionId: 'cached-1' }] as never
    const remote = [{ sessionId: 'remote-1' }] as never
    const repository = {
      listCached: vi.fn().mockResolvedValue(cached),
      refreshHistory: vi.fn().mockResolvedValue(remote),
    }

    await useFocusSessionStore.getState().hydrate(repository)

    expect(repository.listCached).toHaveBeenCalledOnce()
    expect(repository.refreshHistory).toHaveBeenCalledOnce()
    expect(useFocusSessionStore.getState().sessions).toEqual(remote)
    expect(useFocusSessionStore.getState().isLoading).toBe(false)
    expect(useFocusSessionStore.getState().repository).toBe(repository)
  })

  it('keeps the selected session and review draft in disposable projection state', () => {
    useFocusSessionStore.getState().selectSession('session-1')
    useFocusSessionStore.getState().setReviewDraft({ operationId: 'review-1' } as never)
    expect(useFocusSessionStore.getState().selectedSessionId).toBe('session-1')
    expect(useFocusSessionStore.getState().reviewDraft).toMatchObject({ operationId: 'review-1' })

    useFocusSessionStore.getState().reset()
    expect(useFocusSessionStore.getState().selectedSessionId).toBeNull()
    expect(useFocusSessionStore.getState().reviewDraft).toBeNull()
    expect(useFocusSessionStore.getState().repository).toBeNull()
  })
})
