'use client'

import { createElement, type ReactNode } from 'react'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'

export interface WorkItemDetailProps {
  workItem?: CachedWorkItem | null
  workItemId?: string | null
  definitions?: TaskSpaceDefinitions | null
  noteEditor?: ReactNode
}

function definitionValue(
  definitions: TaskSpaceDefinitions | null | undefined,
  group: 'statuses' | 'types',
  id: string,
): Record<string, unknown> | null {
  const entry = definitions?.[group].find((candidate) => (
    typeof candidate.id === 'string' && candidate.id === id
  ))
  return entry ?? null
}

function definitionLabel(value: Record<string, unknown> | null, fallback: string): string {
  if (!value) return fallback
  for (const key of ['label', 'name', 'title']) {
    if (typeof value[key] === 'string' && value[key]) return value[key] as string
  }
  return fallback
}

function definitionColor(value: Record<string, unknown> | null): string | undefined {
  if (!value) return undefined
  for (const key of ['color', 'hexColor']) {
    if (typeof value[key] === 'string') return value[key] as string
  }
  return undefined
}

function timing(label: string, value: string | null): ReactNode {
  if (!value) return null
  return createElement(
    'div',
    { className: 'grid grid-cols-[auto_1fr] gap-3 text-sm' },
    createElement('dt', { className: 'text-muted-foreground' }, label),
    createElement('dd', { className: 'truncate' }, value),
  )
}

export function WorkItemDetail({ workItem, definitions, noteEditor }: WorkItemDetailProps) {
  if (!workItem) {
    return createElement(
      'section',
      { 'aria-label': 'Work item detail', className: 'flex min-h-full items-center justify-center p-6' },
      createElement('p', { className: 'text-sm text-muted-foreground' }, 'Select a work item'),
    )
  }

  const status = definitionValue(definitions, 'statuses', workItem.statusDefinitionId)
  const type = definitionValue(definitions, 'types', workItem.typeDefinitionId)
  const statusColor = definitionColor(status)
  const typeColor = definitionColor(type)

  const statusRow = createElement(
    'div',
    { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
    createElement('dt', { className: 'text-muted-foreground' }, 'Status'),
    createElement(
      'dd',
      { className: 'flex min-w-0 items-center gap-2 truncate' },
      statusColor ? createElement('span', { className: 'size-2.5 shrink-0 rounded-full', style: { backgroundColor: statusColor }, 'aria-hidden': true }) : null,
      createElement('span', { className: 'truncate' }, definitionLabel(status, workItem.statusDefinitionId)),
    ),
  )
  const typeRow = createElement(
    'div',
    { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
    createElement('dt', { className: 'text-muted-foreground' }, 'Type'),
    createElement(
      'dd',
      { className: 'flex min-w-0 items-center gap-2 truncate' },
      typeColor ? createElement('span', { className: 'size-2.5 shrink-0 rounded-full', style: { backgroundColor: typeColor }, 'aria-hidden': true }) : null,
      createElement('span', { className: 'truncate' }, definitionLabel(type, workItem.typeDefinitionId)),
    ),
  )

  return createElement(
    'article',
    { 'aria-label': 'Work item detail', className: 'min-w-0 p-5' },
    createElement(
      'header',
      { className: 'flex min-w-0 items-start justify-between gap-4 border-b pb-4' },
      createElement(
        'div',
        { className: 'min-w-0' },
        createElement('p', { className: 'font-mono text-xs text-muted-foreground' }, workItem.displayKey),
        createElement('h1', { className: 'truncate text-xl font-semibold' }, workItem.title),
      ),
      createElement('span', { className: 'shrink-0 text-xs text-muted-foreground' }, `v${workItem.version}`),
    ),
    createElement(
      'dl',
      { className: 'grid gap-3 border-b py-4 sm:grid-cols-2' },
      statusRow,
      typeRow,
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, 'Priority'),
        createElement('dd', null, workItem.priority ?? 'Not set'),
      ),
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, 'Effort'),
        createElement('dd', null, `${workItem.effortActualSeconds}s actual`),
      ),
    ),
    createElement(
      'dl',
      { className: 'grid gap-2 border-b py-4' },
      timing('Completion window start', workItem.completionWindowStart),
      timing('Completion window end', workItem.completionWindowEnd),
      timing('Review point', workItem.reviewPoint),
      timing('Hard deadline', workItem.hardDeadline),
      timing('Created', workItem.createdAt),
      timing('Updated', workItem.updatedAt),
    ),
    createElement(
      'section',
      {
        'aria-label': 'Work item note editor',
        'data-note-editor-mount': true,
        'data-work-item-id': workItem.id,
        className: 'min-w-0 pt-4',
      },
      noteEditor ?? createElement('p', { className: 'text-sm text-muted-foreground' }, 'Note editor'),
    ),
  )
}
