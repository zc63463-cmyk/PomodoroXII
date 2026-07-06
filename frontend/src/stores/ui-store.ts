/**
 * UI store (F0 §7.3.18).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface UIState {
  isCommandPaletteOpen: boolean
  isShortcutHelpOpen: boolean
  activeModal: string | null
  sidebarCollapsed: boolean
  sidebarOpen: boolean
  mobileNavOpen: boolean
}

interface UIActions {
  toggleCommandPalette: () => void
  toggleShortcutHelp: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setShortcutHelpOpen: (open: boolean) => void
  openModal: (id: string) => void
  closeModal: () => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  toggleMobileNav: () => void
  closeAllPanels: () => void
  reset: () => void
}

type UIStore = UIState & UIActions

export const useUIStore = create<UIStore>()(
  devtools(
    (set) => ({
      isCommandPaletteOpen: false,
      isShortcutHelpOpen: false,
      activeModal: null,
      sidebarCollapsed: false,
      sidebarOpen: false,
      mobileNavOpen: false,

      toggleCommandPalette: () => set((s) => ({ isCommandPaletteOpen: !s.isCommandPaletteOpen })),
      toggleShortcutHelp: () => set((s) => ({ isShortcutHelpOpen: !s.isShortcutHelpOpen })),
      setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
      setShortcutHelpOpen: (open) => set({ isShortcutHelpOpen: open }),
      openModal: (id) => set({ activeModal: id }),
      closeModal: () => set({ activeModal: null }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
      closeAllPanels: () => set({ isCommandPaletteOpen: false, isShortcutHelpOpen: false, activeModal: null, mobileNavOpen: false }),
      reset: () => set({ isCommandPaletteOpen: false, isShortcutHelpOpen: false, activeModal: null, sidebarCollapsed: false, sidebarOpen: false, mobileNavOpen: false }),
    }),
    { name: 'ui-store' },
  ),
)
