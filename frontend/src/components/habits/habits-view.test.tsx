import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as habitRepository from '@/lib/habits/habit-repository'
import { toDateKey, shiftDateKey } from '@/lib/habits/habit-selectors'
import { useHabitStore } from '@/stores/habit-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { HabitCheckIn, SyncedHabit } from '@/types'
import { HabitsView } from './habits-view'

const TODAY = toDateKey(new Date())

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
    date: TODAY,
    count: 1,
    note: '',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('HabitsView', () => {
  beforeEach(() => {
    useHabitStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([])
    vi.spyOn(habitRepository, 'checkIn').mockResolvedValue(checkIn())
    vi.spyOn(habitRepository, 'removeCheckIn').mockResolvedValue(undefined)
    vi.spyOn(habitRepository, 'createHabit').mockImplementation(
      async (input) => habit({ id: input.id, title: input.title ?? '' }),
    )
    // 日界是全局偏好，测试之间要复位
    useSettingsStore.setState({ dayBoundaryHour: 0 })
  })

  afterEach(cleanup)

  it('空列表时给出引导文案', async () => {
    render(<HabitsView />)

    await waitFor(() => {
      expect(screen.getByText(/还没有习惯/)).toBeTruthy()
    })
  })

  it('渲染标题、连续天数与今日进度', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '跑步', target_count: 3 }),
    ])

    render(<HabitsView />)

    await waitFor(() => screen.getByText('跑步'))
    // 无打卡记录 → 连续 0 天、历史最长 0 天；target_count=3 → 今日 0/3
    expect(screen.getByText(/连续 0 天 · 最长 0 天 · 今日 0\/3/)).toBeTruthy()
  })

  it('点打卡调用 checkIn(habitId, today)', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '跑步' }),
    ])
    const doCheckIn = vi.spyOn(habitRepository, 'checkIn').mockResolvedValue(checkIn())

    render(<HabitsView />)
    await waitFor(() => screen.getByText('跑步'))

    fireEvent.click(screen.getByText('打卡'))

    await waitFor(() => {
      expect(doCheckIn).toHaveBeenCalledWith('h1', TODAY)
    })
  })

  it('今日已达标时按钮变为「再打卡」', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '跑步' }),
    ])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([checkIn({ count: 1 })])

    render(<HabitsView />)

    await waitFor(() => screen.getByText('再打卡'))
    // 已达标 → 撤销入口出现
    expect(screen.getByText('撤销')).toBeTruthy()
  })

  it('未打卡时不显示撤销入口', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '跑步' }),
    ])

    render(<HabitsView />)

    await waitFor(() => screen.getByText('打卡'))
    expect(screen.queryByText('撤销')).toBeNull()
  })

  it('点撤销调用 removeCheckIn', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '跑步' }),
    ])
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([checkIn({ count: 1 })])
    const undo = vi.spyOn(habitRepository, 'removeCheckIn').mockResolvedValue(undefined)

    render(<HabitsView />)
    await waitFor(() => screen.getByText('撤销'))

    fireEvent.click(screen.getByText('撤销'))

    await waitFor(() => {
      expect(undo).toHaveBeenCalledWith('h1', TODAY)
    })
  })

  it('当前连续断掉时，历史最长仍然显示', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '跑步' }),
    ])
    // 用相对日期，避免断言随运行日期漂移：距今 10..7 天前连打 4 天，
    // 之后（含今天）都没打 → 当前连续归零，历史最长保持 4
    const daysAgo = (n: number) => shiftDateKey(TODAY, -n)
    vi.spyOn(habitRepository, 'listCheckIns').mockResolvedValue([
      checkIn({ id: 'c1', date: daysAgo(10) }),
      checkIn({ id: 'c2', date: daysAgo(9) }),
      checkIn({ id: 'c3', date: daysAgo(8) }),
      checkIn({ id: 'c4', date: daysAgo(7) }),
    ])

    render(<HabitsView />)

    await waitFor(() => expect(screen.getByText(/最长 4 天/)).toBeTruthy())
    expect(screen.getByText(/连续 0 天/)).toBeTruthy()
  })

  it('日界选择器默认 00:00，改动会写入设置', async () => {
    useSettingsStore.setState({ dayBoundaryHour: 0 })
    render(<HabitsView />)

    const select = screen.getByLabelText('跨午夜日界') as HTMLSelectElement
    expect(select.value).toBe('0')

    fireEvent.change(select, { target: { value: '3' } })

    await waitFor(() => {
      expect(useSettingsStore.getState().dayBoundaryHour).toBe(3)
    })
  })

  it('★ 日界=3 时，凌晨 1 点打卡记到前一天', async () => {
    // 固定「现在」为凌晨 1 点，否则断言随运行时刻漂移
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-09-15T01:00:00.000Z') })
    try {
      useSettingsStore.setState({ dayBoundaryHour: 3 })
      vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
        habit({ id: 'h1', title: '跑步' }),
      ])
      const checkInSpy = vi
        .spyOn(habitRepository, 'checkIn')
        .mockResolvedValue(checkIn({ date: '2026-09-14' }))

      render(<HabitsView />)
      await waitFor(() => screen.getByText('打卡'))
      fireEvent.click(screen.getByText('打卡'))

      await waitFor(() => {
        // 01:00 前推 3 小时 = 昨晚 22:00 → 归入 9/14
        expect(checkInSpy).toHaveBeenCalledWith('h1', '2026-09-14')
      })
    } finally {
      // 先退出 fake timers，再复位 —— store 复位由下一个测试的 beforeEach 负责，
      // 这里若 setState 会触发已挂载组件更新，从而产生 act(...) 警告
      vi.useRealTimers()
    }
  })

  it('近 14 天条带渲染 14 个格子', async () => {
    vi.spyOn(habitRepository, 'listSyncedHabits').mockResolvedValue([
      habit({ id: 'h1', title: '跑步' }),
    ])

    const { container } = render(<HabitsView />)
    await waitFor(() => screen.getByText('跑步'))

    // 条带是 title 属性为 YYYY-MM-DD 的 span
    const cells = container.querySelectorAll('span[title^="20"]')
    expect(cells.length).toBeGreaterThanOrEqual(14)
  })
})
