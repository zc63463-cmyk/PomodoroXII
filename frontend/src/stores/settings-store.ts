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
import {
  DAY_BOUNDARY_MAX,
  DAY_BOUNDARY_MIN,
} from '@/lib/habits/habit-selectors'

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
  /**
   * 跨午夜日界（小时）。0 = 午夜分界；3 = 凌晨 3 点前都算前一天。
   *
   * 这是**本地偏好**，不是同步实体 —— settings 属于 SYNC_PLUMBING_TABLES，
   * 不参与同步，故加这个字段不需要动 response-schema。
   */
  dayBoundaryHour: number
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

/**
 * 读回本地保存的日界。
 *
 * 只有 theme 原本在 load 里读回 —— 其余设置写了 localStorage 却没读，
 * 刷新即丢。这里只为日界补上读取（其余设置不在本次范围内，保持原样）。
 * localStorage 是用户可改的，脏数据一律退回默认值而不是让它崩。
 */
function getInitialDayBoundaryHour(): number {
  if (typeof window === 'undefined') return DAY_BOUNDARY_MIN

  try {
    const raw = window.localStorage.getItem('pxii_settings_dayBoundaryHour')
    if (raw === null) return DAY_BOUNDARY_MIN
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return DAY_BOUNDARY_MIN
    return Math.min(Math.max(Math.trunc(parsed), DAY_BOUNDARY_MIN), DAY_BOUNDARY_MAX)
  } catch {
    return DAY_BOUNDARY_MIN
  }
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
      dayBoundaryHour: DAY_BOUNDARY_MIN,
      theme: getInitialTheme(),
      language: 'zh-CN',
      isLoaded: false,

      load: async () => {
        set({
          theme: getInitialTheme(),
          dayBoundaryHour: getInitialDayBoundaryHour(),
          isLoaded: true,
        })
      },
      update: async (key, value) => {
        persistSetting(key, value)
        set({ [key]: value } as Pick<SettingsStore, typeof key>)
      },
      // Note: reset preserves theme and language (F0 R7-2)
      reset: () => set({ pomodoroDuration: 25, shortBreakDuration: 5, longBreakDuration: 15, longBreakInterval: 4, autoStartBreaks: false, autoStartPomodoros: false, soundEnabled: true, dayBoundaryHour: DAY_BOUNDARY_MIN, isLoaded: false }),
    }),
    { name: 'settings-store' },
  ),
)
