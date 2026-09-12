'use client'

import { createElement, useEffect, useState } from 'react'
import { fetchFocusSummary } from '@/lib/stats/stats-api'

/**
 * 底部统计栏（工单③ 2026-09-13）：[N 个番茄][专注 X.Xh]。
 *
 * ★ 口径结论（先读后定，不猜）：布局规格 L457/L505 写的文案是「今日 N 个
 *   番茄」，但服务端 /stats/focus-summary 的真实语义**不是"今日"**——
 *   StatsService.focus_summary 以 ``utc_now() - timedelta(days=N)`` 再取
 *   UTC 零点为窗口起点（backend/app/services/stats.py:228-229），
 *   days=1 实际覆盖「昨天 UTC 零点至今」：既不是本地"今日"，
 *   也不读用户日界（settings-store.dayBoundaryHour）。
 *
 *   本单红线是不扩后端，所以组件按服务端真实口径诚实标注：days=1 用
 *   「昨日起」而不是「近 1 天」—— 因为窗口实为 24–48h，"近 1 天"会低报最多 2×；
 *   days>1 用「近 N 天」（误差 ≤1 天，占比小，可接受）。
 *   绝不把 period 数据谎报成"今日"（那会让数字天天对不上）。
 *   待裁决：服务端补一个按用户日界的"今日"口径后，标签与 days 语义再切换。
 *
 * N 取 valid_sessions（工单指定）；专注时长 = focused_seconds / 3600，保留 1 位。
 * fail-quiet：请求失败/超时/卸载 → 不渲染本栏（不阻断计时），只留一条 warn。
 */
export function TodaySummary({ days = 1 }: { days?: number }) {
  const [summary, setSummary] = useState<{ validSessions: number; focusedSeconds: number } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void fetchFocusSummary(days, controller.signal)
      .then((data) => {
        if (!cancelled) setSummary({ validSessions: data.valid_sessions, focusedSeconds: data.focused_seconds })
      })
      .catch((cause) => {
        if (!cancelled) {
          console.warn(`[today-summary] 统计不可用，本栏不渲染（不阻断计时）: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [days])

  if (!summary) return null
  const hours = (summary.focusedSeconds / 3600).toFixed(1)
  return createElement(
    'p',
    { role: 'status', 'data-testid': 'focus-summary-bar', className: 'text-sm text-muted-foreground' },
    days === 1
      ? `昨日起 ${summary.validSessions} 个番茄 · 专注 ${hours}h`
      : `近 ${days} 天 ${summary.validSessions} 个番茄 · 专注 ${hours}h`,
  )
}
