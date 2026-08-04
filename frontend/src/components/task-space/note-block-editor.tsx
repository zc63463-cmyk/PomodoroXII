'use client'

import { createElement, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, IndentDecrease, IndentIncrease, Plus, Trash2 } from 'lucide-react'
import type { NoteBlock } from '@/lib/contracts/task-space'
import {
  indentChecklistItem,
  insertChecklistItem,
  outdentChecklistItem,
  removeChecklistItem,
  updateChecklistItem,
} from '@/lib/task-space/document-edit'
import { Button } from '@/components/ui/button'

type ChecklistBlock = Extract<NoteBlock, { type: 'checklist' }>
type ChecklistItem = ChecklistBlock['items'][number]

export interface NoteBlockEditorProps {
  block: NoteBlock
  onChange: (block: NoteBlock) => void
  onRemove?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}

const newChecklistItem = (prefix: string): ChecklistItem => ({
  itemId: `${prefix}-${crypto.randomUUID()}`,
  text: 'New checklist item',
  checked: false,
  children: [],
})

function actionButton(label: string, icon: ReactNode, onClick: () => void, disabled = false): ReactNode {
  return createElement(Button, {
    type: 'button',
    variant: 'ghost',
    size: 'icon-sm',
    'aria-label': label,
    title: label,
    onClick,
    disabled,
  }, icon)
}

function paragraphEditor(props: NoteBlockEditorProps): ReactNode {
  const { onChange, onRemove, onMoveUp, onMoveDown } = props
  const block = props.block
  if (block.type !== 'paragraph') return null
  return createElement(
    'div',
    { className: 'min-w-0 space-y-2 rounded-md border p-3', 'data-block-type': 'paragraph' },
    createElement('div', { className: 'flex justify-end gap-1' },
      onMoveUp ? actionButton('Move block up', createElement(ArrowUp, { 'aria-hidden': true }), onMoveUp) : null,
      onMoveDown ? actionButton('Move block down', createElement(ArrowDown, { 'aria-hidden': true }), onMoveDown) : null,
      onRemove ? actionButton('Remove block', createElement(Trash2, { 'aria-hidden': true }), onRemove) : null,
    ),
    createElement('textarea', {
      'aria-label': 'Paragraph text',
      className: 'min-h-20 w-full resize-y rounded-md border bg-transparent p-2 text-sm outline-none',
      value: block.text,
      onChange: (event: { target: { value: string } }) => onChange({ ...block, text: event.target.value }),
    }),
  )
}

function checklistItemEditor(
  block: ChecklistBlock,
  item: ChecklistItem,
  index: number,
  onChange: (block: NoteBlock) => void,
): ReactNode {
  const update = (replacement: { text?: string; checked?: boolean }) => {
    onChange(updateChecklistItem({ contentVersion: 1, blocks: [block] }, block.blockId, item.itemId, replacement).blocks[0]!)
  }
  const remove = () => {
    onChange(removeChecklistItem({ contentVersion: 1, blocks: [block] }, block.blockId, item.itemId).blocks[0]!)
  }
  const addChild = () => {
    onChange(insertChecklistItem(
      { contentVersion: 1, blocks: [block] },
      block.blockId,
      newChecklistItem('child'),
      item.children.length,
      item.itemId,
    ).blocks[0]!)
  }
  const indent = () => {
    const previous = block.items[index - 1]
    if (!previous) return
    onChange(indentChecklistItem({ contentVersion: 1, blocks: [block] }, block.blockId, item.itemId, previous.itemId).blocks[0]!)
  }
  return createElement(
    'li',
    { className: 'space-y-1', 'data-item-id': item.itemId, 'aria-level': 1 },
    createElement('div', { className: 'flex min-w-0 items-center gap-2' },
      createElement('input', {
        type: 'checkbox',
        'aria-label': item.text || `Checklist item ${item.itemId}`,
        checked: item.checked,
        onChange: (event: { target: { checked: boolean } }) => update({ checked: event.target.checked }),
      }),
      createElement('input', {
        type: 'text',
        'aria-label': `Checklist item ${item.itemId}`,
        className: 'h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm',
        value: item.text,
        onChange: (event: { target: { value: string } }) => update({ text: event.target.value }),
      }),
      actionButton(`Indent ${item.text || item.itemId}`, createElement(IndentIncrease, { 'aria-hidden': true }), indent, index === 0),
      actionButton(`Add child under ${item.text || item.itemId}`, createElement(Plus, { 'aria-hidden': true }), addChild),
      actionButton(`Remove checklist item ${item.itemId}`, createElement(Trash2, { 'aria-hidden': true }), remove),
    ),
    item.children.length > 0
      ? createElement('ul', { className: 'ml-7 space-y-1' }, item.children.map((child) => childEditor(block, child, onChange)))
      : null,
  )
}

function childEditor(
  block: ChecklistBlock,
  item: ChecklistItem['children'][number],
  onChange: (block: NoteBlock) => void,
): ReactNode {
  const update = (replacement: { text?: string; checked?: boolean }) => {
    onChange(updateChecklistItem({ contentVersion: 1, blocks: [block] }, block.blockId, item.itemId, replacement).blocks[0]!)
  }
  const remove = () => {
    onChange(removeChecklistItem({ contentVersion: 1, blocks: [block] }, block.blockId, item.itemId).blocks[0]!)
  }
  const outdent = () => {
    onChange(outdentChecklistItem({ contentVersion: 1, blocks: [block] }, block.blockId, item.itemId).blocks[0]!)
  }
  return createElement(
    'li',
    { className: 'flex min-w-0 items-center gap-2', 'data-item-id': item.itemId, 'aria-level': 2 },
    createElement('input', {
      type: 'checkbox',
      'aria-label': item.text || `Checklist item ${item.itemId}`,
      checked: item.checked,
      onChange: (event: { target: { checked: boolean } }) => update({ checked: event.target.checked }),
    }),
    createElement('input', {
      type: 'text',
      'aria-label': `Checklist item ${item.itemId}`,
      className: 'h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm',
      value: item.text,
      onChange: (event: { target: { value: string } }) => update({ text: event.target.value }),
    }),
    actionButton(`Outdent ${item.text || item.itemId}`, createElement(IndentDecrease, { 'aria-hidden': true }), outdent),
    actionButton(`Remove checklist item ${item.itemId}`, createElement(Trash2, { 'aria-hidden': true }), remove),
  )
}

function checklistEditor(props: NoteBlockEditorProps): ReactNode {
  const { block, onChange, onRemove, onMoveUp, onMoveDown } = props
  if (block.type !== 'checklist') return null
  const addRoot = () => onChange(insertChecklistItem(
    { contentVersion: 1, blocks: [block] },
    block.blockId,
    newChecklistItem('item'),
    block.items.length,
  ).blocks[0]!)
  return createElement(
    'div',
    { className: 'min-w-0 space-y-2 rounded-md border p-3', 'data-block-type': 'checklist' },
    createElement('div', { className: 'flex justify-end gap-1' },
      onMoveUp ? actionButton('Move block up', createElement(ArrowUp, { 'aria-hidden': true }), onMoveUp) : null,
      onMoveDown ? actionButton('Move block down', createElement(ArrowDown, { 'aria-hidden': true }), onMoveDown) : null,
      actionButton('Add checklist item', createElement(Plus, { 'aria-hidden': true }), addRoot),
      onRemove ? actionButton('Remove block', createElement(Trash2, { 'aria-hidden': true }), onRemove) : null,
    ),
    createElement('ul', { className: 'space-y-2' }, block.items.map((item, index) => checklistItemEditor(block, item, index, onChange))),
  )
}

export function NoteBlockEditor(props: NoteBlockEditorProps): ReactNode {
  return props.block.type === 'paragraph' ? paragraphEditor(props) : checklistEditor(props)
}
