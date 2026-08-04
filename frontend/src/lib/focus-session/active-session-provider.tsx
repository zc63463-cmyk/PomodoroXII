'use client'

import { createContext, createElement, useContext, useEffect, useState } from 'react'
import { activeSessionApi } from '@/services/active-session-api'
import { metaDB } from '@/services/meta-database'
import { BrowserProvisionalOperationLock, type ProvisionalOperationLock } from './provisional-operation-lock'
import { ActiveSessionCoordinatorClient } from './active-session-coordinator'
import { closeTabIdentity, getDeviceIdentity, openTabIdentity, type TabIdentity } from './tab-identity'
import { useTimerStore } from '@/stores/timer-store'
import { PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'

interface ActiveSessionClientContext {
  coordinator: ActiveSessionCoordinatorClient
  identity: TabIdentity
  provisionalLock: ProvisionalOperationLock
}

const ActiveSessionCoordinatorContext = createContext<ActiveSessionClientContext | null>(null)

export function useActiveSessionCoordinator(): ActiveSessionCoordinatorClient {
  const value = useContext(ActiveSessionCoordinatorContext)
  if (!value) throw new Error('active_session_coordinator_not_ready')
  return value.coordinator
}

export function useActiveSessionIdentity(): TabIdentity {
  const value = useContext(ActiveSessionCoordinatorContext)
  if (!value) throw new Error('active_session_coordinator_not_ready')
  return value.identity
}

export function useActiveSessionProvisionalLock(): ProvisionalOperationLock {
  const value = useContext(ActiveSessionCoordinatorContext)
  if (!value) throw new Error('active_session_coordinator_not_ready')
  return value.provisionalLock
}

export function ActiveSessionProvider({ children }: { children: React.ReactNode }) {
  const [mountedClient, setMountedClient] = useState<ActiveSessionClientContext | null>(null)

  useEffect(() => {
    let cancelled = false
    let coordinator: ActiveSessionCoordinatorClient | null = null
    let identity: TabIdentity | null = null
    let frame: number | null = null

    const repaint = () => {
      useTimerStore.getState().setNow(Date.now())
      frame = window.setTimeout(repaint, 250)
    }

    const initialize = async () => {
      try {
        const deviceId = await getDeviceIdentity(metaDB)
        identity = await openTabIdentity(metaDB, deviceId)
        if (cancelled) return
        const provisionalLock = new BrowserProvisionalOperationLock()
        coordinator = new ActiveSessionCoordinatorClient(activeSessionApi, metaDB, identity, provisionalLock)
        try {
          await coordinator.bootstrap()
        } catch (error) {
          // A temporary locate failure must not prevent the rest of the app from rendering.
          useTimerStore.getState().fence((error as Error).message)
        }
        if (cancelled) return
        setMountedClient({ coordinator, identity, provisionalLock })
        repaint()
      } catch (error) {
        if (!cancelled) useTimerStore.getState().fence((error as Error).message)
      }
    }

    void initialize()
    const onPageHide = () => {
      if (identity) void closeTabIdentity(metaDB, identity)
    }
    const onSpaceSwitch = () => {
      // Space-local stores are reset by SpaceSwitchProvider; rebuild the global projection from Master scope.
      useTimerStore.getState().reset()
      void coordinator?.refresh(false).catch(() => undefined)
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener(PXII_SPACE_SWITCHED_EVENT, onSpaceSwitch)

    return () => {
      cancelled = true
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener(PXII_SPACE_SWITCHED_EVENT, onSpaceSwitch)
      if (frame !== null) window.clearTimeout(frame)
      if (identity) void closeTabIdentity(metaDB, identity)
      coordinator?.destroy()
      setMountedClient(null)
    }
  }, [])

  return createElement(
    ActiveSessionCoordinatorContext.Provider,
    { value: mountedClient },
    mountedClient ? children : null,
  )
}
