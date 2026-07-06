/**
 * App store (F0 §7.3.3).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface AppState {
  isOnline: boolean
}

interface AppActions {
  setOnline: (online: boolean) => void
  reset: () => void
}

type AppStore = AppState & AppActions

export const useAppStore = create<AppStore>()(
  devtools(
    (set) => ({
      isOnline: true,

      setOnline: (online) => set({ isOnline: online }),
      reset: () => set({ isOnline: true }),
    }),
    { name: 'app-store' },
  ),
)
