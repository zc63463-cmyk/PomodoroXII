import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as habitRepository from '@/lib/habits/habit-repository'
import * as scheduleRepository from '@/lib/schedules/schedule-repository'
import * as timeBlockRepository from '@/lib/schedules/time-block-repository'
import { toDateKey } from '@/lib/habits/habit-selectors'
import { useHabitStore } from '@/stores/habit-store'
import { useScheduleStore } from '@/stores/schedule-store'
import { useTimeBlockStore } from '@/stores/time-block-store'
import type { CachedSchedule, HabitCheckIn, SyncedHabit, SyncedTimeBlock } from '@/types'
import { DashboardView } from './dashboard-view'

const TODAY = toDateKey(new Date())

function schedule(overrides: Partial<CachedSchedule> = {}): CachedSchedule {
  const now = '2026-09-04T00:00:00.000Z'
  return {
    id: 's1',
    title: '评审会',
    due_at: `${TODAY}T10:00:00.000Z`,
    completed_at: null,
    priority: 'medium',
    color: '#3b82f6',
    all_day: false,
    start_time: null,
    end_time: null,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...overrides,
  }
}

function habit(overrides: Partial<SyncedHabit> = {}): SyncedHabit {
  const now = '2026-09-04T00:00:00.000Z'
  return {
    id: 'h1',
    title: '读书',
    description: '',
    color: '#3b82f6',
    icon: '',
    target_count: 1,
    rest_day_protection: false,
    rest_days: [],
    sort_order: 0,
    archived: false,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...overrides,
  }
}

function checkIn(overrides: Partial<HabitCheckIn> = {}): HabitCheckIn {
  const now = '2026-09-04T00:00:00.000Z'
  return {
    id: 'c1',
    habit_id: 'h1',
    date: TODAY,
    count: 1,
    note: '',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function block(overrides: Partial<SyncedTimeBlock> = {}): SyncedTimeBlock {
  const now = '2026-09-04T00:00:00.000Z'
  return {
    id: 'b1',
    title: '深度工作',
    date: TODAY,
    start_time: '09:00',
    end_time: '10:00',
    planned_duration: 3600,
    actual_duration: 1800,
    block_type: 'work',
    status: 'in_progress',
    sort_order: 0,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...overrides,
  }
}

describe('DashboardView', () => {
  beforeEach(() => {
    useScheduleStore.getState().reset()
    useHabitStore.getState().reset()
    useTimeBlockStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(scheduleRepository, 'listSyncedSchedules').mockResolvedValue([])
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([])
    vi.spyOn(timeBlockRepository, 'listSyncedTimeBlocks').mockResolvedValue([])
  })

  afterEach(cleanup)

  it('三个分区都为空时给出各自的引导文案，而不是一片空白', async () => {
    render(<DashboardView />)

    await waitFor(() => {
      expect(screen.getByText('今天没有日程安排')).toBeTruthy()
    })
    expect(screen.getByText(/还没有习惯/)).toBeTruthy()
    expect(screen.getByText(/今天还没有时间块/)).toBeTruthy()
  })

  it('顶部概览显示今日三类的数量', async () => {
    vi.spyOn(scheduleRepository, 'listSyncedSchedules').mockResolvedValue([
      schedule({ id: 'a', title: '评审会' }),
      schedule({ id: 'b', title: '写周报' }),
    ])
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '读书' }),
      habit({ id: 'h2', title: '跑步' }),
    ])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([
      checkIn({ id: 'c1', habit_id: 'h1' }),
    ])
    vi.spyOn(timeBlockRepository, 'listSyncedTimeBlocks').mockResolvedValue([block()])

    render(<DashboardView />)

    await waitFor(() => {
      // 2 条日程、1/2 个习惯、1 个时间块
      expect(screen.getByText('1/2')).toBeTruthy()
    })
    expect(screen.getByText('评审会')).toBeTruthy()
    expect(screen.getByText('写周报')).toBeTruthy()
  })

  it('★ 只显示今天的日程，其它日期的不出现', async () => {
    vi.spyOn(scheduleRepository, 'listSyncedSchedules').mockResolvedValue([
      schedule({ id: 'today', title: '今天的会' }),
      schedule({
        id: 'other',
        title: '别天的会',
        // 用一个明显不在今天的日期键
        due_at: '2020-01-01T10:00:00.000Z',
      }),
    ])

    render(<DashboardView />)

    await waitFor(() => expect(screen.getByText('今天的会')).toBeTruthy())
    expect(screen.queryByText('别天的会')).toBeNull()
  })

  it('★ 可以在首页直接打卡，不必跳到习惯页', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '读书' }),
    ])
    const doCheckIn = vi
      .spyOn(habitRepository, 'checkIn')
      .mockResolvedValue(checkIn())

    render(<DashboardView />)
    await waitFor(() => screen.getByText('读书'))

    fireEvent.click(screen.getByLabelText('读书打卡'))

    await waitFor(() => {
      expect(doCheckIn).toHaveBeenCalledWith('h1', TODAY)
    })
  })

  it('★ 已打卡的习惯显示「撤销」，点了会撤销', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '读书' }),
    ])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([
      checkIn({ id: 'c1', habit_id: 'h1' }),
    ])
    const undo = vi
      .spyOn(habitRepository, 'removeCheckIn')
      .mockResolvedValue(undefined)

    render(<DashboardView />)
    await waitFor(() => screen.getByLabelText('读书撤销打卡'))

    fireEvent.click(screen.getByLabelText('读书撤销打卡'))

    await waitFor(() => {
      expect(undo).toHaveBeenCalledWith('h1', TODAY)
    })
  })

  it('时间块展示计划与实际的对照', async () => {
    vi.spyOn(timeBlockRepository, 'listSyncedTimeBlocks').mockResolvedValue([
      block({ planned_duration: 3600, actual_duration: 1800 }),
    ])

    render(<DashboardView />)

    await waitFor(() => {
      // 30 分钟 / 1 小时
      expect(screen.getByText('30 分钟 / 1 小时')).toBeTruthy()
    })
  })

  it('加载时间块时用的是今天，不是全量', async () => {
    const load = vi
      .spyOn(timeBlockRepository, 'listSyncedTimeBlocks')
      .mockResolvedValue([])

    render(<DashboardView />)

    await waitFor(() => {
      expect(load).toHaveBeenCalledWith(TODAY)
    })
  })
})
