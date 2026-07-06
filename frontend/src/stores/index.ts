/**
 * Store registry —有序 reset 注册（F0 §6.3c / 附录 E）.
 *
 * STORE_RESET_ORDER 定义 17 个业务 store 的 reset 顺序（被依赖的先 reset）。
 * auth-store / space-store / bootstrap-store 不参与（管理跨空间状态）。
 */

import { useSyncStore } from './sync-store'
import { useTimerStore } from './timer-store'
import { useSessionStore } from './session-store'
import { useTaskStore } from './task-store'
import { useNoteStore } from './note-store'
import { useQuickNoteStore } from './quick-note-store'
import { useFolderStore } from './folder-store'
import { useHabitStore } from './habit-store'
import { useScheduleStore } from './schedule-store'
import { useTimeBlockStore } from './time-block-store'
import { useReflectionStore } from './reflection-store'
import { useStatsStore } from './stats-store'
import { useSearchStore } from './search-store'
import { useTrashStore } from './trash-store'
import { useSettingsStore } from './settings-store'
import { useUIStore } from './ui-store'
import { useAppStore } from './app-store'

export const STORE_RESET_ORDER = [
  'sync',
  'timer',
  'session',
  'task',
  'note',
  'quick-note',
  'folder',
  'habit',
  'schedule',
  'time-block',
  'reflection',
  'stats',
  'search',
  'trash',
  'settings',
  'ui',
  'app',
] as const

export const STORE_RESET_FNS: Array<() => void> = [
  () => useSyncStore.getState().reset(),
  () => useTimerStore.getState().reset(),
  () => useSessionStore.getState().reset(),
  () => useTaskStore.getState().reset(),
  () => useNoteStore.getState().reset(),
  () => useQuickNoteStore.getState().reset(),
  () => useFolderStore.getState().reset(),
  () => useHabitStore.getState().reset(),
  () => useScheduleStore.getState().reset(),
  () => useTimeBlockStore.getState().reset(),
  () => useReflectionStore.getState().reset(),
  () => useStatsStore.getState().reset(),
  () => useSearchStore.getState().reset(),
  () => useTrashStore.getState().reset(),
  () => useSettingsStore.getState().reset(),
  () => useUIStore.getState().reset(),
  () => useAppStore.getState().reset(),
]
