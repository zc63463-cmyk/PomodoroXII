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
import { NAV_ITEMS } from '@/lib/nav-config'

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
