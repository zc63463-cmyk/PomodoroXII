/**
 * UI store tests (F0 §7.3.18).
 *
 * Tests command palette, shortcut help, and panel state management.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from '@/stores/ui-store'

describe('ui-store', () => {
  beforeEach(() => {
    useUIStore.getState().reset()
  })

  it('initial state: all panels closed', () => {
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false)
    expect(useUIStore.getState().isShortcutHelpOpen).toBe(false)
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(useUIStore.getState().mobileNavOpen).toBe(false)
  })

  it('toggleCommandPalette flips state', () => {
    useUIStore.getState().toggleCommandPalette()
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true)
    useUIStore.getState().toggleCommandPalette()
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false)
  })

  it('setCommandPaletteOpen(false) closes palette', () => {
    useUIStore.getState().setCommandPaletteOpen(true)
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true)
    useUIStore.getState().setCommandPaletteOpen(false)
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false)
  })

  it('setShortcutHelpOpen controls help dialog', () => {
    useUIStore.getState().setShortcutHelpOpen(true)
    expect(useUIStore.getState().isShortcutHelpOpen).toBe(true)
    useUIStore.getState().setShortcutHelpOpen(false)
    expect(useUIStore.getState().isShortcutHelpOpen).toBe(false)
  })

  it('closeAllPanels closes command palette, shortcut help, modal, mobile nav', () => {
    useUIStore.getState().setCommandPaletteOpen(true)
    useUIStore.getState().setShortcutHelpOpen(true)
    useUIStore.getState().openModal('test-modal')
    useUIStore.getState().toggleMobileNav()
    useUIStore.getState().closeAllPanels()
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false)
    expect(useUIStore.getState().isShortcutHelpOpen).toBe(false)
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(useUIStore.getState().mobileNavOpen).toBe(false)
  })

  it('reset closes all panels and restores sidebar defaults', () => {
    useUIStore.getState().setCommandPaletteOpen(true)
    useUIStore.getState().setShortcutHelpOpen(true)
    useUIStore.getState().openModal('test')
    useUIStore.getState().toggleSidebar()
    useUIStore.getState().setSidebarOpen(true)
    useUIStore.getState().toggleMobileNav()
    useUIStore.getState().reset()
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false)
    expect(useUIStore.getState().isShortcutHelpOpen).toBe(false)
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(useUIStore.getState().mobileNavOpen).toBe(false)
  })
})
