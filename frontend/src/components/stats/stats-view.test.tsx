import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as statsApi from '@/lib/stats/stats-api'
import { useStatsStore } from '@/stores/stats-store'
import { StatsView } from './stats-view'

const emptyHabit = { habits: [], period_days: 30 }
const emptySchedule = {
  total: 0,
  completed: 0,
  pending: 0,
  overdue: 0,
  period_days: 30,
  completion_rate: 0,
}
const emptyNote = { notes: 0, folders: 0, trashed_notes: 0, trashed_folders: 0 }

describe('StatsView', () => {
  beforeEach(() => {
    useStatsStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(statsApi, 'fetchHabitSummary').mockResolvedValue(emptyHabit)
    vi.spyOn(statsApi, 'fetchScheduleSummary').mockResolvedValue(emptySchedule)
    vi.spyOn(statsApi, 'fetchNoteSummary').mockResolvedValue(emptyNote)
  })

  afterEach(cleanup)

  it('三块都无数据时给出占位文案', async () => {
    render(<StatsView />)

    await waitFor(() => {
      expect(screen.getByText('暂无习惯数据')).toBeTruthy()
    })
    expect(screen.getByText('暂无日程数据')).toBeTruthy()
    expect(screen.getByText('暂无笔记数据')).toBeTruthy()
  })

  it('渲染习惯统计（标题、连续天数、天数比）', async () => {
    vi.spyOn(statsApi, 'fetchHabitSummary').mockResolvedValue({
      habits: [
        {
          habit_id: 'h1',
          title: '读书',
          total_check_ins: 20,
          check_in_days: 15,
          current_streak: 5,
          completion_rate: 0.5,
        },
      ],
      period_days: 30,
    })

    render(<StatsView />)

    await waitFor(() => screen.getByText('读书'))
    expect(screen.getByText(/连续 5 天 · 15\/30 天/)).toBeTruthy()
    // 习惯与日程两块都会标注周期，故用 getAllByText
    expect(screen.getAllByText(/近 30 天/).length).toBe(2)
  })

  it('渲染日程统计（四项计数 + 完成率）', async () => {
    vi.spyOn(statsApi, 'fetchScheduleSummary').mockResolvedValue({
      total: 10,
      completed: 6,
      pending: 3,
      overdue: 1,
      period_days: 30,
      completion_rate: 0.6,
    })

    render(<StatsView />)

    await waitFor(() => screen.getByText('总计'))
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('待办')).toBeTruthy()
    expect(screen.getByText('逾期')).toBeTruthy()
    expect(screen.getByText(/完成率 60%/)).toBeTruthy()
  })

  it('渲染笔记统计（四项计数）', async () => {
    vi.spyOn(statsApi, 'fetchNoteSummary').mockResolvedValue({
      notes: 12,
      folders: 3,
      trashed_notes: 2,
      trashed_folders: 1,
    })

    render(<StatsView />)

    await waitFor(() => screen.getByText('回收站笔记'))
    expect(screen.getByText('回收站文件夹')).toBeTruthy()
  })

  it('切换周期时以新天数重新拉取', async () => {
    const habit = vi.spyOn(statsApi, 'fetchHabitSummary').mockResolvedValue(emptyHabit)
    const schedule = vi
      .spyOn(statsApi, 'fetchScheduleSummary')
      .mockResolvedValue(emptySchedule)

    render(<StatsView />)
    await waitFor(() => screen.getByText('暂无习惯数据'))

    fireEvent.click(screen.getByText('7 天'))

    await waitFor(() => {
      expect(habit).toHaveBeenLastCalledWith(7)
      expect(schedule).toHaveBeenLastCalledWith(7)
    })
  })

  it('任一端点失败只丢那一块，不牵连其余', async () => {
    // loadAll 用 Promise.allSettled，故 habit 失败不应影响 schedule / note
    vi.spyOn(statsApi, 'fetchHabitSummary').mockRejectedValue(new Error('boom'))
    vi.spyOn(statsApi, 'fetchNoteSummary').mockResolvedValue({
      notes: 5,
      folders: 1,
      trashed_notes: 0,
      trashed_folders: 0,
    })

    render(<StatsView />)

    await waitFor(() => screen.getByText('回收站笔记'))
    expect(screen.getByText(/部分统计加载失败/)).toBeTruthy()
    // habit 那块拿不到数据 → 显示占位
    expect(screen.getByText('暂无习惯数据')).toBeTruthy()
  })
})
