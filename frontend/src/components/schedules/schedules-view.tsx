'use client'

/**
 * Schedules view —— 日程域月视图日历。
 *
 * 与 NotesView / HabitsView 同一套套路：只跟 store 对话（useScheduleStore /
 * useTimeBlockStore），store 走 repository 落本地 Dexie 并入 outbox ——
 * 这里不碰 Dexie、不发 HTTP 写请求。
 *
 * 日历用纯 CSS Grid 画（7 列 + 首尾补白），未引入日历库：
 * 项目目前没有任何日历依赖，加一个等于引入第二套 UI 体系，
 * 而月视图的形态（定长网格）用 Grid 完全够表达。
 *
 * 日期定位走 schedule-selectors 的纯函数，组件只做渲染：
 * - 日期键一律 YYYY-MM-DD 字符串比较
 * - 取本地日期键必须用 dateKeyOfISO()，禁止 toISOString().slice(0,10)（UTC 会跨日）
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  completionRate,
  dateKeyOfISO,
  groupSchedulesByDate,
  isOverdue,
  sortByPriority,
  splitByStatus,
} from '@/lib/schedules/schedule-selectors'
import { useScheduleStore } from '@/stores/schedule-store'
import { useTimeBlockStore } from '@/stores/time-block-store'
import type { Schedule, TimeBlock } from '@/types'

/** 周一起始（中文日历习惯）。 */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 单个日期格里最多显示几条日程，超出折叠为「+N」。 */
const MAX_VISIBLE_PER_DAY = 3

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 当月天数。`new Date(year, month, 0)` = 下月第 0 天 = 本月最后一天。 */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** 月标题，如「2026 年 9 月」。 */
export function monthTitle(year: number, month: number): string {
  return `${year} 年 ${month} 月`
}

/** 传给 loadSchedules 的当月首尾日期。 */
export function monthRange(year: number, month: number): { from: string; to: string } {
  return {
    from: `${year}-${pad2(month)}-01`,
    to: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
  }
}

/**
 * 生成月视图格子：前导 null 为补白，其余为 YYYY-MM-DD。
 * 尾部补齐到整周，保证最后一行的格子与上方对齐。
 */
export function buildMonthGrid(year: number, month: number): Array<string | null> {
  // getDay() 周日=0，换算成「周一=0」
  const leading = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const cells: Array<string | null> = Array.from({ length: leading }, () => null)
  for (let day = 1; day <= daysInMonth(year, month); day += 1) {
    cells.push(`${year}-${pad2(month)}-${pad2(day)}`)
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

/**
 * YYYY-MM-DD + HH:mm → 本地 ISO datetime。
 *
 * 不能直接拼 `${date}T${time}Z`：那会把本地时间当 UTC 解析。
 * 这是 dateKeyOfISO 的反向操作，两者必须成对使用。
 */
export function localDateTimeToISO(dateKey: string, hhmm: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = hhmm.split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

/** 取 ISO datetime 的 HH:mm 部分；空值或非法值返回空串。 */
export function timeLabelOf(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 秒 → 中文时长。只展示到「分钟」，番茄钟量级不需要秒。 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟'
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分钟`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分钟`
}

/**
 * 实际相对计划的偏差（秒）。正数=超出计划，负数=没做满。
 *
 * 跳过的时间块返回 0 —— 它不是「做了 0 秒」，而是「没发生」，
 * 拿 0 去减计划时长会得到一个误导性的巨额负值。
 */
export function durationDelta(block: TimeBlock): number {
  if (block.status === 'skipped') return 0
  return block.actual_duration - block.planned_duration
}

interface YearMonth {
  year: number
  month: number
}

function shiftYearMonth(prev: YearMonth, delta: number): YearMonth {
  const month = prev.month + delta
  if (month > 12) return { year: prev.year + 1, month: 1 }
  if (month < 1) return { year: prev.year - 1, month: 12 }
  return { ...prev, month }
}

export function SchedulesView() {
  const schedules = useScheduleStore((s) => s.schedules)
  const isLoading = useScheduleStore((s) => s.isLoading)
  const loadSchedules = useScheduleStore((s) => s.loadSchedules)
  const createSchedule = useScheduleStore((s) => s.createSchedule)
  const completeSchedule = useScheduleStore((s) => s.completeSchedule)
  const deleteSchedule = useScheduleStore((s) => s.deleteSchedule)
  const updateSchedule = useScheduleStore((s) => s.updateSchedule)

  const timeBlocks = useTimeBlockStore((s) => s.timeBlocks)
  const loadTimeBlocks = useTimeBlockStore((s) => s.loadTimeBlocks)

  /**
   * now 只在挂载时取一次。放在 render 里 new Date() 会让每次重渲染都得到新值，
   * 逾期判定随之抖动（同一条日程可能在两次渲染间变色）。
   */
  const [nowISO] = useState(() => new Date().toISOString())
  const todayKey = useMemo(() => dateKeyOfISO(nowISO), [nowISO])

  const [anchor, setAnchor] = useState<YearMonth>(() => {
    const date = new Date()
    return { year: date.getFullYear(), month: date.getMonth() + 1 }
  })
  const [selectedDate, setSelectedDate] = useState(todayKey)

  const range = useMemo(() => monthRange(anchor.year, anchor.month), [anchor])
  const cells = useMemo(() => buildMonthGrid(anchor.year, anchor.month), [anchor])

  useEffect(() => {
    void loadSchedules(range)
  }, [loadSchedules, range])

  // 时间块按「天」加载 —— 一天一天拉，不一次读全部历史。
  useEffect(() => {
    void loadTimeBlocks(selectedDate)
  }, [loadTimeBlocks, selectedDate])

  const byDate = useMemo(() => {
    // groupSchedulesByDate 的返回是 Schedule[]（纯函数不关心同步字段），
    // 下游只读展示，故按 Schedule 传播即可
    const map = new Map<string, Schedule[]>()
    for (const group of groupSchedulesByDate(schedules)) map.set(group.date, group.schedules)
    return map
  }, [schedules])

  /** 落在当月范围内的日程，用于完成率与逾期统计。 */
  const monthSchedules = useMemo(
    () =>
      schedules.filter((schedule) => {
        const key = dateKeyOfISO(schedule.due_at)
        return key >= range.from && key <= range.to
      }),
    [schedules, range],
  )
  const { overdue } = useMemo(() => splitByStatus(monthSchedules, nowISO), [monthSchedules, nowISO])
  const rate = useMemo(() => completionRate(monthSchedules), [monthSchedules])

  /**
   * 选中日详情按优先级排（high 先），与格子里「按开始时间」不同 ——
   * 格子要看时间先后顺序，详情要看该先做哪件。
   */
  const selectedSchedules = useMemo(
    () => sortByPriority(byDate.get(selectedDate) ?? []),
    [byDate, selectedDate],
  )
  const selectedBlocks = useMemo(
    () =>
      timeBlocks
        .filter((block) => block.date === selectedDate)
        .sort((a, b) => a.start_time.localeCompare(b.start_time)),
    [timeBlocks, selectedDate],
  )

  const handleToday = () => {
    const [year, month] = todayKey.split('-').map(Number)
    setAnchor({ year, month })
    setSelectedDate(todayKey)
  }

  const handleCreate = async () => {
    const schedule = await createSchedule({
      title: '新日程',
      due_at: localDateTimeToISO(selectedDate, '09:00'),
    })
    // 建完把选中日挪到它实际落下的那天，避免「建了但看不见」
    setSelectedDate(dateKeyOfISO(schedule.due_at))
  }

  const isEmpty = schedules.length === 0 && !isLoading

  return (
    <div className="flex min-h-full min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              aria-label="上一月"
              onClick={() => setAnchor((prev) => shiftYearMonth(prev, -1))}
            >
              ‹
            </Button>
            <span className="text-sm font-medium">{monthTitle(anchor.year, anchor.month)}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label="下一月"
              onClick={() => setAnchor((prev) => shiftYearMonth(prev, 1))}
            >
              ›
            </Button>
            <Button size="sm" variant="ghost" onClick={handleToday}>
              今天
            </Button>
          </div>

          <div className="flex items-center gap-3">
            {monthSchedules.length > 0 && (
              <span className="text-xs text-muted-foreground">
                完成 {Math.round(rate * 100)}%
                {overdue.length > 0 && (
                  <span className="text-destructive"> · 逾期 {overdue.length}</span>
                )}
              </span>
            )}
            <Button size="sm" variant="outline" onClick={() => void handleCreate()}>
              新建
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-7 border-b text-center text-xs text-muted-foreground">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="py-1.5">
              {label}
            </div>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
          {cells.map((date, index) => (
            <DayCell
              key={date ?? `blank-${index}`}
              date={date}
              schedules={date ? (byDate.get(date) ?? []) : []}
              selected={date != null && date === selectedDate}
              today={date === todayKey}
              nowISO={nowISO}
              onSelect={setSelectedDate}
            />
          ))}
        </div>
      </section>

      <aside className="flex w-80 shrink-0 flex-col border-l">
        <div className="border-b px-3 py-3">
          <span className="text-sm font-medium">{selectedDate}</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {selectedSchedules.length} 条日程 · {selectedBlocks.length} 个时间块
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {/*
            空态针对「整个库一条日程都没有」，与「这一天没有安排」分开判断：
            当天只有时间块、没有日程时，时间块仍然要看得见 ——
            所以时间块区必须挂在空态分支之外。
          */}
          {isEmpty && (
            <div className="py-6">
              <p className="text-sm text-muted-foreground">还没有日程，点「新建」开始。</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => void handleCreate()}
              >
                新建日程
              </Button>
            </div>
          )}

          {!isEmpty && selectedSchedules.length === 0 && (
            <p className="text-sm text-muted-foreground">这一天还没有安排。</p>
          )}

          {!isEmpty && selectedSchedules.length > 0 && (
            <ul className="flex flex-col gap-2">
              {selectedSchedules.map((schedule) => (
                <ScheduleDetailRow
                  key={schedule.id}
                  schedule={schedule}
                  nowISO={nowISO}
                  onComplete={() => void completeSchedule(schedule.id)}
                  onReopen={() => void updateSchedule(schedule.id, { completed_at: null })}
                  onDelete={() => void deleteSchedule(schedule.id)}
                />
              ))}
            </ul>
          )}

          {selectedBlocks.length > 0 && (
            <>
              <div className="mt-4 text-xs font-medium uppercase text-muted-foreground">
                时间块
              </div>
              {/* 时段重叠不做特殊布局 —— 按开始时间纵向罗列，先能看见再谈排版 */}
                  <ul className="mt-2 flex flex-col gap-1">
                    {selectedBlocks.map((block) => (
                      <TimeBlockRow key={block.id} block={block} />
                    ))}
                  </ul>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

const BLOCK_TYPE_LABEL: Record<string, string> = {
  work: '专注',
  short_break: '短休息',
  long_break: '长休息',
}

function ScheduleDetailRow({
  schedule,
  nowISO,
  onComplete,
  onReopen,
  onDelete,
}: {
  schedule: Schedule
  nowISO: string
  onComplete: () => void
  onReopen: () => void
  onDelete: () => void
}) {
  const overdue = isOverdue(schedule, nowISO)

  return (
    <li className="rounded-lg border p-2">
      <div className="flex items-start gap-2">
        <span
          className="mt-1 h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: schedule.color || 'currentColor' }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <span
            className={
              schedule.completed_at != null
                ? 'block truncate text-sm text-muted-foreground line-through'
                : 'block truncate text-sm font-medium'
            }
          >
            {schedule.title || '(未命名)'}
          </span>
          <span className="block text-xs text-muted-foreground">
            {timeLabelOf(schedule.due_at) || '全天'}
            {overdue && <span className="text-destructive"> · 逾期</span>}
          </span>
        </div>
      </div>

      <div className="mt-2 flex gap-2 pl-4">
        {schedule.completed_at == null ? (
          <Button size="xs" variant="outline" onClick={onComplete}>
            完成
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={onReopen}>
            撤销完成
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={onDelete}>
          删除
        </Button>
      </div>
    </li>
  )
}

/**
 * 时间块行。除了时段与标题，还把「计划 vs 实际」摆出来 ——
 *
 * TimeBlock 早就有 planned_duration / actual_duration 双字段，但之前只渲染了
 * 时段，等于数据有了、呈现没跟上。番茄钟的意义正在于「计划与现实的落差」，
 * 不展示这个偏差，时间块就退化成了一个普通的日程条目。
 */
function TimeBlockRow({ block }: { block: TimeBlock }) {
  const delta = durationDelta(block)
  const skipped = block.status === 'skipped'

  return (
    <li className="rounded border px-2 py-1 text-xs">
      <div>
        <span className="text-muted-foreground">
          {block.start_time}–{block.end_time}
        </span>{' '}
        <span>{block.title || '(未命名)'}</span>{' '}
        <span className="text-muted-foreground">
          {BLOCK_TYPE_LABEL[block.block_type]}
        </span>
      </div>

      <div className="mt-0.5 text-muted-foreground">
        {skipped ? (
          <span>已跳过</span>
        ) : (
          <>
            计划 {formatDuration(block.planned_duration)} · 实际{' '}
            {formatDuration(block.actual_duration)}
            {delta !== 0 && (
              // 超出计划用红（要警惕），没做满用琥珀（要留意），都不是「错误」
              <span className={delta > 0 ? 'ml-1 text-destructive' : 'ml-1 text-amber-600'}>
                ({delta > 0 ? '+' : '-'}
                {formatDuration(Math.abs(delta))})
              </span>
            )}
          </>
        )}
      </div>
    </li>
  )
}

function DayCell({
  date,
  schedules,
  selected,
  today,
  nowISO,
  onSelect,
}: {
  date: string | null
  schedules: Schedule[]
  selected: boolean
  today: boolean
  nowISO: string
  onSelect: (date: string) => void
}) {
  if (date == null) {
    return <div className="border-b border-r bg-muted/20" aria-hidden />
  }

  const visible = schedules.slice(0, MAX_VISIBLE_PER_DAY)
  const hidden = schedules.length - visible.length

  return (
    <div
      data-date={date}
      className={
        selected
          ? 'min-h-[6rem] border-b border-r bg-muted p-1'
          : 'min-h-[6rem] border-b border-r p-1'
      }
    >
      <button
        type="button"
        onClick={() => onSelect(date)}
        aria-label={`选择 ${date}`}
        className={
          today
            ? 'flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground'
            : 'flex h-5 w-5 items-center justify-center rounded-full text-xs text-muted-foreground hover:bg-muted'
        }
      >
        {Number(date.slice(8, 10))}
      </button>

      <ul className="mt-0.5 flex flex-col gap-0.5">
        {visible.map((schedule) => (
          <li key={schedule.id}>
            {/* 点格子里的日程 = 选中那一天（完成/删除在右侧详情里操作，
                避免日历上的误点直接改数据） */}
            <button
              type="button"
              onClick={() => onSelect(date)}
              title={schedule.title}
              className="flex w-full items-center gap-1 rounded px-1 text-left hover:bg-muted"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: schedule.color || 'currentColor' }}
                aria-hidden
              />
              <span
                className={
                  schedule.completed_at != null
                    ? 'truncate text-xs text-muted-foreground line-through'
                    : isOverdue(schedule, nowISO)
                      ? 'truncate text-xs font-medium text-destructive'
                      : 'truncate text-xs'
                }
              >
                {schedule.title || '(未命名)'}
              </span>
              {isOverdue(schedule, nowISO) && (
                <span className="sr-only">逾期</span>
              )}
            </button>
          </li>
        ))}

        {hidden > 0 && (
          <li className="px-1 text-xs text-muted-foreground">+{hidden}</li>
        )}
      </ul>
    </div>
  )
}
