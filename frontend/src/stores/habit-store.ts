/**
 * Habit store (F0 §7.3.10) —— 空壳域收尾。
 *
 * 与 note / folder store 同一套模式：写操作先落本地 Dexie
 * （habit-repository 保证「写行 + 入队 outbox」同一事务），再由同步引擎推上去。
 * Store 只负责编排与状态，不碰 Dexie、不发 HTTP 写请求。
 *
 * 打卡按 (habit_id, date) 唯一：同一天重复打卡是递增 count，不是新建行 ——
 * 离线期间多次打卡恢复上线后不会堆出一堆待推事件。
 *
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { SyncedHabit, HabitCheckIn } from '@/types'
import {
  archiveHabit as archiveHabitLocally,
  checkIn as checkInLocally,
  createHabit as createHabitLocally,
  listCheckIns,
  listSyncedHabits,
  removeCheckIn as removeCheckInLocally,
  updateHabit as updateHabitLocally,
} from '@/lib/habits/habit-repository'

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

      loadHabits: async () => {
        set({ isLoading: true })
        try {
          const [habits, checkIns] = await Promise.all([
            listSyncedHabits(),
            listCheckIns(),
          ])
          set({ habits, checkIns, isLoading: false })
        } catch {
          set({ isLoading: false })
        }
      },

      createHabit: async (data) => {
        const habit = await createHabitLocally({
          id: data.id ?? crypto.randomUUID(),
          title: data.title ?? '',
          description: data.description,
          color: data.color,
          icon: data.icon,
          target_count: data.target_count,
          rest_day_protection: data.rest_day_protection,
          rest_days: data.rest_days,
        })
        const habits = await listSyncedHabits()
        set({ habits })
        // 新建后返回带同步字段的行，与 state 中其余行保持一致
        return habits.find((h) => h.id === habit.id) ?? ({ ...habit, version: 1, _dirty: true, deletion_state: 'active' } as SyncedHabit)
      },

      updateHabit: async (id, data) => {
        await updateHabitLocally(id, data)
        set({ habits: await listSyncedHabits() })
      },

      archiveHabit: async (id) => {
        await archiveHabitLocally(id)
        set({ habits: await listSyncedHabits() })
      },

      checkIn: async (habitId, date) => {
        await checkInLocally(habitId, date)
        set({ checkIns: await listCheckIns() })
      },

      removeCheckIn: async (habitId, date) => {
        await removeCheckInLocally(habitId, date)
        set({ checkIns: await listCheckIns() })
      },

      reset: () => set({ habits: [], checkIns: [], isLoading: false }),
    }),
    { name: 'habit-store' },
  ),
)
