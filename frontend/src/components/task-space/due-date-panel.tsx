'use client'

import { createElement } from 'react'
import type { CachedWorkItem } from '@/types'
import type { DueDateBuckets } from '@/lib/task-space/due-date-selectors'

/**
 * 日期视图面板（工单③·space_018）：把 due_at 变成用户**看得见**的东西。
 *
 * 口径（lib/task-space/due-date-selectors，单测钉死）：
 *   - 今日到期：due_at == 本地今天，且工作项未完成/未取消/未归档；
 *   - 逾期：due_at < 本地今天，同上 —— **红色高亮**（有了日期维度才可能做）。
 *
 * 展示字段刻意极简（displayKey + 标题 + 到期日）：这是催办清单，不是树。
 * 点击一行 = 选中该工作项（复用页面现有的选中链路，详情在右侧打开）。
 */

export interface DueDatePanelProps {
  buckets: DueDateBuckets
  selectedWorkItemId: string | null
  onSelect: (workItemId: string) => void
}

function DueRow(props: {
  row: CachedWorkItem
  overdue: boolean
  selected: boolean
  onSelect: (workItemId: string) => void
}) {
  const { row, overdue, selected, onSelect } = props
  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => onSelect(row.id),
      'aria-current': selected || undefined,
      className: [
        'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        overdue
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-border',
        selected ? 'ring-1 ring-ring' : '',
      ].join(' '),
    },
    createElement(
      'span',
      { className: 'shrink-0 font-mono text-xs text-muted-foreground' },
      row.displayKey,
    ),
    createElement('span', { className: 'truncate' }, row.title),
    createElement(
      'span',
      { className: 'ml-auto shrink-0 text-xs tabular-nums' },
      overdue ? `逾期 ${row.dueAt}` : `今天 ${row.dueAt}`,
    ),
  )
}

export function DueDatePanel({ buckets, selectedWorkItemId, onSelect }: DueDatePanelProps) {
  const empty = buckets.today.length === 0 && buckets.overdue.length === 0
  return createElement(
    'section',
    { 'aria-label': 'Due dates', className: 'grid gap-3' },
    // 逾期永远在今日之上 —— 催办的优先级高于提醒。
    createElement(
      'div',
      { className: 'grid gap-1.5' },
      createElement(
        'h2',
        { className: 'flex items-center gap-2 text-sm font-medium' },
        '逾期',
        createElement(
          'span',
          { className: 'rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive tabular-nums' },
          String(buckets.overdue.length),
        ),
      ),
      buckets.overdue.length === 0
        ? createElement('p', { className: 'text-xs text-muted-foreground' }, '没有逾期项')
        : buckets.overdue.map((row) => createElement(DueRow, {
            key: row.id, row, overdue: true,
            selected: row.id === selectedWorkItemId, onSelect,
          })),
    ),
    createElement(
      'div',
      { className: 'grid gap-1.5' },
      createElement(
        'h2',
        { className: 'flex items-center gap-2 text-sm font-medium' },
        '今日到期',
        createElement(
          'span',
          { className: 'rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums' },
          String(buckets.today.length),
        ),
      ),
      buckets.today.length === 0
        ? createElement('p', { className: 'text-xs text-muted-foreground' }, '今天没有到期项')
        : buckets.today.map((row) => createElement(DueRow, {
            key: row.id, row, overdue: false,
            selected: row.id === selectedWorkItemId, onSelect,
          })),
    ),
    empty
      ? createElement(
          'p',
          { className: 'text-xs text-muted-foreground' },
          '给工作项设置截止日期后，今日/逾期会出现在这里',
        )
      : null,
  )
}
