'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { tokenStorage } from '@/lib/token-storage'
import { AppShell } from '@/components/layout/app-shell'

/**
 * App layout — 2-state guard + /select-space exception (F0 §4.3).
 *
 * No master → /login
 * /select-space → only needs master, no AppShell
 * Other routes → need master + space, wrapped in AppShell
 */

const SELECT_SPACE_PATH = '/select-space'

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
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const master = tokenStorage.getMasterToken()
    const space = tokenStorage.getSpaceToken()
    const spaceId = tokenStorage.getCurrentSpaceId()

    // No master → login
    if (!master) {
      router.replace('/login')
      return
    }

    // /select-space only needs master
    if (pathname === SELECT_SPACE_PATH) {
      setChecked(true)
      return
    }

    // Other (app) routes need master + space
    if (!space || !spaceId) {
      router.replace(SELECT_SPACE_PATH)
      return
    }

    setChecked(true)
  }, [router, pathname])

  // /select-space: no AppShell (full-screen space picker)
  if (pathname === SELECT_SPACE_PATH) {
    return checked ? <>{children}</> : <LoadingScreen />
  }

  if (!checked) return <LoadingScreen />
  return <AppShell>{children}</AppShell>
}
