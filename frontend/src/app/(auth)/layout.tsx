'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokenStorage } from '@/lib/token-storage'
import { resolveAuthRouteGuard } from '@/lib/route-guard'

/**
 * Auth layout — 3-state guard (F0 §4.2).
 *
 * Uses route-guard pure function (S3-3).
 * ③ master + space + spaceId → redirect /dashboard
 * ② master, no space → redirect /select-space
 * ① no master → allow (setup or login page)
 */

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const decision = resolveAuthRouteGuard({
      masterToken: tokenStorage.getMasterToken(),
      spaceToken: tokenStorage.getSpaceToken(),
      spaceId: tokenStorage.getCurrentSpaceId(),
    })

    if (decision === 'redirect-dashboard') {
      router.replace('/dashboard')
      return
    }
    if (decision === 'redirect-select-space') {
      router.replace('/select-space')
      return
    }
    setChecked(true)
  }, [router])

  if (!checked) {
    return (
      <div className="flex h-screen items-center justify-center">
        <span className="text-muted-foreground">Loading…</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}
