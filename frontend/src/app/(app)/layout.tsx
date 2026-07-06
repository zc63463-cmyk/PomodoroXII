'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { tokenStorage } from '@/lib/token-storage'
import { useBootstrapStore } from '@/lib/bootstrap-store'
import { resolveAppRouteGuard } from '@/lib/route-guard'
import { AppShell } from '@/components/layout/app-shell'

/**
 * App layout — 2-state guard + /select-space exception (F0 §4.3).
 *
 * Uses bootstrap phase gate (S3-2) + route-guard pure function (S3-3).
 * /select-space: only needs master, no AppShell, no bootstrap wait.
 * Other routes: need master + space + bootstrap ready.
 */

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <span className="text-muted-foreground">Loading…</span>
    </div>
  )
}

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const phase = useBootstrapStore((s) => s.phase)

  useEffect(() => {
    const decision = resolveAppRouteGuard({
      pathname,
      masterToken: tokenStorage.getMasterToken(),
      spaceToken: tokenStorage.getSpaceToken(),
      spaceId: tokenStorage.getCurrentSpaceId(),
      bootstrapPhase: phase,
    })

    switch (decision) {
      case 'redirect-login':
        router.replace('/login')
        break
      case 'redirect-select-space':
        router.replace('/select-space')
        break
      // allow-select-space, allow-shell, wait → no redirect
    }
  }, [router, pathname, phase])

  const decision = resolveAppRouteGuard({
    pathname,
    masterToken: tokenStorage.getMasterToken(),
    spaceToken: tokenStorage.getSpaceToken(),
    spaceId: tokenStorage.getCurrentSpaceId(),
    bootstrapPhase: phase,
  })

  // /select-space: no AppShell (full-screen space picker)
  if (decision === 'allow-select-space') return <>{children}</>
  // Wait for bootstrap to finish before rendering AppShell
  if (decision === 'wait') return <LoadingScreen />
  // Redirect cases: show loading while router.replace takes effect
  if (decision === 'redirect-login' || decision === 'redirect-select-space')
    return <LoadingScreen />
  // allow-shell
  return <AppShell>{children}</AppShell>
}
