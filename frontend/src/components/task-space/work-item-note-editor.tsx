'use client'

import { createElement, type ReactNode } from 'react'
import { CheckSquare, Pilcrow } from 'lucide-react'
import type { WorkItemNoteConflictRow } from '@/types'
import type { NoteBlock, WorkItemNoteDocument } from '@/lib/contracts/task-space'
import type { FlushReason } from '@/lib/task-space/note-autosave-controller'
import { insertBlock, moveBlock, removeBlock, updateBlock } from '@/lib/task-space/document-edit'
import { Button } from '@/components/ui/button'
import { NoteBlockEditor } from './note-block-editor'
import { NoteConflictPanel } from './note-conflict-panel'

export interface WorkItemNoteEditorProps {
  document: WorkItemNoteDocument
  onChange: (document: WorkItemNoteDocument) => void
  conflict: WorkItemNoteConflictRow | null
  onReloadRemote?: () => void | Promise<void>
  onOverwriteLocal?: () => void | Promise<void>
  saveLabel?: string
  onWorkItemTransition?: (statusDefinitionId: string) => void
  onFlush?: (reason: FlushReason) => void | Promise<void>
}

const emptyBlock = (type: NoteBlock['type'], blockId: string): NoteBlock => type === 'paragraph'
  ? { type, blockId, text: '' }
  : { type, blockId, items: [] }

const blockId = (type: NoteBlock['type']): string => `${type}-${crypto.randomUUID()}`

function commandButton(label: string, icon: ReactNode, onClick: () => void): ReactNode {
  return createElement(Button, {
    type: 'button',
    variant: 'ghost',
    size: 'sm',
    'aria-label': label,
    title: label,
    onClick,
  }, icon, label)
}

export function WorkItemNoteEditor(props: WorkItemNoteEditorProps): ReactNode {
  if (props.conflict) {
    return createElement(NoteConflictPanel, {
      conflict: props.conflict,
      onReloadRemote: props.onReloadRemote ?? (() => undefined),
      onOverwriteLocal: props.onOverwriteLocal ?? (() => undefined),
    })
  }

  const add = (type: NoteBlock['type']) => props.onChange(insertBlock(
    props.document,
    emptyBlock(type, blockId(type)),
    props.document.blocks.length,
  ))

  return createElement(
    'section',
    {
      'aria-label': 'Work item note',
      className: 'min-w-0 space-y-2 work-item-note-editor',
      onBlur: () => {
        if (props.onFlush) void props.onFlush('blur')
      },
    },
    createElement('div', { role: 'toolbar', 'aria-label': 'Insert note Block', className: 'flex flex-wrap gap-1' },
      commandButton('Add paragraph', createElement(Pilcrow, { 'aria-hidden': true }), () => add('paragraph')),
      commandButton('Add checklist', createElement(CheckSquare, { 'aria-hidden': true }), () => add('checklist')),
    ),
    createElement('ol', { className: 'space-y-2' }, props.document.blocks.map((block, index) => createElement(
      'li', { key: block.blockId },
      createElement(NoteBlockEditor, {
        block,
        onChange: (next: NoteBlock) => props.onChange(updateBlock(props.document, block.blockId, next)),
        onRemove: () => props.onChange(removeBlock(props.document, block.blockId)),
        onMoveUp: index > 0 ? () => props.onChange(moveBlock(props.document, block.blockId, index - 1)) : undefined,
        onMoveDown: index < props.document.blocks.length - 1
          ? () => props.onChange(moveBlock(props.document, block.blockId, index + 1))
          : undefined,
      }),
    ))),
    createElement('output', { 'aria-live': 'polite', className: 'text-xs text-muted-foreground' }, props.saveLabel ?? 'Not saved'),
  )
}
