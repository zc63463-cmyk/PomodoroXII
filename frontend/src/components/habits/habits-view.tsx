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
  longestStreak,
  toDateKeyWithBoundary,
  todayProgress,
} from '@/lib/habits/habit-selectors'
import { useHabitStore } from '@/stores/habit-store'
import { useSettingsStore } from '@/stores/settings-store'

/** 近多少天显示为条带。 */
const STRIP_DAYS = 14

/** 可选的日界档位。0 为默认（午夜分界），其余为常见作息。 */
const DAY_BOUNDARY_OPTIONS = [0, 3, 6] as const

export function HabitsView() {
  const habits = useHabitStore((s) => s.habits)
  const checkIns = useHabitStore((s) => s.checkIns)
  const isLoading = useHabitStore((s) => s.isLoading)
  const loadHabits = useHabitStore((s) => s.loadHabits)
  const createHabit = useHabitStore((s) => s.createHabit)
  const checkIn = useHabitStore((s) => s.checkIn)
  const removeCheckIn = useHabitStore((s) => s.removeCheckIn)

  const dayBoundaryHour = useSettingsStore((s) => s.dayBoundaryHour)
  const setSetting = useSettingsStore((s) => s.update)

  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    void loadHabits()
  }, [loadHabits])

  // 今天按「日界」算。日界改了，今天可能落到昨天 —— 下游 streak 与
  // 打卡记录都是日期键字符串比较，会自动跟着走，不需要额外处理。
  const today = useMemo(
    () => toDateKeyWithBoundary(new Date(), dayBoundaryHour),
    [dayBoundaryHour],
  )
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

        <div className="flex items-center gap-2">
          {/* 跨午夜日界：凌晨 3 点前打卡仍算前一天。夜猫子/加班场景的刚需。 */}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            日界
            <select
              className="border bg-background px-1.5 py-0.5 text-xs"
              value={dayBoundaryHour}
              onChange={(e) => void setSetting('dayBoundaryHour', Number(e.target.value))}
              aria-label="跨午夜日界"
              title="设置几点之后才算新的一天。设为 03:00 时，凌晨 1 点打卡仍算前一天。"
            >
              {DAY_BOUNDARY_OPTIONS.map((hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>

          <Button size="sm" variant="outline" onClick={() => void createHabit({ title: '新习惯' })}>
            新建
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {habits.length === 0 && !isLoading && (
          <p className="text-sm text-muted-foreground">还没有习惯，点「新建」开始。</p>
        )}

        <ul className="flex flex-col gap-3">
          {habits.map((habit) => {
            const streak = computeStreak(habit, checkIns, today)
            const longest = longestStreak(habit, checkIns, today)
            const progress = todayProgress(habit, checkIns, today)

            return (
              <li key={habit.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {habit.title || '(未命名)'}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      连续 {streak} 天 · 最长 {longest} 天 · 今日 {progress.done}/
                      {progress.target}
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
