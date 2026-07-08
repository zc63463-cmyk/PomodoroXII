'use client'

/**
 * App providers (F0 §6.1).
 *
 * Nesting: QueryClientProvider → ThemeProvider → SpaceBootstrap
 *          → SpaceSwitchProvider → CrossTabSyncProvider → {children}
 *          + Toaster
 *
 * F0 §6.1 对照:
 * 1. QueryClientProvider (最外 — 所有 useQuery 可用)
 * 2. ThemeProvider (UI 组件之前)
 * 3. SpaceBootstrap (bootstrap 门控 — S0-3 添加)
 * 4. SpaceSwitchProvider (监听 pxii:space-switched — reset + invalidate)
 * 5. CrossTabSyncProvider (监听跨 Tab 空间切换)
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { queryClient } from '@/lib/query-client'
import { SpaceBootstrap } from '@/lib/space-bootstrap'
import { SpaceSwitchProvider } from '@/lib/on-space-switch'
import { CrossTabSyncProvider } from '@/lib/cross-tab-sync'
import { Toaster } from '@/components/ui/sonner'
import { THEMES } from '@/utils/constants'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        themes={[...THEMES]}
      >
        <SpaceBootstrap>
          <SpaceSwitchProvider>
            <CrossTabSyncProvider>
              {children}
            </CrossTabSyncProvider>
          </SpaceSwitchProvider>
        </SpaceBootstrap>
        <Toaster position="bottom-right" />
      </ThemeProvider>
    </QueryClientProvider>
  )
}
