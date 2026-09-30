'use client'

/**
 * 「继续上次」三栏快捷入口（准备态）—— iOS 分组列表语汇。
 *
 * 三栏（用户 2026-09-30 确认）：最近打开 / 昨日未完成 / 七天内堆积，**并排成三栏**；
 * 每栏是"层名 + 计数 + 排序口径 + 列表卡"，同一工作项只出现在最贴近的一栏。
 *
 * 空层**整层隐藏**（不显示空标题）；三栏全空时由调用方渲染退化文案。
 *
 * 职责边界：本组件只负责展示与选择回调；分桶逻辑在
 * `lib/task-space/continue-previous.ts`（纯函数，已单测），时间格式化由调用方注入
 * （复用页面既有的本地化口径，避免两处各写一套）。
 */
import { createElement, type ReactNode } from 'react'

export interface ContinuePreviousItem {
  workItemId: string
  displayKey: string
  title: string
  /** 最近一次会话开始时间（ISO） */
  lastSessionAt: string
  sessionCount: number
  priority?: string | null
}

export interface ContinuePreviousProps {
  buckets: {
    today: ContinuePreviousItem[]
    yesterday: ContinuePreviousItem[]
    withinWeek: ContinuePreviousItem[]
  }
  selectedWorkItemId: string | null
  onSelect: (workItemId: string) => void
  /** 时间显示（注入，复用页面口径） */
  formatSessionTime: (iso: string) => string
}

const PRIORITY_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  mid: '中',
  low: '低',
}

interface BucketProps {
  title: string
  sortLabel: string
  items: ContinuePreviousItem[]
  selectedWorkItemId: string | null
  onSelect: (workItemId: string) => void
  formatSessionTime: (iso: string) => string
  /** 是否显示优先级标签（七天内堆积按优先级排布） */
  showPriority?: boolean
  testId: string
}

function bucket(props: BucketProps): ReactNode {
  const { title, sortLabel, items, selectedWorkItemId, onSelect, formatSessionTime } = props
  // 空层整层隐藏 —— 不留空标题
  if (items.length === 0) return null

  return createElement('section', { className: 'flex min-w-0 flex-col gap-2', 'data-testid': props.testId },
    createElement('div', { className: 'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1' },
      createElement('span', { className: 'text-[12.5px] font-medium' }, title),
      createElement('span', {
        className: 'rounded-full px-1.5 text-[10.5px] tabular-nums',
        style: { background: 'var(--ios-fill)', color: 'var(--ios-label-2)' },
      }, String(items.length)),
      createElement('span', {
        className: 'ml-auto text-[10.5px]',
        style: { color: 'var(--ios-label-3)' },
      }, sortLabel),
    ),
    createElement('div', { className: 'ios-card' },
      ...items.map((item) => createElement('button', {
        key: item.workItemId,
        type: 'button',
        className: 'ios-row w-full text-left',
        'data-tappable': 'true',
        'data-selected': selectedWorkItemId === item.workItemId ? 'true' : 'false',
        onClick: () => onSelect(item.workItemId),
      },
      createElement('span', { className: 'ios-radio' }),
      createElement('span', { className: 'min-w-0 flex-1' },
        createElement('span', { className: 'block truncate text-[13.5px]' }, item.title),
        createElement('span', {
          className: 'mt-0.5 flex items-center gap-1.5 text-[11px]',
          style: { color: 'var(--ios-label-2)' },
        },
        props.showPriority && item.priority
          ? createElement('span', {
              className: 'ios-prio',
              'data-level': (PRIORITY_LABEL[item.priority] ?? '') === '高'
                ? 'high'
                : (PRIORITY_LABEL[item.priority] ?? '') === '中' ? 'mid' : 'low',
            }, PRIORITY_LABEL[item.priority])
          : null,
        `${formatSessionTime(item.lastSessionAt)} · ${item.sessionCount} 次`,
        ),
      ),
      )),
    ),
  )
}

export function ContinuePrevious(props: ContinuePreviousProps): ReactNode {
  const { buckets, selectedWorkItemId, onSelect, formatSessionTime } = props
  const total = buckets.today.length + buckets.yesterday.length + buckets.withinWeek.length
  if (total === 0) return null

  return createElement('div', {
    // 三栏并排；窄容器自动折行（每栏最小 216px）
    className: 'grid gap-x-4 gap-y-5',
    style: { gridTemplateColumns: 'repeat(auto-fit, minmax(216px, 1fr))' },
    'data-testid': 'continue-previous',
  },
  bucket({
    title: '最近打开',
    sortLabel: '按最近会话时间',
    items: buckets.today,
    selectedWorkItemId,
    onSelect,
    formatSessionTime,
    testId: 'bucket-today',
  }),
  bucket({
    title: '昨日未完成',
    sortLabel: '按最近会话时间',
    items: buckets.yesterday,
    selectedWorkItemId,
    onSelect,
    formatSessionTime,
    testId: 'bucket-yesterday',
  }),
  bucket({
    title: '七天内堆积',
    sortLabel: '按优先级排布',
    items: buckets.withinWeek,
    selectedWorkItemId,
    onSelect,
    formatSessionTime,
    showPriority: true,
    testId: 'bucket-week',
  }),
  )
}
