'use client'

/**
 * Auth bootstrap component (F0 §6.4 — hydrate fix S2-4).
 *
 * Mounts and triggers authStore.hydrate() → spaceStore.hydrate().
 * Non-blocking: children render immediately, guards read localStorage directly.
 */

import { useEffect } from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { useSpaceStore } from '@/stores/space-store'

export function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const hydrateAuth = useAuthStore((s) => s.hydrate)
  const hydrateSpace = useSpaceStore((s) => s.hydrate)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      hydrateAuth()
      await hydrateSpace()
      if (cancelled) return
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [hydrateAuth, hydrateSpace])

  return <>{children}</>
}
