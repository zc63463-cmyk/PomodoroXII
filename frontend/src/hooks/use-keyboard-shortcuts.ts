'use client'

/**
 * Keyboard shortcuts hook (F0 §5.6).
 *
 * S3-5: SHORTCUT_ROUTES imported from nav-config (single source of truth).
 * S3-6: Added Ctrl+K (command palette), ? (shortcut help), Escape (close dialogs).
 * Number keys 1–5 navigate to main routes.
 */

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { SHORTCUT_ROUTES } from '@/lib/nav-config'

function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export interface ShortcutState {
  commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void
  shortcutHelpOpen: boolean
  setShortcutHelpOpen: (open: boolean) => void
}

export function useKeyboardShortcuts(): ShortcutState {
  const router = useRouter()
  const pathname = usePathname()
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K / Meta+K → toggle command palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen((prev) => !prev)
        return
      }

      // ? (Shift+/) → open shortcut help (not in form fields)
      if (e.shiftKey && e.key === '?' && !isFormField(e.target)) {
        e.preventDefault()
        setShortcutHelpOpen(true)
        return
      }

      // Escape → close dialogs
      if (e.key === 'Escape') {
        setCommandPaletteOpen(false)
        setShortcutHelpOpen(false)
        return
      }

      // 1-5 → navigation (no modifiers, no form fields)
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isFormField(e.target)) return
      const route = SHORTCUT_ROUTES[e.key as keyof typeof SHORTCUT_ROUTES]
      if (route && pathname !== route) {
        router.push(route)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [router, pathname])

  return {
    commandPaletteOpen,
    setCommandPaletteOpen,
    shortcutHelpOpen,
    setShortcutHelpOpen,
  }
}
