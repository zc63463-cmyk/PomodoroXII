'use client'

/**
 * Space bootstrap — gated hydrate (S3-2 + S3-1).
 *
 * Replaces AuthBootstrap. Sets bootstrap phase based on hydrate result:
 * 1. auth-store.hydrate() (sync — reads localStorage)
 * 2. No master → setReady() (guard will redirect /login)
 * 3. Has master → await space-store.hydrate()
 * 4. Success → bootstrapSyncEngine + setReady()
 * 5. Failure → setFailed(msg) + toast.error
 */

import { useEffect, createElement, Fragment } from 'react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useSpaceStore } from '@/stores/space-store'
import { useBootstrapStore } from '@/lib/bootstrap-store'
import { tokenStorage } from '@/lib/token-storage'
import { bootstrapSyncEngine } from '@/lib/sync'
import {
  isQuickNotePreviewEnabled,
  isQuickNotePreviewRoute,
} from '@/lib/quick-notes/quick-note-preview'

export function SpaceBootstrap({ children }: { children: React.ReactNode }) {
  const hydrateAuth = useAuthStore((s) => s.hydrate)
  const hydrateSpace = useSpaceStore((s) => s.hydrate)
  const setReady = useBootstrapStore((s) => s.setReady)
  const setFailed = useBootstrapStore((s) => s.setFailed)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (
        isQuickNotePreviewRoute(window.location.pathname) &&
        isQuickNotePreviewEnabled()
      ) {
        if (!cancelled) setReady()
        return
      }

      // 1. auth hydrate (sync — reads localStorage)
      hydrateAuth()

      // 2. no master → ready (guard will redirect /login)
      const master = tokenStorage.getMasterToken()
      if (!master) {
        if (!cancelled) setReady()
        return
      }

      // 3. has master → await space hydrate
      try {
        await hydrateSpace()
        if (cancelled) return
        // S1-4: hydrate 成功后 bootstrap sync 引擎（不派发 pxii:space-switched）
        const spaceId = useSpaceStore.getState().currentSpaceId
        if (spaceId) bootstrapSyncEngine(spaceId)
        if (!cancelled) setReady()
      } catch (e) {
        if (cancelled) return
        const msg = (e as Error).message
        setFailed(msg)
        toast.error('空间恢复失败', { description: msg })
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [hydrateAuth, hydrateSpace, setReady, setFailed])

  return createElement(Fragment, null, children)
}
