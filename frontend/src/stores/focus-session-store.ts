import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CachedFocusSession } from '@/types'
import type { SessionReviewDraft } from '@/lib/focus-session/session-review-draft-registry'

export interface FocusSessionRepositoryLike {
  listCached: () => Promise<CachedFocusSession[]>
  refreshHistory: () => Promise<CachedFocusSession[]>
  submitReview?: (draft: SessionReviewDraft) => Promise<unknown>
}

export interface FocusSessionState {
  sessions: CachedFocusSession[]
  selectedSessionId: string | null
  /** Compatibility alias for the pre-Task-6 projection; it is not business state. */
  currentSessionId: string | null
  reviewDraft: SessionReviewDraft | null
  isLoading: boolean
  error: string | null
  repository: FocusSessionRepositoryLike | null
}

export interface FocusSessionActions {
  hydrate: (repository: FocusSessionRepositoryLike) => Promise<void>
  selectSession: (sessionId: string | null) => void
  setReviewDraft: (draft: SessionReviewDraft | null) => void
  reset: () => void
}

type FocusSessionStore = FocusSessionState & FocusSessionActions

const initialState = (): FocusSessionState => ({
  sessions: [],
  selectedSessionId: null,
  currentSessionId: null,
  reviewDraft: null,
  isLoading: false,
  error: null,
  repository: null,
})

export const useFocusSessionStore = create<FocusSessionStore>()(
  devtools((set, get) => {
    let hydrationSequence = 0
    return {
      ...initialState(),

      async hydrate(repository) {
        const sequence = ++hydrationSequence
        set({
          repository,
          isLoading: true,
          error: null,
        })
        try {
          const cached = await repository.listCached()
          if (sequence !== hydrationSequence) return
          const selectedBeforeRefresh = get().selectedSessionId
          const selected = selectedBeforeRefresh && cached.some(
            (session) => session.sessionId === selectedBeforeRefresh,
          )
            ? selectedBeforeRefresh
            : cached[0]?.sessionId ?? null
          set({
            sessions: cached,
            selectedSessionId: selected,
            currentSessionId: selected,
          })
          const remote = await repository.refreshHistory()
          if (sequence !== hydrationSequence) return
          const retained = selected && remote.some((session) => session.sessionId === selected)
            ? selected
            : remote[0]?.sessionId ?? null
          set({
            sessions: remote,
            selectedSessionId: retained,
            currentSessionId: retained,
            isLoading: false,
            error: null,
          })
        } catch (error) {
          if (sequence !== hydrationSequence) return
          set({ isLoading: false, error: (error as Error).message })
        }
      },

      selectSession(sessionId) {
        set({ selectedSessionId: sessionId, currentSessionId: sessionId })
      },

      setReviewDraft(reviewDraft) {
        set({ reviewDraft })
      },

      reset() {
        hydrationSequence += 1
        set(initialState())
      },
    }
  }, { name: 'focus-session-store' }),
)
