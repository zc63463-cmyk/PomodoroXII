'use client'

/**
 * Desktop sidebar (F0 §5.2).
 *
 * 10 nav items, NO dashboard in nav (F0 G3).
 * Order: timer → tasks → schedules → quick-notes → stats
 *        → reflections → notes → habits → trash → settings
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
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

interface NavItem {
  path: string
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

const NAV_ITEMS: readonly NavItem[] = [
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
]

export function DesktopSidebar() {
  const pathname = usePathname()

  return (
    <nav className="hidden w-56 flex-col gap-1 border-r bg-sidebar p-3 md:flex">
      {NAV_ITEMS.map(({ path, label, Icon }) => {
        const isActive = pathname === path
        return (
          <Link
            key={path}
            href={path}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
            )}
          >
            <Icon className="size-4" />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
