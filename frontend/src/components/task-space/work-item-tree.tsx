'use client'

import { createElement, type ReactNode } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import type { CachedWorkItem } from '@/types'
import { Button } from '@/components/ui/button'

export interface WorkItemTreeProps {
  items: CachedWorkItem[]
  selectedId: string | null
  onSelect: (workItemId: string) => void
  onCreateChild: (parentId: string) => void
}

export function WorkItemTree({ items, selectedId, onSelect, onCreateChild }: WorkItemTreeProps) {
  const children = new Map<string | null, CachedWorkItem[]>()
  for (const item of items) {
    const group = children.get(item.parentId) ?? []
    group.push(item)
    children.set(item.parentId, group)
  }
  for (const group of children.values()) {
    group.sort((left, right) => left.childRank - right.childRank || left.id.localeCompare(right.id))
  }

  const renderLevel = (parentId: string | null, level: 1 | 2 | 3): ReactNode => (
    children.get(parentId)?.map((item) => createElement(
      'li',
      {
        key: item.id,
        role: 'treeitem',
        'aria-label': `${item.displayKey} ${item.title}`,
        'aria-level': level,
        'aria-selected': item.id === selectedId,
        className: 'min-w-0',
      },
      createElement(
        'div',
        { className: 'group flex min-h-9 items-center gap-1 px-2', style: { paddingInlineStart: `${level * 12}px` } },
        createElement(ChevronRight, { className: 'size-3.5 shrink-0 text-muted-foreground', 'aria-hidden': true }),
        createElement(
          'button',
          {
            type: 'button',
            className: 'min-w-0 flex-1 truncate py-1 text-left text-sm',
            'aria-label': `${item.displayKey} ${item.title}`,
            onClick: () => onSelect(item.id),
          },
          createElement('span', { className: 'mr-1 font-mono text-xs text-muted-foreground' }, item.displayKey),
          createElement('span', null, item.title),
        ),
        level < 3
          ? createElement(
              Button,
              {
                type: 'button',
                variant: 'ghost',
                size: 'icon-sm',
                'aria-label': `Create child under ${item.title}`,
                title: `Create child under ${item.title}`,
                onClick: () => onCreateChild(item.id),
              },
              createElement(Plus, { 'aria-hidden': true }),
            )
          : null,
      ),
      level < 3
        ? createElement('ul', { role: 'group' }, renderLevel(item.id, (level + 1) as 2 | 3))
        : null,
    )) ?? null
  )

  return createElement(
    'ul',
    { role: 'tree', 'aria-label': 'Work items', className: 'min-w-0 py-2' },
    renderLevel(null, 1),
  )
}
