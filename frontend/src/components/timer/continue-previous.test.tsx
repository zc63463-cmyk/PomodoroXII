import { createElement } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ContinuePrevious, type ContinuePreviousItem } from './continue-previous'

/**
 * 三栏快捷入口的**展示层**用例（分桶逻辑在 lib/task-space/continue-previous.test.ts）。
 *
 * 这一组用例锁的是 2026-09-30 用户两次反馈的问题面：
 * 「你的三列布局在哪？」—— 旧实现只在有数据时才挂载组件，本机账号近 7 天零会话
 * 导致**一栏都不渲染**。现在的契约是：三列**恒显**，空层在卡内显示「暂无」占位。
 */

const empty = { today: [], yesterday: [], withinWeek: [] }

const item = (over: Partial<ContinuePreviousItem> & { workItemId: string }): ContinuePreviousItem => ({
  displayKey: 'P-1',
  title: 'Ship feature',
  lastSessionAt: '2026-09-30T01:12:00.000Z',
  sessionCount: 1,
  ...over,
})

const format = (): string => '今日 09:12'

describe('ContinuePrevious 三栏布局', () => {
  it('★ 空桶也渲染三列（含层名/计数/排序口径），空层显示「暂无」占位', () => {
    render(createElement(ContinuePrevious, {
      buckets: empty, selectedWorkItemId: null, onSelect: vi.fn(), formatSessionTime: format,
    }))

    expect(screen.getByTestId('continue-previous')).toBeInTheDocument()
    for (const [testId, name] of [
      ['bucket-today', '最近打开'],
      ['bucket-yesterday', '昨日未完成'],
      ['bucket-week', '七天内堆积'],
    ] as const) {
      const layer = screen.getByTestId(testId)
      expect(layer).toHaveTextContent(name)
      expect(layer).toHaveTextContent('0')
      expect(layer).toHaveTextContent('暂无')
    }
    // 排序口径必须跟着层标题一起出现（设计稿 .gh .sort）
    expect(screen.getByTestId('bucket-week')).toHaveTextContent('按优先级排布')
    expect(screen.getByTestId('bucket-today')).toHaveTextContent('按最近会话时间')
  })

  it('三列是并排的固定三列网格（设计稿 .groups: repeat(3, minmax(0,1fr))）', () => {
    render(createElement(ContinuePrevious, {
      buckets: empty, selectedWorkItemId: null, onSelect: vi.fn(), formatSessionTime: format,
    }))

    expect(screen.getByTestId('continue-previous').className).toContain('ios-groups')
  })

  it('有数据时渲染两行行（标题 + 时间·次数）并带单选圈', () => {
    render(createElement(ContinuePrevious, {
      buckets: { ...empty, today: [item({ workItemId: 'w1', title: '探索小窗实现方式', sessionCount: 3 })] },
      selectedWorkItemId: null,
      onSelect: vi.fn(),
      formatSessionTime: format,
    }))

    const row = screen.getByRole('button', { name: /探索小窗实现方式/ })
    expect(row).toHaveTextContent('今日 09:12 · 3 次')
    expect(row.querySelector('.ios-radio')).not.toBeNull()
    expect(row.querySelector('.ios-radio')?.getAttribute('data-size')).toBe('sm')
    // 本层有数据 → 不再出现占位（其余两层仍各有「暂无」，故按层内断言）
    expect(within(screen.getByTestId('bucket-today')).queryByText('暂无')).toBeNull()
  })

  it('点行回调工作项 id；选中行标 data-selected（单选圈填充由样式承担）', () => {
    const onSelect = vi.fn()
    render(createElement(ContinuePrevious, {
      buckets: { ...empty, today: [item({ workItemId: 'w1', title: 'A' }), item({ workItemId: 'w2', title: 'B' })] },
      selectedWorkItemId: 'w2',
      onSelect,
      formatSessionTime: format,
    }))

    const rows = screen.getAllByRole('button')
    expect(rows[0]?.getAttribute('data-selected')).toBe('false')
    expect(rows[1]?.getAttribute('data-selected')).toBe('true')

    fireEvent.click(rows[1]!)
    expect(onSelect).toHaveBeenCalledWith('w2')
  })

  it('「七天内堆积」按优先级显示中文标签，今日/昨日不显示', () => {
    render(createElement(ContinuePrevious, {
      buckets: {
        today: [item({ workItemId: 'w1', title: '今日项', priority: 'high' })],
        yesterday: [],
        withinWeek: [
          item({ workItemId: 'w2', title: '高优先', priority: 'high' }),
          item({ workItemId: 'w3', title: '中优先', priority: 'medium' }),
        ],
      },
      selectedWorkItemId: null,
      onSelect: vi.fn(),
      formatSessionTime: format,
    }))

    const week = screen.getByTestId('bucket-week')
    expect(week.querySelectorAll('.ios-prio').length).toBe(2)
    expect(week).toHaveTextContent('高')
    expect(week).toHaveTextContent('中')

    // 今日栏：即便工作项带 priority 也不显示优先级标签（该层按时间排）
    expect(screen.getByTestId('bucket-today').querySelectorAll('.ios-prio').length).toBe(0)
  })

  it('计数胶囊等于该层条目数（不是全局总数）', () => {
    render(createElement(ContinuePrevious, {
      buckets: {
        today: [item({ workItemId: 'w1', title: 'A' }), item({ workItemId: 'w2', title: 'B' })],
        yesterday: [item({ workItemId: 'w3', title: 'C' })],
        withinWeek: [],
      },
      selectedWorkItemId: null,
      onSelect: vi.fn(),
      formatSessionTime: format,
    }))

    expect(screen.getByTestId('bucket-today').querySelector('.cnt')?.textContent).toBe('2')
    expect(screen.getByTestId('bucket-yesterday').querySelector('.cnt')?.textContent).toBe('1')
    expect(screen.getByTestId('bucket-week').querySelector('.cnt')?.textContent).toBe('0')
  })
})
