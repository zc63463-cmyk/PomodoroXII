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
import { useStatsStore } from '@/stores/stats-store'

const PERIODS = [7, 30, 90] as const

export function StatsView() {
  const habitSummary = useStatsStore((s) => s.habitSummary)
  const scheduleSummary = useStatsStore((s) => s.scheduleSummary)
  const noteSummary = useStatsStore((s) => s.noteSummary)
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
          {!scheduleSummary ? (
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
          {!noteSummary ? (
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
  label: string
  value: number
  tone?: 'warn'
}) {
  return (
    <div>
      <div
        className={
          tone === 'warn' && value > 0
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
