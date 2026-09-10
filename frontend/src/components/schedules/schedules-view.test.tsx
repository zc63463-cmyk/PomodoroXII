import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as scheduleRepository from '@/lib/schedules/schedule-repository'
import * as timeBlockRepository from '@/lib/schedules/time-block-repository'
import { useScheduleStore } from '@/stores/schedule-store'
import { useTimeBlockStore } from '@/stores/time-block-store'
import type { CachedSchedule, SyncedTimeBlock } from '@/types'
import {
  buildMonthGrid,
  daysInMonth,
  durationDelta,
  formatDuration,
  localDateTimeToISO,
  monthRange,
  monthTitle,
  SchedulesView,
} from './schedules-view'

/**
 * 固定系统时间：月视图的格子数、逾期判定都依赖「现在」。
 * 用真实时间会让这些断言随运行日期漂移。
 * TZ=UTC（vitest.setup.ts），故本地日期键即 2026-09-15。
 * shouldAdvanceTime 让 waitFor 的轮询照常推进，不会卡死。
 */
const NOW_ISO = '2026-09-15T10:00:00.000Z'
const TODAY = '2026-09-15'

function schedule(overrides: Partial<CachedSchedule> = {}): CachedSchedule {
  const now = '2026-09-01T00:00:00.000Z'
  return {
    id: 's1',
    title: '交房租',
    due_at: '2026-09-15T09:00:00.000Z',
    completed_at: null,
    priority: 'medium',
    color: '#ef4444',
    all_day: false,
    start_time: null,
    end_time: null,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
    ...overrides,
  }
}

function timeBlock(overrides: Partial<SyncedTimeBlock> = {}): SyncedTimeBlock {
  const now = '2026-09-01T00:00:00.000Z'
  return {
    id: 'b1',
    title: '深度工作',
    date: TODAY,
    start_time: '09:00',
    end_time: '10:00',
    planned_duration: 3600,
    actual_duration: 0,
    block_type: 'work',
    status: 'planned',
    sort_order: 0,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
    ...overrides,
  }
}

describe('SchedulesView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(NOW_ISO) })
    useScheduleStore.getState().reset()
    useTimeBlockStore.getState().reset()
    vi.restoreAllMocks()

    vi.spyOn(scheduleRepository, 'listSyncedSchedules').mockResolvedValue([])
    vi.spyOn(timeBlockRepository, 'listSyncedTimeBlocks').mockResolvedValue([])
    vi.spyOn(scheduleRepository, 'createSchedule').mockImplementation(
      async (input) =>
        schedule({
          id: input.id,
          title: input.title ?? '',
          due_at: input.due_at,
        }) as CachedSchedule,
    )
    // 这两个仓储函数返回的是更新后的实体，不是 void
    vi.spyOn(scheduleRepository, 'updateSchedule').mockResolvedValue(schedule())
    vi.spyOn(scheduleRepository, 'completeSchedule').mockResolvedValue(schedule())
    vi.spyOn(scheduleRepository, 'deleteSchedule').mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('空列表时给出引导文案与新建入口', async () => {
    render(<SchedulesView />)

    await waitFor(() => {
      expect(screen.getByText(/还没有日程/)).toBeTruthy()
    })
    expect(screen.getByText('新建日程')).toBeTruthy()
  })

  it('渲染当月标题与当月天数个日期格', async () => {
    const { container } = render(<SchedulesView />)

    await waitFor(() => {
      expect(screen.getByText(monthTitle(2026, 9))).toBeTruthy()
    })

    const cells = container.querySelectorAll('[data-date]')
    expect(cells.length).toBe(30)
    expect(cells[0]?.getAttribute('data-date')).toBe('2026-09-01')
  })

  it('点击某天把右侧详情切到该日期', async () => {
    render(<SchedulesView />)
    await waitFor(() => expect(screen.getByText(TODAY)).toBeTruthy())

    // 选一个不是今天的日子，否则「已选中」与初始态无法区分
    fireEvent.click(screen.getByLabelText('选择 2026-09-20'))

    await waitFor(() => {
      expect(screen.getByText('2026-09-20')).toBeTruthy()
    })
  })

  it('点击格子里的日程会选中它所在的那天', async () => {
    vi.spyOn(scheduleRepository, 'listSyncedSchedules').mockResolvedValue([
      schedule({
        id: 's7',
        title: '牙医复诊',
        due_at: localDateTimeToISO('2026-09-20', '14:30'),
      }),
    ])

    const { container } = render(<SchedulesView />)
    await waitFor(() => expect(screen.getByTitle('牙医复诊')).toBeTruthy())

    const cell = container.querySelector('[data-date="2026-09-20"]') as HTMLElement
    fireEvent.click(within(cell).getByText('牙医复诊'))

    await waitFor(() => {
      expect(screen.getByText('2026-09-20')).toBeTruthy()
    })
  })

  it('逾期日程有醒目标记，未到期的没有', async () => {
    vi.spyOn(scheduleRepository, 'listSyncedSchedules').mockResolvedValue([
      schedule({ id: 's1', title: '交房租', due_at: '2026-09-10T09:00:00.000Z' }), // 已过截止
      schedule({ id: 's2', title: '体检', due_at: '2026-09-20T09:00:00.000Z' }), // 未到期
    ])

    render(<SchedulesView />)
    await waitFor(() => expect(screen.getByTitle('交房租')).toBeTruthy())

    expect(
      screen.getByTitle('交房租').querySelector('span[class*="text-destructive"]'),
    ).toBeTruthy()
    expect(
      screen.getByTitle('体检').querySelector('span[class*="text-destructive"]'),
    ).toBeNull()
  })

  it('详情里点「完成」调用 completeSchedule(id)', async () => {
    const complete = vi.spyOn(scheduleRepository, 'completeSchedule')
    vi.spyOn(scheduleRepository, 'listSyncedSchedules').mockResolvedValue([
      schedule({ id: 's9', title: '写周报', due_at: '2026-09-15T09:00:00.000Z' }),
    ])

    render(<SchedulesView />)
    const aside = screen.getByRole('complementary')
    await waitFor(() => expect(within(aside).getByText('写周报')).toBeTruthy())

    fireEvent.click(within(aside).getByText('完成'))

    await waitFor(() => {
      expect(complete).toHaveBeenCalledWith('s9')
    })
  })

  it('选中日的时间块按开始时间纵向罗列', async () => {
    vi.spyOn(timeBlockRepository, 'listSyncedTimeBlocks').mockResolvedValue([
      timeBlock({ id: 'b2', title: '晚间复盘', start_time: '20:00', end_time: '21:00' }),
      timeBlock({ id: 'b1', title: '深度工作', start_time: '09:00', end_time: '10:00' }),
    ])

    render(<SchedulesView />)

    await waitFor(() => expect(screen.getByText('时间块')).toBeTruthy())
    const items = screen.getAllByText(/09:00–10:00|20:00–21:00/)
    expect(items[0]?.textContent).toContain('09:00–10:00')
    expect(items[1]?.textContent).toContain('20:00–21:00')
  })

  it('时间块展示「计划 vs 实际」与偏差', async () => {
    vi.spyOn(timeBlockRepository, 'listSyncedTimeBlocks').mockResolvedValue([
      timeBlock({
        id: 'b1',
        title: '深度工作',
        start_time: '09:00',
        end_time: '10:00',
        planned_duration: 3600, // 1 小时
        actual_duration: 2700, // 45 分钟 → 少 15 分钟
      }),
    ])

    render(<SchedulesView />)

    await waitFor(() => expect(screen.getByText('时间块')).toBeTruthy())
    expect(screen.getByText(/计划 1 小时 · 实际 45 分钟/)).toBeTruthy()
    expect(screen.getByText(/\(-15 分钟\)/)).toBeTruthy()
  })

  it('时间块超出计划时偏差为正，跳过时不显示偏差', async () => {
    vi.spyOn(timeBlockRepository, 'listSyncedTimeBlocks').mockResolvedValue([
      timeBlock({
        id: 'b1',
        title: '深度工作',
        planned_duration: 3600,
        actual_duration: 4200, // 超出 10 分钟
      }),
      timeBlock({
        id: 'b2',
        title: '午间散步',
        start_time: '12:00',
        end_time: '12:30',
        status: 'skipped',
        planned_duration: 1800,
        actual_duration: 0,
      }),
    ])

    render(<SchedulesView />)

    await waitFor(() => expect(screen.getByText('时间块')).toBeTruthy())
    expect(screen.getByText(/\(\+10 分钟\)/)).toBeTruthy()
    // 跳过的时间块显示「已跳过」，且不出现 −30 分钟这种误导性偏差
    expect(screen.getByText('已跳过')).toBeTruthy()
    expect(screen.queryByText(/\(-30 分钟\)/)).toBeNull()
  })

  it('切到下一月会重新加载（换一次范围）', async () => {
    const list = vi.spyOn(scheduleRepository, 'listSyncedSchedules')

    render(<SchedulesView />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    const callsBefore = list.mock.calls.length

    fireEvent.click(screen.getByLabelText('下一月'))

    await waitFor(() => {
      expect(list.mock.calls.length).toBe(callsBefore + 1)
    })
  })
})

describe('月视图纯函数', () => {
  it('buildMonthGrid 补前后空白并对齐整周', () => {
    const cells = buildMonthGrid(2026, 9)

    expect(cells.length % 7).toBe(0)
    expect(cells.filter((cell) => cell != null).length).toBe(30)
    expect(cells[0]).toBeNull() // 2026-09-01 是周二 → 前导 1 格补白
    expect(cells[1]).toBe('2026-09-01')
    expect(cells.at(-1)).toBeNull()
  })

  it('monthRange 返回当月首尾日期', () => {
    expect(monthRange(2026, 9)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('daysInMonth 闰年二月为 29 天', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 2)).toBe(28)
  })

  it('localDateTimeToISO 按本地时区解析，不是拼 Z', () => {
    // TZ=UTC（vitest.setup），故本地 09:00 就是 09:00Z。
    // 若实现写成 `${date}T${time}Z` 这里会碰巧通过，故再用非零时区语义断言一次：
    expect(localDateTimeToISO('2026-09-15', '09:00')).toBe('2026-09-15T09:00:00.000Z')
    expect(localDateTimeToISO('2026-09-15', '23:30')).toBe('2026-09-15T23:30:00.000Z')
  })

  it('formatDuration 只到分钟', () => {
    expect(formatDuration(0)).toBe('0 分钟')
    expect(formatDuration(-5)).toBe('0 分钟')
    expect(formatDuration(60)).toBe('1 分钟')
    expect(formatDuration(3600)).toBe('1 小时')
    expect(formatDuration(5400)).toBe('1 小时 30 分钟')
    expect(formatDuration(90)).toBe('2 分钟') // 四舍五入
  })

  it('durationDelta 正数=超出计划，负数=没做满', () => {
    expect(durationDelta(timeBlock({ planned_duration: 3600, actual_duration: 4200 }))).toBe(600)
    expect(durationDelta(timeBlock({ planned_duration: 3600, actual_duration: 2700 }))).toBe(-900)
  })

  it('★ 跳过的时间块不计偏差 —— 它不是「做了 0 秒」', () => {
    // 若按 actual - planned 算，会得到 -3600 这种误导性的巨额负值
    const skipped = timeBlock({
      status: 'skipped',
      planned_duration: 3600,
      actual_duration: 0,
    })
    expect(durationDelta(skipped)).toBe(0)
  })
})
