/**
 * Settings store (F0 §7.3.19).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { THEMES } from '@/utils/constants'
import type { ThemeName } from '@/types'

export type SettingsTheme = ThemeName | 'system'
export type SettingsLanguage = 'zh-CN' | 'en'

interface SettingsState {
  pomodoroDuration: number
  shortBreakDuration: number
  longBreakDuration: number
  longBreakInterval: number
  autoStartBreaks: boolean
  autoStartPomodoros: boolean
  soundEnabled: boolean
  theme: SettingsTheme
  language: SettingsLanguage
  isLoaded: boolean
}

interface SettingsActions {
  load: () => Promise<void>
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => Promise<void>
  reset: () => void
}

type SettingsStore = SettingsState & SettingsActions

const SETTINGS_THEME_VALUES = ['system', ...THEMES] as const

function getInitialTheme(): SettingsTheme {
  if (typeof window === 'undefined') return 'system'

  const savedTheme = window.localStorage.getItem('theme')
  if (SETTINGS_THEME_VALUES.some((theme) => theme === savedTheme)) {
    return savedTheme as SettingsTheme
  }

  return 'system'
}

function persistSetting<K extends keyof SettingsState>(
  key: K,
  value: SettingsState[K],
): void {
  if (typeof window === 'undefined') return

  if (key === 'theme') {
    window.localStorage.setItem('theme', String(value))
    return
  }

  window.localStorage.setItem(`pxii_settings_${String(key)}`, JSON.stringify(value))
}

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
      theme: getInitialTheme(),
      language: 'zh-CN',
      isLoaded: false,

      load: async () => {
        set({ theme: getInitialTheme(), isLoaded: true })
      },
      update: async (key, value) => {
        persistSetting(key, value)
        set({ [key]: value } as Pick<SettingsStore, typeof key>)
      },
      // Note: reset preserves theme and language (F0 R7-2)
      reset: () => set({ pomodoroDuration: 25, shortBreakDuration: 5, longBreakDuration: 15, longBreakInterval: 4, autoStartBreaks: false, autoStartPomodoros: false, soundEnabled: true, isLoaded: false }),
    }),
    { name: 'settings-store' },
  ),
)
