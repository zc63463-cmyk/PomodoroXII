'use client'

import { createElement, useEffect, useState } from 'react'
import { fetchFocusSummaryWindow } from '@/lib/stats/stats-api'
import { todayStartIso } from '@/lib/stats/day-window'
import { useSettingsStore } from '@/stores/settings-store'

/**
 * 底部统计栏（工单③ 2026-09-13；工单 A 2026-09-14 口径闭环）：[N 个番茄][专注 X.Xh]。
 *
 * ★ 口径演进（先读后定，不猜）：
 *   工单③ 时服务端 /stats/focus-summary 只有 days —— 窗口起点是
 *   ``utc_now() - days`` 再取 UTC 零点，days=1 实为「昨天 UTC 零点至今」：
 *   既不是本地"今日"，也不读用户日界（settings-store.dayBoundaryHour）。
 *   当时红线是不扩后端，因此如实标注「昨日起」，绝不把 period 数据谎报成"今日"。
 *   本单 A1 已给服务端补齐显式窗口 ``start``，A2 把标签切回「今日」：
 *   窗口 = **本地日界起**（todayStartIso —— 复用 habits 域日界语义，见
 *   lib/stats/day-window.ts），服务端对 ``start`` 优先于 ``days`` 推导。
 *   待裁决①（"今日"口径）由此闭环；``days=1`` 仅用于服务端 period_days 回显。
 *
 * N 取 valid_sessions（工单指定）；专注时长 = focused_seconds / 3600，保留 1 位。
 * fail-quiet：请求失败/超时/卸载 → 不渲染本栏（不阻断计时），只留一条 warn。
 *
 * `now` 为测试注入口（默认取当前时刻）—— 生产渲染不传，避免劫持真实时钟。
 */
interface TodaySummaryProps {
  /**
   * 测试注入口：固定"现在"以断言窗口起点（默认取真实当前时刻）。
   * 不写 `= {}` 默认值 —— 可选参数会让 createElement 的 props 推断落到
   * host 元素重载上（TS2769），仓库其余组件统一用显式 props 接口。
   */
  now?: Date
}

export function TodaySummary({ now }: TodaySummaryProps) {
  const dayBoundaryHour = useSettingsStore((state) => state.dayBoundaryHour)
  const [summary, setSummary] = useState<{ validSessions: number; focusedSeconds: number } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const start = todayStartIso(now ?? new Date(), dayBoundaryHour)
    void fetchFocusSummaryWindow({ start }, controller.signal)
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
  }, [dayBoundaryHour, now])

  if (!summary) return null
  const hours = (summary.focusedSeconds / 3600).toFixed(1)
  return createElement(
    'p',
    { role: 'status', 'data-testid': 'focus-summary-bar', className: 'text-sm text-muted-foreground' },
    `今日 ${summary.validSessions} 个番茄 · 专注 ${hours}h`,
  )
}
