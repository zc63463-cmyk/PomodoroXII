'use client'

import { createElement, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { WorkItemNoteConflictRow } from '@/types'
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'

export interface NoteConflictPanelProps {
  conflict: WorkItemNoteConflictRow
  onReloadRemote: () => void | Promise<void>
  onOverwriteLocal: () => void | Promise<void>
}

function readonlyDocument(document: WorkItemNoteDocument): ReactNode {
  return createElement(
    'div',
    { className: 'space-y-2 rounded-md border p-3', 'data-readonly-note': true },
    document.blocks.length === 0
      ? createElement('p', { className: 'text-sm text-muted-foreground' }, 'Empty note')
      : document.blocks.map((block) => block.type === 'paragraph'
        ? createElement('p', { key: block.blockId, className: 'whitespace-pre-wrap text-sm' }, block.text)
        : createElement('ul', { key: block.blockId, className: 'list-disc pl-5 text-sm' }, block.items.map((item) => createElement(
          'li', { key: item.itemId },
          createElement('span', { className: item.checked ? 'line-through' : undefined }, item.text),
          item.children.length > 0
            ? createElement('ul', { className: 'list-[circle] pl-5' }, item.children.map((child) => createElement('li', { key: child.itemId }, child.text)))
            : null,
        ))),
    ),
  )
}

export function NoteConflictPanel({ conflict, onReloadRemote, onOverwriteLocal }: NoteConflictPanelProps): ReactNode {
  return createElement(
    'section',
    { role: 'alert', 'aria-labelledby': 'note-conflict-title', className: 'min-w-0 space-y-3' },
    createElement('h3', { id: 'note-conflict-title', className: 'text-sm font-semibold' }, 'Work item note conflict'),
    createElement('div', { className: 'grid min-w-0 gap-3 lg:grid-cols-2' },
      createElement('div', { className: 'min-w-0 space-y-2' },
        createElement('h4', { className: 'text-xs font-medium' }, `Local revision ${conflict.localRevision}`),
        readonlyDocument(conflict.localDocument),
      ),
      createElement('div', { className: 'min-w-0 space-y-2' },
        createElement('h4', { className: 'text-xs font-medium' }, `Remote version ${conflict.remoteVersion}`),
        readonlyDocument(conflict.remoteDocument),
      ),
    ),
    createElement('div', { className: 'flex flex-wrap justify-end gap-2' },
      createElement(Button, { type: 'button', variant: 'outline', onClick: () => void onReloadRemote() }, 'Reload remote'),
      createElement(Button, { type: 'button', onClick: () => void onOverwriteLocal() }, 'Use reviewed local copy'),
    ),
  )
}
