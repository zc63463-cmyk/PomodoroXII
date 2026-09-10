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
import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { syncEngine } from '@/lib/sync'
import { buildOutboxIdentity, enqueueOutbox } from '@/lib/sync/outbox'
import { parseRetainedLwwOutboxPostImage } from '@/lib/sync/response-schema'
import type { SpaceAuthorityToken } from '@/lib/sync/space-authority-fence'
import { withSpaceAuthorityFence } from '@/lib/sync/space-authority-fence'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'
import type { CachedNote, Note, OutboxEvent } from '@/types'

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
// 遗留行归一化与 post-image 白名单
//
// 2026-09-01 前的旧版笔记实现以 camelCase 模型（createdAt/folderId/trashedAt/
// updatedAt）+ 派生元数据（contentHash/wordCount/spaceId）落库。这类行一旦被
// 现行 `updateNote` 的 `...existing` 展开继承，会把非法 payload 塞进 outbox ——
// 同步周期的 S4 admission 校验（freezeOutboxIdentity → strictObject）随即抛
// ZodError，每个周期都在**任何网络请求之前**失败，状态栏永久"同步出错"。
// --------------------------------------------------------------------------- //

/** 同步 post-image 白名单 —— 与 response-schema 的 note strictObject 一一对齐。 */
function toNotePostImage(note: Note): Note {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    summary: note.summary,
    tags: note.tags,
    category: note.category,
    folder_id: note.folder_id,
    status: note.status,
    trashed_at: note.trashed_at,
    created_at: note.created_at,
    updated_at: note.updated_at,
  }
}

function isLegacyNoteRow(row: Record<string, unknown>): boolean {
  return 'createdAt' in row || 'contentHash' in row
    || 'wordCount' in row || 'folderId' in row || 'trashedAt' in row
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value
  return null
}

/** 旧版 camelCase 行 → 现行 snake_case CachedNote（丢弃派生元数据）。 */
function normalizeLegacyNoteRow(row: Record<string, unknown>): CachedNote {
  const read = (snake: string, camel: string): unknown =>
    row[snake] !== undefined ? row[snake] : row[camel]
  const fallbackIso = new Date().toISOString()
  return {
    id: String(row.id ?? ''),
    title: typeof row.title === 'string' ? row.title : '',
    content: typeof row.content === 'string' ? row.content : '',
    summary: typeof row.summary === 'string' ? row.summary : '',
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    category: asStringOrNull(row.category),
    folder_id: asStringOrNull(read('folder_id', 'folderId')),
    status: row.status === 'archived' ? 'archived' : 'active',
    trashed_at: asStringOrNull(read('trashed_at', 'trashedAt')),
    created_at: asStringOrNull(read('created_at', 'createdAt')) ?? fallbackIso,
    updated_at: asStringOrNull(read('updated_at', 'updatedAt')) ?? fallbackIso,
    content_hash: undefined,
    deletion_state: typeof row.deletion_state === 'string'
      ? (row.deletion_state as CachedNote['deletion_state'])
      : 'active',
    version: Number.isSafeInteger(row.version) ? (row.version as number) : 1,
    _dirty: row._dirty === true,
  }
}

/** 每个 Space 只跑一次的修复守卫。 */
const legacyRepairDoneSpaces = new Set<string>()

/**
 * 一次性修复旧版笔记实现留下的脏数据：
 * 1. notes 表内的 camelCase 遗留行 → 归一化为现行 snake_case 模型；
 * 2. outbox 内 payload 不再通过 post-image schema 的未同步 note 行 →
 *    用归一化后的本地行重写 payload 并重算 payloadHash（内容保真，身份字段
 *    operationId/expectedVersion/attemptCount 原样保留，CAS/幂等语义不变）。
 *
 * 在 fence 内执行（与同步周期、笔记写入互斥），写入收拢在单个 rw 事务。
 * 无法修复的情形（实体行缺失、attemptCount>0 的在途行）原样保留，
 * 交由既有 fail-closed 路径暴露，绝不静默丢弃。
 */
export async function repairLegacyNoteSyncState(): Promise<void> {
  const database: PomodoroXIDB = spaceDBManager.current
  if (!database || legacyRepairDoneSpaces.has(database.spaceId)) return
  await withSpaceAuthorityFence(database.spaceId, async () => {
    // 1) 读取 + 计算（事务外，WebCrypto 无需阻塞 Dexie 事务）
    const rawRows = await database.notes.toArray()
    const normalizedById = new Map<string, CachedNote>()
    for (const raw of rawRows as unknown as Array<Record<string, unknown>>) {
      if (!isLegacyNoteRow(raw)) continue
      const normalized = normalizeLegacyNoteRow(raw)
      normalizedById.set(normalized.id, normalized)
    }
    const outboxRows = await database.outbox
      .where('spaceId').equals(database.spaceId)
      .and((e) => e.entityType === 'note' && !e.synced && e.attemptCount === 0)
      .toArray()
    const repairs: Array<{ row: OutboxEvent; payload: string; payloadHash: string }> = []
    for (const row of outboxRows) {
      try {
        parseRetainedLwwOutboxPostImage(
          'note', row.action, JSON.parse(String(row.payload)),
        )
        continue // payload 合法，不动
      } catch {
        // 走修复
      }
      const normalized = normalizedById.get(row.entityId)
      if (!normalized) continue // 无权威本地行可依，保留原状由既有路径暴露
      const postImage = row.action === 'delete'
        ? { id: row.entityId }
        : toNotePostImage(normalized)
      repairs.push({
        row,
        payload: JSON.stringify(postImage),
        payloadHash: await hashCommandPayload(postImage),
      })
    }
    if (normalizedById.size === 0 && repairs.length === 0) {
      legacyRepairDoneSpaces.add(database.spaceId)
      return
    }
    // 2) 写入（单事务：notes 归一化行 + outbox payload/hash 一并落地）
    await database.transaction('rw', database.notes, database.outbox, async () => {
      for (const normalized of normalizedById.values()) {
        await database.notes.put(normalized)
      }
      for (const repair of repairs) {
        await database.outbox.put({
          ...repair.row,
          payload: repair.payload,
          payloadHash: repair.payloadHash,
        })
      }
    })
    legacyRepairDoneSpaces.add(database.spaceId)
    // 3) 修复改变了 outbox 内容 —— 若本轮周期已在此之前失败，补一次同步触发收敛
    void syncEngine.sync().catch((error) => {
      console.error('post-repair sync failed:', error)
    })
  })
}

// --------------------------------------------------------------------------- //
// 读取
// --------------------------------------------------------------------------- //

/** 列出未回收的笔记，按更新时间倒序。 */
export async function listNotes(): Promise<Note[]> {
  void repairLegacyNoteSyncState().catch((error) => {
    console.error('legacy note sync repair failed:', error)
  })
  const rows = await db.notes.toArray()
  return rows
    .filter((row) => row.trashed_at == null && row.deletion_state !== 'deleted')
    .map(stripSyncFields)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

/** 列出回收站中的笔记。 */
export async function listTrashedNotes(): Promise<Note[]> {
  void repairLegacyNoteSyncState().catch((error) => {
    console.error('legacy note sync repair failed:', error)
  })
  const rows = await db.notes.toArray()
  return rows
    .filter((row) => row.trashed_at != null && row.deletion_state !== 'deleted')
    .map(stripSyncFields)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function getNote(id: string): Promise<Note | null> {
  void repairLegacyNoteSyncState().catch((error) => {
    console.error('legacy note sync repair failed:', error)
  })
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
        // post-image 白名单：无论本地行携带过什么历史字段，进入 outbox 的
        // payload 必须与同步 schema 逐字段对齐（delete 仅需 {id}）。
        const postImage = context.action === 'delete'
          ? hookPayload
          : toNotePostImage(hookPayload as Note)
        await enqueueOutbox(
          database,
          database.spaceId,
          token,
          'note' as SyncEntityType,
          context.entityId,
          context.action,
          postImage,
          await buildOutboxIdentity(postImage, {
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
  const row = await db.notes.get(id)
  if (!row) throw new Error(`note not found: ${id}`)
  // 遗留 camelCase 行在此归一化：mutations 的 `...existing` 展开与
  // 入队 payload 都以归一化结果为基，杜绝历史字段再次流入同步管道。
  return normalizeLegacyNoteRow(row as unknown as Record<string, unknown>)
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
