/**
 * Habit store (F0 §7.3.10).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { SyncedHabit, HabitCheckIn } from '@/types'

interface HabitState {
  habits: SyncedHabit[]
  checkIns: HabitCheckIn[]
  isLoading: boolean
}

interface HabitActions {
  loadHabits: () => Promise<void>
  createHabit: (data: Partial<SyncedHabit>) => Promise<SyncedHabit>
  updateHabit: (id: string, data: Partial<SyncedHabit>) => Promise<void>
  archiveHabit: (id: string) => Promise<void>
  checkIn: (habitId: string, date: string) => Promise<void>
  removeCheckIn: (habitId: string, date: string) => Promise<void>
  reset: () => void
}

type HabitStore = HabitState & HabitActions

export const useHabitStore = create<HabitStore>()(
  devtools(
    (set) => ({
      habits: [],
      checkIns: [],
      isLoading: false,

      loadHabits: async () => { /* S0 stub */ },
      createHabit: async () => ({} as SyncedHabit),
      updateHabit: async () => { /* S0 stub */ },
      archiveHabit: async () => { /* S0 stub */ },
      checkIn: async () => { /* S0 stub */ },
      removeCheckIn: async () => { /* S0 stub */ },
      reset: () => set({ habits: [], checkIns: [], isLoading: false }),
    }),
    { name: 'habit-store' },
  ),
)
