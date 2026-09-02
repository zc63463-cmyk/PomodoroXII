'use client'

/**
 * Reflections view —— 反思域页面（空壳域收尾）。
 *
 * 与 NotesView / HabitsView 同一套套路：只跟 useReflectionStore 对话，
 * store 走 repository，最终落本地 Dexie 并入 outbox —— 这里不碰 Dexie、
 * 不发 HTTP 写请求。
 *
 * 形态接近笔记，但主键语义是「日期」：同一天一篇，缺省用今天。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  MOODS,
  computeReflectionStreak,
  countMoods,
  groupReflectionsByMonth,
  reflectionExcerpt,
} from '@/lib/reflections/reflection-selectors'
import { toDateKey } from '@/lib/habits/habit-selectors'
import { useReflectionStore } from '@/stores/reflection-store'
import type { Mood } from '@/types'

const MOOD_LABEL: Record<Mood, string> = {
  great: '很好',
  good: '不错',
  normal: '一般',
  bad: '不好',
  terrible: '很差',
}

export function ReflectionsView() {
  const reflections = useReflectionStore((s) => s.reflections)
  const isLoading = useReflectionStore((s) => s.isLoading)
  const loadReflections = useReflectionStore((s) => s.loadReflections)
  const createReflection = useReflectionStore((s) => s.createReflection)
  const updateReflection = useReflectionStore((s) => s.updateReflection)
  const deleteReflection = useReflectionStore((s) => s.deleteReflection)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const today = useMemo(() => toDateKey(new Date()), [])

  useEffect(() => {
    void loadReflections()
  }, [loadReflections])

  const groups = useMemo(() => groupReflectionsByMonth(reflections), [reflections])
  const streak = useMemo(() => computeReflectionStreak(reflections, today), [reflections, today])
  const moods = useMemo(() => countMoods(reflections), [reflections])
  const totalMoodCount = useMemo(() => moods.reduce((sum, m) => sum + m.count, 0), [moods])

  const active = useMemo(
    () => reflections.find((r) => r.id === activeId) ?? null,
    [reflections, activeId],
  )

  // 切换反思时载入当前内容作为草稿起点
  useEffect(() => {
    setDraft(active?.content ?? '')
  }, [active?.id, active?.content])

  const handleCreate = async () => {
    const created = await createReflection({ date: today, content: '' })
    setActiveId(created.id)
  }

  const handleSave = async () => {
    if (!active) return
    await updateReflection(active.id, { content: draft })
  }

  const handleDelete = async () => {
    if (!active) return
    await deleteReflection(active.id)
    setActiveId(null)
  }

  return (
    <div className="flex min-h-full min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-3 py-3">
          <span className="text-sm font-medium">反思</span>
          <Button size="sm" variant="outline" onClick={() => void handleCreate()}>
            新建
          </Button>
        </div>

        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          连续 {streak} 天 · 共 {reflections.length} 篇
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {reflections.length === 0 && !isLoading && (
            <p className="px-3 py-6 text-sm text-muted-foreground">
              还没有反思，点「新建」开始。
            </p>
          )}

          {groups.map((group) => (
            <div key={group.month}>
              <div className="px-3 py-1 text-xs font-medium uppercase text-muted-foreground">
                {group.month}
              </div>
              {group.reflections.map((reflection) => (
                <button
                  key={reflection.id}
                  type="button"
                  onClick={() => setActiveId(reflection.id)}
                  className={
                    reflection.id === activeId
                      ? 'block w-full border-l-2 border-primary bg-muted px-3 py-2 text-left'
                      : 'block w-full border-l-2 border-transparent px-3 py-2 text-left hover:bg-muted/50'
                  }
                >
                  <span className="block truncate text-sm">{reflection.date}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {reflection.mood ? `${MOOD_LABEL[reflection.mood]} · ` : ''}
                    {reflectionExcerpt(reflection, 40)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!active ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            选择一篇反思，或新建一篇。
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <input
                type="date"
                className="border bg-background px-2 py-1 text-xs"
                value={active.date}
                onChange={(e) => void updateReflection(active.id, { date: e.target.value })}
                aria-label="日期"
              />
              <select
                className="border bg-background px-2 py-1 text-xs"
                value={active.mood ?? ''}
                onChange={(e) =>
                  void updateReflection(active.id, {
                    mood: (e.target.value || null) as Mood | null,
                  })
                }
                aria-label="心情"
              >
                <option value="">未记录</option>
                {MOODS.map((mood) => (
                  <option key={mood} value={mood}>
                    {MOOD_LABEL[mood]}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => void handleSave()}>
                保存
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void handleDelete()}>
                删除
              </Button>
            </div>

            <textarea
              className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm outline-none"
              placeholder="写下今天的反思…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </>
        )}

        {totalMoodCount > 0 && (
          <div className="border-t px-3 py-2">
            <div className="flex h-2 overflow-hidden rounded">
              {moods.map(({ mood, count }) =>
                count > 0 ? (
                  <span
                    key={mood}
                    title={`${MOOD_LABEL[mood]} ${count}`}
                    style={{ width: `${(count / totalMoodCount) * 100}%` }}
                    className="bg-primary/70"
                  />
                ) : null,
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
              {moods
                .filter((m) => m.count > 0)
                .map(({ mood, count }) => (
                  <span key={mood}>
                    {MOOD_LABEL[mood]} {count}
                  </span>
                ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
