'use client'

/**
 * Keyboard shortcuts hook (F0 §5.6).
 *
 * Number keys 1–5 navigate to main routes.
 * Ignores keys when typing in form fields or with modifier keys.
 */

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'

const SHORTCUT_ROUTES: Readonly<Record<string, string>> = {
  '1': '/timer',
  '2': '/tasks',
  '3': '/schedules',
  '4': '/quick-notes',
  '5': '/stats',
}

function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export function useKeyboardShortcuts(): void {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip when typing in form fields
      if (isFormField(e.target)) return
      // Ignore modifier combos (Ctrl+K etc. reserved for future)
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const route = SHORTCUT_ROUTES[e.key]
      if (route && pathname !== route) {
        router.push(route)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [router, pathname])
}
