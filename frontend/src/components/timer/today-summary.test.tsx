import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { TodaySummary } from './today-summary'
import { fetchFocusSummary } from '@/lib/stats/stats-api'

vi.mock('@/lib/stats/stats-api', () => ({
  fetchFocusSummary: vi.fn(),
}))

const fetchFocusSummaryMock = vi.mocked(fetchFocusSummary)

describe('TodaySummary（工单③ 底部统计栏）', () => {
  beforeEach(() => {
    fetchFocusSummaryMock.mockReset()
  })

  it('按服务端真实口径渲染「昨日起」标签与格式化数字（days=1）', async () => {
    fetchFocusSummaryMock.mockResolvedValue({
      period_days: 1, total_sessions: 6, valid_sessions: 5, interrupted_sessions: 1,
      focused_seconds: 5400, planned_seconds: 7200, estimate_accuracy: 0.75, by_hour: [],
    })
    render(createElement(TodaySummary))

    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('昨日起 5 个番茄 · 专注 1.5h')
    expect(fetchFocusSummaryMock).toHaveBeenCalledWith(1, expect.anything())
  })

  it('0 会话与大数值都不失真（100h 保留 1 位）', async () => {
    fetchFocusSummaryMock.mockResolvedValue({
      period_days: 1, total_sessions: 0, valid_sessions: 0, interrupted_sessions: 0,
      focused_seconds: 360000, planned_seconds: 0, estimate_accuracy: 0, by_hour: [],
    })
    render(createElement(TodaySummary))

    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('昨日起 0 个番茄 · 专注 100.0h')
  })

  it('days>1 用「近 N 天」（锁住分支，防止公式被改死）', async () => {
    fetchFocusSummaryMock.mockResolvedValue({
      period_days: 30, total_sessions: 12, valid_sessions: 10, interrupted_sessions: 2,
      focused_seconds: 5400, planned_seconds: 7200, estimate_accuracy: 0.75, by_hour: [],
    })
    render(createElement(TodaySummary, { days: 30 }))

    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('近 30 天 10 个番茄 · 专注 1.5h')
  })

  it('请求失败 fail-quiet：不渲染本栏、不抛出、只留一条 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fetchFocusSummaryMock.mockRejectedValue(new Error('stats_unavailable'))
    try {
      render(createElement(TodaySummary))

      await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
      expect(warnSpy.mock.calls[0]?.[0]).toContain('stats_unavailable')
      expect(screen.queryByTestId('focus-summary-bar')).toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
