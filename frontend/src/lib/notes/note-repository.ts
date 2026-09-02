/**
 * Note repository — 笔记的本地仓储，复刻小记（quick-note-repository）的同事务铁律。
 *
 * 铁律：写本地行 + 写 outbox 必须落在**同一个** `rw` 事务里，并由
 * `withSpaceAuthorityFence` 包裹。拆成两个事务会在崩溃时产生两种脏状态：
 *   - 本地改了但没入队 → 这次变更永远推不上去（静默丢数据）
 *   - 入队了但本地没改 → 推上去的是过期内容
 *
 * 与服务端的关系：笔记是唯一的 FS_DB_SPLIT 实体，正文落在 notes 目录下的 .md 文件。
 * 本地 Dexie 行的 `content` 是权威副本，push 时随 payload 一起发给服务端；
 * 服务端再编译成 .md 投影 + index.db 索引 + FTS5。
 *
 * 注意：`content_hash` 刻意置为 undefined 与后端对齐 —— 后端在编译期自己算
 * （`KnowledgeDomainPolicy` 用 sha256(content)），前端没有按哈希查询的代码。
 */

import { db, spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'
import { buildOutboxIdentity, enqueueOutbox } from '@/lib/sync/outbox'
import type { SpaceAuthorityToken } from '@/lib/sync/space-authority-fence'
import { withSpaceAuthorityFence } from '@/lib/sync/space-authority-fence'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'
import type { CachedNote, Note } from '@/types'

/** 发给后端的 payload —— 剔除客户端同步 plumbing 字段，但保留 content。 */
type NotePayload = Note | { id: string }

interface NoteMutationContext {
  action: OutboxAction
  entityId: string
  payload?: NotePayload
  /** 置 false 可跳过入队（仅供同步引擎回写本地时使用）。 */
  sync?: boolean
}

interface NoteMutationResult<T> {
  result: T
  payload?: NotePayload
  /** CAS 期望版本：变更**之前**的 version，不是自增后的。 */
  expectedVersion?: number | null
}

export interface NoteCreateInput {
  id: string
  title?: string
  content?: string
  summary?: string
  tags?: string[]
  category?: string | null
  folder_id?: string | null
}

export interface NoteUpdateInput {
  title?: string
  summary?: string
  tags?: string[]
  category?: string | null
  folder_id?: string | null
  status?: 'active' | 'archived'
}

// --------------------------------------------------------------------------- //
// 读取
// --------------------------------------------------------------------------- //

/** 列出未回收的笔记，按更新时间倒序。 */
export async function listNotes(): Promise<Note[]> {
  const rows = await db.notes.toArray()
  return rows
    .filter((row) => row.trashed_at == null && row.deletion_state !== 'deleted')
    .map(stripSyncFields)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

/** 列出回收站中的笔记。 */
export async function listTrashedNotes(): Promise<Note[]> {
  const rows = await db.notes.toArray()
  return rows
    .filter((row) => row.trashed_at != null && row.deletion_state !== 'deleted')
    .map(stripSyncFields)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function getNote(id: string): Promise<Note | null> {
  const row = await db.notes.get(id)
  if (!row || row.deletion_state === 'deleted') return null
  return stripSyncFields(row)
}

/** 取未消费（待推）的实体 id —— 同步引擎与 UI 指示器共用。 */
export async function listPendingNoteIds(): Promise<string[]> {
  const rows = await db.notes.toArray()
  return rows.filter((row) => row._dirty === true).map((row) => row.id)
}

// --------------------------------------------------------------------------- //
// 写入
// --------------------------------------------------------------------------- //

export async function createNote(input: NoteCreateInput): Promise<Note> {
  const now = new Date().toISOString()
  const row: CachedNote = {
    id: input.id,
    title: input.title ?? '',
    content: input.content ?? '',
    summary: input.summary ?? '',
    tags: input.tags ?? [],
    category: input.category ?? null,
    folder_id: input.folder_id ?? null,
    status: 'active',
    trashed_at: null,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
  }

  return runNoteMutation<Note>(
    { action: 'create', entityId: input.id },
    async () => {
      await (spaceDBManager.current as PomodoroXIDB).notes.put(row)
      const note = stripSyncFields(row)
      return { result: note, payload: note, expectedVersion: null }
    },
  )
}

/** 更新元数据 —— 不触碰 content（改名、换文件夹、改标签、归档）。 */
export async function updateNote(id: string, patch: NoteUpdateInput): Promise<Note> {
  return runNoteMutation<Note>({ action: 'update', entityId: id }, async () => {
    const existing = await requireExistingNote(id)
    const baseVersion = existing.version ?? 1

    const row: CachedNote = {
      ...existing,
      ...patch,
      id,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await (spaceDBManager.current as PomodoroXIDB).notes.put(row)
    const note = stripSyncFields(row)
    return { result: note, payload: note, expectedVersion: baseVersion }
  })
}

/**
 * 更新正文 —— 与元数据分开，对应服务端的 `PUT /notes/{id}/content`。
 * 服务端会据此重写 .md、重算 content_hash/word_count 并刷新 FTS5。
 */
export async function updateNoteContent(id: string, content: string): Promise<Note> {
  return runNoteMutation<Note>({ action: 'update', entityId: id }, async () => {
    const existing = await requireExistingNote(id)
    const baseVersion = existing.version ?? 1

    const row: CachedNote = {
      ...existing,
      content,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await (spaceDBManager.current as PomodoroXIDB).notes.put(row)
    const note = stripSyncFields(row)
    return { result: note, payload: note, expectedVersion: baseVersion }
  })
}

/** 软删除：置 trashed_at，仍可恢复。对应 REST 的软删除语义。 */
export async function moveNoteToTrash(id: string): Promise<Note> {
  return runNoteMutation<Note>({ action: 'update', entityId: id }, async () => {
    const existing = await requireExistingNote(id)
    const baseVersion = existing.version ?? 1

    const row: CachedNote = {
      ...existing,
      trashed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await (spaceDBManager.current as PomodoroXIDB).notes.put(row)
    const note = stripSyncFields(row)
    return { result: note, payload: note, expectedVersion: baseVersion }
  })
}

export async function restoreNote(id: string): Promise<Note> {
  return runNoteMutation<Note>({ action: 'update', entityId: id }, async () => {
    const existing = await requireExistingNote(id)
    const baseVersion = existing.version ?? 1

    const row: CachedNote = {
      ...existing,
      trashed_at: null,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await (spaceDBManager.current as PomodoroXIDB).notes.put(row)
    const note = stripSyncFields(row)
    return { result: note, payload: note, expectedVersion: baseVersion }
  })
}

/** 硬删除：本地行 + tombstone。不可恢复。 */
export async function purgeNote(id: string): Promise<void> {
  await runNoteMutation<void>({ action: 'delete', entityId: id }, async () => {
    const existing = await requireExistingNote(id)
    const baseVersion = existing.version ?? 1

    await (spaceDBManager.current as PomodoroXIDB).notes.put({
      ...existing,
      deletion_state: 'deleted',
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    })
    return { result: undefined, payload: { id }, expectedVersion: baseVersion }
  })
}

// --------------------------------------------------------------------------- //
// 内部：事务骨架
// --------------------------------------------------------------------------- //

async function runNoteMutation<T>(
  context: NoteMutationContext,
  write: () => Promise<NoteMutationResult<T>>,
): Promise<T> {
  const database = spaceDBManager.current
  return withSpaceAuthorityFence(database.spaceId, (token: SpaceAuthorityToken) =>
    database.transaction('rw', database.notes, database.outbox, async () => {
      const written = await write()
      const hookPayload = written.payload ?? context.payload

      if (context.sync !== false && hookPayload) {
        await enqueueOutbox(
          database,
          database.spaceId,
          token,
          'note' as SyncEntityType,
          context.entityId,
          context.action,
          hookPayload,
          await buildOutboxIdentity(hookPayload, {
            operationId: crypto.randomUUID(),
            expectedVersion: written.expectedVersion ?? null,
            transportState: 'ready',
            createdAt: new Date().toISOString(),
          }),
        )
      }

      return written.result
    }),
  )
}

async function requireExistingNote(id: string): Promise<CachedNote> {
  const row = await (spaceDBManager.current as PomodoroXIDB).notes.get(id)
  if (!row) throw new Error(`note not found: ${id}`)
  return row
}

/** 剥离客户端同步字段；`content` 保留（服务端需要它来写 .md）。 */
function stripSyncFields(row: CachedNote): Note {
  const { content_hash, deletion_state, version, _dirty, ...note } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return note
}
