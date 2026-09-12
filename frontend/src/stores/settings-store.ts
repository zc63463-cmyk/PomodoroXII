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
   * 专注结束桌面通知（工单① 2026-09-13）。提示音走 soundEnabled，二者独立。
   * 授权（requestPermission）只在设置页的用户手势里发生，本 store 只存偏好。
   */
  notificationEnabled: boolean
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
const SETTINGS_LANGUAGE_VALUES: readonly SettingsLanguage[] = ['zh-CN', 'en']

/**
 * 数值键的防呆上下限：时长（分钟）与长休间隔。
 * 这里是"脏数据别把 UI 弄崩"的兜底，**不是业务约束** —— 真正的业务规则在计时器侧。
 */
const DURATION_MIN_MINUTES = 1
const DURATION_MAX_MINUTES = 1440
const INTERVAL_MIN = 1
const INTERVAL_MAX = 24

/**
 * 共享的安全读取原语（工单③ 2026-09-13）。
 *
 * localStorage 是用户可改的：任何解析失败、类型不符、越界都退回到 `fallback`，
 * 绝不抛出（既有规矩）。`storageKey` 用完整键名 —— 其余键是 `pxii_settings_<key>`。
 * `validate` 返回 `undefined` 表示数据不合法。
 *
 * ⚠️ 本原语按 **JSON** 解析值。`theme` 是唯一**裸串**键（键名就是裸 `theme`），
 * 不能走这里 —— 见 readRawString。
 */
function readPersisted<T>(
  storageKey: string,
  validate: (value: unknown) => T | undefined,
  fallback: T,
): T {
  if (typeof window === 'undefined') return fallback

  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    const valid = validate(parsed)
    return valid === undefined ? fallback : valid
  } catch {
    return fallback
  }
}

/** 整数键：类型/有限性校验 → 截断 → clamp 到防呆区间。 */
function readIntegerSetting(
  storageKey: string,
  min: number,
  max: number,
  fallback: number,
): number {
  return readPersisted<number>(
    storageKey,
    (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      return Math.min(Math.max(Math.trunc(value), min), max)
    },
    fallback,
  )
}

function readBooleanSetting(storageKey: string, fallback: boolean): boolean {
  return readPersisted<boolean>(
    storageKey,
    (value) => (typeof value === 'boolean' ? value : undefined),
    fallback,
  )
}

/**
 * 裸字符串读取原语 —— **刻意不走 JSON.parse**（工单③ 回归修复 2026-09-13）。
 *
 * ⚠️ 格式不对称的原因（不要把 theme"统一"成 JSON）：`theme` 这个 localStorage
 * 键由**两个写入方共用，且两边都写裸串** —— next-themes 内部是
 * `localStorage.setItem('theme', value)`，本 store 的 persistSetting 对 theme
 * 也是 `setItem('theme', String(value))`（见下）。其余键是我们独占的，写读都走
 * JSON。若把 theme 也接进 readPersisted（JSON.parse），裸值 `midnight` 会直接
 * SyntaxError 被 catch 吞掉、回落到 'system' —— 用户选过的主题会在刷新后被静默
 * 重置回 system（settings/page.tsx:80-85 的 effect 再把它同步回 next-themes，
 * 选择器也错误高亮"跟随系统"）。故 theme 用本原语：裸串 + 枚举校验 + 脏值回落。
 * 对照：language 存的是 '"en"'（带引号），必须保持 JSON 语义。
 */
function readRawString<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof window === 'undefined') return fallback

  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return fallback
    return allowed.find((value) => value === raw) ?? fallback
  } catch {
    return fallback
  }
}

function getInitialTheme(): SettingsTheme {
  return readRawString<SettingsTheme>('theme', SETTINGS_THEME_VALUES, 'system')
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
 * 偏好全键读回（工单③ 2026-09-13）。
 *
 * 此前只有 theme 在初始状态读回，notificationEnabled 在工单①补上；其余设置
 * 写了 localStorage 却没读，刷新即丢。这里把**全部键**的读取统一放在
 * **初始状态**（同 getInitialTheme 的做法）：全应用目前没有任何调用
 * settings load() 的引导点，只补 load() 读回的话，真实运行时依旧是
 * "写了不读、刷新即丢"。load() 也同步扩展为全键读回，保留 API ——
 * 未来接服务端偏好 / 延迟加载时它是天然入口。
 *
 * 数值键做防呆 clamp（脏数据退回默认，不崩）；布尔键只认 boolean；
 * language 只认枚举内取值。
 */
function getInitialPomodoroDuration(): number {
  return readIntegerSetting('pxii_settings_pomodoroDuration', DURATION_MIN_MINUTES, DURATION_MAX_MINUTES, 25)
}

function getInitialShortBreakDuration(): number {
  return readIntegerSetting('pxii_settings_shortBreakDuration', DURATION_MIN_MINUTES, DURATION_MAX_MINUTES, 5)
}

function getInitialLongBreakDuration(): number {
  return readIntegerSetting('pxii_settings_longBreakDuration', DURATION_MIN_MINUTES, DURATION_MAX_MINUTES, 15)
}

function getInitialLongBreakInterval(): number {
  return readIntegerSetting('pxii_settings_longBreakInterval', INTERVAL_MIN, INTERVAL_MAX, 4)
}

function getInitialAutoStartBreaks(): boolean {
  return readBooleanSetting('pxii_settings_autoStartBreaks', false)
}

function getInitialAutoStartPomodoros(): boolean {
  return readBooleanSetting('pxii_settings_autoStartPomodoros', false)
}

function getInitialSoundEnabled(): boolean {
  return readBooleanSetting('pxii_settings_soundEnabled', true)
}

function getInitialNotificationEnabled(): boolean {
  return readBooleanSetting('pxii_settings_notificationEnabled', true)
}

function getInitialDayBoundaryHour(): number {
  return readIntegerSetting('pxii_settings_dayBoundaryHour', DAY_BOUNDARY_MIN, DAY_BOUNDARY_MAX, DAY_BOUNDARY_MIN)
}

function getInitialLanguage(): SettingsLanguage {
  return readPersisted<SettingsLanguage>(
    'pxii_settings_language',
    (value) =>
      SETTINGS_LANGUAGE_VALUES.some((language) => language === value)
        ? (value as SettingsLanguage)
        : undefined,
    'zh-CN',
  )
}

export const useSettingsStore = create<SettingsStore>()(
  devtools(
    (set) => ({
      pomodoroDuration: getInitialPomodoroDuration(),
      shortBreakDuration: getInitialShortBreakDuration(),
      longBreakDuration: getInitialLongBreakDuration(),
      longBreakInterval: getInitialLongBreakInterval(),
      autoStartBreaks: getInitialAutoStartBreaks(),
      autoStartPomodoros: getInitialAutoStartPomodoros(),
      soundEnabled: getInitialSoundEnabled(),
      notificationEnabled: getInitialNotificationEnabled(),
      dayBoundaryHour: getInitialDayBoundaryHour(),
      theme: getInitialTheme(),
      language: getInitialLanguage(),
      isLoaded: false,

      load: async () => {
        set({
          pomodoroDuration: getInitialPomodoroDuration(),
          shortBreakDuration: getInitialShortBreakDuration(),
          longBreakDuration: getInitialLongBreakDuration(),
          longBreakInterval: getInitialLongBreakInterval(),
          autoStartBreaks: getInitialAutoStartBreaks(),
          autoStartPomodoros: getInitialAutoStartPomodoros(),
          soundEnabled: getInitialSoundEnabled(),
          notificationEnabled: getInitialNotificationEnabled(),
          dayBoundaryHour: getInitialDayBoundaryHour(),
          theme: getInitialTheme(),
          language: getInitialLanguage(),
          isLoaded: true,
        })
      },
      update: async (key, value) => {
        persistSetting(key, value)
        set({ [key]: value } as Pick<SettingsStore, typeof key>)
      },
      // Note: reset preserves theme and language (F0 R7-2)
      reset: () => set({ pomodoroDuration: 25, shortBreakDuration: 5, longBreakDuration: 15, longBreakInterval: 4, autoStartBreaks: false, autoStartPomodoros: false, soundEnabled: true, notificationEnabled: true, dayBoundaryHour: DAY_BOUNDARY_MIN, isLoaded: false }),
    }),
    { name: 'settings-store' },
  ),
)
