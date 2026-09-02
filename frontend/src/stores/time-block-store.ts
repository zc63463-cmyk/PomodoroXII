/**
 * Time block store (F0 §7.3.12).
 *
 * 空壳域收尾。与其余 store 同一套模式：写操作先落本地 Dexie
 * （time-block-repository 保证「写行 + 入队 outbox」同一事务），
 * 再由同步引擎推上去。
 *
 * 注意 loadTimeBlocks 接受 date：时间块以「天」为单位加载，
 * 避免一次把全部历史时间块读进内存。
 *
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { SyncedTimeBlock, TimeBlock } from '@/types'
import {
  createTimeBlock as createTimeBlockLocally,
  deleteTimeBlock as deleteTimeBlockLocally,
  listSyncedTimeBlocks,
  updateTimeBlock as updateTimeBlockLocally,
} from '@/lib/schedules/time-block-repository'

interface TimeBlockState {
  timeBlocks: SyncedTimeBlock[]
  isLoading: boolean
}

interface TimeBlockActions {
  loadTimeBlocks: (date: string) => Promise<void>
  createTimeBlock: (data: Partial<TimeBlock>) => Promise<TimeBlock>
  updateTimeBlock: (id: string, data: Partial<TimeBlock>) => Promise<void>
  deleteTimeBlock: (id: string) => Promise<void>
  reset: () => void
}

type TimeBlockStore = TimeBlockState & TimeBlockActions

export const useTimeBlockStore = create<TimeBlockStore>()(
  devtools(
    (set, get) => ({
      timeBlocks: [],
      isLoading: false,

      loadTimeBlocks: async (date) => {
        set({ isLoading: true })
        try {
          set({ timeBlocks: await listSyncedTimeBlocks(date), isLoading: false })
        } catch {
          set({ isLoading: false })
        }
      },

      createTimeBlock: async (data) => {
        const block = await createTimeBlockLocally({
          id: data.id ?? crypto.randomUUID(),
          title: data.title ?? '',
          date: data.date ?? '',
          start_time: data.start_time ?? '09:00',
          end_time: data.end_time ?? '10:00',
          planned_duration: data.planned_duration,
          block_type: data.block_type,
        })
        set({ timeBlocks: await listSyncedTimeBlocks(data.date) })
        return block
      },

      updateTimeBlock: async (id, data) => {
        await updateTimeBlockLocally(id, data)
        // 沿用当前已载入的日期重新拉取，保持筛选范围不变
        const date = get().timeBlocks[0]?.date
        set({ timeBlocks: await listSyncedTimeBlocks(date) })
      },

      deleteTimeBlock: async (id) => {
        await deleteTimeBlockLocally(id)
        const date = get().timeBlocks[0]?.date
        set({ timeBlocks: await listSyncedTimeBlocks(date) })
      },

      reset: () => set({ timeBlocks: [], isLoading: false }),
    }),
    { name: 'time-block-store' },
  ),
)
