import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { TodaySummary } from './today-summary'
import { fetchFocusSummaryWindow } from '@/lib/stats/stats-api'
import { todayStartIso } from '@/lib/stats/day-window'
import { useSettingsStore } from '@/stores/settings-store'

/**
 * 工单 A（2026-09-14）：「今日」口径闭环后的统计栏测试。
 *
 * 与工单③ 版本的差异逐条对应实现变更：
 * - 标签两例由「昨日起」改「今日」（服务端 start 已支持显式窗口）；
 * - 新增「调用参数含 start 且等于 todayStartIso(now, boundary)」——
 *   窗口口径是本单的核心，必须锁住；
 * - 新增跨日界用例（now=01:00 + h=3 → 起点为昨日）；
 * - 原「days>1 用近 N 天」用例随 `days` prop 移除而删除（能力变更：
 *   本栏永远表达"今日"；其断言面等价替换为上面的 start 参数用例）。
 * - fail-quiet 原样保留。
 *
 * 断言 TZ 安全：不写死 UTC 串，用 todayStartIso + 本地零点瞬时比较。
 */

vi.mock('@/lib/stats/stats-api', () => ({
  fetchFocusSummaryWindow: vi.fn(),
}))

const fetchWindowMock = vi.mocked(fetchFocusSummaryWindow)

/** 固定的注入时刻（测试内不依赖真实时钟；构造用本地时间，断言不写死 UTC）。 */
const fixedNow = new Date(2026, 8, 14, 10, 0, 0)

describe('TodaySummary（工单 A 今日口径）', () => {
  beforeEach(() => {
    fetchWindowMock.mockReset()
    useSettingsStore.setState({ dayBoundaryHour: 0 })
  })

  it('渲染「今日」标签与格式化数字，且请求起点 = todayStartIso(now, 日界)', async () => {
    fetchWindowMock.mockResolvedValue({
      period_days: 1, total_sessions: 6, valid_sessions: 5, interrupted_sessions: 1,
      focused_seconds: 5400, planned_seconds: 7200, estimate_accuracy: 0.75, by_hour: [],
    })
    render(createElement(TodaySummary, { now: fixedNow }))

    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('今日 5 个番茄 · 专注 1.5h')
    expect(fetchWindowMock).toHaveBeenCalledWith(
      { start: todayStartIso(fixedNow, 0) },
      expect.anything(),
    )
  })

  it('0 会话与大数值都不失真（100h 保留 1 位）', async () => {
    fetchWindowMock.mockResolvedValue({
      period_days: 1, total_sessions: 0, valid_sessions: 0, interrupted_sessions: 0,
      focused_seconds: 360000, planned_seconds: 0, estimate_accuracy: 0, by_hour: [],
    })
    render(createElement(TodaySummary, { now: fixedNow }))

    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('今日 0 个番茄 · 专注 100.0h')
  })

  it('★ 跨日界：now=01:00 + h=3 → 起点为「昨天」本地零点', async () => {
    useSettingsStore.setState({ dayBoundaryHour: 3 })
    const lateNightNow = new Date(2026, 8, 14, 1, 0, 0) // 本地 09-14 01:00，属于 09-13
    fetchWindowMock.mockResolvedValue({
      period_days: 1, total_sessions: 1, valid_sessions: 1, interrupted_sessions: 0,
      focused_seconds: 1500, planned_seconds: 1500, estimate_accuracy: 1, by_hour: [],
    })
    render(createElement(TodaySummary, { now: lateNightNow }))

    await screen.findByTestId('focus-summary-bar')
    const payload = fetchWindowMock.mock.calls[0]?.[0]
    expect(payload?.start).toBe(todayStartIso(lateNightNow, 3))
    // 与「昨日本地零点」的瞬时等值比较（不写死 UTC 串）
    expect(new Date(String(payload?.start)).getTime()).toBe(new Date(2026, 8, 13, 0, 0, 0).getTime())
  })

  it('请求失败 fail-quiet：不渲染本栏、不抛出、只留一条 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fetchWindowMock.mockRejectedValue(new Error('stats_unavailable'))
    try {
      render(createElement(TodaySummary, { now: fixedNow }))

      await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
      expect(warnSpy.mock.calls[0]?.[0]).toContain('stats_unavailable')
      expect(screen.queryByTestId('focus-summary-bar')).toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
