'use client'

import { createElement, useMemo, useState, type ReactNode } from 'react'
import {
  buildQuickNoteTagTree,
  getQuickNoteActivityData,
  getQuickNoteTagStats,
  type QuickNoteActivityData,
  type QuickNoteTagStat,
  type QuickNoteTagTreeNode,
} from '@/lib/quick-notes/quick-note-selectors'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { cn } from '@/lib/utils'
import type { QuickNote } from '@/types'
import type { QuickNoteTagFilterMode } from '@/stores/quick-note-store'

type TagViewMode = 'cloud' | 'tree'

interface QuickNoteExplorerProps {
  notes: QuickNote[]
  selectedTagFilters: string[]
  tagFilterMode: QuickNoteTagFilterMode
  selectedDate: string | null
  topSlot?: ReactNode
  onToggleTag: (tag: string) => void
  onClearTags: () => void
  onSetTagFilterMode: (mode: QuickNoteTagFilterMode) => void
  onToggleDate: (date: string) => void
  onClearDate: () => void
}

export function QuickNoteExplorer({
  notes,
  selectedTagFilters,
  tagFilterMode,
  selectedDate,
  topSlot,
  onToggleTag,
  onClearTags,
  onSetTagFilterMode,
  onToggleDate,
  onClearDate,
}: QuickNoteExplorerProps) {
  const [tagViewMode, setTagViewMode] = useState<TagViewMode>('cloud')
  const [currentMonth, setCurrentMonth] = useState(() => {
    if (selectedDate) return selectedDate.slice(0, 7)
    return toLocalMonthKey(new Date())
  })
  const tagStats = useMemo(() => getQuickNoteTagStats(notes), [notes])
  const tagTree = useMemo(() => buildQuickNoteTagTree(tagStats), [tagStats])
  const activityData = useMemo(() => getQuickNoteActivityData(notes), [notes])
  const selectedTags = useMemo(
    () => new Set(selectedTagFilters.map((tag) => tag.toLowerCase())),
    [selectedTagFilters],
  )

  return createElement(
    'aside',
    { className: quickNoteStyles.explorer, 'aria-label': '小记探索' },
    topSlot ?? null,
    createElement(
      'section',
      { className: quickNoteStyles.explorerPanel },
      createElement(ExplorerHeader, {
        title: '活动日历',
        action: selectedDate
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: onClearDate,
                className: quickNoteStyles.explorerTextButton,
                'aria-label': '清除日期筛选',
              },
              '清除',
            )
          : null,
      }),
      createElement(ActivityCalendar, {
        activityData,
        currentMonth,
        selectedDate,
        onMonthChange: setCurrentMonth,
        onToggleDate,
      }),
    ),
    createElement(
      'section',
      { className: quickNoteStyles.explorerPanel },
      createElement(ExplorerHeader, {
        title: '标签',
        action: selectedTagFilters.length > 0
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: onClearTags,
                className: quickNoteStyles.explorerTextButton,
                'aria-label': '清除标签筛选',
              },
              '清除',
            )
          : null,
      }),
      createElement(
        'div',
        { className: quickNoteStyles.explorerSegment },
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => onSetTagFilterMode('single'),
            'aria-pressed': tagFilterMode === 'single',
            'aria-label': '切换为单选标签过滤',
            className: cn(
              quickNoteStyles.explorerSegmentButton,
              tagFilterMode === 'single' ? quickNoteStyles.explorerSegmentButtonActive : null,
            ),
          },
          '单选',
        ),
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => onSetTagFilterMode('multi'),
            'aria-pressed': tagFilterMode === 'multi',
            'aria-label': '切换为多选标签过滤',
            className: cn(
              quickNoteStyles.explorerSegmentButton,
              tagFilterMode === 'multi' ? quickNoteStyles.explorerSegmentButtonActive : null,
            ),
          },
          '多选',
        ),
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => setTagViewMode('cloud'),
            'aria-pressed': tagViewMode === 'cloud',
            'aria-label': '标签云视图',
            className: cn(
              quickNoteStyles.explorerSegmentButton,
              tagViewMode === 'cloud' ? quickNoteStyles.explorerSegmentButtonActive : null,
            ),
          },
          '云',
        ),
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => setTagViewMode('tree'),
            'aria-pressed': tagViewMode === 'tree',
            'aria-label': '标签树视图',
            className: cn(
              quickNoteStyles.explorerSegmentButton,
              tagViewMode === 'tree' ? quickNoteStyles.explorerSegmentButtonActive : null,
            ),
          },
          '树',
        ),
      ),
      tagStats.length === 0
        ? createElement(
            'p',
            { className: quickNoteStyles.explorerEmpty },
            '还没有标签，写下 #灵感 试试。',
          )
        : tagViewMode === 'cloud'
          ? createElement(TagCloud, {
              tagStats,
              selectedTags,
              onToggleTag,
            })
          : createElement(TagTree, {
              nodes: tagTree,
              selectedTags,
              onToggleTag,
            }),
    ),
  )
}

function ExplorerHeader({ title, action }: { title: string; action?: ReactNode }) {
  return createElement(
    'div',
    { className: quickNoteStyles.explorerHeader },
    createElement('h2', { className: quickNoteStyles.explorerTitle }, title),
    action ?? null,
  )
}

function TagCloud({
  tagStats,
  selectedTags,
  onToggleTag,
}: {
  tagStats: QuickNoteTagStat[]
  selectedTags: Set<string>
  onToggleTag: (tag: string) => void
}) {
  return createElement(
    'div',
    { className: quickNoteStyles.explorerTagCloud },
    ...tagStats.slice(0, 24).map((stat) =>
      createElement(TagButton, {
        key: stat.tag,
        stat,
        selected: selectedTags.has(stat.tag.toLowerCase()),
        onToggleTag,
      }),
    ),
  )
}

function TagTree({
  nodes,
  selectedTags,
  onToggleTag,
}: {
  nodes: QuickNoteTagTreeNode[]
  selectedTags: Set<string>
  onToggleTag: (tag: string) => void
}) {
  return createElement(
    'div',
    { className: quickNoteStyles.explorerTagTree },
    ...nodes.map((node) =>
      createElement(TagTreeNodeView, {
        key: node.path,
        node,
        selectedTags,
        onToggleTag,
      }),
    ),
  )
}

function TagTreeNodeView({
  node,
  selectedTags,
  onToggleTag,
}: {
  node: QuickNoteTagTreeNode
  selectedTags: Set<string>
  onToggleTag: (tag: string) => void
}): ReactNode {
  const ownStat = { tag: node.path, count: node.count }
  return createElement(
    'div',
    { className: quickNoteStyles.explorerTreeNode },
    createElement(
      'div',
      {
        className: quickNoteStyles.explorerTreeRow,
        style: { paddingLeft: `${node.depth * 12}px` },
      },
      node.count > 0
        ? createElement(TagButton, {
            stat: ownStat,
            selected: selectedTags.has(node.path.toLowerCase()),
            onToggleTag,
          })
        : createElement(
            'span',
            { className: quickNoteStyles.explorerTreeLabel },
            node.name,
          ),
      createElement(
        'span',
        { className: quickNoteStyles.explorerTreeCount },
        String(node.totalCount),
      ),
    ),
    ...node.children.map((child) =>
      createElement(TagTreeNodeView, {
        key: child.path,
        node: child,
        selectedTags,
        onToggleTag,
      }),
    ),
  )
}

function TagButton({
  stat,
  selected,
  onToggleTag,
}: {
  stat: QuickNoteTagStat
  selected: boolean
  onToggleTag: (tag: string) => void
}) {
  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => onToggleTag(stat.tag),
      'aria-pressed': selected,
      'aria-label': `筛选标签 #${stat.tag}，${stat.count} 条小记`,
      className: cn(
        quickNoteStyles.explorerTag,
        selected ? quickNoteStyles.explorerTagSelected : null,
      ),
    },
    createElement('span', null, `#${stat.tag}`),
    createElement('span', { className: quickNoteStyles.explorerTagCount }, stat.count),
  )
}

function ActivityCalendar({
  activityData,
  currentMonth,
  selectedDate,
  onMonthChange,
  onToggleDate,
}: {
  activityData: QuickNoteActivityData
  currentMonth: string
  selectedDate: string | null
  onMonthChange: (month: string) => void
  onToggleDate: (date: string) => void
}) {
  const monthCells = useMemo(() => buildMonthCells(currentMonth, activityData), [
    activityData,
    currentMonth,
  ])
  const maxCount = Math.max(1, ...Object.values(activityData))

  return createElement(
    'div',
    { className: quickNoteStyles.explorerCalendar },
    createElement(
      'div',
      { className: quickNoteStyles.explorerCalendarHeader },
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => onMonthChange(shiftMonth(currentMonth, -1)),
          className: quickNoteStyles.explorerCalendarNav,
          'aria-label': '上个月',
        },
        '‹',
      ),
      createElement('span', { className: quickNoteStyles.explorerCalendarLabel }, formatMonth(currentMonth)),
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => onMonthChange(shiftMonth(currentMonth, 1)),
          className: quickNoteStyles.explorerCalendarNav,
          'aria-label': '下个月',
        },
        '›',
      ),
    ),
    createElement(
      'div',
      { className: quickNoteStyles.explorerWeekdays },
      ...['一', '二', '三', '四', '五', '六', '日'].map((day) =>
        createElement('span', { key: day }, day),
      ),
    ),
    createElement(
      'div',
      { className: quickNoteStyles.explorerCalendarGrid },
      ...monthCells.map((cell) =>
        cell.date
          ? createElement(
              'button',
              {
                key: cell.key,
                type: 'button',
                onClick: () => onToggleDate(cell.date!),
                'aria-pressed': selectedDate === cell.date,
                'aria-label': `筛选日期 ${cell.date}，${cell.count > 0 ? `${cell.count} 条小记` : '无小记'}`,
                className: cn(
                  quickNoteStyles.explorerCalendarCell,
                  calendarIntensityClass(cell.count, maxCount),
                  selectedDate === cell.date ? quickNoteStyles.explorerCalendarCellSelected : null,
                ),
              },
              String(cell.day),
            )
          : createElement('span', { key: cell.key, className: quickNoteStyles.explorerCalendarBlank }),
      ),
    ),
  )
}

function buildMonthCells(month: string, data: QuickNoteActivityData) {
  const [year, monthNumber] = month.split('-').map(Number)
  const firstDay = new Date(year, monthNumber - 1, 1)
  const daysInMonth = new Date(year, monthNumber, 0).getDate()
  const mondayOffset = (firstDay.getDay() + 6) % 7
  const cells: Array<{ key: string; date: string | null; day: number; count: number }> = []

  for (let i = 0; i < mondayOffset; i++) {
    cells.push({ key: `blank-${i}`, date: null, day: 0, count: 0 })
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    cells.push({
      key: date,
      date,
      day,
      count: data[date] ?? 0,
    })
  }

  return cells
}

function calendarIntensityClass(count: number, maxCount: number): string {
  if (count <= 0) return quickNoteStyles.explorerCalendarCellEmpty
  const ratio = count / maxCount
  if (ratio > 0.75) return quickNoteStyles.explorerCalendarCellHigh
  if (ratio > 0.5) return quickNoteStyles.explorerCalendarCellMedium
  if (ratio > 0.25) return quickNoteStyles.explorerCalendarCellLow
  return quickNoteStyles.explorerCalendarCellMinimal
}

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number)
  return toLocalMonthKey(new Date(year, monthNumber - 1 + offset, 1))
}

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split('-')
  return `${year} 年 ${Number(monthNumber)} 月`
}

function toLocalMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
