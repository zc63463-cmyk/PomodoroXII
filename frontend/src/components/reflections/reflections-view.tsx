'use client'

/**
 * Reflections view —— 反思域页面。
 *
 * 与 NotesView / HabitsView 同一套套路：只跟 useReflectionStore 对话，
 * store 走 repository，最终落本地 Dexie 并入 outbox —— 这里不碰 Dexie、
 * 不发 HTTP 写请求。
 *
 * 形态接近笔记，但主键语义是「日期」：同一天一篇，缺省用今天。
 *
 * ## 今日事实抽屉（Phase 1）
 * 右侧抽屉只读展示「当天番茄事实」（时长/会话/有效性/投入分布/悬挂思考），
 * 由 `lib/reflections/daily-evidence.ts` 的纯函数投影而来。
 * **派生不落库**：这些数据不进 `reflections` 表，纯粹每次打开现算。
 *
 * ## ★ 注入的读-改-写纪律（与 `timer/page.tsx:502-506` 同源）
 * `updateReflection` 是**整份覆盖**语义。若注入后不更新 `draft`，
 * 用户下次点「保存」就会用旧 draft 覆盖掉刚注入的内容 ——
 * 故 `handleInject` 写库成功后**必须** `setDraft(next)`。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  MOODS,
  computeReflectionStreak,
  countMoods,
  groupReflectionsByMonth,
  reflectionExcerpt,
} from '@/lib/reflections/reflection-selectors'
import {
  DEFAULT_DAY_BOUNDARY,
  emptyDailyEvidence,
  formatDailyEvidenceMarkdown,
  type DailyEvidenceSnapshot,
} from '@/lib/reflections/daily-evidence'
import { filterHanging, type DailyMapProjection } from '@/lib/reflections/daily-map'
import { readDailyMapBundle } from '@/lib/reflections/daily-map-provider'
import { toDateKey } from '@/lib/habits/habit-selectors'
import { useReflectionStore } from '@/stores/reflection-store'
import type { Mood } from '@/types'

import { DailyEvidenceDrawer } from './daily-evidence-drawer'

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

  // 今日事实（派生，不落库）：跟随「当前选中的反思日期」而不是跟随 today ——
  // 用户翻到 10-01，抽屉就该显示 10-01 的事实，否则抽屉与正文对不上（反直觉）。
  const [evidence, setEvidence] = useState<DailyEvidenceSnapshot>(() => emptyDailyEvidence(today))
  // 导图投影（Phase 2）：与 evidence 同一次读取产出，避免抽屉闪两次
  const [mapProjection, setMapProjection] = useState<DailyMapProjection | null>(null)
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [injecting, setInjecting] = useState(false)

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

  // 今日事实（派生，不落库）：跟随「当前选中的反思日期」而不是跟随 today ——
  // 用户翻到 10-01，抽屉就该显示 10-01 的事实，否则抽屉与正文对不上（反直觉）。
  const evidenceDate = active?.date ?? today
  useEffect(() => {
    let cancelled = false
    setEvidenceLoading(true)
    void readDailyMapBundle(evidenceDate, DEFAULT_DAY_BOUNDARY)
      .then((bundle) => {
        if (cancelled) return
        setEvidence(bundle.evidence)
        setMapProjection(bundle.map)
      })
      // fail-soft：读事实失败只让抽屉缺席，**绝不把 rejection 泄漏成未捕获错误**
      // （provider 内已有 catch，这里是第二道 —— 未来换实现也不会漏）。
      .catch(() => {
        if (cancelled) return
        setEvidence(emptyDailyEvidence(evidenceDate))
        setMapProjection(null)
      })
      .finally(() => {
        if (!cancelled) setEvidenceLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [evidenceDate])

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

  /**
   * 一键引入今日提炼。
   *
   * **追加**而非替换（用户的写作区不能被覆写），双换行分隔块与块。
   * 写库成功后同步 `draft` —— 否则下次点「保存」会用旧 draft 抹掉这段内容
   * （`updateReflection` 是整份覆盖语义，见文件头注）。
   */
  const handleInject = useCallback(async () => {
    if (!active || injecting) return
    // 注入内容里的"悬挂思考"取**导图侧**的提炼结果（已剔除已升格的），
    // 纯函数层负责去重，页面只做拼装。
    const withHanging: DailyEvidenceSnapshot =
      mapProjection === null ? evidence : { ...evidence, hanging: filterHanging(mapProjection.hanging) }
    const markdown = formatDailyEvidenceMarkdown(withHanging)
    if (markdown === '') return

    setInjecting(true)
    try {
      const base = draft.trimEnd()
      const next = base === '' ? markdown : `${base}\n\n${markdown}`
      await updateReflection(active.id, { content: next })
      setDraft(next)
    } finally {
      setInjecting(false)
    }
  }, [active, draft, evidence, injecting, mapProjection, updateReflection])

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

      {/*
        今日事实抽屉是 `<section>` 的**同级兄弟**（不是它的子节点）——
        它自己带 `border-l`，若塞进 section 内部会被正文的 padding 挤窄。
        `isEmpty` / `loading` 时组件自身返回 null，故此处置空即可。
      */}
      <DailyEvidenceDrawer
        snapshot={evidence}
        map={mapProjection}
        loading={evidenceLoading}
        injecting={injecting}
        onInject={active ? () => void handleInject() : undefined}
      />
    </div>
  )
}
