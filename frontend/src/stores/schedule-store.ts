/**
 * Schedule store (F0 §7.3.11).
 *
 * 空壳域收尾。与 note / folder / habit store 同一套模式：
 * 写操作先落本地 Dexie（schedule-repository 保证「写行 + 入队 outbox」
 * 同一事务），再由同步引擎推上去。Store 只负责编排与状态。
 *
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CachedSchedule, Schedule } from '@/types'
import {
  completeSchedule as completeScheduleLocally,
  createSchedule as createScheduleLocally,
  deleteSchedule as deleteScheduleLocally,
  listSyncedSchedules,
  updateSchedule as updateScheduleLocally,
  type ScheduleRange,
} from '@/lib/schedules/schedule-repository'

interface ScheduleState {
  schedules: CachedSchedule[]
  isLoading: boolean
  /**
   * 当前加载范围。
   *
   * 写操作后会重新拉取列表 —— 必须按**同一个范围**拉，否则一次「完成」
   * 就会把全量历史灌进来，把月视图的按月筛选冲掉。
   */
  range: ScheduleRange | null
}

interface ScheduleActions {
  loadSchedules: (range?: ScheduleRange) => Promise<void>
  createSchedule: (data: Partial<Schedule>) => Promise<Schedule>
  updateSchedule: (id: string, data: Partial<Schedule>) => Promise<void>
  completeSchedule: (id: string) => Promise<void>
  deleteSchedule: (id: string) => Promise<void>
  reset: () => void
}

type ScheduleStore = ScheduleState & ScheduleActions

export const useScheduleStore = create<ScheduleStore>()(
  devtools(
    (set, get) => ({
      schedules: [],
      isLoading: false,
      range: null,

      loadSchedules: async (range) => {
        set({ isLoading: true, range: range ?? null })
        try {
          set({ schedules: await listSyncedSchedules(range), isLoading: false })
        } catch {
          set({ isLoading: false })
        }
      },

      createSchedule: async (data) => {
        const schedule = await createScheduleLocally({
          id: data.id ?? crypto.randomUUID(),
          title: data.title ?? '',
          due_at: data.due_at ?? new Date().toISOString(),
          priority: data.priority,
          color: data.color,
          all_day: data.all_day,
          start_time: data.start_time,
          end_time: data.end_time,
        })
        set({ schedules: await listSyncedSchedules(get().range ?? undefined) })
        return schedule
      },

      updateSchedule: async (id, data) => {
        await updateScheduleLocally(id, data)
        set({ schedules: await listSyncedSchedules(get().range ?? undefined) })
      },

      completeSchedule: async (id) => {
        await completeScheduleLocally(id)
        set({ schedules: await listSyncedSchedules(get().range ?? undefined) })
      },

      deleteSchedule: async (id) => {
        await deleteScheduleLocally(id)
        set({ schedules: await listSyncedSchedules(get().range ?? undefined) })
      },

      reset: () => set({ schedules: [], isLoading: false, range: null }),
    }),
    { name: 'schedule-store' },
  ),
)
