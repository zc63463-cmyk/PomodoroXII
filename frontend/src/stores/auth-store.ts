/**
 * Auth store (F0 §7.3.1).
 *
 * State: masterToken, isAuthenticating, error
 * Actions: setup, login, verify, logout, hydrate, reset
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { authApi } from '@/services/auth-api'
import { tokenStorage } from '@/lib/token-storage'

interface AuthState {
  masterToken: string | null
  isAuthenticating: boolean
  error: string | null
}

interface AuthActions {
  setup: (password: string) => Promise<void>
  login: (password: string) => Promise<void>
  verify: () => Promise<boolean>
  logout: () => void
  hydrate: () => void
  reset: () => void
}

export const useAuthStore = create<AuthState & AuthActions>()(
  devtools(
    (set) => ({
      masterToken: null,
      isAuthenticating: false,
      error: null,

      setup: async (password) => {
        set({ isAuthenticating: true, error: null })
        try {
          await authApi.setup(password)
          const token = await authApi.login(password)
          tokenStorage.setMasterToken(token)
          set({ masterToken: token, isAuthenticating: false })
        } catch (e) {
          set({ isAuthenticating: false, error: (e as Error).message })
          throw e
        }
      },

      login: async (password) => {
        set({ isAuthenticating: true, error: null })
        try {
          const token = await authApi.login(password)
          tokenStorage.setMasterToken(token)
          set({ masterToken: token, isAuthenticating: false })
        } catch (e) {
          set({ isAuthenticating: false, error: (e as Error).message })
          throw e
        }
      },

      verify: async () => {
        try {
          return (await authApi.verify()).valid
        } catch {
          return false
        }
      },

      logout: () => {
        // S3-7: unified logout entry — delegates to performLogout
        void import('@/lib/logout').then(({ performLogout }) => performLogout())
      },

      hydrate: () => {
        set({ masterToken: tokenStorage.getMasterToken() })
      },

      reset: () => {
        set({ masterToken: null, isAuthenticating: false, error: null })
      },
    }),
    { name: 'auth-store' },
  ),
)

export const selectIsAuthenticated = (s: AuthState & AuthActions): boolean =>
  s.masterToken !== null
