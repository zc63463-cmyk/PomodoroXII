'use client'

/**
 * App shell layout (F0 §5.1).
 *
 * Header: logo + SpaceSwitcher + SyncStatusBar + Logout
 * Desktop: sidebar + main content
 * Mobile: bottom nav
 * S3-6: Command palette stub (Ctrl+K) + shortcut help dialog (?)
 */

import { useState } from 'react'
import { DesktopSidebar } from '@/components/layout/desktop-sidebar'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { SpaceSwitcher } from '@/components/layout/space-switcher'
import { SyncStatusBar } from '@/components/layout/sync-status-bar'
import { CommandPaletteStub } from '@/components/layout/command-palette-stub'
import { ShortcutHelpDialog } from '@/components/layout/shortcut-help-dialog'
import { Button } from '@/components/ui/button'
import { performLogout } from '@/lib/logout'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import { LogOutIcon } from 'lucide-react'

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    shortcutHelpOpen,
    setShortcutHelpOpen,
  } = useKeyboardShortcuts()
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = async () => {
    setIsLoggingOut(true)
    try {
      await performLogout()
    } catch {
      setIsLoggingOut(false)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Header */}
      <header className="flex h-14 items-center justify-between border-b px-4">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-primary">PomodoroXII</span>
          <SpaceSwitcher />
        </div>
        <div className="flex items-center gap-3">
          <SyncStatusBar />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            <LogOutIcon />
            <span className="sr-only">退出</span>
          </Button>
        </div>
      </header>

      {/* Desktop: sidebar + main */}
      <div className="flex flex-1 overflow-hidden">
        <DesktopSidebar />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>

      {/* Mobile: bottom nav */}
      <MobileBottomNav />

      {/* S3-6: Dialog stubs */}
      <CommandPaletteStub
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
      />
      <ShortcutHelpDialog
        open={shortcutHelpOpen}
        onOpenChange={setShortcutHelpOpen}
      />
    </div>
  )
}
