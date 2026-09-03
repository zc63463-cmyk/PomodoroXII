import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as scheduleRepo from '@/lib/schedules/schedule-repository'
import * as timeBlockRepo from '@/lib/schedules/time-block-repository'
import { useScheduleStore } from '@/stores/schedule-store'
import { useTimeBlockStore } from '@/stores/time-block-store'
import type { CachedSchedule, SyncedTimeBlock } from '@/types'

function schedule(overrides: Partial<CachedSchedule> = {}): CachedSchedule {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 's1',
    title: '会议',
    due_at: '2026-09-10T10:00:00.000Z',
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

function block(overrides: Partial<SyncedTimeBlock> = {}): SyncedTimeBlock {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 't1',
    title: '专注',
    date: '2026-09-10',
    start_time: '09:00',
    end_time: '10:00',
    planned_duration: 3600,
    actual_duration: 0,
    block_type: 'work',
    status: 'planned',
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

/** Store 只做编排，故 mock 掉仓储（真实持久化由各自的 repository 测试覆盖）。 */
describe('schedule-store', () => {
  beforeEach(() => {
    useScheduleStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(scheduleRepo, 'listSyncedSchedules').mockResolvedValue([])
  })

  it('loadSchedules 填充列表', async () => {
    vi.spyOn(scheduleRepo, 'listSyncedSchedules').mockResolvedValue([
      schedule({ id: 'a', title: '评审' }),
    ])

    const pending = useScheduleStore.getState().loadSchedules()
    expect(useScheduleStore.getState().isLoading).toBe(true)
    await pending

    expect(useScheduleStore.getState().schedules.map((s) => s.title)).toEqual(['评审'])
    expect(useScheduleStore.getState().isLoading).toBe(false)
  })

  it('createSchedule 未给 id 时自行生成', async () => {
    const create = vi
      .spyOn(scheduleRepo, 'createSchedule')
      .mockImplementation(async (input) => schedule({ id: input.id, title: input.title ?? '' }))

    await useScheduleStore.getState().createSchedule({ title: '新日程' })

    const passed = create.mock.calls[0][0]
    expect(passed.id).toBeTruthy()
    expect(passed.title).toBe('新日程')
  })

  it('completeSchedule 透传给仓储的完成动作', async () => {
    const complete = vi
      .spyOn(scheduleRepo, 'completeSchedule')
      .mockResolvedValue(schedule({ completed_at: '2026-09-10T11:00:00.000Z' }))

    await useScheduleStore.getState().completeSchedule('s1')

    expect(complete).toHaveBeenCalledWith('s1')
  })

  it('deleteSchedule 走仓储软删除', async () => {
    const del = vi.spyOn(scheduleRepo, 'deleteSchedule').mockResolvedValue(undefined)

    await useScheduleStore.getState().deleteSchedule('s1')

    expect(del).toHaveBeenCalledWith('s1')
  })
})

describe('time-block-store', () => {
  beforeEach(() => {
    useTimeBlockStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(timeBlockRepo, 'listSyncedTimeBlocks').mockResolvedValue([])
  })

  it('loadTimeBlocks 按日期加载', async () => {
    const load = vi
      .spyOn(timeBlockRepo, 'listSyncedTimeBlocks')
      .mockResolvedValue([block({ id: 'a' })])

    await useTimeBlockStore.getState().loadTimeBlocks('2026-09-10')

    expect(load).toHaveBeenCalledWith('2026-09-10')
    expect(useTimeBlockStore.getState().timeBlocks).toHaveLength(1)
  })

  it('createTimeBlock 未给 id 时自行生成', async () => {
    const create = vi
      .spyOn(timeBlockRepo, 'createTimeBlock')
      .mockImplementation(async (input) => block({ id: input.id }))

    await useTimeBlockStore.getState().createTimeBlock({
      title: '专注',
      date: '2026-09-10',
      start_time: '09:00',
      end_time: '10:00',
    })

    const passed = create.mock.calls[0][0]
    expect(passed.id).toBeTruthy()
    expect(passed.date).toBe('2026-09-10')
  })

  it('★ updateTimeBlock 后沿用同一日期重新加载，不丢筛选范围', async () => {
    vi.spyOn(timeBlockRepo, 'updateTimeBlock').mockResolvedValue(block())
    useTimeBlockStore.setState({ timeBlocks: [block({ id: 'a', date: '2026-09-10' })] })
    const load = vi
      .spyOn(timeBlockRepo, 'listSyncedTimeBlocks')
      .mockResolvedValue([block({ id: 'a', date: '2026-09-10', actual_duration: 1800 })])

    await useTimeBlockStore.getState().updateTimeBlock('a', { actual_duration: 1800 })

    expect(load).toHaveBeenCalledWith('2026-09-10')
    expect(useTimeBlockStore.getState().timeBlocks[0].actual_duration).toBe(1800)
  })

  it('deleteTimeBlock 走仓储软删除并重新加载', async () => {
    vi.spyOn(timeBlockRepo, 'deleteTimeBlock').mockResolvedValue(undefined)
    useTimeBlockStore.setState({ timeBlocks: [block({ id: 'a', date: '2026-09-10' })] })
    vi.spyOn(timeBlockRepo, 'listSyncedTimeBlocks').mockResolvedValue([])

    await useTimeBlockStore.getState().deleteTimeBlock('a')

    expect(timeBlockRepo.deleteTimeBlock).toHaveBeenCalledWith('a')
    expect(useTimeBlockStore.getState().timeBlocks).toHaveLength(0)
  })
})
