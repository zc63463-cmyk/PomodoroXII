'use client'

import { createElement, useEffect, useMemo, useState } from 'react'
import type { NoteBlock } from '@/lib/contracts/task-space'
import type { CachedWorkItemNote } from '@/types'
import type { TimerNoteComposerDraft, TimerNoteComposerDraftController } from '@/lib/task-space/timer-note-composer-draft-registry'

interface FocusedWorkItemNoteProps {
  note: CachedWorkItemNote | null
  spaceId: string
  workItemId: string
  draftRegistry?: TimerNoteComposerDraftController
  onAppendBlocks: (workItemId: string, blocks: NoteBlock[], operationId: string) => Promise<void> | void
  onFlush?: (reason: 'blur' | 'before-append' | 'append-failed' | 'append-committed') => Promise<void> | void
}

interface ChecklistDraft { itemId: string; text: string; children: Array<{ itemId: string; text: string }> }

function draftState(value: TimerNoteComposerDraft): {
  mode: 'paragraph' | 'checklist'
  paragraph: string
  checklist: ChecklistDraft[]
} {
  if (value.block.type === 'paragraph') {
    return { mode: 'paragraph', paragraph: value.block.text, checklist: [{ itemId: 'checklist-root', text: '', children: [] }] }
  }
  return {
    mode: 'checklist', paragraph: '',
    checklist: value.block.items.map((item) => ({
      itemId: item.itemId, text: item.text,
      children: item.children.map((child) => ({ itemId: child.itemId, text: child.text })),
    })),
  }
}

function existingBlockText(block: NoteBlock): string {
  if (block.type === 'paragraph') return block.text
  return block.items.map((item) => item.text).join(', ')
}

export function FocusedWorkItemNote({ note, workItemId, draftRegistry, onAppendBlocks, onFlush }: FocusedWorkItemNoteProps) {
  const [mode, setMode] = useState<'paragraph' | 'checklist'>('paragraph')
  const [paragraph, setParagraph] = useState('')
  const [checklist, setChecklist] = useState<ChecklistDraft[]>([{ itemId: 'checklist-root', text: '', children: [] }])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const existing = useMemo(() => note?.document.blocks ?? [], [note])

  useEffect(() => {
    let active = true
    if (!draftRegistry) return undefined
    void draftRegistry.hydrate().then((draft) => {
      if (!active) return
      const next = draftState(draft)
      setMode(next.mode)
      setParagraph(next.paragraph)
      setChecklist(next.checklist)
    }).catch((cause) => {
      if (active) setError((cause as Error).message)
    })
    return () => {
      active = false
      void draftRegistry.dispose().catch(() => undefined)
    }
  }, [draftRegistry])

  const persistDraft = (nextMode: 'paragraph' | 'checklist', nextParagraph: string, nextChecklist: ChecklistDraft[]) => {
    if (!draftRegistry) return
    void draftRegistry.update(nextMode === 'paragraph'
      ? { contentVersion: 1, block: { type: 'paragraph', blockId: `timer-draft-${workItemId}`, text: nextParagraph } }
      : { contentVersion: 1, block: { type: 'checklist', blockId: `timer-draft-${workItemId}`, items: nextChecklist.map((item) => ({
        ...item,
        children: item.children.map((child) => ({ ...child, children: [] as [] })),
      })) } }).catch((cause) => setError((cause as Error).message))
  }

  const updateChecklist = (next: ChecklistDraft[]) => {
    setChecklist(next)
    persistDraft(mode, paragraph, next)
  }

  const append = async () => {
    setError(null)
    setBusy(true)
    const operationId = crypto.randomUUID()
    const block: NoteBlock = mode === 'paragraph'
      ? { type: 'paragraph', blockId: `timer-${operationId}`, text: paragraph.trim() }
      : { type: 'checklist', blockId: `timer-${operationId}`, items: checklist.map((item) => ({
        itemId: item.itemId, text: item.text.trim(), checked: false,
        children: item.children.map((child) => ({ itemId: child.itemId, text: child.text.trim(), checked: false, children: [] })),
      })) }
    try {
      await onFlush?.('before-append')
      if (mode === 'paragraph' && !paragraph.trim()) throw new Error('Paragraph is empty')
      if (mode === 'checklist' && (!checklist.length || checklist.some((item) => !item.text.trim() || item.children.some((child) => !child.text.trim())))) throw new Error('Checklist is empty')
      if (draftRegistry) {
        await draftRegistry.update(mode === 'paragraph'
          ? { contentVersion: 1, block: { type: 'paragraph', blockId: block.blockId, text: paragraph } }
          : { contentVersion: 1, block: { type: 'checklist', blockId: block.blockId, items: checklist.map((item) => ({ ...item, children: item.children.map((child) => ({ ...child, children: [] as [] })) })) } })
        await draftRegistry.appendExplicitly()
      } else {
        await onAppendBlocks(workItemId, [block], operationId)
      }
      setParagraph('')
      setChecklist([{ itemId: 'checklist-root', text: '', children: [] }])
      await onFlush?.('append-committed')
    } catch (cause) {
      setError((cause as Error).message)
      await onFlush?.('append-failed')
    } finally {
      setBusy(false)
    }
  }

  const checklistEditor = checklist.map((item, index) => createElement('div', { key: item.itemId, className: 'grid gap-2' },
    createElement('label', { htmlFor: `checklist-${index}` }, `New checklist item ${index + 1}`),
    createElement('input', {
      id: `checklist-${index}`, value: item.text,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => updateChecklist(checklist.map((row) => row.itemId === item.itemId ? { ...row, text: event.target.value } : row)),
    }),
    createElement('button', { type: 'button', onClick: () => updateChecklist(checklist.map((row) => row.itemId === item.itemId ? { ...row, children: [...row.children, { itemId: `child-${crypto.randomUUID()}`, text: '' }] } : row)) }, `Add child under ${item.text || `item ${index + 1}`}`),
    item.children.map((child) => createElement('label', { key: child.itemId, htmlFor: child.itemId },
      `Child of ${item.text || `item ${index + 1}`}`,
      createElement('input', {
        id: child.itemId, 'aria-label': `Child of ${item.text || `item ${index + 1}`}`, value: child.text,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => updateChecklist(checklist.map((row) => row.itemId === item.itemId ? { ...row, children: row.children.map((nested) => nested.itemId === child.itemId ? { ...nested, text: event.target.value } : nested) } : row)),
      }),
    )),
  ))

  return createElement(
    'section', { 'aria-label': 'Focused WorkItem Note', className: 'grid gap-3' },
    createElement('div', { 'aria-label': 'Existing WorkItemNote', className: 'grid gap-2' }, existing.map((block) => createElement('p', { key: block.blockId }, existingBlockText(block)))),
    createElement('div', { className: 'flex gap-2' },
      createElement('button', { type: 'button', onClick: () => { setMode('paragraph'); persistDraft('paragraph', paragraph, checklist) } }, 'Paragraph'),
      createElement('button', { type: 'button', onClick: () => { setMode('checklist'); persistDraft('checklist', paragraph, checklist) } }, 'Checklist'),
    ),
    mode === 'paragraph'
      ? createElement('label', { className: 'grid gap-2', htmlFor: 'new-paragraph' }, 'New paragraph', createElement('textarea', { id: 'new-paragraph', value: paragraph, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setParagraph(event.target.value); persistDraft('paragraph', event.target.value, checklist) } }))
      : createElement('div', { className: 'grid gap-2' }, checklistEditor),
    createElement('button', {
      type: 'button', disabled: busy || (mode === 'paragraph' ? !paragraph.trim() : !checklist.length || !checklist.every((item) => item.text.trim() && item.children.every((child) => child.text.trim()))),
      onClick: () => void append(),
    }, `Append ${mode}`),
    error ? createElement('p', { role: 'alert' }, error) : null,
  )
}
