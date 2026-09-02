/**
 * Stats store (F0 §7.3.14).
 *
 * 只读服务端聚合统计。
 *
 * ★ 原 stub 的 loadOverview / loadFocusTrend / loadTaskDistribution 后端并不存在，
 *   已按真实端点（habit / schedule / note summary）重建。详见 lib/stats/stats-api.ts。
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  fetchHabitSummary,
  fetchNoteSummary,
  fetchScheduleSummary,
  type HabitSummary,
  type NoteSummary,
  type ScheduleSummary,
} from '@/lib/stats/stats-api'

interface StatsState {
  habitSummary: HabitSummary | null
  scheduleSummary: ScheduleSummary | null
  noteSummary: NoteSummary | null
  isLoading: boolean
  error: string | null
}

interface StatsActions {
  loadHabitSummary: (days?: number) => Promise<void>
  loadScheduleSummary: (days?: number) => Promise<void>
  loadNoteSummary: () => Promise<void>
  /** 一次性拉齐三块，页面首屏用。 */
  loadAll: (days?: number) => Promise<void>
  reset: () => void
}

type StatsStore = StatsState & StatsActions

export const useStatsStore = create<StatsStore>()(
  devtools(
    (set) => ({
      habitSummary: null,
      scheduleSummary: null,
      noteSummary: null,
      isLoading: false,
      error: null,

      loadHabitSummary: async (days = 30) => {
        set({ isLoading: true, error: null })
        try {
          set({ habitSummary: await fetchHabitSummary(days), isLoading: false })
        } catch (error) {
          set({ isLoading: false, error: toMessage(error) })
        }
      },

      loadScheduleSummary: async (days = 30) => {
        set({ isLoading: true, error: null })
        try {
          set({ scheduleSummary: await fetchScheduleSummary(days), isLoading: false })
        } catch (error) {
          set({ isLoading: false, error: toMessage(error) })
        }
      },

      loadNoteSummary: async () => {
        set({ isLoading: true, error: null })
        try {
          set({ noteSummary: await fetchNoteSummary(), isLoading: false })
        } catch (error) {
          set({ isLoading: false, error: toMessage(error) })
        }
      },

      loadAll: async (days = 30) => {
        set({ isLoading: true, error: null })
        try {
          // 三块互不依赖，并发拉取；任一失败只丢那一块，不牵连其余
          const [habit, schedule, note] = await Promise.allSettled([
            fetchHabitSummary(days),
            fetchScheduleSummary(days),
            fetchNoteSummary(),
          ])
          set({
            habitSummary: habit.status === 'fulfilled' ? habit.value : null,
            scheduleSummary: schedule.status === 'fulfilled' ? schedule.value : null,
            noteSummary: note.status === 'fulfilled' ? note.value : null,
            isLoading: false,
            error:
              habit.status === 'rejected' || schedule.status === 'rejected' || note.status === 'rejected'
                ? '部分统计加载失败'
                : null,
          })
        } catch (error) {
          set({ isLoading: false, error: toMessage(error) })
        }
      },

      reset: () =>
        set({
          habitSummary: null,
          scheduleSummary: null,
          noteSummary: null,
          isLoading: false,
          error: null,
        }),
    }),
    { name: 'stats-store' },
  ),
)

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
