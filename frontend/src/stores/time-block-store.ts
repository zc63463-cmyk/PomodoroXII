/**
 * Time block store (F0 §7.3.12).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { SyncedTimeBlock, TimeBlock } from '@/types'

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
    (set) => ({
      timeBlocks: [],
      isLoading: false,

      loadTimeBlocks: async () => { /* S0 stub */ },
      createTimeBlock: async () => ({} as TimeBlock),
      updateTimeBlock: async () => { /* S0 stub */ },
      deleteTimeBlock: async () => { /* S0 stub */ },
      reset: () => set({ timeBlocks: [], isLoading: false }),
    }),
    { name: 'time-block-store' },
  ),
)
