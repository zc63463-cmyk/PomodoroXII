/**
 * Reflection store (F0 §7.3.13).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CachedReflection, Reflection, ReflectionTemplate } from '@/types'

interface ReflectionState {
  reflections: CachedReflection[]
  templates: ReflectionTemplate[]
  isLoading: boolean
}

interface ReflectionActions {
  loadReflections: () => Promise<void>
  createReflection: (data: Partial<Reflection>) => Promise<Reflection>
  updateReflection: (id: string, data: Partial<Reflection>) => Promise<void>
  deleteReflection: (id: string) => Promise<void>
  loadTemplates: () => Promise<void>
  reset: () => void
}

type ReflectionStore = ReflectionState & ReflectionActions

export const useReflectionStore = create<ReflectionStore>()(
  devtools(
    (set) => ({
      reflections: [],
      templates: [],
      isLoading: false,

      loadReflections: async () => { /* S0 stub */ },
      createReflection: async () => ({} as Reflection),
      updateReflection: async () => { /* S0 stub */ },
      deleteReflection: async () => { /* S0 stub */ },
      loadTemplates: async () => { /* S0 stub */ },
      reset: () => set({ reflections: [], templates: [], isLoading: false }),
    }),
    { name: 'reflection-store' },
  ),
)
