'use client'

/**
 * Stats view —— 统计页（空壳域收尾）。
 *
 * 只读：数据全部来自服务端 /stats/* 聚合端点，组件不做本地聚合，
 * 也不读 Dexie —— 避免与源数据不一致的第二个真相。
 *
 * 图形用纯 CSS（进度条 / 条形图），不引入图表库：这三块指标都是
 * 「一个数值 + 占比」，图表库带来的交互与配置在这里用不上，
 * 却会增加一个依赖与随之而来的第二个渲染体系。
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { FocusSummary } from '@/lib/stats/stats-api'
import { useStatsStore } from '@/stores/stats-store'

const PERIODS = [7, 30, 90] as const

export function StatsView() {
  const habitSummary = useStatsStore((s) => s.habitSummary)
  const scheduleSummary = useStatsStore((s) => s.scheduleSummary)
  const noteSummary = useStatsStore((s) => s.noteSummary)
  const focusSummary = useStatsStore((s) => s.focusSummary)
  const isLoading = useStatsStore((s) => s.isLoading)
  const error = useStatsStore((s) => s.error)
  const loadAll = useStatsStore((s) => s.loadAll)

  const [days, setDays] = useState<number>(30)

  useEffect(() => {
    void loadAll(days)
  }, [loadAll, days])

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">统计</span>
        <div className="flex gap-1">
          {PERIODS.map((period) => (
            <Button
              key={period}
              size="sm"
              variant={period === days ? 'default' : 'outline'}
              onClick={() => setDays(period)}
            >
              {period} 天
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {/* 专注放在最前：这是产品名里的那个东西，此前统计页完全看不到它 */}
        <Section
          title="专注"
          hint={focusSummary ? `近 ${focusSummary.period_days} 天` : undefined}
        >
          {!focusSummary || focusSummary.total_sessions === 0 ? (
            <Empty loaded={!isLoading} text="暂无专注数据" />
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Stat label="会话" value={focusSummary.total_sessions} />
                <Stat label="有效" value={focusSummary.valid_sessions} />
                <Stat
                  label="被打断"
                  value={focusSummary.interrupted_sessions}
                  tone="warn"
                />
                <Stat
                  label="专注时长"
                  value={`${(focusSummary.focused_seconds / 3600).toFixed(1)} h`}
                />
              </div>

              {/* ★ 按小时的热力图 —— 比"总共做了几个番茄"有用得多：
                  它回答"哪些时段是完整无中断的"，也就是该把难活排在什么时候。 */}
              <div className="mt-4">
                <div className="mb-1 text-xs text-muted-foreground">
                  按时段的专注分布
                </div>
                <div className="flex gap-0.5">
                  {focusSummary.by_hour.map((bucket) => (
                    <div
                      key={bucket.hour}
                      className="min-w-0 flex-1"
                      // data 属性供测试稳定定位（不依赖 title 文案的排版细节）
                      data-heat-hour={bucket.hour}
                      title={`${bucket.hour}:00 · ${bucket.sessions} 场（完整 ${bucket.valid}、被打断 ${bucket.interrupted}）`}
                    >
                      <div
                        className="h-8 rounded-sm bg-primary"
                        style={{
                          opacity: heatOpacity(bucket.sessions, maxSessions(focusSummary)),
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>0</span>
                  <span>6</span>
                  <span>12</span>
                  <span>18</span>
                  <span>23</span>
                </div>
              </div>

              {/* 估算准确度：计划时长 vs 实际专注时长。1.0 = 估得准。 */}
              {focusSummary.planned_seconds > 0 && (
                <div className="mt-4">
                  <div className="mb-1 text-xs text-muted-foreground">
                    估算准确度 {Math.round(focusSummary.estimate_accuracy * 100)}%
                    <span className="ml-1">
                      （计划 {(focusSummary.planned_seconds / 3600).toFixed(1)} h ·
                      实际 {(focusSummary.focused_seconds / 3600).toFixed(1)} h）
                    </span>
                  </div>
                  {/* 可能 >1（超时），这里按 0..1 夹取，避免撑破进度条 */}
                  <Bar value={focusSummary.estimate_accuracy} />
                </div>
              )}
            </>
          )}
        </Section>

        <Section title="习惯" hint={habitSummary ? `近 ${habitSummary.period_days} 天` : undefined}>
          {!habitSummary || habitSummary.habits.length === 0 ? (
            <Empty loaded={!isLoading} text="暂无习惯数据" />
          ) : (
            <ul className="flex flex-col gap-3">
              {habitSummary.habits.map((habit) => (
                <li key={habit.habit_id}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="truncate">{habit.title}</span>
                    <span className="shrink-0 pl-3 text-xs text-muted-foreground">
                      连续 {habit.current_streak} 天 · {habit.check_in_days}/
                      {habitSummary.period_days} 天
                    </span>
                  </div>
                  <Bar value={habit.completion_rate} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="日程"
          hint={scheduleSummary ? `近 ${scheduleSummary.period_days} 天` : undefined}
        >
          {/* 全零也算「无数据」—— 显示一排 0 不如明确告诉用户还没有日程 */}
          {!scheduleSummary || scheduleSummary.total === 0 ? (
            <Empty loaded={!isLoading} text="暂无日程数据" />
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Stat label="总计" value={scheduleSummary.total} />
                <Stat label="已完成" value={scheduleSummary.completed} />
                <Stat label="待办" value={scheduleSummary.pending} />
                <Stat label="逾期" value={scheduleSummary.overdue} tone="warn" />
              </div>
              <div className="mt-3">
                <div className="mb-1 text-xs text-muted-foreground">
                  完成率 {Math.round(scheduleSummary.completion_rate * 100)}%
                </div>
                <Bar value={scheduleSummary.completion_rate} />
              </div>
            </>
          )}
        </Section>

        <Section title="笔记">
          {/* 同上：四项全零视为无数据 */}
          {!noteSummary ||
          noteSummary.notes + noteSummary.folders + noteSummary.trashed_notes === 0 ? (
            <Empty loaded={!isLoading} text="暂无笔记数据" />
          ) : (
            <div className="grid grid-cols-4 gap-2 text-center">
              <Stat label="笔记" value={noteSummary.notes} />
              <Stat label="文件夹" value={noteSummary.folders} />
              <Stat label="回收站笔记" value={noteSummary.trashed_notes} />
              <Stat label="回收站文件夹" value={noteSummary.trashed_folders} />
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

/** 时段热力图的最大小时会话数（用于归一化）。全零时返回 0。 */
function maxSessions(summary: FocusSummary): number {
  return summary.by_hour.reduce((max, bucket) => Math.max(max, bucket.sessions), 0)
}

/**
 * 热力图的不透明度。
 *
 * 保留 0.12 的底色，让"有过专注但很少"的时段仍然可见 ——
 * 若从 0 开始，1 场的时段在浅色背景上几乎看不见。
 */
function heatOpacity(sessions: number, max: number): number {
  if (sessions === 0) return 0
  if (max <= 1) return 0.75
  return 0.12 + 0.88 * (sessions / max)
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  /** 数值或已格式化好的文案（如 "2.5 h"） */
  value: number | string
  label: string
  tone?: 'warn'
}) {
  return (
    <div>
      <div
        className={
            tone === 'warn' && value !== 0 && value !== '0'
            ? 'text-lg font-medium text-destructive'
            : 'text-lg font-medium'
        }
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

/** value 为 0..1。夹取边界，防止脏数据撑破布局。 */
function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  return (
    <div className="mt-1 h-2 overflow-hidden rounded bg-muted">
      <div className="h-full bg-primary" style={{ width: `${pct * 100}%` }} />
    </div>
  )
}

function Empty({ loaded, text }: { loaded: boolean; text: string }) {
  return <p className="text-sm text-muted-foreground">{loaded ? text : '加载中…'}</p>
}
