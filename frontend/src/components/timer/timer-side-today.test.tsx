import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { TimerSideToday, type RecentSessionRow } from './timer-side-today'
import { fetchFocusSummaryWindow } from '@/lib/stats/stats-api'
import { useSettingsStore } from '@/stores/settings-store'

/**
 * 准备态右栏「今日」（设计稿 `.side`）用例。
 *
 * 关键锁点：
 * 1. `data-testid="focus-summary-bar"` 与其**文案**必须保留 —— 运行态/结束态
 *    复用的是同一个 testid，页面测试（`app/(app)/timer/page.test.tsx`）对准备态
 *    也有断言，换组件不能换掉这句口径。
 * 2. 三格口径：番茄 = valid_sessions、专注 = focused_seconds/60、被打断 = interrupted_sessions。
 * 3. 最近会话只取「今日」的，时间倒序，最多 3 条；尾标是主观评价的中文标签。
 * 4. 节奏：距长休 = interval − (已完成 % interval)（刚好整除时取 interval，不写 0）。
 */

vi.mock('@/lib/stats/stats-api', () => ({ fetchFocusSummaryWindow: vi.fn() }))

const fetchMock = vi.mocked(fetchFocusSummaryWindow)

/** 固定注入时刻：本地 2026-09-30 10:00（断言不写死 UTC 串，TZ 安全）。 */
const fixedNow = new Date(2026, 8, 30, 10, 0, 0)

const summaryFixture = {
  period_days: 1, total_sessions: 4, valid_sessions: 3, interrupted_sessions: 1,
  focused_seconds: 4500, planned_seconds: 7500, estimate_accuracy: 0.6, by_hour: [],
}

const today = (hour: number, minute: number): string => new Date(2026, 8, 30, hour, minute).toISOString()

describe('TimerSideToday（准备态右栏「今日」）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(summaryFixture)
    useSettingsStore.setState({ dayBoundaryHour: 0, longBreakInterval: 4 })
  })

  it('统计三格 + 保留 <focus-summary-bar> 的今日口径那句话', async () => {
    render(createElement(TimerSideToday, { now: fixedNow }))

    const bar = await screen.findByTestId('focus-summary-bar')
    expect(bar).toHaveTextContent('今日 3 个番茄 · 专注 1.3h')

    // 三格：按类名取，避免 getByText 在「75min」「今日 3 个番茄 · 专注 1.3h」
    // 这类包含关系上产生多重命中。
    const stats = document.querySelector('.ios-stats')
    expect(stats).not.toBeNull()
    expect([...(stats as HTMLElement).querySelectorAll('.ios-stat-n')].map((n) => n.textContent))
      .toEqual(['3', '75min', '1']) // 4500s → 75min
    expect([...(stats as HTMLElement).querySelectorAll('.ios-stat-l')].map((n) => n.textContent))
      .toEqual(['番茄', '专注', '被打断'])
  })

  it('请求起点 = todayStartIso(now, 日界) —— 与"今日"统计同一把尺子', async () => {
    render(createElement(TimerSideToday, { now: fixedNow }))
    await screen.findByTestId('focus-summary-bar')

    const payload = fetchMock.mock.calls[0]?.[0]
    expect(new Date(String(payload?.start)).getTime()).toBe(new Date(2026, 8, 30, 0, 0, 0).getTime())
  })

  it('最近会话：只取今日、按开始时间倒序、最多 3 条，带时长与主观评价尾标', async () => {
    const rows: RecentSessionRow[] = [
      { sessionId: 's1', startedAt: today(8, 5), plannedSeconds: 1500, overallProgress: 'progressed' },
      { sessionId: 's2', startedAt: today(9, 12), plannedSeconds: 1500, overallProgress: 'smooth' },
      { sessionId: 's3', startedAt: today(7, 0), plannedSeconds: 3000, overallProgress: null },
      { sessionId: 's4', startedAt: today(6, 0), plannedSeconds: 1500 },
      // 昨日 —— 必须被排除
      { sessionId: 's5', startedAt: new Date(2026, 8, 29, 21, 40).toISOString(), plannedSeconds: 3000, overallProgress: 'stuck' },
    ]
    render(createElement(TimerSideToday, { recentSessions: rows, now: fixedNow }))
    await screen.findByTestId('focus-summary-bar')

    const card = screen.getByText('最近会话').parentElement as HTMLElement
    const lines = [...card.querySelectorAll('.ios-drow')].map((node) => node.textContent)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('今日 09:12')
    expect(lines[0]).toContain('25min')
    expect(lines[0]).toContain('顺利推进')
    expect(lines[1]).toContain('今日 08:05')
    expect(lines[2]).toContain('今日 07:00')
    expect(card.textContent).not.toContain('09-29')
  })

  it('节奏：距长休 = interval − (已完成 % interval)；整除时取满一个间隔（不是 0）', async () => {
    render(createElement(TimerSideToday, { now: fixedNow }))
    await screen.findByTestId('focus-summary-bar')

    const card = screen.getByText('节奏').parentElement as HTMLElement
    expect(card).toHaveTextContent('已完成 3 个番茄 · 距长休还需 1 个')
    expect(card).toHaveTextContent('长休间隔：4 个番茄')

    fetchMock.mockResolvedValue({ ...summaryFixture, valid_sessions: 4 })
    render(createElement(TimerSideToday, { now: fixedNow }))
    await waitFor(() => {
      const cards = screen.getAllByText('节奏').map((node) => node.parentElement as HTMLElement)
      expect(cards[cards.length - 1]).toHaveTextContent('距长休还需 4 个')
    })
  })

  it('没有今日会话时给出说明，而不是空卡', async () => {
    render(createElement(TimerSideToday, { recentSessions: [], now: fixedNow }))
    await screen.findByTestId('focus-summary-bar')

    expect(screen.getByText('今天还没有会话。')).toBeInTheDocument()
  })

  it('统计不可用 fail-quiet：三格与那行统计不渲染、不抛出、只留一条 warn；节奏与最近会话仍在', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fetchMock.mockRejectedValue(new Error('stats_unavailable'))
    try {
      render(createElement(TimerSideToday, { recentSessions: [], now: fixedNow }))

      await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
      expect(warnSpy.mock.calls[0]?.[0]).toContain('stats_unavailable')
      expect(screen.queryByTestId('focus-summary-bar')).toBeNull()
      expect(document.querySelector('.ios-stats')).toBeNull()
      // 与统计无关的两张卡不受影响（不因统计挂了整栏空白）
      expect(screen.getByText('最近会话')).toBeInTheDocument()
      expect(screen.getByText('节奏')).toBeInTheDocument()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
