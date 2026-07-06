'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokenStorage } from '@/lib/token-storage'

/**
 * Root page (F0 §4.4).
 *
 * / → has token+space → /dashboard
 *   → has master only → /select-space
 *   → otherwise → /login
 */

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    const master = tokenStorage.getMasterToken()
    const space = tokenStorage.getSpaceToken()
    const spaceId = tokenStorage.getCurrentSpaceId()

    if (master && space && spaceId) {
      router.replace('/dashboard')
    } else if (master) {
      router.replace('/select-space')
    } else {
      router.replace('/login')
    }
  }, [router])

  return (
    <div className="flex h-screen items-center justify-center">
      <span className="text-muted-foreground">Loading…</span>
    </div>
  )
}
