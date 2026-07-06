/**
 * Bootstrap store — hydrate phase gate (S3-2).
 *
 * Phase: 'pending' → 'ready' | 'failed'
 * Not one of the 17 business stores; S0-4 SpaceSwitchProvider will
 * reuse the phase semantics.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type BootstrapPhase = 'pending' | 'ready' | 'failed'

interface BootstrapState {
  phase: BootstrapPhase
  error: string | null
  setReady: () => void
  setFailed: (message: string) => void
  reset: () => void
}

export const useBootstrapStore = create<BootstrapState>()(
  devtools(
    (set) => ({
      phase: 'pending',
      error: null,
      setReady: () => set({ phase: 'ready', error: null }),
      setFailed: (message: string) => set({ phase: 'failed', error: message }),
      reset: () => set({ phase: 'pending', error: null }),
    }),
    { name: 'bootstrap-store' },
  ),
)
