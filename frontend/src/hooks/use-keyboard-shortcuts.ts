'use client'

/**
 * Keyboard shortcuts hook (F0 §5.6).
 *
 * S0-4: Migrated from useState to ui-store (Zustand).
 * S3-5: SHORTCUT_ROUTES imported from nav-config (single source of truth).
 * S3-6: Ctrl+K (command palette), ? (shortcut help), Escape (close dialogs).
 * Number keys 1–5 navigate to main routes.
 *
 * React best practices:
 * - selector-only subscriptions for stable action references
 * - actions are stable (Zustand) — safe in useEffect deps
 */

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { SHORTCUT_ROUTES } from '@/lib/nav-config'
import { useUIStore } from '@/stores/ui-store'

function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export function useKeyboardShortcuts(): void {
  const router = useRouter()
  const pathname = usePathname()
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette)
  const setShortcutHelpOpen = useUIStore((s) => s.setShortcutHelpOpen)
  const closeAllPanels = useUIStore((s) => s.closeAllPanels)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K / Meta+K → toggle command palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        toggleCommandPalette()
        return
      }

      // ? (Shift+/) → open shortcut help (not in form fields)
      if (e.shiftKey && e.key === '?' && !isFormField(e.target)) {
        e.preventDefault()
        setShortcutHelpOpen(true)
        return
      }

      // Escape → close all dialogs
      if (e.key === 'Escape') {
        closeAllPanels()
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
  }, [router, pathname, toggleCommandPalette, setShortcutHelpOpen, closeAllPanels])
}
