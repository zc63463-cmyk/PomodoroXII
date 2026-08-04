import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { ActiveSessionView, FocusSessionView } from '@/lib/contracts/focus-session'
import { deriveSessionClock, type DerivedClock } from '@/lib/focus-session/clock'
import type { TabIdentity } from '@/lib/focus-session/tab-identity'

export type OwnershipMode = 'none' | 'owner' | 'read_only' | 'conflict'

export interface TimerState {
  locator: ActiveSessionView | null
  session: FocusSessionView | null
  ownershipMode: OwnershipMode
  ownershipEpoch: number | null
  deviceId: string | null
  tabId: string | null
  nowMs: number
  error: string | null
}

interface TimerActions {
  installLocator: (locator: ActiveSessionView | null, identity: TabIdentity) => void
  setNow: (nowMs: number) => void
  fence: (error: string) => void
  assertCanStart: (spaceId: string) => void
  reset: () => void
}

export type TimerStore = TimerState & TimerActions

const initialState = (): TimerState => ({
  locator: null,
  session: null,
  ownershipMode: 'none',
  ownershipEpoch: null,
  deviceId: null,
  tabId: null,
  nowMs: Date.now(),
  error: null,
})

export const useTimerStore = create<TimerStore>()(
  devtools((set, get) => ({
    ...initialState(),
    installLocator(locator, identity) {
      set({
        locator,
        session: locator?.session.session ?? null,
        ownershipEpoch: locator?.ownershipEpoch ?? null,
        deviceId: identity.deviceId,
        tabId: identity.tabId,
        ownershipMode: locator === null ? 'none' :
          locator.ownerDeviceId === identity.deviceId && locator.ownerTabId === identity.tabId
            ? 'owner' : 'read_only',
        error: null,
      })
    },
    setNow: (nowMs) => set({ nowMs }),
    fence: (error) => set({ ownershipMode: 'read_only', error }),
    assertCanStart(spaceId) {
      const locator = get().locator
      if (locator) throw new Error(`active_session_exists:${locator.spaceId}:${spaceId}`)
    },
    reset: () => set(initialState()),
  }), { name: 'timer-store' }),
)

export const selectDerivedClock = (state: TimerState): DerivedClock | null =>
  state.session ? deriveSessionClock(state.session, state.nowMs) : null
