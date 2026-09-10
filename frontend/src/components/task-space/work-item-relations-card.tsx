'use client'

import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { BLOCKING_RELATION_TYPES } from '@/lib/contracts/task-space'
import type { CachedRelation, RelationSet } from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'

/**
 * Dependency management card (依赖域 v1).
 *
 * 首版刻意**不做图可视化**：只提供结构化列表 + 添加/解除动作。
 * 依赖边必须由用户显式建立 —— 没有任何"智能推断"。
 */

export interface WorkItemRelationsCardProps {
  workItem: CachedWorkItem
  /** Edges already loaded for this item (both directions). */
  relations: CachedRelation[]
  relationSet?: RelationSet | null
  /** Candidate endpoints for a new edge (already filtered by the caller). */
  candidates?: CachedWorkItem[]
  definitions?: { statuses: Array<Record<string, unknown>> } | null
  pending?: boolean
  onAdd?: (input: { toWorkItemId: string; relationType: string }) => Promise<unknown> | unknown
  onRemove?: (input: { fromWorkItemId: string; toWorkItemId: string; relationType: string }) => Promise<unknown> | unknown
}

const TYPE_LABELS: Record<string, string> = {
  depends_on: '依赖于',
  blocks: '阻塞',
  relates_to: '关联',
}

function statusLabel(
  definitions: { statuses: Array<Record<string, unknown>> } | null | undefined,
  statusDefinitionId: string,
): string {
  const entry = definitions?.statuses.find(
    (candidate) => String(candidate.id) === statusDefinitionId,
  )
  if (!entry) return ''
  for (const key of ['label', 'name', 'title'] as const) {
    const value = entry[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

export function WorkItemRelationsCard({
  workItem,
  relations,
  relationSet = null,
  candidates = [],
  definitions = null,
  pending = false,
  onAdd,
  onRemove,
}: WorkItemRelationsCardProps): ReactNode {
  const [adding, setAdding] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    setAdding(false)
    setTargetId('')
    setQuery('')
  }, [workItem.id])

  const myId = workItem.id
  // Minimal projections keyed by id, when the server sent the richer set.
  const minimalById = useMemo(() => {
    const map = new Map<string, { title: string; displayKey: string; statusDefinitionId: string }>()
    for (const entry of [...(relationSet?.blockers ?? []), ...(relationSet?.blocking ?? [])]) {
      map.set(entry.workItem.id, entry.workItem)
    }
    return map
  }, [relationSet])

  const blockers = relations.filter((edge) => edge.fromWorkItemId === myId)
  const blocking = relations.filter((edge) => edge.toWorkItemId === myId)

  const endpointName = (edge: CachedRelation): string => {
    const otherId = edge.fromWorkItemId === myId ? edge.toWorkItemId : edge.fromWorkItemId
    const minimal = minimalById.get(otherId)
    if (minimal) return `${minimal.displayKey} ${minimal.title}`.trim()
    return otherId
  }

  const filteredCandidates = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return candidates
    return candidates.filter((item) => (
      item.title.toLowerCase().includes(needle)
      || item.displayKey.toLowerCase().includes(needle)
    ))
  }, [candidates, query])

  const submit = async () => {
    if (!onAdd || !targetId) return
    try {
      await onAdd({ toWorkItemId: targetId, relationType: 'depends_on' })
      setAdding(false)
      setTargetId('')
      setQuery('')
    } catch {
      // The store surfaced a stable message; keep the dialog open so the
      // user can pick a different endpoint.
    }
  }

  const remove = async (edge: CachedRelation) => {
    if (!onRemove) return
    try {
      await onRemove({
        fromWorkItemId: edge.fromWorkItemId,
        toWorkItemId: edge.toWorkItemId,
        relationType: edge.relationType,
      })
    } catch {
      // Stable error is surfaced by the store; the edge stays.
    }
  }

  const edgeRow = (edge: CachedRelation) => {
    const blocks = BLOCKING_RELATION_TYPES.includes(
      edge.relationType as (typeof BLOCKING_RELATION_TYPES)[number],
    )
    const minimal = minimalById.get(
      edge.fromWorkItemId === myId ? edge.toWorkItemId : edge.fromWorkItemId,
    )
    const status = minimal ? statusLabel(definitions, minimal.statusDefinitionId) : ''
    return createElement(
      'li',
      {
        key: edge.id,
        className: 'flex min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1.5',
      },
      createElement(
        'span',
        { className: 'flex min-w-0 items-center gap-1.5 text-sm' },
        createElement('span', { className: 'truncate' }, endpointName(edge)),
        status
          ? createElement(
              'span',
              { className: 'shrink-0 rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground' },
              status,
            )
          : null,
        !blocks
          ? createElement('span', { className: 'shrink-0 text-xs text-muted-foreground' }, '不阻塞')
          : null,
      ),
      onRemove
        ? createElement(
            Button,
            {
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              disabled: pending || workItem.archivedAt !== null,
              'aria-label': `解除与 ${endpointName(edge)} 的依赖`,
              onClick: () => void remove(edge),
            },
            '解除',
          )
        : null,
    )
  }

  return createElement(
    'section',
    { 'aria-label': 'Work item dependencies', 'data-relations-card': true, className: 'grid gap-3 border-b py-4' },
    createElement(
      'div',
      { className: 'flex items-center justify-between gap-3' },
      createElement('h2', { className: 'text-sm font-medium text-muted-foreground' }, '依赖'),
      onAdd
        ? createElement(
            Button,
            {
              type: 'button',
              variant: 'outline',
              size: 'sm',
              disabled: pending || workItem.archivedAt !== null,
              ...({ 'data-add-relation': true } as unknown as Record<string, never>),
              onClick: () => setAdding((current) => !current),
            },
            '添加依赖',
          )
        : null,
    ),
    adding
      ? createElement(
          'div',
          { className: 'grid gap-2 rounded-md border p-2', 'data-add-relation-panel': true },
          createElement('input', {
            'aria-label': '搜索工作项',
            className: 'h-8 rounded-md border bg-background px-2 text-sm outline-none',
            placeholder: '按标题或编号搜索…',
            value: query,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
          }),
          createElement(
            'select',
            {
              'aria-label': '选择上游工作项',
              className: 'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none',
              value: targetId,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setTargetId(event.target.value),
            },
            createElement('option', { value: '' }, '选择上游…'),
            filteredCandidates.map((item) => createElement(
              'option',
              { key: item.id, value: item.id },
              `${item.displayKey} ${item.title}`,
            )),
          ),
          createElement(
            'div',
            { className: 'flex justify-end gap-2' },
            createElement(
              Button,
              { type: 'button', variant: 'ghost', size: 'sm', onClick: () => setAdding(false) },
              '取消',
            ),
            createElement(
              Button,
              { type: 'button', size: 'sm', disabled: !targetId, onClick: () => void submit() },
              '建立依赖',
            ),
          ),
        )
      : null,
    createElement(
      'div',
      { className: 'grid gap-1' },
      createElement('h3', { className: 'text-xs font-medium' }, '被我依赖（上游）'),
      blockers.length === 0
        ? createElement('p', { className: 'text-xs text-muted-foreground', 'data-blockers-empty': true }, '暂无上游依赖')
        : createElement('ul', { className: 'grid gap-1', 'data-blockers': true }, blockers.map(edgeRow)),
    ),
    createElement(
      'div',
      { className: 'grid gap-1' },
      createElement('h3', { className: 'text-xs font-medium' }, '依赖我的（下游）'),
      blocking.length === 0
        ? createElement('p', { className: 'text-xs text-muted-foreground' }, '暂无下游依赖')
        : createElement('ul', { className: 'grid gap-1', 'data-blocking': true }, blocking.map(edgeRow)),
    ),
    createElement(
      'p',
      { className: 'text-xs text-muted-foreground' },
      `语义：${TYPE_LABELS.depends_on} / ${TYPE_LABELS.blocks} 会阻塞；${TYPE_LABELS.relates_to} 不阻塞。多上游为「全部完成才解除」。`,
    ),
  )
}
