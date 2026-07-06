/**
 * Schedule store (F0 §7.3.11).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CachedSchedule, Schedule } from '@/types'

interface ScheduleState {
  schedules: CachedSchedule[]
  isLoading: boolean
}

interface ScheduleActions {
  loadSchedules: (range?: { from?: string; to?: string }) => Promise<void>
  createSchedule: (data: Partial<Schedule>) => Promise<Schedule>
  updateSchedule: (id: string, data: Partial<Schedule>) => Promise<void>
  completeSchedule: (id: string) => Promise<void>
  deleteSchedule: (id: string) => Promise<void>
  reset: () => void
}

type ScheduleStore = ScheduleState & ScheduleActions

export const useScheduleStore = create<ScheduleStore>()(
  devtools(
    (set) => ({
      schedules: [],
      isLoading: false,

      loadSchedules: async () => { /* S0 stub */ },
      createSchedule: async () => ({} as Schedule),
      updateSchedule: async () => { /* S0 stub */ },
      completeSchedule: async () => { /* S0 stub */ },
      deleteSchedule: async () => { /* S0 stub */ },
      reset: () => set({ schedules: [], isLoading: false }),
    }),
    { name: 'schedule-store' },
  ),
)
