import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as habitRepository from '@/lib/habits/habit-repository'
import { useHabitStore } from '@/stores/habit-store'
import type { HabitCheckIn, SyncedHabit } from '@/types'

function habit(overrides: Partial<SyncedHabit> = {}): SyncedHabit {
  const now = '2026-09-02T00:00:00.000Z'
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
    _dirty: true,
    ...overrides,
  }
}

function checkIn(overrides: Partial<HabitCheckIn> = {}): HabitCheckIn {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'c1',
    habit_id: 'h1',
    date: '2026-09-02',
    count: 1,
    note: '',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

/** Store 的职责是编排，故 mock 掉仓储（真实持久化由 habit-repository.test.ts 覆盖）。 */
describe('habit-store', () => {
  beforeEach(() => {
    useHabitStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([])
  })

  it('loadHabits 同时载入习惯与打卡', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1' }),
    ])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([checkIn()])

    const pending = useHabitStore.getState().loadHabits()
    expect(useHabitStore.getState().isLoading).toBe(true)
    await pending

    expect(useHabitStore.getState().habits).toHaveLength(1)
    expect(useHabitStore.getState().checkIns).toHaveLength(1)
    expect(useHabitStore.getState().isLoading).toBe(false)
  })

  it('createHabit 未给 id 时自行生成', async () => {
    const create = vi
      .spyOn(habitRepository, 'createHabit')
      .mockImplementation(async (input) => habit({ id: input.id, title: input.title ?? '' }))

    await useHabitStore.getState().createHabit({ title: '跑步' })

    expect(create).toHaveBeenCalledTimes(1)
    const passed = create.mock.calls[0][0]
    expect(passed.id).toBeTruthy()
    expect(passed.title).toBe('跑步')
  })

  it('createHabit 返回带同步字段的行', async () => {
    vi.spyOn(habitRepository, 'createHabit').mockImplementation(
      async (input) => habit({ id: input.id }),
    )
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h9', version: 1, _dirty: true }),
    ])

    const created = await useHabitStore.getState().createHabit({ id: 'h9', title: 'X' })

    expect(created.id).toBe('h9')
    expect(created._dirty).toBe(true)
    expect(created.version).toBe(1)
  })

  it('archiveHabit 透传为 archived=true', async () => {
    const archive = vi
      .spyOn(habitRepository, 'archiveHabit')
      .mockResolvedValue(habit({ archived: true }))

    await useHabitStore.getState().archiveHabit('h1')

    expect(archive).toHaveBeenCalledWith('h1')
  })

  it('checkIn 后刷新打卡列表', async () => {
    const doCheckIn = vi.spyOn(habitRepository, 'checkIn').mockResolvedValue(checkIn())
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([
      checkIn({ count: 1 }),
    ])

    await useHabitStore.getState().checkIn('h1', '2026-09-02')

    expect(doCheckIn).toHaveBeenCalledWith('h1', '2026-09-02')
    expect(useHabitStore.getState().checkIns).toHaveLength(1)
  })

  it('removeCheckIn 透传并刷新', async () => {
    const undo = vi.spyOn(habitRepository, 'removeCheckIn').mockResolvedValue(undefined)

    await useHabitStore.getState().removeCheckIn('h1', '2026-09-02')

    expect(undo).toHaveBeenCalledWith('h1', '2026-09-02')
  })
})
