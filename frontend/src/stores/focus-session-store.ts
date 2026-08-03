import { create } from 'zustand'
import type { CachedFocusSession } from '@/types'

interface FocusSessionState {
  sessions: CachedFocusSession[]
  currentSessionId: string | null
  reset: () => void
}

const initialState = (): Omit<FocusSessionState, 'reset'> => ({
  sessions: [],
  currentSessionId: null,
})

export const useFocusSessionStore = create<FocusSessionState>()((set) => ({
  ...initialState(),
  reset: () => set(initialState()),
}))
