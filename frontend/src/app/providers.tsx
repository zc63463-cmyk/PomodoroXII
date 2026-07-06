'use client'

/**
 * App providers (F0 §6.1 — S0-3 simplified).
 *
 * Nesting: QueryClientProvider → ThemeProvider → AuthBootstrap + Toaster
 * S0-3 does NOT add SpaceSwitchProvider / CrossTabSyncProvider (S0-4).
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { queryClient } from '@/lib/query-client'
import { AuthBootstrap } from '@/lib/auth-bootstrap'
import { Toaster } from '@/components/ui/sonner'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        <AuthBootstrap>{children}</AuthBootstrap>
        <Toaster position="bottom-right" />
      </ThemeProvider>
    </QueryClientProvider>
  )
}
