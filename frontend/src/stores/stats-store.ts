/**
 * Stats store (F0 §7.3.14).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface StatsOverview {
  totalSessions: number
  totalFocusTime: number
  totalPomodoros: number
  streak: number
}

interface FocusTrendPoint {
  date: string
  focusTime: number
  pomodoros: number
}

interface TaskDistributionItem {
  status: string
  count: number
}

interface StatsState {
  overview: StatsOverview | null
  focusTrend: FocusTrendPoint[]
  taskDistribution: TaskDistributionItem[]
  isLoading: boolean
}

interface StatsActions {
  loadOverview: () => Promise<void>
  loadFocusTrend: (period: '7d' | '30d' | '90d') => Promise<void>
  loadTaskDistribution: () => Promise<void>
  reset: () => void
}

type StatsStore = StatsState & StatsActions

export const useStatsStore = create<StatsStore>()(
  devtools(
    (set) => ({
      overview: null,
      focusTrend: [],
      taskDistribution: [],
      isLoading: false,

      loadOverview: async () => { /* S0 stub */ },
      loadFocusTrend: async () => { /* S0 stub */ },
      loadTaskDistribution: async () => { /* S0 stub */ },
      reset: () => set({ overview: null, focusTrend: [], taskDistribution: [], isLoading: false }),
    }),
    { name: 'stats-store' },
  ),
)
