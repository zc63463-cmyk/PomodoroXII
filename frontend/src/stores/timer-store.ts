/**
 * Timer store (F0 §7.3.4).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

type TimerMode = 'pomodoro' | 'short-break' | 'long-break' | 'countdown'
type TimerStatus = 'idle' | 'running' | 'paused' | 'completed'

interface TimerState {
  mode: TimerMode
  status: TimerStatus
  duration: number
  remaining: number
  countdownPresets: number[]
  activeSessionId: string | null
}

interface TimerActions {
  setMode: (mode: TimerMode) => void
  setDuration: (seconds: number) => void
  start: () => void
  pause: () => void
  resume: () => void
  tick: () => void
  reset: () => void
}

type TimerStore = TimerState & TimerActions

export const useTimerStore = create<TimerStore>()(
  devtools(
    (set) => ({
      mode: 'pomodoro',
      status: 'idle',
      duration: 1500,
      remaining: 1500,
      countdownPresets: [3, 5, 10, 15, 20, 25, 30, 45, 60],
      activeSessionId: null,

      setMode: (mode) => set({ mode }),
      setDuration: (seconds) => set({ duration: seconds, remaining: seconds }),
      start: () => set({ status: 'running' }),
      pause: () => set({ status: 'paused' }),
      resume: () => set({ status: 'running' }),
      tick: () => set((s) => ({ remaining: Math.max(0, s.remaining - 1) })),
      // Note: reset does NOT reset countdownPresets
      reset: () => set({ mode: 'pomodoro', status: 'idle', duration: 1500, remaining: 1500, activeSessionId: null }),
    }),
    { name: 'timer-store' },
  ),
)
