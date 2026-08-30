import Dexie from 'dexie'
import { canonicalize } from 'json-canonicalize'
import { acceptedMutationSchema, parseNoteDocument, workItemNoteSchema, type NoteBlock, type WorkItemNote, type WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { canonicalNow } from '@/lib/direct-command-intents'
import { enqueueOutbox } from '@/lib/sync/outbox'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  withSpaceAuthorityFence,
  type SpaceAuthorityToken,
} from '@/lib/sync/space-authority-fence'
import {
  buildNoteEditDraft,
  clearNoteEditDraft,
  loadNoteEditDraft,
  persistNoteEditDraft,
  type NoteEditDraft,
} from '@/lib/task-space/note-draft-store'
import type { PomodoroXIDB } from '@/services/database'
import { taskSpaceApi } from '@/services/task-space-api'
import type { CachedWorkItemNote, OutboxEvent, WorkItemNoteConflictRow } from '@/types'

export interface SaveLocalNoteInput {
  workItemId: string
  expectedLocalRevision: number
  document: WorkItemNoteDocument
  operationId: string
  now: string
}

export interface AppendBlocksInput {
  workItemId: string
  expectedLocalRevision: number
  blocks: NoteBlock[]
  operationId: string
  now: string
}

export interface ToggleChecklistItemInput {
  workItemId: string
  expectedLocalRevision: number
  blockId: string
  itemId: string
  checked: boolean
  operationId: string
  now: string
}

type NoteApi = Pick<
  typeof taskSpaceApi,
  'getNote' | 'replaceNote' | 'appendBlocks' | 'toggleChecklistItem'
>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const storeRow = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

const storeNoteRow = (value: CachedWorkItemNote): Record<string, unknown> => ({
  id: value.noteId,
  ...value,
})

const valueOf = (raw: Record<string, unknown>, camel: string, snake = camel): unknown =>
  raw[camel] ?? raw[snake]

const acceptedValue = (value: unknown): Record<string, unknown> => {
  if (isRecord(value) && typeof value.commandId === 'string' && 'value' in value) {
    const accepted = acceptedMutationSchema.parse(value)
    return isRecord(accepted.value) ? accepted.value : {}
  }
  return isRecord(value) ? value : {}
}

function notePrimary(value: unknown): Record<string, unknown> {
  const raw = acceptedValue(value)
  for (const key of ['workItemNote', 'work_item_note']) {
    if (isRecord(raw[key])) return raw[key]
  }
  return raw
}

function parseWireNote(value: unknown, spaceId: string, fallback?: Partial<CachedWorkItemNote>): WorkItemNote {
  if (value === null) throw new Error('work_item_note_not_found')
  const raw = notePrimary(value)
  const documentValue = valueOf(raw, 'document')
  const document = documentValue !== undefined
    ? parseNoteDocument(documentValue)
    : parseNoteDocument(valueOf(raw, 'documentJson', 'document_json'))
  const parsed = workItemNoteSchema.parse({
    spaceId,
    noteId: valueOf(raw, 'noteId', 'id') ?? fallback?.noteId,
    workItemId: valueOf(raw, 'workItemId', 'work_item_id') ?? fallback?.workItemId,
    document,
    version: valueOf(raw, 'version') ?? fallback?.version,
    createdAt: valueOf(raw, 'createdAt', 'created_at') ?? fallback?.createdAt,
    updatedAt: valueOf(raw, 'updatedAt', 'updated_at') ?? fallback?.updatedAt,
  })
  return parsed
}

export function serializeWorkItemNoteCommandPostImage(
  row: CachedWorkItemNote,
) {
  // The S4 sync wire format uses the server catalog's snake_case fields
  // (work_item_id / document_json / created_at / updated_at).  document_json
  // must be the EXACT canonical form produced by
  // backend/app/task_space/document.py::canonical_document_json (RFC 8785
  // key-sorted compact JSON, raw UTF-8); the server re-canonicalizes and
  // rejects with `document_json_not_canonical` on any byte difference.
  const documentJson = canonicalize(row.document)
  if (documentJson === undefined) throw new Error('note_document_not_canonical')
  return {
    id: row.noteId,
    work_item_id: row.workItemId,
    document_json: documentJson,
    // The cached row.version is the LAST server-applied version; the sync
    // post-image must carry the NEXT version (before.version + 1) so the
    // server's `invalid_candidate_version` guard passes.
    version: row.version + 1,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function isVersionConflict(error: unknown): boolean {
  if (error instanceof Error && (error.message === 'version_conflict' || error.message.includes('version_conflict'))) return true
  if (!isRecord(error)) return false
  const response = error.response
  return isRecord(response) && response.status === 409
}

function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false
  const response = error.response
  return isRecord(response) && response.status === 404
}

function noteRow(note: WorkItemNote, localRevision: number, syncState: CachedWorkItemNote['syncState']): CachedWorkItemNote {
  return {
    noteId: note.noteId,
    workItemId: note.workItemId,
    document: note.document,
    version: note.version,
    localRevision,
    syncState,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  }
}

export class WorkItemNoteRepository {
  constructor(
    private readonly db: PomodoroXIDB,
    private readonly spaceId: string,
    private readonly api: NoteApi = taskSpaceApi,
  ) {
    if (db.spaceId !== spaceId) throw new Error('work_item_note_repository_database_mismatch')
  }

  async read(workItemId: string): Promise<CachedWorkItemNote | null> {
    const cached = await this.find(workItemId)
    if (cached) return cached
    try {
      const remote = await this.api.getNote(this.spaceId, workItemId)
      if (remote === null) return null
      const note = parseWireNote(remote, this.spaceId)
      const row = noteRow(note, 0, 'clean')
      await this.db.workItemNotes.put(storeNoteRow(row))
      return row
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async saveLocal(input: SaveLocalNoteInput): Promise<CachedWorkItemNote> {
    try {
      return await this.saveLocalAuthorized(input)
    } catch (error) {
      // Durable retryable draft: a failed flush must survive repository/space
      // rebinding and reload, not just the in-memory autosave controller.
      persistNoteEditDraft(buildNoteEditDraft({
        spaceId: this.spaceId,
        workItemId: input.workItemId,
        expectedLocalRevision: input.expectedLocalRevision,
        document: input.document,
        operationId: input.operationId,
        now: input.now,
      }))
      throw error
    }
  }

  private async saveLocalAuthorized(input: SaveLocalNoteInput): Promise<CachedWorkItemNote> {
    return this.withAuthority(async (token) => {
      const document = parseNoteDocument(input.document)
      const payloadHash = await hashCommandPayload({ document })
      const saved = await this.db.transaction('rw', this.db.workItemNotes, this.db.outbox, async () => {
      const current = await this.find(input.workItemId)
      if (!current) throw new Error('work_item_note_not_loaded')
      if (current.syncState === 'conflict') throw new Error('version_conflict')
      if (current.localRevision !== input.expectedLocalRevision) {
        throw new Error('local_version_conflict')
      }
      const next: CachedWorkItemNote = {
        ...current,
        document,
        localRevision: current.localRevision + 1,
        syncState: 'dirty',
        updatedAt: input.now,
      }
      await this.db.workItemNotes.put(storeNoteRow(next))
      await enqueueOutbox(
        this.db, this.spaceId, token, 'workItemNote', current.noteId, 'update',
        serializeWorkItemNoteCommandPostImage(next),
        {
          operationId: input.operationId,
          payloadHash,
          hashPayload: { document },
          expectedVersion: current.version,
          transportState: 'awaiting_s4',
          createdAt: input.now,
        },
      )
      // A successful local save supersedes any durable draft — but only when
      // the saved edit IS the draft, or is strictly NEWER than it.  A stale
      // flush (e.g. an editor blur racing with a newer keystroke) can complete
      // AFTER a newer edit scheduled a fresh draft; clearing that newer draft
      // here would drop the edit on a hard reload inside the debounce window.
      const existingDraft = loadNoteEditDraft(this.spaceId, input.workItemId)
      if (
        existingDraft
        && (
          existingDraft.operationId === input.operationId
          || input.expectedLocalRevision > existingDraft.expectedLocalRevision
        )
      ) {
        clearNoteEditDraft(this.spaceId, input.workItemId)
      }
      return next
      })
      return saved
    })
  }

  /** Durable draft accessors — survive repository/space rebinding and reload. */
  loadDraft(workItemId: string): NoteEditDraft | null {
    return loadNoteEditDraft(this.spaceId, workItemId)
  }

  clearDraft(workItemId: string): void {
    clearNoteEditDraft(this.spaceId, workItemId)
  }

  /** Synchronously persist a durable draft (before the debounced flush). */
  persistDraft(input: {
    workItemId: string
    expectedLocalRevision: number
    document: WorkItemNoteDocument
    operationId: string
    now: string
  }): void {
    persistNoteEditDraft(buildNoteEditDraft({ spaceId: this.spaceId, ...input }))
  }

  /** Re-apply a durable draft if one exists; returns the saved note or null. */
  async retryDraft(workItemId: string): Promise<CachedWorkItemNote | null> {
    const draft = loadNoteEditDraft(this.spaceId, workItemId)
    if (!draft) return null
    try {
      return await this.withAuthority((token) => this.reapplyDraftAuthorized(token, draft))
    } catch {
      // Still pending; the durable draft remains for a later retry.
      return null
    }
  }

  /**
   * Atomically re-apply a durable draft.
   *
   * The guard and the write share one transaction: retryDraft previously read
   * `current` BEFORE opening the save transaction, and the sync engine can
   * reset the row (push terminal → syncState clean/localRevision 0) between
   * those two reads, so saveLocal's strict `localRevision === expected`
   * check threw `local_version_conflict` and the draft was never re-applied.
   * Re-reading once inside the transaction closes that race.
   *
   * Fail-closed: if the row has advanced PAST the draft's base revision, a
   * newer successful save exists and the draft may be stale — keep it durable
   * instead of clobbering newer content.  If the note is at or behind the
   * draft's base (the base save never landed, e.g. a hard reload interrupted
   * an in-flight flush), re-apply the draft over the current state.
   */
  private async reapplyDraftAuthorized(
    token: SpaceAuthorityToken,
    draft: NoteEditDraft,
  ): Promise<CachedWorkItemNote | null> {
    this.assertAuthority(token)
    const document = parseNoteDocument(draft.document)
    const payloadHash = await hashCommandPayload({ document })
    return this.db.transaction('rw', this.db.workItemNotes, this.db.outbox, async () => {
      const current = await this.find(draft.workItemId)
      if (!current) return null
      if (current.syncState === 'conflict') return null
      if (current.localRevision > draft.expectedLocalRevision) return null
      const next: CachedWorkItemNote = {
        ...current,
        document,
        localRevision: current.localRevision + 1,
        syncState: 'dirty',
        updatedAt: draft.now,
      }
      await this.db.workItemNotes.put(storeNoteRow(next))
      await enqueueOutbox(
        this.db, this.spaceId, token, 'workItemNote', current.noteId, 'update',
        serializeWorkItemNoteCommandPostImage(next),
        {
          operationId: draft.operationId,
          payloadHash,
          hashPayload: { document },
          expectedVersion: current.version,
          transportState: 'awaiting_s4',
          createdAt: draft.now,
        },
      )
      clearNoteEditDraft(this.spaceId, draft.workItemId)
      return next
    })
  }

  async dispatchReplace(workItemId: string): Promise<void> {
    return this.withAuthority((token) => this.dispatchReplaceAuthorized(token, workItemId))
  }

  private async dispatchReplaceAuthorized(
    token: SpaceAuthorityToken,
    workItemId: string,
  ): Promise<void> {
    this.assertAuthority(token)
    const sent = await this.find(workItemId)
    if (!sent || sent.syncState !== 'dirty') return
    const row = await this.pendingOutbox(sent.noteId)
    if (!row || row.transportState === 'blocked_conflict') return
    const sentRevision = sent.localRevision
    await this.db.outbox.update(row.id!, { attemptCount: row.attemptCount + 1 })
    try {
      const remote = parseWireNote(await this.api.replaceNote({
        spaceId: this.spaceId,
        workItemId,
        expectedVersion: sent.version,
        document: sent.document,
        operationId: row.operationId,
      }), this.spaceId, sent)
      await this.acknowledge(token, row, sentRevision, remote)
    } catch (error) {
      if (!isVersionConflict(error)) throw error
      const remoteWire = await this.api.getNote(this.spaceId, workItemId)
      const remote = parseWireNote(remoteWire, this.spaceId, sent)
      await this.preserveConflict(token, row, sent, remote)
      throw new Error('version_conflict')
    }
  }

  async appendBlocks(input: AppendBlocksInput): Promise<void> {
    await this.withAuthority(async (token) => {
    await this.applyLocalDocument(token, input, (document) => parseNoteDocument({
      ...document,
      blocks: [...document.blocks, ...input.blocks],
    }))
    await this.dispatchFocused(token, input.workItemId, (row) => this.api.appendBlocks({
      spaceId: this.spaceId,
      workItemId: input.workItemId,
      expectedVersion: row.version,
      blocks: input.blocks,
      operationId: row.operationId,
    }))
    })
  }

  async toggleChecklistItem(input: ToggleChecklistItemInput): Promise<void> {
    await this.withAuthority(async (token) => {
    await this.applyLocalDocument(token, input, (document) => {
      let found = false
      type ChecklistNode = {
        itemId: string
        text: string
        checked: boolean
        children: ChecklistNode[]
      }
      const blocks = document.blocks.map((block) => {
        if (block.type !== 'checklist' || block.blockId !== input.blockId) return block
        const update = (items: ChecklistNode[]): ChecklistNode[] => items.map((item) => {
          if (item.itemId === input.itemId) {
            found = true
            return { ...item, checked: input.checked }
          }
          return { ...item, children: update(item.children) }
        })
        return { ...block, items: update(block.items as unknown as ChecklistNode[]) } as NoteBlock
      })
      if (!found) throw new Error('checklist_item_not_found')
      return parseNoteDocument({ ...document, blocks })
    })
    await this.dispatchFocused(token, input.workItemId, (row) => this.api.toggleChecklistItem({
      spaceId: this.spaceId,
      workItemId: input.workItemId,
      expectedVersion: row.version,
      blockId: input.blockId,
      itemId: input.itemId,
      checked: input.checked,
      operationId: row.operationId,
    }))
    })
  }

  async resolveReloadRemote(workItemId: string): Promise<void> {
    await this.withAuthority(async (token) => {
      this.assertAuthority(token)
      await this.db.transaction(
      'rw', this.db.workItemNotes, this.db.workItemNoteConflicts, this.db.outbox,
      async () => {
        const conflict = await this.conflict(workItemId)
        if (!conflict) throw new Error('conflict_not_found')
        const current = await this.db.workItemNotes.get(conflict.noteId) as CachedWorkItemNote | undefined
        if (!current) throw new Error('work_item_note_not_loaded')
        await this.db.workItemNotes.put(storeNoteRow({
          ...current,
          document: conflict.remoteDocument,
          version: conflict.remoteVersion,
          localRevision: current.localRevision + 1,
          syncState: 'clean',
        }))
        await this.deleteOutbox(token, conflict.noteId)
        await this.db.workItemNoteConflicts.delete(workItemId)
      },
      )
    })
  }

  async resolveOverwriteLocal(workItemId: string): Promise<void> {
    await this.withAuthority(async (token) => {
    const conflict = await this.conflict(workItemId)
    if (!conflict) throw new Error('conflict_not_found')
    const operationId = crypto.randomUUID()
    const createdAt = canonicalNow()
    const payloadHash = await hashCommandPayload({ document: conflict.localDocument })
    await this.db.transaction(
      'rw', this.db.workItemNotes, this.db.workItemNoteConflicts, this.db.outbox,
      async () => {
        const current = await this.db.workItemNotes.get(conflict.noteId) as CachedWorkItemNote | undefined
        if (!current || current.workItemId !== workItemId) throw new Error('work_item_note_not_loaded')
        const next: CachedWorkItemNote = {
          ...current,
          document: conflict.localDocument,
          version: conflict.remoteVersion,
          localRevision: current.localRevision + 1,
          syncState: 'dirty',
          updatedAt: createdAt,
        }
        await this.deleteOutbox(token, conflict.noteId)
        await this.db.workItemNotes.put(storeNoteRow(next))
        await enqueueOutbox(
          this.db, this.spaceId, token, 'workItemNote', conflict.noteId, 'update',
          serializeWorkItemNoteCommandPostImage(next),
          {
            operationId,
            payloadHash,
            hashPayload: { document: conflict.localDocument },
            expectedVersion: conflict.remoteVersion,
            transportState: 'awaiting_s4',
            createdAt,
          },
        )
        await this.db.workItemNoteConflicts.delete(workItemId)
      },
    )
    await this.dispatchReplaceAuthorized(token, workItemId)
    })
  }

  private async applyLocalDocument(
    token: SpaceAuthorityToken,
    input: { workItemId: string; expectedLocalRevision: number; operationId: string; now: string },
    transform: (document: WorkItemNoteDocument) => WorkItemNoteDocument,
  ): Promise<CachedWorkItemNote> {
    this.assertAuthority(token)
    const current = await this.find(input.workItemId)
    if (!current) throw new Error('work_item_note_not_loaded')
    const nextDocument = parseNoteDocument(transform(current.document))
    const payloadHash = await hashCommandPayload({ document: nextDocument })
    return this.db.transaction('rw', this.db.workItemNotes, this.db.outbox, async () => {
      const latest = await this.find(input.workItemId)
      if (!latest) throw new Error('work_item_note_not_loaded')
      if (latest.syncState === 'conflict') throw new Error('version_conflict')
      if (latest.localRevision !== input.expectedLocalRevision) throw new Error('local_version_conflict')
      const next = {
        ...latest,
        document: nextDocument,
        localRevision: latest.localRevision + 1,
        syncState: 'dirty' as const,
        updatedAt: input.now,
      }
      await this.db.workItemNotes.put(storeRow(next))
      await enqueueOutbox(
        this.db, this.spaceId, token, 'workItemNote', latest.noteId, 'update',
        serializeWorkItemNoteCommandPostImage(next),
        {
          operationId: input.operationId,
          payloadHash,
          hashPayload: { document: nextDocument },
          expectedVersion: latest.version,
          transportState: 'awaiting_s4',
          createdAt: input.now,
        },
      )
      return next
    })
  }

  private async dispatchFocused(
    token: SpaceAuthorityToken,
    workItemId: string,
    send: (row: CachedWorkItemNote & { operationId: string }) => Promise<unknown>,
  ): Promise<void> {
    this.assertAuthority(token)
    const sent = await this.find(workItemId)
    if (!sent || sent.syncState !== 'dirty') return
    const row = await this.pendingOutbox(sent.noteId)
    if (!row || row.transportState === 'blocked_conflict') return
    await this.db.outbox.update(row.id!, { attemptCount: row.attemptCount + 1 })
    try {
      const remote = parseWireNote(await send({ ...sent, operationId: row.operationId }), this.spaceId, sent)
      await this.acknowledge(token, row, sent.localRevision, remote)
    } catch (error) {
      if (!isVersionConflict(error)) throw error
      const remote = parseWireNote(await this.api.getNote(this.spaceId, workItemId), this.spaceId, sent)
      await this.preserveConflict(token, row, sent, remote)
      throw new Error('version_conflict')
    }
  }

  private async acknowledge(
    token: SpaceAuthorityToken,
    row: OutboxEvent,
    sentRevision: number,
    remote: WorkItemNote,
  ): Promise<void> {
    this.assertAuthority(token)
    await this.db.transaction('rw', this.db.workItemNotes, this.db.outbox, async () => {
      const current = await this.db.workItemNotes.get(remote.noteId) as CachedWorkItemNote | undefined
      if (!current) return
      await this.db.outbox.delete(row.id!)
      if (current.localRevision === sentRevision) {
        await this.db.workItemNotes.put(storeNoteRow({
          ...current,
          document: remote.document,
          version: remote.version,
          syncState: 'clean',
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
        }))
        return
      }
      const next: CachedWorkItemNote = {
        ...current,
        version: remote.version,
        syncState: 'dirty',
      }
      await this.db.workItemNotes.put(storeNoteRow(next))
      await enqueueOutbox(
        this.db, this.spaceId, token, 'workItemNote', next.noteId, 'update',
        serializeWorkItemNoteCommandPostImage(next),
        {
          operationId: crypto.randomUUID(),
          payloadHash: await Dexie.waitFor(hashCommandPayload({ document: next.document })),
          hashPayload: { document: next.document },
          expectedVersion: remote.version,
          transportState: 'awaiting_s4',
          createdAt: canonicalNow(),
        },
      )
    })
  }

  private async preserveConflict(
    token: SpaceAuthorityToken,
    row: OutboxEvent,
    sent: CachedWorkItemNote,
    remote: WorkItemNote,
  ): Promise<void> {
    this.assertAuthority(token)
    await this.db.transaction(
      'rw', this.db.workItemNotes, this.db.workItemNoteConflicts, this.db.outbox,
      async () => {
        const current = await this.db.workItemNotes.get(sent.noteId) as CachedWorkItemNote | undefined
        if (!current) throw new Error('work_item_note_not_loaded')
        const conflict: WorkItemNoteConflictRow & { id: string } = {
          id: sent.workItemId,
          spaceId: this.spaceId,
          workItemId: sent.workItemId,
          noteId: sent.noteId,
          localDocument: current.document,
          localRevision: current.localRevision,
          baseVersion: sent.version,
          remoteDocument: remote.document,
          remoteVersion: remote.version,
          detectedAt: canonicalNow(),
        }
        await this.db.workItemNoteConflicts.put(storeRow(conflict))
        await this.db.workItemNotes.put(storeNoteRow({ ...current, syncState: 'conflict' }))
        await this.db.outbox.update(row.id!, { transportState: 'blocked_conflict' })
      },
    )
  }

  private async find(workItemId: string): Promise<CachedWorkItemNote | undefined> {
    return await this.db.workItemNotes.where('workItemId').equals(workItemId).first() as CachedWorkItemNote | undefined
  }

  private async conflict(workItemId: string): Promise<(WorkItemNoteConflictRow & { id: string }) | undefined> {
    return await this.db.workItemNoteConflicts.get(workItemId) as (WorkItemNoteConflictRow & { id: string }) | undefined
  }

  private async pendingOutbox(noteId: string): Promise<OutboxEvent | undefined> {
    return await this.db.outbox.where('entityId').equals(noteId).filter((row) =>
      row.entityType === 'workItemNote' && !row.synced,
    ).first()
  }

  private async deleteOutbox(token: SpaceAuthorityToken, noteId: string): Promise<void> {
    this.assertAuthority(token)
    const rows = await this.db.outbox.where('entityId').equals(noteId).filter((row) =>
      row.entityType === 'workItemNote' && !row.synced,
    ).toArray()
    await this.db.outbox.bulkDelete(rows.map((row) => row.id!).filter((id): id is number => id !== undefined))
  }

  private withAuthority<T>(
    work: (token: SpaceAuthorityToken) => Promise<T>,
  ): Promise<T> {
    return withSpaceAuthorityFence(this.spaceId, work)
  }

  private assertAuthority(token: SpaceAuthorityToken): void {
    requireSpaceAuthorityToken(token, this.spaceId)
    requireSpaceDatabaseBinding(this.db, this.spaceId)
  }
}
