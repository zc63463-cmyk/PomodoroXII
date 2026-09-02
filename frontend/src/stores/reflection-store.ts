/**
 * Reflection store (F0 §7.3.13) —— 空壳域收尾。
 *
 * 与 note / folder / habit store 同一套模式：写操作先落本地 Dexie
 * （reflection-repository 保证「写行 + 入队 outbox」同一事务），
 * 再由同步引擎推上去。Store 只负责编排与状态。
 *
 * 已知未接线：loadTemplates。反思模板（3-2-1 / ORID / KPT 等）在后端有
 * reflectionTemplates 表与端点，但本轮不做模板选择与结构化编辑，
 * 故保留空实现 —— 与其塞个假的，不如留着让调用方看得见它没做。
 *
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CachedReflection, Reflection, ReflectionTemplate } from '@/types'
import {
  createReflection as createReflectionLocally,
  deleteReflection as deleteReflectionLocally,
  listSyncedReflections,
  updateReflection as updateReflectionLocally,
} from '@/lib/reflections/reflection-repository'
import { toDateKey } from '@/lib/habits/habit-selectors'

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

      loadReflections: async () => {
        set({ isLoading: true })
        try {
          set({ reflections: await listSyncedReflections(), isLoading: false })
        } catch {
          set({ isLoading: false })
        }
      },

      createReflection: async (data) => {
        const reflection = await createReflectionLocally({
          id: data.id ?? crypto.randomUUID(),
          // 反思以「日期」为主键语义：同一天一篇，缺省用今天
          date: data.date ?? toDateKey(new Date()),
          content: data.content,
          mood: data.mood,
          tags: data.tags,
        })
        set({ reflections: await listSyncedReflections() })
        return reflection
      },

      updateReflection: async (id, data) => {
        await updateReflectionLocally(id, data)
        set({ reflections: await listSyncedReflections() })
      },

      deleteReflection: async (id) => {
        await deleteReflectionLocally(id)
        set({ reflections: await listSyncedReflections() })
      },

      // 未接线：模板选择需要结构化编辑器，本轮不做。保留空实现而非假数据。
      loadTemplates: async () => { /* 未接线 */ },

      reset: () => set({ reflections: [], templates: [], isLoading: false }),
    }),
    { name: 'reflection-store' },
  ),
)
