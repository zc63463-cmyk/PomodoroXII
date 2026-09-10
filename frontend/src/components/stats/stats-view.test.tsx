import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
const emptyFocus = {
  period_days: 30,
  total_sessions: 0,
  valid_sessions: 0,
  interrupted_sessions: 0,
  focused_seconds: 0,
  planned_seconds: 0,
  estimate_accuracy: 0,
  by_hour: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sessions: 0,
    valid: 0,
    interrupted: 0,
    focused_seconds: 0,
  })),
}

describe('StatsView', () => {
  beforeEach(() => {
    useStatsStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(statsApi, 'fetchHabitSummary').mockResolvedValue(emptyHabit)
    vi.spyOn(statsApi, 'fetchScheduleSummary').mockResolvedValue(emptySchedule)
    vi.spyOn(statsApi, 'fetchNoteSummary').mockResolvedValue(emptyNote)
    vi.spyOn(statsApi, 'fetchFocusSummary').mockResolvedValue(emptyFocus)
  })

  afterEach(cleanup)

  it('四块都无数据时给出占位文案', async () => {
    render(<StatsView />)

    await waitFor(() => {
      expect(screen.getByText('暂无习惯数据')).toBeTruthy()
    })
    expect(screen.getByText('暂无日程数据')).toBeTruthy()
    expect(screen.getByText('暂无笔记数据')).toBeTruthy()
    expect(screen.getByText('暂无专注数据')).toBeTruthy()
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
    // 带 period 提示的区块：习惯 + 日程 + 专注
    expect(screen.getAllByText(/近 30 天/).length).toBe(3)
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

  /** 构造一份指定小时分布的 focus summary。 */
  function focusWith(buckets: Array<[number, number, number]>) {
    // [hour, sessions, interrupted]
    const byHour = emptyFocus.by_hour.map((bucket) => ({ ...bucket }))
    for (const [hour, sessions, interrupted] of buckets) {
      byHour[hour].sessions = sessions
      byHour[hour].interrupted = interrupted
      byHour[hour].valid = sessions - interrupted
      byHour[hour].focused_seconds = sessions * 1500
    }
    const totalSessions = buckets.reduce((sum, b) => sum + b[1], 0)
    const interrupted = buckets.reduce((sum, b) => sum + b[2], 0)
    return {
      period_days: 30,
      total_sessions: totalSessions,
      valid_sessions: totalSessions - interrupted,
      interrupted_sessions: interrupted,
      focused_seconds: totalSessions * 1500,
      planned_seconds: totalSessions * 1500,
      estimate_accuracy: 1,
      by_hour: byHour,
    }
  }

  it('★ 渲染专注统计：四项指标 + 24 格热力图', async () => {
    vi.spyOn(statsApi, 'fetchFocusSummary').mockResolvedValue(
      focusWith([
        [9, 4, 0],
        [14, 2, 2],
      ]),
    )

    const { container } = render(<StatsView />)

    await waitFor(() => screen.getByText('按时段的专注分布'))

    // 会话 6 / 有效 4 / 被打断 2 / 时长 2.5h
    const focusSection = container.querySelectorAll('section')[0]
    // Stat 的值渲染在 div 里；热力图 x 轴的刻度是 span（也有 "6"），用 selector 区分
    expect(within(focusSection).getByText('6', { selector: 'div' })).toBeTruthy()
    expect(within(focusSection).getByText('4', { selector: 'div' })).toBeTruthy()
    expect(within(focusSection).getByText('2', { selector: 'div' })).toBeTruthy()
    expect(within(focusSection).getByText('2.5 h')).toBeTruthy()

    // 热力图固定 24 格（含全零时段），便于直接对比
    expect(container.querySelectorAll('[data-heat-hour]').length).toBe(24)
  })

  it('★ 被打断的时段有用可访问提示，而不是只靠颜色', async () => {
    vi.spyOn(statsApi, 'fetchFocusSummary').mockResolvedValue(
      focusWith([
        [9, 3, 0],
        [14, 2, 2],
      ]),
    )

    render(<StatsView />)

    await waitFor(() => screen.getByText('按时段的专注分布'))

    // 9 点：3 场全完整；14 点：2 场且 2 场被打断
    expect(screen.getByTitle('9:00 · 3 场（完整 3、被打断 0）')).toBeTruthy()
    expect(screen.getByTitle('14:00 · 2 场（完整 0、被打断 2）')).toBeTruthy()
  })

  it('★ 估算准确度按 focused/planned 显示，而不是会话总数', async () => {
    vi.spyOn(statsApi, 'fetchFocusSummary').mockResolvedValue({
      ...focusWith([[9, 4, 0]]),
      // 计划 4×1500=6000，实际只有 3000 → 50%
      planned_seconds: 6000,
      focused_seconds: 3000,
      estimate_accuracy: 0.5,
    })

    render(<StatsView />)

    await waitFor(() => {
      expect(screen.getByText(/估算准确度 50%/)).toBeTruthy()
    })
  })
})
