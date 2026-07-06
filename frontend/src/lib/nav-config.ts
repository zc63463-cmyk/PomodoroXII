/**
 * Navigation configuration — single source of truth (S3-5).
 *
 * F0 §5.2 — 10 items, no dashboard in nav.
 * Order: timer → tasks → schedules → quick-notes → stats
 *        → reflections → notes → habits → trash → settings
 */

import {
  TimerIcon,
  ListTodoIcon,
  CalendarIcon,
  ZapIcon,
  BarChart3Icon,
  PenLineIcon,
  NotebookIcon,
  RepeatIcon,
  Trash2Icon,
  SettingsIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'

export interface NavItem {
  path: string
  label: string
  Icon: ComponentType<{ className?: string }>
}

/** F0 §5.2 — 10 项，无 dashboard */
export const NAV_ITEMS = [
  { path: '/timer', label: '番茄钟', Icon: TimerIcon },
  { path: '/tasks', label: '任务', Icon: ListTodoIcon },
  { path: '/schedules', label: '日程', Icon: CalendarIcon },
  { path: '/quick-notes', label: '速记', Icon: ZapIcon },
  { path: '/stats', label: '统计', Icon: BarChart3Icon },
  { path: '/reflections', label: '反思', Icon: PenLineIcon },
  { path: '/notes', label: '笔记', Icon: NotebookIcon },
  { path: '/habits', label: '习惯', Icon: RepeatIcon },
  { path: '/trash', label: '回收站', Icon: Trash2Icon },
  { path: '/settings', label: '设置', Icon: SettingsIcon },
] as const satisfies readonly NavItem[]

/** F0 §5.5 — 前 5 项 */
export const MOBILE_NAV_ITEMS: readonly NavItem[] = NAV_ITEMS.slice(0, 5)

/** F0 §5.6 — 数字键 1-5 → 路由 */
export const SHORTCUT_ROUTES = {
  '1': '/timer',
  '2': '/tasks',
  '3': '/schedules',
  '4': '/quick-notes',
  '5': '/stats',
} as const satisfies Readonly<Record<string, string>>
