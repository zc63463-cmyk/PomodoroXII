/**
 * Space store (F0 §7.3.2).
 *
 * State: spaces, currentSpaceId, spaceToken, isLoading, error, pendingPasswordSpaceId
 * Actions: loadSpaces, createSpace, selectSpace, issueSpaceToken, hydrate, reset
 * D8 reserved: has_password always false, _spacePassword unused, pendingPasswordSpaceId always null
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { spacesApi } from '@/services/spaces-api'
import { tokenStorage } from '@/lib/token-storage'
import { spaceDBManager } from '@/services/space-db'
import { metaDB, type SpaceMeta } from '@/services/meta-database'

export interface SpaceInfo extends SpaceMeta {
  has_password: boolean // D8: always false
}

interface SpaceState {
  spaces: SpaceInfo[]
  currentSpaceId: string | null
  spaceToken: string | null
  isLoading: boolean
  error: string | null
  pendingPasswordSpaceId: string | null
}

interface SpaceActions {
  loadSpaces: () => Promise<void>
  createSpace: (name: string, password?: string) => Promise<SpaceInfo>
  selectSpace: (spaceId: string, spacePassword?: string) => Promise<void>
  issueSpaceToken: (spaceId: string, spacePassword?: string) => Promise<string>
  hydrate: () => void
  reset: () => void
}

const toSpaceInfo = (meta: SpaceMeta): SpaceInfo => ({
  ...meta,
  has_password: false,
})

export const useSpaceStore = create<SpaceState & SpaceActions>()(
  devtools(
    (set, get) => ({
      spaces: [],
      currentSpaceId: null,
      spaceToken: null,
      isLoading: false,
      error: null,
      pendingPasswordSpaceId: null,

      loadSpaces: async () => {
        set({ isLoading: true, error: null })
        try {
          const raw = await spacesApi.listSpaces()
          await metaDB.putSpaces(raw)
          set({ spaces: raw.map(toSpaceInfo), isLoading: false })
        } catch (e) {
          set({ isLoading: false, error: (e as Error).message })
          throw e
        }
      },

      createSpace: async (name, _password) => {
        set({ isLoading: true, error: null })
        try {
          const raw = await spacesApi.createSpace(name)
          await metaDB.spaces.put(raw)
          const info = toSpaceInfo(raw)
          set((s) => ({ spaces: [...s.spaces, info], isLoading: false }))
          return info
        } catch (e) {
          set({ isLoading: false, error: (e as Error).message })
          throw e
        }
      },

      selectSpace: async (spaceId, spacePassword) => {
        set({ isLoading: true, error: null })
        try {
          const token = await get().issueSpaceToken(spaceId, spacePassword)
          tokenStorage.setSpaceToken(token)
          tokenStorage.setCurrentSpaceId(spaceId)
          await spaceDBManager.switchTo(spaceId)
          set({ currentSpaceId: spaceId, spaceToken: token, isLoading: false })
        } catch (e) {
          set({ isLoading: false, error: (e as Error).message })
          throw e
        }
      },

      issueSpaceToken: async (spaceId, _spacePassword) =>
        spacesApi.issueToken(spaceId),

      hydrate: () => {
        const spaceId = tokenStorage.getCurrentSpaceId()
        const spaceToken = tokenStorage.getSpaceToken()
        set({ currentSpaceId: spaceId, spaceToken })
        metaDB
          .getAllSpaces()
          .then((raw) => set({ spaces: raw.map(toSpaceInfo) }))
          .catch(() => {})
        if (spaceId) spaceDBManager.switchTo(spaceId).catch(() => {})
      },

      reset: () =>
        set({
          spaces: [],
          currentSpaceId: null,
          spaceToken: null,
          isLoading: false,
          error: null,
          pendingPasswordSpaceId: null,
        }),
    }),
    { name: 'space-store' },
  ),
)

export const selectCurrentSpace = (
  s: SpaceState & SpaceActions,
): SpaceInfo | null =>
  s.spaces.find((sp) => sp.id === s.currentSpaceId) ?? null

export const selectHasSpace = (s: SpaceState & SpaceActions): boolean =>
  s.currentSpaceId !== null && s.spaceToken !== null
