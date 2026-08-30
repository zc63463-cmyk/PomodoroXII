'use client'

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react'
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
  /** Parent-driven move: the component validates the drop target first. */
  onMove?: (workItemId: string, newParentId: string | null) => void
  /** Monotonic signal from the page shortcuts: collapse or expand every branch. */
  collapseSignal?: { seq: number; mode: 'collapse' | 'expand' } | null
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
  onMove,
  collapseSignal = null,
}: WorkItemTreeProps) {
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set())
  const draggedIdRef = useRef<string | null>(null)
  const [dropHighlight, setDropHighlight] = useState<string | null>(null)
  const collapseSeq = collapseSignal?.seq ?? 0
  const collapseMode = collapseSignal?.mode ?? null

  useEffect(() => {
    if (collapseSeq === 0 || collapseMode === null) return
    setCollapsedIds(collapseMode === 'collapse' ? new Set(items.map((i) => i.id)) : new Set())
    // Items are re-derived on every parent render; only the monotonic signal
    // may re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseSeq, collapseMode])

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

  const descendantsOf = (rootId: string): Set<string> => {
    const found = new Set<string>()
    const frontier = [rootId]
    while (frontier.length > 0) {
      const id = frontier.pop()!
      for (const child of children.get(id) ?? []) {
        if (!found.has(child.id)) {
          found.add(child.id)
          frontier.push(child.id)
        }
      }
    }
    return found
  }

  const subtreeRelativeDepth = (rootId: string): number => {
    const root = items.find((candidate) => candidate.id === rootId)
    if (!root) return 0
    let maxDepth: number = root.depth
    for (const id of descendantsOf(rootId)) {
      const candidate = items.find((entry) => entry.id === id)
      if (candidate) maxDepth = Math.max(maxDepth, candidate.depth)
    }
    return maxDepth - root.depth
  }

  // Drop-target validation mirrors the backend tree constraints (three
  // levels, no self/descendant parenting).  The backend stays authoritative:
  // an invalid drop that slips through is rejected server-side.
  const canAcceptDrop = (draggedId: string, target: CachedWorkItem | null): boolean => {
    if (!onMove) return false
    if (target === null) {
      // Top level: the moved subtree becomes depth 1..(1+relative).
      return 1 + subtreeRelativeDepth(draggedId) <= 3
    }
    if (target.depth >= 3) return false
    if (target.id === draggedId) return false
    if (descendantsOf(draggedId).has(target.id)) return false
    return target.depth + 1 + subtreeRelativeDepth(draggedId) <= 3
  }

  const handleDragStart = (item: CachedWorkItem) => (event: React.DragEvent) => {
    draggedIdRef.current = item.id
    event.dataTransfer?.setData('text/plain', item.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  const handleDrop = (target: CachedWorkItem | null) => (event: React.DragEvent) => {
    event.preventDefault()
    const draggedId = draggedIdRef.current
    draggedIdRef.current = null
    setDropHighlight(null)
    if (!draggedId || !canAcceptDrop(draggedId, target)) return
    onMove?.(draggedId, target?.id ?? null)
  }

  const renderLevel = (parentId: string | null, level: 1 | 2 | 3): ReactNode => (
    children.get(parentId)?.map((item) => {
      const collapsed = collapsedIds.has(item.id)
      const droppable = onMove !== null && level < 3
      return createElement(
        'li',
        {
          key: item.id,
          role: 'treeitem',
          'aria-label': `${item.displayKey} ${item.title}`,
          'aria-level': level,
          'aria-selected': item.id === selectedId,
          'aria-expanded': level < 3 ? !collapsed : undefined,
          className: 'min-w-0',
        },
        createElement(
          'div',
          {
            className: droppable
              ? `group flex min-h-9 items-center gap-1 px-2${dropHighlight === item.id ? ' rounded bg-accent' : ''}`
              : `group flex min-h-9 items-center gap-1 px-2${dropHighlight === item.id ? ' rounded bg-accent' : ''}`,
            style: { paddingInlineStart: `${level * 12}px` },
            draggable: true,
            onDragStart: handleDragStart(item),
            onDragOver: droppable
              ? (event: React.DragEvent) => {
                  if (draggedIdRef.current === null) return
                  if (!canAcceptDrop(draggedIdRef.current, item)) return
                  event.preventDefault()
                  setDropHighlight(item.id)
                }
              : undefined,
            onDragLeave: droppable
              ? () => setDropHighlight((current) => (current === item.id ? null : current))
              : undefined,
            onDrop: droppable ? handleDrop(item) : undefined,
          },
          level < 3
            ? createElement(
                Button,
                {
                  type: 'button',
                  variant: 'ghost',
                  size: 'icon-sm',
                  'aria-label': collapsed
                    ? `Expand children of ${item.title}`
                    : `Collapse children of ${item.title}`,
                  'aria-expanded': !collapsed,
                  onClick: () => setCollapsedIds((current) => {
                    const next = new Set(current)
                    if (next.has(item.id)) next.delete(item.id)
                    else next.add(item.id)
                    return next
                  }),
                },
                createElement(ChevronRight, {
                  className: `size-3.5 shrink-0 text-muted-foreground transition-transform${collapsed ? '' : ' rotate-90'}`,
                  'aria-hidden': true,
                }),
              )
            : createElement(ChevronRight, {
                className: 'size-3.5 shrink-0 text-muted-foreground',
                'aria-hidden': true,
              }),
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
        level < 3 && !collapsed
          ? createElement('ul', { role: 'group' }, renderLevel(item.id, (level + 1) as 2 | 3))
          : null,
      )
    }) ?? null
  )

  return createElement(
    'ul',
    {
      role: 'tree',
      'aria-label': 'Work items',
      className: `min-w-0 py-2${dropHighlight === '__top__' ? ' rounded bg-accent/60' : ''}`,
      onDragOver: onMove
        ? (event: React.DragEvent) => {
            const draggedId = draggedIdRef.current
            if (draggedId === null) return
            if (!canAcceptDrop(draggedId, null)) return
            event.preventDefault()
            setDropHighlight('__top__')
          }
        : undefined,
      onDragLeave: onMove
        ? () => setDropHighlight((current) => (current === '__top__' ? null : current))
        : undefined,
      onDrop: onMove ? handleDrop(null) : undefined,
    },
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
