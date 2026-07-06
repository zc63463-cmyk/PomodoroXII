'use client'

/**
 * Mobile bottom navigation (F0 §5.5).
 *
 * First 5 items only: timer → tasks → schedules → quick-notes → stats
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
} from 'lucide-react'

interface NavItem {
  path: string
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

const MOBILE_NAV_ITEMS: readonly NavItem[] = [
  { path: '/timer', label: '番茄钟', Icon: TimerIcon },
  { path: '/tasks', label: '任务', Icon: ListTodoIcon },
  { path: '/schedules', label: '日程', Icon: CalendarIcon },
  { path: '/quick-notes', label: '速记', Icon: ZapIcon },
  { path: '/stats', label: '统计', Icon: BarChart3Icon },
]

export function MobileBottomNav() {
  const pathname = usePathname()

  return (
    <nav className="flex items-center justify-around border-t bg-background py-1 md:hidden">
      {MOBILE_NAV_ITEMS.map(({ path, label, Icon }) => {
        const isActive = pathname === path
        return (
          <Link
            key={path}
            href={path}
            className={cn(
              'flex flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-5" />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
