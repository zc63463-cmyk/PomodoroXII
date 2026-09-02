'use client'

/**
 * Habits view —— 习惯域页面（空壳域收尾）。
 *
 * 与 NotesView 同一套套路：只跟 useHabitStore 对话，store 走 repository，
 * 最终落本地 Dexie 并入 outbox —— 这里不碰 Dexie、不发 HTTP 写请求。
 *
 * 展示逻辑全部来自 habit-selectors 的纯函数（连续天数、今日进度、近 N 天），
 * 组件本身不做日期与计数运算。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  computeStreak,
  isCompletedOn,
  lastNDateKeys,
  toDateKey,
  todayProgress,
} from '@/lib/habits/habit-selectors'
import { useHabitStore } from '@/stores/habit-store'

/** 近多少天显示为条带。 */
const STRIP_DAYS = 14

export function HabitsView() {
  const habits = useHabitStore((s) => s.habits)
  const checkIns = useHabitStore((s) => s.checkIns)
  const isLoading = useHabitStore((s) => s.isLoading)
  const loadHabits = useHabitStore((s) => s.loadHabits)
  const createHabit = useHabitStore((s) => s.createHabit)
  const checkIn = useHabitStore((s) => s.checkIn)
  const removeCheckIn = useHabitStore((s) => s.removeCheckIn)

  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    void loadHabits()
  }, [loadHabits])

  // 今天只在挂载时算一次即可；跨日需刷新页面（或后续接定时器）
  const today = useMemo(() => toDateKey(new Date()), [])
  const strip = useMemo(() => lastNDateKeys(STRIP_DAYS, today), [today])

  const handleCheckIn = async (habitId: string) => {
    setPendingId(habitId)
    try {
      await checkIn(habitId, today)
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">习惯</span>
        <Button size="sm" variant="outline" onClick={() => void createHabit({ title: '新习惯' })}>
          新建
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {habits.length === 0 && !isLoading && (
          <p className="text-sm text-muted-foreground">还没有习惯，点「新建」开始。</p>
        )}

        <ul className="flex flex-col gap-3">
          {habits.map((habit) => {
            const streak = computeStreak(habit, checkIns, today)
            const progress = todayProgress(habit, checkIns, today)

            return (
              <li key={habit.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {habit.title || '(未命名)'}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      连续 {streak} 天 · 今日 {progress.done}/{progress.target}
                    </span>
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant={progress.completed ? 'outline' : 'default'}
                      disabled={pendingId === habit.id}
                      onClick={() => void handleCheckIn(habit.id)}
                    >
                      {progress.completed ? '再打卡' : '打卡'}
                    </Button>
                    {progress.done > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pendingId === habit.id}
                        onClick={() => void removeCheckIn(habit.id, today)}
                      >
                        撤销
                      </Button>
                    )}
                  </div>
                </div>

                {/* 近 N 天条带：达标实心，未达标空心 */}
                <div className="mt-3 flex gap-1">
                  {strip.map((date) => (
                    <span
                      key={date}
                      title={date}
                      className={
                        isCompletedOn(habit, checkIns, date)
                          ? 'h-3 w-3 rounded-sm bg-primary'
                          : 'h-3 w-3 rounded-sm border'
                      }
                    />
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
