import type { PomodoroXIDB } from '@/services/database'
import { db, spaceDBManager } from '@/services/space-db'
import type { CachedNote, CachedQuickNote, QuickNote } from '@/types'
import {
  isActiveQuickNote,
  isConvertedQuickNote,
  isTrashedQuickNote,
  selectActiveQuickNotes,
  selectTrashedQuickNotes,
} from '@/lib/quick-notes/quick-note-selectors'
import {
  extractQuickNoteTags,
  mergeQuickNoteTags,
} from '@/lib/quick-notes/quick-note-tags'
import { enqueueOutbox } from '@/lib/sync/outbox'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'

export type QuickNoteRepositoryErrorCode =
  | 'not_found'
  | 'not_active'
  | 'not_trashed'
  | 'converted'
  | 'empty_content'
  | 'invalid_patch'

const QUICK_NOTE_ERROR_MESSAGES: Record<
  QuickNoteRepositoryErrorCode,
  { userMessage: string; developerMessage: string }
> = {
  not_found: {
    userMessage: '小记不存在或已被删除',
    developerMessage: 'QuickNote was not found in the local repository',
  },
  not_active: {
    userMessage: '当前小记状态不允许这个操作',
    developerMessage: 'QuickNote operation requires an active row',
  },
  not_trashed: {
    userMessage: '只有回收站中的小记可以执行这个操作',
    developerMessage: 'QuickNote operation requires a trashed row',
  },
  converted: {
    userMessage: '已转为笔记的小记不能再操作',
    developerMessage: 'QuickNote has already been converted to a Note',
  },
  empty_content: {
    userMessage: '小记内容不能为空',
    developerMessage: 'QuickNote content must not be blank',
  },
  invalid_patch: {
    userMessage: '没有可保存的小记改动',
    developerMessage: 'QuickNote update patch does not contain valid fields',
  },
}

export class QuickNoteRepositoryError extends Error {
  public readonly userMessage: string
  public readonly developerMessage: string

  constructor(
    public readonly code: QuickNoteRepositoryErrorCode,
    message?: string,
  ) {
    const messages = QUICK_NOTE_ERROR_MESSAGES[code]
    super(message ?? messages.developerMessage)
    this.name = 'QuickNoteRepositoryError'
    this.userMessage = messages.userMessage
    this.developerMessage = message ?? messages.developerMessage
  }
}

export function getQuickNoteRepositoryUserMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof QuickNoteRepositoryError ? error.userMessage : fallback
}

export interface QuickNoteCreateInput {
  id?: string
  content: string
  mood?: QuickNote['mood']
  tags?: string[]
  pinned?: boolean
  session_id?: string | null
  folder_id?: string | null
  created_at?: string
  updated_at?: string
}

export type QuickNoteUpdateInput = Partial<
  Pick<QuickNote, 'content' | 'mood' | 'tags' | 'pinned' | 'folder_id' | 'session_id'>
> & {
  updated_at?: string
}

export interface QuickNoteMutationContext {
  entityType: Extract<SyncEntityType, 'quickNote'>
  entityId: string
  action: OutboxAction
  payload: QuickNote | { id: string }
}

export interface QuickNoteConvertResult {
  noteId: string
  quickNoteId: string
}

export type QuickNoteSyncStatus = 'pending' | 'failed'

export type QuickNoteLifecycleState =
  | 'active'
  | 'trashed'
  | 'archived'
  | 'converted'
  | 'sync-deleted'

export type QuickNoteOutboxHook = (
  context: QuickNoteMutationContext,
) => Promise<void> | void

type QuickNoteOutboxConfiguration =
  | { kind: 'default' }
  | { kind: 'disabled' }
  | { kind: 'custom'; hook: QuickNoteOutboxHook }

let quickNoteOutboxConfiguration: QuickNoteOutboxConfiguration = { kind: 'default' }

export function configureQuickNoteOutboxHook(
  hook: QuickNoteOutboxHook | null,
): void {
  quickNoteOutboxConfiguration = hook === null
    ? { kind: 'disabled' }
    : { kind: 'custom', hook }
}

export function resetQuickNoteOutboxHook(): void {
  quickNoteOutboxConfiguration = { kind: 'default' }
}

export async function listQuickNotes(query = ''): Promise<QuickNote[]> {
  const rows = await db.quickNotes.toArray()
  return selectActiveQuickNotes(
    rows.filter(isNotSyncDeleted).map(stripSyncFields),
    query,
  )
}

export async function listTrashedQuickNotes(): Promise<QuickNote[]> {
  const rows = await db.quickNotes.toArray()
  return selectTrashedQuickNotes(rows.filter(isNotSyncDeleted).map(stripSyncFields))
}

export async function listQuickNoteSyncStates(): Promise<
  Record<string, QuickNoteSyncStatus>
> {
  const rows = await db.quickNotes.toArray()
  const pendingIds = new Set(
    rows.filter((row) => row._dirty === true).map((row) => row.id),
  )
  const pendingOutbox = await db.outbox
    .filter((event) => event.entityType === 'quickNote' && !event.synced)
    .toArray()
  const failedIds = new Set(
    pendingOutbox
      .filter((event) => event.lastError || event.failedAt)
      .map((event) => event.entityId),
  )

  for (const event of pendingOutbox) pendingIds.add(event.entityId)

  return Object.fromEntries(
    Array.from(pendingIds).map((id) => [
      id,
      failedIds.has(id) ? 'failed' as const : 'pending' as const,
    ]),
  )
}

export async function listQuickNoteLifecycleStates(): Promise<
  Record<string, QuickNoteLifecycleState>
> {
  const rows = await db.quickNotes.toArray()

  return Object.fromEntries(
    rows.map((row) => {
      const note = stripSyncFields(row)
      if (isConvertedQuickNote(note)) return [row.id, 'converted' as const]
      if (note.archived_at !== null) return [row.id, 'archived' as const]
      if (isTrashedQuickNote(note)) return [row.id, 'trashed' as const]
      if (row.deletion_state === 'deleted') return [row.id, 'sync-deleted' as const]
      return [row.id, 'active' as const]
    }),
  )
}

export async function createQuickNote(
  input: QuickNoteCreateInput,
): Promise<QuickNote> {
  const database = spaceDBManager.current

  return database.transaction(
    'rw',
    database.quickNotes,
    database.outbox,
    () => createQuickNoteInTransaction(database, input),
  )
}

/** @internal Call only from a transaction containing quickNotes and outbox. */
export async function createQuickNoteInTransaction(
  database: PomodoroXIDB,
  input: QuickNoteCreateInput,
): Promise<QuickNote> {
  const note = buildQuickNote(input)

  await database.quickNotes.put(toCachedQuickNote(note))
  await runConfiguredQuickNoteOutbox(database, {
    entityType: 'quickNote',
    entityId: note.id,
    action: 'create',
    payload: note,
  })

  return note
}

function buildQuickNote(input: QuickNoteCreateInput): QuickNote {
  const now = new Date().toISOString()
  const content = normalizeContent(input.content)
  return {
    id: input.id ?? crypto.randomUUID(),
    content,
    mood: input.mood ?? null,
    tags: mergeQuickNoteTags(input.tags, extractQuickNoteTags(content)),
    pinned: input.pinned ?? false,
    archived_at: null,
    archive_file_path: null,
    session_id: input.session_id ?? null,
    folder_id: input.folder_id ?? null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  }
}

export async function updateQuickNote(
  id: string,
  input: QuickNoteUpdateInput,
): Promise<QuickNote> {
  const patch = normalizeUpdateInput(input)

  return runQuickNoteMutation({ action: 'update', entityId: id }, async () => {
    const existing = await getExistingQuickNote(id)
    assertActiveForUpdate(stripSyncFields(existing))

    const updatedAt = patch.updated_at ?? new Date().toISOString()
    const row: CachedQuickNote = {
      ...existing,
      ...patch,
      id,
      updated_at: updatedAt,
      deletion_state: deletionStateFor(existing),
      version: (existing.version ?? 1) + 1,
      _dirty: true,
    }

    await db.quickNotes.put(row)
    const note = stripSyncFields(row)
    return { result: note, payload: note }
  })
}

export async function moveQuickNoteToTrash(id: string): Promise<QuickNote> {
  return runQuickNoteMutation({ action: 'update', entityId: id }, async () => {
    const existing = await getExistingQuickNote(id)
    assertActiveForTrash(stripSyncFields(existing))

    const now = new Date().toISOString()
    const row: CachedQuickNote = {
      ...existing,
      trashed_at: now,
      updated_at: now,
      deletion_state: 'deleted',
      version: (existing.version ?? 1) + 1,
      _dirty: true,
    }

    await db.quickNotes.put(row)
    const note = stripSyncFields(row)
    return { result: note, payload: note }
  })
}

export async function restoreQuickNote(id: string): Promise<QuickNote> {
  return runQuickNoteMutation({ action: 'update', entityId: id }, async () => {
    const existing = await getExistingQuickNote(id)
    assertTrashedForRestore(stripSyncFields(existing))

    const now = new Date().toISOString()
    const row: CachedQuickNote = {
      ...existing,
      trashed_at: null,
      updated_at: now,
      deletion_state: 'active',
      version: (existing.version ?? 1) + 1,
      _dirty: true,
    }

    await db.quickNotes.put(row)
    const note = stripSyncFields(row)
    return { result: note, payload: note }
  })
}

export async function purgeQuickNote(id: string): Promise<void> {
  await runQuickNoteMutation({ action: 'delete', entityId: id }, async () => {
    const existing = await getExistingQuickNote(id)
    assertTrashedForPurge(stripSyncFields(existing))
    await db.quickNotes.delete(id)
    return { result: undefined, payload: { id } }
  })
}

export async function convertQuickNoteToNote(id: string): Promise<QuickNoteConvertResult> {
  return db.transaction('rw', db.quickNotes, db.notes, db.outbox, async () => {
    const existing = await getExistingQuickNote(id)
    const source = stripSyncFields(existing)
    assertActiveForConvert(source)

    const now = new Date().toISOString()
    const noteId = crypto.randomUUID()
    const note: CachedNote = {
      id: noteId,
      title: getConversionTitle(source),
      content: source.content,
      summary: getConversionSummary(source.content),
      tags: source.tags,
      category: null,
      folder_id: source.folder_id,
      status: 'active',
      trashed_at: null,
      created_at: now,
      updated_at: now,
      content_hash: undefined,
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    }
    const convertedRow: CachedQuickNote = {
      ...existing,
      archived_at: now,
      migrated_to_note_id: noteId,
      updated_at: now,
      deletion_state: 'active',
      version: (existing.version ?? 1) + 1,
      _dirty: true,
    }

    await db.notes.put(note)
    await db.quickNotes.put(convertedRow)

    await enqueueOutbox(db, 'note', noteId, 'create', stripNoteSyncFields(note))
    await runConfiguredQuickNoteOutbox(db, {
      entityType: 'quickNote',
      entityId: id,
      action: 'update',
      payload: stripSyncFields(convertedRow),
    })

    return { noteId, quickNoteId: id }
  })
}

async function runQuickNoteMutation<T>(
  context: Omit<QuickNoteMutationContext, 'entityType' | 'payload'> & {
    payload?: QuickNote | { id: string }
    sync?: boolean
  },
  write: () => Promise<T | { result: T; payload: QuickNote | { id: string } }>,
): Promise<T> {
  return db.transaction('rw', db.quickNotes, db.outbox, async () => {
    const written = await write()
    const { result, payload } = normalizeQuickNoteMutationResult(written)
    const hookPayload = payload ?? context.payload

    if (context.sync !== false && hookPayload) {
      await runConfiguredQuickNoteOutbox(db, {
        entityType: 'quickNote',
        entityId: context.entityId,
        action: context.action,
        payload: hookPayload,
      })
    }

    return result
  })
}

async function runConfiguredQuickNoteOutbox(
  database: PomodoroXIDB,
  context: QuickNoteMutationContext,
): Promise<void> {
  if (quickNoteOutboxConfiguration.kind === 'disabled') return
  if (quickNoteOutboxConfiguration.kind === 'custom') {
    await quickNoteOutboxConfiguration.hook(context)
    return
  }

  await enqueueOutbox(
    database,
    context.entityType,
    context.entityId,
    context.action,
    context.payload,
  )
}

function normalizeQuickNoteMutationResult<T>(
  written: T | { result: T; payload: QuickNote | { id: string } },
): { result: T; payload?: QuickNote | { id: string } } {
  if (
    written &&
    typeof written === 'object' &&
    'result' in written &&
    'payload' in written
  ) {
    return written as { result: T; payload: QuickNote | { id: string } }
  }

  return { result: written as T }
}

export function stripSyncFields(row: CachedQuickNote): QuickNote {
  const { content_hash, deletion_state, version, _dirty, ...note } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return note
}

function stripNoteSyncFields(row: CachedNote) {
  const { content_hash, deletion_state, version, _dirty, ...note } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return note
}

function toCachedQuickNote(note: QuickNote): CachedQuickNote {
  return {
    ...note,
    content_hash: undefined,
    deletion_state: note.trashed_at ? 'deleted' : 'active',
    version: 1,
    _dirty: true,
  }
}

function deletionStateFor(note: QuickNote): CachedQuickNote['deletion_state'] {
  return note.trashed_at ? 'deleted' : 'active'
}

function isNotSyncDeleted(row: CachedQuickNote): boolean {
  return row.deletion_state !== 'deleted' || row.trashed_at != null
}

async function getExistingQuickNote(id: string): Promise<CachedQuickNote> {
  const existing = await db.quickNotes.get(id)
  if (!existing) {
    throw new QuickNoteRepositoryError('not_found')
  }

  return existing
}

function normalizeContent(content: string): string {
  const normalized = content.trim()
  if (!normalized) throw new QuickNoteRepositoryError('empty_content')
  return normalized
}

function normalizeUpdateInput(input: QuickNoteUpdateInput): QuickNoteUpdateInput {
  const patch: QuickNoteUpdateInput = {}

  if ('content' in input && input.content !== undefined) {
    const content = normalizeContent(input.content)
    patch.content = content
    patch.tags = mergeQuickNoteTags(input.tags, extractQuickNoteTags(content))
  } else if ('tags' in input && input.tags !== undefined) {
    patch.tags = mergeQuickNoteTags(input.tags)
  }

  if ('mood' in input && input.mood !== undefined) patch.mood = input.mood
  if ('pinned' in input && input.pinned !== undefined) patch.pinned = input.pinned
  if ('folder_id' in input && input.folder_id !== undefined) patch.folder_id = input.folder_id
  if ('session_id' in input && input.session_id !== undefined) patch.session_id = input.session_id
  if ('updated_at' in input && input.updated_at !== undefined) patch.updated_at = input.updated_at

  if (Object.keys(patch).length === 0) {
    throw new QuickNoteRepositoryError('invalid_patch')
  }

  return patch
}

function assertActiveForUpdate(note: QuickNote): void {
  if (isConvertedQuickNote(note)) {
    throw new QuickNoteRepositoryError('converted', 'QuickNote update rejected because the row is converted')
  }
  if (!isActiveQuickNote(note)) {
    throw new QuickNoteRepositoryError('not_active', 'QuickNote update rejected because the row is not active')
  }
}

function assertActiveForTrash(note: QuickNote): void {
  if (isConvertedQuickNote(note)) {
    throw new QuickNoteRepositoryError('converted', 'QuickNote trash rejected because the row is converted')
  }
  if (!isActiveQuickNote(note)) {
    throw new QuickNoteRepositoryError('not_active', 'QuickNote trash rejected because the row is not active')
  }
}

function assertActiveForConvert(note: QuickNote): void {
  if (isConvertedQuickNote(note)) {
    throw new QuickNoteRepositoryError('converted', 'QuickNote convert rejected because the row is already converted')
  }
  if (!isActiveQuickNote(note)) {
    throw new QuickNoteRepositoryError('not_active', 'QuickNote convert rejected because the row is not active')
  }
}

function assertTrashedForRestore(note: QuickNote): void {
  if (isConvertedQuickNote(note)) {
    throw new QuickNoteRepositoryError('converted', 'QuickNote restore rejected because the row is converted')
  }
  if (!isTrashedQuickNote(note)) {
    throw new QuickNoteRepositoryError('not_trashed', 'QuickNote restore rejected because the row is not trashed')
  }
}

function assertTrashedForPurge(note: QuickNote): void {
  if (isConvertedQuickNote(note)) {
    throw new QuickNoteRepositoryError('converted', 'QuickNote purge rejected because the row is converted')
  }
  if (!isTrashedQuickNote(note)) {
    throw new QuickNoteRepositoryError('not_trashed', 'QuickNote purge rejected because the row is not trashed')
  }
}

function getConversionTitle(note: QuickNote): string {
  const title = note.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return title?.slice(0, 80) ?? '无标题小记'
}

function getConversionSummary(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n')
    .slice(0, 280)
}
