'use client'

/**
 * 准备态右栏「今日」（设计稿 `.side` 的 ② 列内容）—— 设计稿复刻。
 *
 * 结构（与 `设计稿-番茄钟页面UI优化.html` 的准备态右栏逐块对应）：
 * ```
 * 「今日」                        ← 由 TimerFrame 的 sideHeader 渲染（全宽标题栏）
 *   .ios-stats  三格             ← 番茄 / 专注(min) / 被打断
 *   <focus-summary-bar>          ← 原底部统计栏文案，保留（既有页面测试断言）
 *   .ios-panel 「最近会话」       ← 圆点 + 「今日 HH:MM · NNmin」 + 尾标（主观评价）
 *   .ios-panel 「节奏」           ← 已完成 N 个番茄 · 距长休还需 M 个 / 长休间隔
 * ```
 *
 * ## 为什么保留 <focus-summary-bar>
 * `app/(app)/timer/page.test.tsx` 断言准备态与运行态**两处**都有
 * `data-testid="focus-summary-bar"`，内容为「今日 N 个番茄 · 专注 X.Xh」。
 * 本轮把"底部一行统计栏"升级为设计稿的「今日」卡组，但那一条统计仍是今日
 * 口径的唯一一句话表述 —— 保留在同一张卡里（作为小字），既不断言面回归，
 * 也不丢信息。口径仍走 `todayStartIso`（habits 域日界单一事实源）。
 *
 * ## 数据来源
 * - 统计三格 + 那句统计：`fetchFocusSummaryWindow({ start })`（服务端显式窗口）
 * - 最近会话：**由页面注入**本地会话缓存行（页面已为节奏面板读过 `listCached`），
 *   本组件不直接碰 Dexie —— 便于单测，也避免重复 IO。
 * - 节奏：`settings.longBreakInterval` + 今日有效会话数（纯推导，不新增状态）
 *
 * fail-quiet：统计不可用时三格与那一行整体不渲染（不阻断计时），只留一条 warn。
 */
import { createElement, useEffect, useState } from 'react'
import { fetchFocusSummaryWindow } from '@/lib/stats/stats-api'
import { todayStartIso } from '@/lib/stats/day-window'
import { useSettingsStore } from '@/stores/settings-store'

/** 本地会话缓存行（页面注入；只取展示需要的字段）。 */
export interface RecentSessionRow {
  sessionId?: string
  id?: string
  startedAt?: string
  plannedSeconds?: number | null
  focusedSeconds?: number | null
  overallProgress?: string | null
  sessionType?: string | null
}

export interface TimerSideTodayProps {
  /** 最近会话（本地缓存行，按开始时间倒序；本组件只取今日的前 3 条） */
  recentSessions?: readonly RecentSessionRow[]
  /**
   * 测试注入口：固定"现在"。生产渲染不传 —— 不劫持真实时钟。
   * 不进 effect 依赖之外的用途（与 today-summary 同约定）。
   */
  now?: Date
}

/**
 * 会话主观评价的中文标签。
 *
 * 取值来自 `lib/contracts/focus-session.ts` 的 `overallProgressSchema`
 * （`smooth | progressed | stuck | interrupted`）。此处是**首处中文映射**
 * —— 既有复盘面板只把这些值当 option value 渲染（未本地化），因此这里定义
 * 一份并注明来源；若日后复盘面板也要显示中文，应把它提到共享常量模块，
 * 而不是复制第二份。
 */
const PROGRESS_LABEL: Record<string, string> = {
  smooth: '顺利推进',
  progressed: '有进展',
  stuck: '卡住',
  interrupted: '被打断',
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * 会话时长显示：「今日 09:12」 + 「· 25min」。
 *
 * ⚠ `todayKey` 必须由调用方传入（同一把 `now` 尺子）—— 2026-10-01 修：
 * 本函数原先自取 `new Date()`，"今日/日期"分支与组件注入的 `now` 分叉，
 * 后果是注入语义不完整（跨日必红、单测不确定）。生产调用方恒传真实 now，
 * 行为不变；注入路径（测试）自此**完全确定**。
 */
function formatRecentTime(row: RecentSessionRow, todayKey: string, dayBoundaryHour: number): string {
  const at = new Date(String(row.startedAt))
  if (Number.isNaN(at.getTime())) return ''
  const atKey = todayStartIso(at, dayBoundaryHour)
  const stamp = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  return atKey === todayKey ? `今日 ${stamp}` : `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${stamp}`
}

function formatRecentMinutes(row: RecentSessionRow): string {
  const seconds = typeof row.plannedSeconds === 'number' && row.plannedSeconds > 0
    ? row.plannedSeconds
    : (typeof row.focusedSeconds === 'number' ? row.focusedSeconds : 0)
  if (seconds <= 0) return ''
  return `${Math.round(seconds / 60)}min`
}

export function TimerSideToday({ recentSessions, now }: TimerSideTodayProps) {
  const dayBoundaryHour = useSettingsStore((state) => state.dayBoundaryHour)
  const longBreakInterval = useSettingsStore((state) => state.longBreakInterval)
  const [summary, setSummary] = useState<{
    validSessions: number
    interruptedSessions: number
    focusedSeconds: number
  } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const start = todayStartIso(now ?? new Date(), dayBoundaryHour)
    void fetchFocusSummaryWindow({ start }, controller.signal)
      .then((data) => {
        if (cancelled) return
        setSummary({
          validSessions: data.valid_sessions,
          interruptedSessions: data.interrupted_sessions,
          focusedSeconds: data.focused_seconds,
        })
      })
      .catch((cause) => {
        if (!cancelled) {
          console.warn(`[timer-side-today] 统计不可用，本卡不渲染（不阻断计时）: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [dayBoundaryHour, now])

  // 今日最近会话：本地缓存行里按开始时间倒序取 3 条（只取归入今日的）。
  const todayKey = todayStartIso(now ?? new Date(), dayBoundaryHour)
  const recent = (recentSessions ?? [])
    .filter((row) => row.startedAt && todayStartIso(new Date(row.startedAt), dayBoundaryHour) === todayKey)
    .slice()
    .sort((a, b) => Date.parse(String(b.startedAt)) - Date.parse(String(a.startedAt)))
    .slice(0, 3)

  const focusMinutes = summary ? Math.round(summary.focusedSeconds / 60) : 0
  const completed = summary?.validSessions ?? 0
  const interval = Math.max(1, longBreakInterval || 4)
  const remainingToLongBreak = interval - (completed % interval)

  return createElement('div', { className: 'ios-side-bd' },
    // ── 统计三格 + 今日口径那一句（见头注"为什么保留 focus-summary-bar"）──
    summary
      ? createElement('div', { className: 'ios-panel' },
        createElement('div', { className: 'ios-stats' },
          createElement('div', { className: 'ios-stat' },
            createElement('div', { className: 'ios-stat-n' }, String(completed)),
            createElement('div', { className: 'ios-stat-l' }, '番茄'),
          ),
          createElement('div', { className: 'ios-stat' },
            createElement('div', { className: 'ios-stat-n' },
              String(focusMinutes), createElement('small', null, 'min')),
            createElement('div', { className: 'ios-stat-l' }, '专注'),
          ),
          createElement('div', { className: 'ios-stat' },
            createElement('div', { className: 'ios-stat-n' }, String(summary.interruptedSessions)),
            createElement('div', { className: 'ios-stat-l' }, '被打断'),
          ),
        ),
        createElement('p', {
          role: 'status',
          'data-testid': 'focus-summary-bar',
          className: 'ios-tiny',
          style: { marginTop: 9 },
        }, `今日 ${completed} 个番茄 · 专注 ${(summary.focusedSeconds / 3600).toFixed(1)}h`),
      )
      : null,
    // ── 最近会话 ──
    createElement('div', { className: 'ios-panel' },
      createElement('div', { className: 'ios-card-title' }, '最近会话'),
      recent.length === 0
        ? createElement('div', { className: 'ios-tiny' }, '今天还没有会话。')
        : createElement('div', null, ...recent.map((row, index) => createElement('div', {
            key: String(row.sessionId ?? row.id ?? index),
            className: 'ios-drow',
          },
          createElement('span', {
            className: index === 0 ? 'ios-dot ios-dot--strong' : 'ios-dot',
          }),
          createElement('span', null,
            `${formatRecentTime(row, todayKey, dayBoundaryHour)} · ${formatRecentMinutes(row)}`.replace(/ · $/, ''),
          ),
          row.overallProgress && PROGRESS_LABEL[row.overallProgress]
            ? createElement('span', { className: 'ios-tail' }, PROGRESS_LABEL[row.overallProgress])
            : null,
        ))),
    ),
    // ── 节奏 ──
    createElement('div', { className: 'ios-panel' },
      createElement('div', { className: 'ios-card-title' }, '节奏'),
      createElement('div', { className: 'ios-tiny' },
        `已完成 ${completed} 个番茄 · 距长休还需 ${remainingToLongBreak} 个`,
        createElement('br'),
        `长休间隔：${interval} 个番茄`,
      ),
    ),
  )
}
