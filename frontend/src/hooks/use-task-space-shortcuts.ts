'use client'

/**
 * Tasks-page keyboard shortcuts (T3 前端打磨).
 *
 * - `n` → create a work item (child of the selected item, or a root when
 *   nothing is selected) — opens the same dialog as the tree buttons
 * - `e` → collapse / expand the whole work-item tree (toggle)
 * - `s` → start a focus session for the selected item (clicks the
 *   data-launch-session button rendered by LaunchSessionButton)
 *
 * Mirrors the global use-keyboard-shortcuts guards: no modifiers, ignored
 * while typing in form fields.  Registered here (not globally) so the keys
 * stay free on other pages.
 */

import { useEffect } from 'react'
import { isFormField } from './use-keyboard-shortcuts'

export interface TaskSpaceShortcutHandlers {
  onCreateWorkItem: () => void
  onToggleCollapse: () => void
  onStartFocus: () => void
}

export function useTaskSpaceShortcuts(handlers: TaskSpaceShortcutHandlers): void {
  const { onCreateWorkItem, onToggleCollapse, onStartFocus } = handlers

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isFormField(e.target)) return
      switch (e.key) {
        case 'n':
          e.preventDefault()
          onCreateWorkItem()
          return
        case 'e':
          e.preventDefault()
          onToggleCollapse()
          return
        case 's': {
          const button = document.querySelector<HTMLButtonElement>('[data-launch-session]')
          if (button !== null && !button.disabled) {
            e.preventDefault()
            button.click()
          }
          return
        }
        default:
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCreateWorkItem, onToggleCollapse, onStartFocus])
}
