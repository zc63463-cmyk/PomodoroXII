/**
 * Session store (F0 §7.3.5).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Session } from '@/types'

interface SessionState {
  sessions: Session[]
  isLoading: boolean
  error: string | null
}

interface SessionActions {
  loadSessions: () => Promise<void>
  createSession: (data: Partial<Session>) => Promise<Session>
  updateSession: (id: string, data: Partial<Session>) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  reset: () => void
}

type SessionStore = SessionState & SessionActions

export const useSessionStore = create<SessionStore>()(
  devtools(
    (set) => ({
      sessions: [],
      isLoading: false,
      error: null,

      loadSessions: async () => { /* S0 stub */ },
      createSession: async () => ({} as Session),
      updateSession: async () => { /* S0 stub */ },
      deleteSession: async () => { /* S0 stub */ },
      reset: () => set({ sessions: [], isLoading: false, error: null }),
    }),
    { name: 'session-store' },
  ),
)
