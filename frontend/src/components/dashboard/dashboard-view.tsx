'use client'

/**
 * Dashboard —— 应用首页，日常动线的起点。
 *
 * 设计依据（见《子系统功能与使用逻辑深度打磨》）：
 * - 早晨流程：确认固定事项 → 选 1–3 个优先级 → 现实估算 → 加缓冲
 * - 成熟实践反复强调「**容量可见**」：让今天有多少事一眼看得到，而不是点进各个页面才知道
 * - 「**不要排满**」：这里只呈现今天，且不做任何编辑，避免首页变成第二个任务管理器
 *
 * 这里只**读取**各域 store，不写入（唯一例外是习惯打卡 —— 它是最高频的动作，
 * 为了打一次卡跳一次页面太贵了）。
 */

import { useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { toDateKey } from '@/lib/habits/habit-selectors'
import { isCompletedOn, todayProgress } from '@/lib/habits/habit-selectors'
import { dateKeyOfISO } from '@/lib/schedules/schedule-selectors'
import { formatDuration } from '@/components/schedules/schedules-view'
import { useHabitStore } from '@/stores/habit-store'
import { useScheduleStore } from '@/stores/schedule-store'
import { useTimeBlockStore } from '@/stores/time-block-store'

export function DashboardView() {
  const schedules = useScheduleStore((s) => s.schedules)
  const loadSchedules = useScheduleStore((s) => s.loadSchedules)

  const habits = useHabitStore((s) => s.habits)
  const checkIns = useHabitStore((s) => s.checkIns)
  const loadHabits = useHabitStore((s) => s.loadHabits)
  const checkIn = useHabitStore((s) => s.checkIn)
  const removeCheckIn = useHabitStore((s) => s.removeCheckIn)

  const timeBlocks = useTimeBlockStore((s) => s.timeBlocks)
  const loadTimeBlocks = useTimeBlockStore((s) => s.loadTimeBlocks)

  // 今天只在挂载时算一次；跨日需刷新（与 habits / schedules 的既有做法一致）
  const today = useMemo(() => toDateKey(new Date()), [])

  useEffect(() => {
    void loadSchedules()
    void loadHabits()
  }, [loadSchedules, loadHabits])

  useEffect(() => {
    void loadTimeBlocks(today)
  }, [loadTimeBlocks, today])

  /** 今天的日程，按时间先后（仓储已按 due_at 升序返回） */
  const todaySchedules = useMemo(
    () => schedules.filter((schedule) => dateKeyOfISO(schedule.due_at) === today),
    [schedules, today],
  )

  /** 今天的计划专注时长与已完成时长（秒） */
  const focusSummary = useMemo(() => {
    const planned = timeBlocks.reduce((sum, b) => sum + b.planned_duration, 0)
    const actual = timeBlocks.reduce((sum, b) => sum + b.actual_duration, 0)
    return { planned, actual }
  }, [timeBlocks])

  const doneHabits = habits.filter((habit) => isCompletedOn(habit, checkIns, today)).length

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">今天</h1>
        <p className="mt-1 text-sm text-muted-foreground">{today}</p>
      </header>

      {/* 容量概览 —— 让「今天有多少事」一眼可见 */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatCard label="日程" value={todaySchedules.length} href="/schedules" />
        <StatCard
          label="习惯"
          value={`${doneHabits}/${habits.length}`}
          href="/habits"
        />
        <StatCard label="时间块" value={timeBlocks.length} href="/schedules" />
      </div>

      {/* 主行动：开始专注。首页不该堆功能，但「开始」这一下必须够显眼 */}
      <div className="mb-8 flex items-center gap-3 rounded-lg border p-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">专注</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {focusSummary.planned > 0
              ? `计划 ${formatDuration(focusSummary.planned)} · 已完成 ${formatDuration(focusSummary.actual)}`
              : '今天还没有安排时间块'}
          </div>
        </div>
        <Link href="/timer">
          <Button size="sm">开始专注</Button>
        </Link>
      </div>

      {/* 今日日程 */}
      <section className="mb-8">
        <SectionHeader title="今日日程" href="/schedules" />
        {todaySchedules.length === 0 ? (
          <EmptyHint text="今天没有日程安排" />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {todaySchedules.map((schedule) => (
              <li
                key={schedule.id}
                className="flex items-center gap-2 rounded border px-3 py-2 text-sm"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: schedule.color || 'currentColor' }}
                  aria-hidden
                />
                <span
                  className={
                    schedule.completed_at !== null
                      ? 'min-w-0 flex-1 truncate text-muted-foreground line-through'
                      : 'min-w-0 flex-1 truncate'
                  }
                >
                  {schedule.title || '(未命名)'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 今日习惯 —— 可直接打卡：为了打一次卡跳一次页面太贵 */}
      <section className="mb-8">
        <SectionHeader title="今日习惯" href="/habits" />
        {habits.length === 0 ? (
          <EmptyHint text="还没有习惯，去「习惯」页添加一个" />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {habits.map((habit) => {
              const done = isCompletedOn(habit, checkIns, today)
              const progress = todayProgress(habit, checkIns, today)
              return (
                <li
                  key={habit.id}
                  className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{habit.title || '(未命名)'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {progress.done}/{progress.target}
                  </span>
                  <Button
                    size="xs"
                    variant={done ? 'ghost' : 'outline'}
                    onClick={() =>
                      void (done
                        ? removeCheckIn(habit.id, today)
                        : checkIn(habit.id, today))
                    }
                    aria-label={`${habit.title || '习惯'}${done ? '撤销打卡' : '打卡'}`}
                  >
                    {done ? '撤销' : '打卡'}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* 今日时间块：计划 vs 实际 */}
      <section>
        <SectionHeader title="今日时间块" href="/schedules" />
        {timeBlocks.length === 0 ? (
          <EmptyHint text="今天还没有时间块，可在「日程」页安排" />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {timeBlocks.map((block) => (
              <li
                key={block.id}
                className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
              >
                <span className="shrink-0 text-xs text-muted-foreground">
                  {block.start_time}–{block.end_time}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {block.title || '(未命名)'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDuration(block.actual_duration)} / {formatDuration(block.planned_duration)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function StatCard({
  label,
  value,
  href,
}: {
  label: string
  value: number | string
  href: string
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border px-3 py-3 text-center transition-colors hover:bg-muted/50"
    >
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </Link>
  )
}

function SectionHeader({ title, href }: { title: string; href: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="text-sm font-medium">{title}</h2>
      <Link href={href} className="text-xs text-muted-foreground hover:text-foreground">
        查看全部
      </Link>
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>
}
