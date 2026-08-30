'use client'

import { createElement, type ReactNode } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'
import { Button } from '@/components/ui/button'

export interface WorkItemTreeProps {
  items: CachedWorkItem[]
  selectedId: string | null
  onSelect: (workItemId: string) => void
  onCreateChild: (parentId: string) => void
  /** Root-item creation entry shown when the project has no work items yet. */
  onCreateRoot?: () => void
  definitions?: TaskSpaceDefinitions | null
  isLoading?: boolean
  error?: string | null
  pendingMutations?: Record<string, boolean>
}

function definitionLabel(
  definitions: TaskSpaceDefinitions | null | undefined,
  group: 'statuses' | 'types',
  id: string,
): string {
  const entry = definitions?.[group].find((candidate) => (
    typeof candidate.id === 'string' && candidate.id === id
  ))
  if (!entry) return id
  for (const key of ['label', 'name', 'title'] as const) {
    if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string
  }
  return id
}

export function WorkItemTree({
  items,
  selectedId,
  onSelect,
  onCreateChild,
  onCreateRoot,
  definitions,
  isLoading = false,
  error = null,
  pendingMutations = {},
}: WorkItemTreeProps) {
  if (isLoading) {
    return createElement(
      'p',
      { className: 'px-2 py-3 text-sm text-muted-foreground' },
      'Loading work items',
    )
  }
  // A refresh error must not hide already-cached rows: the failure state is
  // only shown when there is nothing to render.
  if (error && items.length === 0) {
    return createElement(
      'p',
      { role: 'alert', className: 'px-2 py-3 text-sm text-destructive' },
      error,
    )
  }

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
          createElement(
            'span',
            { className: 'ml-1 shrink-0 text-[10px] text-muted-foreground' },
            [definitionLabel(definitions, 'types', item.typeDefinitionId),
              definitionLabel(definitions, 'statuses', item.statusDefinitionId),
              item.priority ?? ''].filter(Boolean).join(' · '),
          ),
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
                disabled: pendingMutations[item.id] === true,
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
    renderLevel(null, 1) ?? createElement(
      'li',
      { className: 'px-2 py-3' },
      createElement(
        'div',
        { className: 'text-sm text-muted-foreground' },
        'No work items',
      ),
      onCreateRoot
        ? createElement(
            Button,
            {
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              'aria-label': 'Create root work item',
              disabled: pendingMutations.__root__ === true,
              onClick: onCreateRoot,
            },
            createElement(Plus, { 'aria-hidden': true }),
            'Create root work item',
          )
        : null,
    ),
  )
}
