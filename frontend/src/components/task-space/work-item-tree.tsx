'use client'

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
// ★ 工单②：同层拖拽排序 —— 落点分区与 onReorder 回调。
import type { SiblingPosition } from '@/lib/task-space/sibling-reorder'
import type { CachedWorkItem } from '@/types'
import { Button } from '@/components/ui/button'

/** ★ 工单②：拖拽落点分区。 */
type DropZone = 'before' | 'after' | 'child'

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
  /**
   * Derived dependency signal per work item id.  Only ``isBlocked`` true
   * renders the lock; ``openBlockerCount`` feeds the hover hint.
   */
  blockedSignals?: Record<string, { isBlocked: boolean; openBlockerCount?: number }>
  /** Parent-driven move: the component validates the drop target first. */
  onMove?: (workItemId: string, newParentId: string | null) => void
  /** ★ 工单②：同层插入（before/after 落点）。同父直接 reorder；跨父由上层
   *  拆成 move+reorder 两步。后端始终权威：非法落点服务端仍会拒绝。 */
  onReorder?: (workItemId: string, targetId: string, position: SiblingPosition) => void
  /** Monotonic signal from the page shortcuts: collapse or expand every branch. */
  collapseSignal?: { seq: number; mode: 'collapse' | 'expand' } | null
  /**
   * A tree filter is active: ignore the manual collapse state so deep matches
   * are actually visible instead of hidden behind a collapsed parent.
   */
  filterActive?: boolean
  /** Unfinished direct children per parent id — surfaces the parent/child
   *  completion guard before the user walks into it. */
  openChildCountById?: Record<string, number>
  /** 层级编码（`1.2.3`，客户端派生）—— 显示用；稳定身份仍是 displayKey。 */
  codeById?: Record<string, string>
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
  blockedSignals = {},
  onMove,
  onReorder,
  collapseSignal = null,
  filterActive = false,
  openChildCountById = {},
  codeById = {},
}: WorkItemTreeProps) {
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set())
  const draggedIdRef = useRef<string | null>(null)
  // ★ 工单②：drop 高亮带分区（before 上边线 / after 下边线 / child 行高亮）。
  //   '__top__' 是树背景（成为根项）的哨兵 id。
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: DropZone } | null>(null)
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
  //
  // ★ 工单②：落点分区 —— 行上缘 1/4 插到之前、下缘 1/4 插到之后、中间成为
  //   子项。before/after 的树约束 = 「把被拖项 move 到 target 的父下」的约束
  //   （同父时无树变化，任何非自身兄弟都可）；child 约束保持不变。jsdom 等
  //   无布局环境 rect 高度为 0，兜底按 child 处理（兼容既有 move 语义测试）。
  const dropZone = (event: React.DragEvent): DropZone => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.height <= 0) return 'child'
    const ratio = (event.clientY - rect.top) / rect.height
    if (ratio < 0.25) return 'before'
    if (ratio > 0.75) return 'after'
    return 'child'
  }

  const canAcceptDrop = (
    draggedId: string,
    target: CachedWorkItem | null,
    zone: DropZone = 'child',
  ): boolean => {
    if (zone === 'child' || target === null) {
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
    if (!onReorder) return false
    if (target.id === draggedId) return false
    const dragged = items.find((item) => item.id === draggedId)
    if (!dragged) return false
    const targetParentId = target.parentId ?? null
    if ((dragged.parentId ?? null) === targetParentId) return true
    // Cross-parent before/after ≙ move to target's parent: mirror Move's
    // cycle + depth constraints.
    if (targetParentId === draggedId) return false
    if (targetParentId !== null && descendantsOf(draggedId).has(targetParentId)) return false
    const parentDepth = targetParentId === null
      ? 0
      : (items.find((item) => item.id === targetParentId)?.depth ?? 0)
    return parentDepth + 1 + subtreeRelativeDepth(draggedId) <= 3
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
    setDropTarget(null)
    if (!draggedId) return
    if (target === null) {
      // Tree background: become a root item (move semantics).
      if (!canAcceptDrop(draggedId, null, 'child')) return
      onMove?.(draggedId, null)
      return
    }
    const zone = dropZone(event)
    if (!canAcceptDrop(draggedId, target, zone)) return
    if (zone === 'child') {
      onMove?.(draggedId, target.id)
    } else {
      onReorder?.(draggedId, target.id, zone)
    }
  }

  const renderLevel = (parentId: string | null, level: 1 | 2 | 3): ReactNode => (
    children.get(parentId)?.map((item) => {
      // 过滤激活时不理会手工折叠：命中的深层节点必须直接可见。
      const collapsed = filterActive ? false : collapsedIds.has(item.id)
      // ★ 工单②：L3 行不接受 child（已是叶子层），但要接受 before/after
      //   （同级插入）—— droppable 因此与 onMove/onReorder 的可用性分别判定。
      const droppable = (onMove !== null && level < 3) || onReorder !== undefined
      const rowDrop = dropTarget?.id === item.id ? dropTarget.zone : null
      const blocked = blockedSignals[item.id]?.isBlocked === true
      const openBlockers = blockedSignals[item.id]?.openBlockerCount ?? 0
      const blockedHint = blocked
        ? `被 ${openBlockers} 个未完成依赖项阻塞`
        : undefined
      const openChildren = openChildCountById[item.id] ?? 0
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
            className: `group flex min-h-9 items-center gap-1 px-2${
              rowDrop === 'before'
                ? ' shadow-[inset_0_2px_0_0_var(--primary)]'
                : rowDrop === 'after'
                  ? ' shadow-[inset_0_-2px_0_0_var(--primary)]'
                  : rowDrop === 'child'
                    ? ' rounded bg-accent'
                    : ''
            }`,
            style: { paddingInlineStart: `${level * 12}px` },
            draggable: true,
            onDragStart: handleDragStart(item),
            onDragOver: droppable
              ? (event: React.DragEvent) => {
                  if (draggedIdRef.current === null) return
                  const zone = dropZone(event)
                  if (!canAcceptDrop(draggedIdRef.current, item, zone)) return
                  event.preventDefault()
                  setDropTarget({ id: item.id, zone })
                }
              : undefined,
            onDragLeave: droppable
              ? () => setDropTarget((current) => (current?.id === item.id ? null : current))
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
              'aria-label': blocked
                ? `${item.displayKey} ${item.title}（${blockedHint}）`
                : `${item.displayKey} ${item.title}`,
              onClick: () => onSelect(item.id),
            },
            blocked
              ? createElement(
                  'span',
                  {
                    'aria-hidden': true,
                    role: 'img',
                    'aria-label': blockedHint,
                    title: blockedHint,
                    'data-blocked-lock': true,
                    className: 'mr-1 text-xs',
                  },
                  '🔒',
                )
              : null,
            createElement('span', { className: 'mr-1 font-mono text-xs text-muted-foreground' }, codeById[item.id] ?? item.displayKey),
            createElement('span', null, item.title),
            openChildren > 0
              ? createElement(
                  'span',
                  {
                    'data-open-children': true,
                    title: `${openChildren} 个未完成的直接子项`,
                    className: 'ml-1 shrink-0 rounded-full border px-1.5 text-[10px] text-muted-foreground',
                  },
                  `${openChildren} 子`,
                )
              : null,
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
      className: `min-w-0 py-2${dropTarget?.id === '__top__' ? ' rounded bg-accent/60' : ''}`,
      onDragOver: onMove
        ? (event: React.DragEvent) => {
            const draggedId = draggedIdRef.current
            if (draggedId === null) return
            if (!canAcceptDrop(draggedId, null)) return
            event.preventDefault()
            setDropTarget({ id: '__top__', zone: 'child' })
          }
        : undefined,
      onDragLeave: onMove
        ? () => setDropTarget((current) => (current?.id === '__top__' ? null : current))
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
