/**
 * Settings store (F0 §7.3.19).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface SettingsState {
  pomodoroDuration: number
  shortBreakDuration: number
  longBreakDuration: number
  longBreakInterval: number
  autoStartBreaks: boolean
  autoStartPomodoros: boolean
  soundEnabled: boolean
  theme: 'light' | 'dark' | 'system'
  language: 'zh-CN' | 'en'
  isLoaded: boolean
}

interface SettingsActions {
  load: () => Promise<void>
  update: (key: string, value: unknown) => Promise<void>
  reset: () => void
}

type SettingsStore = SettingsState & SettingsActions

export const useSettingsStore = create<SettingsStore>()(
  devtools(
    (set) => ({
      pomodoroDuration: 25,
      shortBreakDuration: 5,
      longBreakDuration: 15,
      longBreakInterval: 4,
      autoStartBreaks: false,
      autoStartPomodoros: false,
      soundEnabled: true,
      theme: 'system',
      language: 'zh-CN',
      isLoaded: false,

      load: async () => { /* S0 stub */ },
      update: async () => { /* S0 stub */ },
      // Note: reset preserves theme and language (F0 R7-2)
      reset: () => set({ pomodoroDuration: 25, shortBreakDuration: 5, longBreakDuration: 15, longBreakInterval: 4, autoStartBreaks: false, autoStartPomodoros: false, soundEnabled: true, isLoaded: false }),
    }),
    { name: 'settings-store' },
  ),
)
