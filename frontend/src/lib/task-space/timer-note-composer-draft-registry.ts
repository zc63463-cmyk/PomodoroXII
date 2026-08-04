import { canonicalize } from 'json-canonicalize'
import { noteBlockSchema, type NoteBlock } from '@/lib/contracts/task-space'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { TimerNoteComposerDraftRow } from '@/types'
import { criticalDraftRegistry, type CriticalDraftDatabase, type DraftFlushReason } from '@/lib/critical-draft-registry'

export interface TimerNoteComposerDraftDatabase extends CriticalDraftDatabase {
  timerNoteComposerDrafts: {
    get(key: [string, string]): Promise<TimerNoteComposerDraftRow | undefined>
    put(row: TimerNoteComposerDraftRow): Promise<unknown>
    delete(key: [string, string]): Promise<unknown>
  }
}

export interface ChecklistDraftItem {
  itemId: string
  text: string
  children: Array<{ itemId: string; text: string; children: [] }>
}

export type TimerNoteComposerDraft = {
  contentVersion: 1
  block:
    | { type: 'paragraph'; blockId: string; text: string }
    | { type: 'checklist'; blockId: string; items: ChecklistDraftItem[] }
}

const emptyParagraph = (blockId = 'paragraph-empty'): TimerNoteComposerDraft => ({
  contentVersion: 1,
  block: { type: 'paragraph', blockId, text: '' },
})

export const paragraphComposerDraft = (text: string, blockId = `paragraph-${text || 'empty'}`): TimerNoteComposerDraft => ({
  contentVersion: 1,
  block: { type: 'paragraph', blockId, text },
})

export const checklistComposerDraft = (
  rootText: string,
  childText = '',
  blockId = 'checklist-draft',
): TimerNoteComposerDraft => ({
  contentVersion: 1,
  block: {
    type: 'checklist', blockId,
    items: [{
      itemId: 'checklist-root', text: rootText,
      children: childText ? [{ itemId: 'checklist-child', text: childText, children: [] }] : [],
    }],
  },
})

function parseDraft(value: unknown): TimerNoteComposerDraft {
  if (!value || typeof value !== 'object') throw new Error('timer_note_draft_invalid')
  const candidate = value as Record<string, unknown>
  if (candidate.contentVersion !== 1 || !candidate.block || typeof candidate.block !== 'object') {
    throw new Error('timer_note_draft_invalid')
  }
  const block = candidate.block as Record<string, unknown>
  if (block.type === 'paragraph' && typeof block.blockId === 'string' && typeof block.text === 'string') {
    return { contentVersion: 1, block: { type: 'paragraph', blockId: block.blockId, text: block.text } }
  }
  if (block.type === 'checklist' && typeof block.blockId === 'string' && Array.isArray(block.items)) {
    return {
      contentVersion: 1,
      block: {
        type: 'checklist', blockId: block.blockId,
        items: block.items.map((item) => {
          if (!item || typeof item !== 'object') throw new Error('timer_note_draft_invalid')
          const row = item as Record<string, unknown>
          if (typeof row.itemId !== 'string' || typeof row.text !== 'string' || !Array.isArray(row.children)) {
            throw new Error('timer_note_draft_invalid')
          }
          return {
            itemId: row.itemId, text: row.text,
            children: row.children.map((child) => {
              if (!child || typeof child !== 'object') throw new Error('timer_note_draft_invalid')
              const nested = child as Record<string, unknown>
              if (typeof nested.itemId !== 'string' || typeof nested.text !== 'string') throw new Error('timer_note_draft_invalid')
              return { itemId: nested.itemId, text: nested.text, children: [] as [] }
            }),
          }
        }),
      },
    }
  }
  throw new Error('timer_note_draft_invalid')
}

function toNoteBlock(draft: TimerNoteComposerDraft): NoteBlock {
  if (draft.block.type === 'paragraph') {
    const text = draft.block.text.trim()
    if (!text) throw new Error('timer_note_paragraph_empty')
    return noteBlockSchema.parse({ type: 'paragraph', blockId: draft.block.blockId, text })
  }
  if (!draft.block.items.length || draft.block.items.some((item) =>
    !item.text.trim() || item.children.some((child) => !child.text.trim()))) {
    throw new Error('timer_note_checklist_empty')
  }
  return noteBlockSchema.parse({
    type: 'checklist', blockId: draft.block.blockId,
    items: draft.block.items.map((item) => ({
      itemId: item.itemId, text: item.text.trim(), checked: false,
      children: item.children.map((child) => ({ itemId: child.itemId, text: child.text.trim(), checked: false, children: [] })),
    })),
  })
}

export class TimerNoteComposerDraftController {
  readonly database: TimerNoteComposerDraftDatabase
  private key: { spaceId: string; workItemId: string }
  private draft: TimerNoteComposerDraft = emptyParagraph()
  private appendState: TimerNoteComposerDraftRow['appendState'] = 'draft'
  private appendOperationId: string | null = null
  private submittedBlock: NoteBlock | null = null
  private unregister: (() => void) | null
  private persistQueue: Promise<void> = Promise.resolve()
  private disposePromise: Promise<void> | null = null

  constructor(
    database: TimerNoteComposerDraftDatabase,
    key: { spaceId: string; workItemId: string },
    private readonly append: (workItemId: string, blocks: NoteBlock[], operationId: string) => Promise<void>,
    private readonly hasAppliedAppendIntent: (workItemId: string, blockId: string, operationId: string) => Promise<boolean>,
  ) {
    this.database = database
    this.key = key
    this.unregister = criticalDraftRegistry.register(this)
  }

  currentDraft(): TimerNoteComposerDraft {
    return structuredClone(this.draft)
  }

  async hydrate(): Promise<TimerNoteComposerDraft> {
    const row = await this.database.timerNoteComposerDrafts.get([this.key.spaceId, this.key.workItemId])
    if (!row) {
      this.draft = emptyParagraph()
      this.appendState = 'draft'
      this.appendOperationId = null
      this.submittedBlock = null
      return this.currentDraft()
    }
    this.draft = parseDraft(JSON.parse(row.draftJson))
    this.appendState = row.appendState
    this.appendOperationId = row.appendOperationId
    this.submittedBlock = row.submittedBlockJson ? noteBlockSchema.parse(JSON.parse(row.submittedBlockJson)) : null
    if (this.appendState !== 'draft') {
      if (!this.appendOperationId || !this.submittedBlock) {
        throw new Error('timer_note_append_intent_corrupt')
      }
      if (await this.hasAppliedAppendIntent(this.key.workItemId, this.submittedBlock.blockId, this.appendOperationId)) {
        await this.clearCommittedDraft()
      } else if (this.appendState === 'committed') {
        throw new Error('timer_note_committed_append_evidence_missing')
      }
    }
    return this.currentDraft()
  }

  async update(next: TimerNoteComposerDraft): Promise<void> {
    this.draft = parseDraft(next)
    this.appendState = 'draft'
    this.appendOperationId = null
    this.submittedBlock = null
    await this.persist()
  }

  async switchTo(key: { spaceId: string; workItemId: string }): Promise<void> {
    const previous = this.key
    await this.flush('current-item-change')
    this.key = key
    try {
      await this.hydrate()
    } catch (error) {
      this.key = previous
      await this.hydrate().catch(() => undefined)
      throw error
    }
  }

  async flush(_reason: DraftFlushReason): Promise<void> {
    await this.persist()
  }

  async appendExplicitly(): Promise<void> {
    if (this.appendState === 'committed') {
      await this.reconcileCommittedAppend()
      return
    }
    if (this.appendState === 'draft') {
      this.appendOperationId = this.appendOperationId ?? crypto.randomUUID()
      this.submittedBlock = toNoteBlock(this.draft)
      this.appendState = 'submitting'
      await this.persist()
    }
    if (this.appendState !== 'submitting' || !this.appendOperationId || !this.submittedBlock) {
      throw new Error('timer_note_append_intent_missing')
    }
    const operationId = this.appendOperationId
    const block = this.submittedBlock
    try {
      await this.append(this.key.workItemId, [block], operationId)
    } catch (error) {
      await this.persist()
      throw error
    }
    this.appendState = 'committed'
    await this.persist()
    await this.clearCommittedDraft()
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = (async () => {
      try {
        await this.flush('unmount')
      } finally {
        this.unregister?.()
        this.unregister = null
      }
    })()
    return this.disposePromise
  }

  private async persist(): Promise<void> {
    const queued = this.persistQueue.catch(() => undefined).then(async () => {
      const draftJson = canonicalize(this.draft)
      const submittedBlockJson = this.submittedBlock ? canonicalize(this.submittedBlock) : null
      if (draftJson === undefined || (this.submittedBlock && submittedBlockJson === undefined)) {
        throw new Error('timer_note_draft_not_canonical')
      }
      await this.database.timerNoteComposerDrafts.put({
        spaceId: this.key.spaceId,
        workItemId: this.key.workItemId,
        contentVersion: 1,
        draftJson,
        appendState: this.appendState,
        appendOperationId: this.appendOperationId,
        submittedBlockJson,
        updatedAt: canonicalNow(),
      })
    })
    this.persistQueue = queued
    await queued
  }

  private async reconcileCommittedAppend(): Promise<void> {
    if (!this.appendOperationId || !this.submittedBlock) {
      throw new Error('timer_note_append_intent_corrupt')
    }
    if (!await this.hasAppliedAppendIntent(this.key.workItemId, this.submittedBlock.blockId, this.appendOperationId)) {
      throw new Error('timer_note_committed_append_evidence_missing')
    }
    await this.clearCommittedDraft()
  }

  private async clearCommittedDraft(): Promise<void> {
    await this.database.timerNoteComposerDrafts.delete([this.key.spaceId, this.key.workItemId])
    this.draft = emptyParagraph()
    this.appendState = 'draft'
    this.appendOperationId = null
    this.submittedBlock = null
  }
}

export function createMemoryTimerNoteDraftDatabase(name: string): TimerNoteComposerDraftDatabase {
  const rows = new Map<string, TimerNoteComposerDraftRow>()
  return {
    name,
    timerNoteComposerDrafts: {
      async get([spaceId, workItemId]) { return rows.get(`${spaceId}:${workItemId}`) },
      async put(row) { rows.set(`${row.spaceId}:${row.workItemId}`, structuredClone(row)) },
      async delete([spaceId, workItemId]) { rows.delete(`${spaceId}:${workItemId}`) },
    },
  }
}
