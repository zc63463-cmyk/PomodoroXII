'use client'

import { createElement, useEffect, useState, type ReactNode } from 'react'
import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'
import { Button } from '@/components/ui/button'

export interface WorkItemDetailProps {
  workItem?: CachedWorkItem | null
  definitions?: TaskSpaceDefinitions | null
  noteEditor?: ReactNode
  pendingMutations?: Record<string, boolean>
  mutationError?: { targetId: string; code: string } | null
  error?: string | null
  /** Same-project nodes that may become the new parent (depth < 3). */
  availableParents?: CachedWorkItem[]
  onUpdate?: (input: { title: string; description: string | null; priority: string | null }) => Promise<unknown> | unknown
  onTransition?: (statusDefinitionId: string) => Promise<unknown> | unknown
  onMove?: (parentId: string | null) => Promise<unknown> | unknown
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

function timing(label: string, value: string | null): ReactNode {
  if (!value) return null
  return createElement(
    'div',
    { className: 'grid grid-cols-[auto_1fr] gap-3 text-sm' },
    createElement('dt', { className: 'text-muted-foreground' }, label),
    createElement('dd', { className: 'truncate' }, value),
  )
}

export function WorkItemDetail({
  workItem,
  definitions,
  noteEditor,
  pendingMutations = {},
  mutationError = null,
  error = null,
  availableParents = [],
  onUpdate,
  onTransition,
  onMove,
}: WorkItemDetailProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('')

  // The draft always mirrors the store post-image; it is reset only when the
  // selected item or its version changes (i.e. after a successful mutation).
  useEffect(() => {
    setName(workItem?.title ?? '')
    setDescription(workItem?.description ?? '')
    setPriority(workItem?.priority ?? '')
  }, [workItem?.id, workItem?.version, workItem?.title, workItem?.description, workItem?.priority])

  if (!workItem) {
    return createElement(
      'section',
      { 'aria-label': 'Work item detail', className: 'flex min-h-full items-center justify-center p-6' },
      createElement('p', { className: 'text-sm text-muted-foreground' }, 'Select a work item'),
    )
  }

  const pending = pendingMutations[workItem.id] === true
  const readonly = workItem.archivedAt !== null
  const visibleError = mutationError?.targetId === workItem.id ? error : null
  const statusOptions = definitions?.statuses ?? []

  const save = async () => {
    if (!onUpdate) return
    try {
      await onUpdate({
        title: name.trim(),
        description: description.trim() || null,
        priority: priority.trim() || null,
      })
    } catch {
      // Keep the draft; the store has already surfaced a stable error.
    }
  }

  const changeStatus = async (statusDefinitionId: string) => {
    if (!onTransition || statusDefinitionId === workItem.statusDefinitionId) return
    try {
      await onTransition(statusDefinitionId)
    } catch {
      // Stable error is surfaced by the store; keep the previous status.
    }
  }

  const changeParent = async (parentId: string) => {
    if (!onMove) return
    try {
      await onMove(parentId === '' ? null : parentId)
    } catch {
      // Stable error is surfaced by the store; keep the previous tree.
    }
  }

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
    visibleError
      ? createElement('p', { role: 'alert', className: 'border-b py-3 text-sm text-destructive' }, visibleError)
      : null,
    createElement(
      'section',
      { 'aria-label': 'Edit work item', className: 'grid gap-3 border-b py-4' },
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement('label', { htmlFor: 'wi-title', className: 'text-xs font-medium text-muted-foreground' }, 'Title'),
        createElement('input', {
          id: 'wi-title', className: 'h-9 rounded-md border bg-background px-3 text-sm outline-none',
          value: name, disabled: pending || readonly,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        }),
      ),
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement('label', { htmlFor: 'wi-description', className: 'text-xs font-medium text-muted-foreground' }, 'Description'),
        createElement('textarea', {
          id: 'wi-description', className: 'min-h-20 rounded-md border bg-background px-3 py-2 text-sm outline-none',
          value: description, disabled: pending || readonly,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value),
        }),
      ),
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement('label', { htmlFor: 'wi-priority', className: 'text-xs font-medium text-muted-foreground' }, 'Priority'),
        createElement('input', {
          id: 'wi-priority', className: 'h-9 rounded-md border bg-background px-3 text-sm outline-none',
          value: priority, disabled: pending || readonly,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPriority(event.target.value),
        }),
      ),
      createElement(
        Button,
        { type: 'button', disabled: pending || readonly || !onUpdate, onClick: () => void save() },
        'Save changes',
      ),
    ),
    createElement(
      'dl',
      { className: 'grid gap-3 border-b py-4 sm:grid-cols-2' },
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, 'Status'),
        createElement(
          'dd',
          { className: 'min-w-0' },
          createElement(
            'select',
            {
              'aria-label': 'Status',
              className: 'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none',
              value: workItem.statusDefinitionId,
              disabled: pending || readonly || !onTransition,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void changeStatus(event.target.value),
            },
            statusOptions.length === 0
              ? createElement('option', { value: workItem.statusDefinitionId }, workItem.statusDefinitionId)
              : statusOptions.map((status) => createElement(
                  'option',
                  { key: String(status.id), value: String(status.id) },
                  String(status.label ?? status.name ?? status.id),
                )),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, 'Type'),
        createElement('dd', { className: 'truncate' }, definitionLabel(definitions, 'types', workItem.typeDefinitionId)),
      ),
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, 'Parent'),
        createElement(
          'dd',
          { className: 'min-w-0' },
          createElement(
            'select',
            {
              'aria-label': 'Parent',
              className: 'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none',
              value: workItem.parentId ?? '',
              disabled: pending || readonly || !onMove,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void changeParent(event.target.value),
            },
            createElement('option', { value: '' }, 'No parent'),
            availableParents.map((parent) => createElement(
              'option',
              { key: parent.id, value: parent.id },
              `${parent.displayKey} ${parent.title}`,
            )),
          ),
        ),
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
