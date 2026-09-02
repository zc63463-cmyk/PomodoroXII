/**
 * Folder repository —— 文件夹的本地仓储。
 *
 * 与 note-repository 同一套铁律：写本地行 + 写 outbox 必须在**同一个**
 * `rw` 事务里，并由 `withSpaceAuthorityFence` 包裹。拆开会在崩溃时产生
 * 「本地改了没入队」或「入队了本地没改」两种脏状态。
 *
 * 与笔记的一处差异：服务端对文件夹施加**层级约束**
 * （`FolderDomainPolicy` 会检测环并拒绝把文件夹移进自己的后代），
 * 所以这里的 move 只负责落本地并如实上报，冲突由服务端裁决 ——
 * 前端不重复实现环检测（树形渲染用的环保护在 folder-selectors 里）。
 */

import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'
import { buildOutboxIdentity, enqueueOutbox } from '@/lib/sync/outbox'
import type { SpaceAuthorityToken } from '@/lib/sync/space-authority-fence'
import { withSpaceAuthorityFence } from '@/lib/sync/space-authority-fence'
import type { OutboxAction } from '@/lib/sync/types'
import type { CachedFolder, Folder } from '@/types'

type FolderPayload = Folder | { id: string }

interface FolderMutationResult<T> {
  result: T
  payload?: FolderPayload
  /** CAS 期望版本：变更**之前**的 version。 */
  expectedVersion?: number | null
}

export interface CreateFolderInput {
  id: string
  name: string
  parent_id?: string | null
  icon?: string | null
  color?: string | null
}

export async function listFolders(): Promise<Folder[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).folders.toArray()
  return rows
    .filter((row) => row.trashed_at == null && row.deletion_state !== 'deleted')
    .map(stripSyncFields)
    .sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name))
}

export async function getFolder(id: string): Promise<Folder | null> {
  const row = await (spaceDBManager.current as PomodoroXIDB).folders.get(id)
  if (!row || row.deletion_state === 'deleted') return null
  return stripSyncFields(row)
}

export async function createFolder(input: CreateFolderInput): Promise<Folder> {
  const now = new Date().toISOString()
  const row: CachedFolder = {
    id: input.id,
    name: input.name,
    parent_id: input.parent_id ?? null,
    icon: input.icon ?? null,
    color: input.color ?? null,
    sort_order: 0,
    is_system: false,
    trashed_at: null,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
  }

  return runFolderMutation<Folder>(
    { action: 'create', entityId: input.id },
    async (database) => {
      await database.folders.put(row)
      const folder = stripSyncFields(row)
      return { result: folder, payload: folder, expectedVersion: null }
    },
  )
}

export async function renameFolder(id: string, name: string): Promise<Folder> {
  return runFolderMutation<Folder>({ action: 'update', entityId: id }, async (database) => {
    const existing = await requireFolder(database, id)
    const baseVersion = existing.version ?? 1

    const row: CachedFolder = {
      ...existing,
      name,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await database.folders.put(row)
    const folder = stripSyncFields(row)
    return { result: folder, payload: folder, expectedVersion: baseVersion }
  })
}

/**
 * 移动文件夹。注意：服务端会拒绝「移到自己的后代」（会成环），
 * 这类冲突由服务端裁决并回传，前端不做预判。
 */
export async function moveFolder(id: string, parent_id: string | null): Promise<Folder> {
  return runFolderMutation<Folder>({ action: 'update', entityId: id }, async (database) => {
    const existing = await requireFolder(database, id)
    const baseVersion = existing.version ?? 1

    const row: CachedFolder = {
      ...existing,
      parent_id,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await database.folders.put(row)
    const folder = stripSyncFields(row)
    return { result: folder, payload: folder, expectedVersion: baseVersion }
  })
}

export async function trashFolder(id: string): Promise<Folder> {
  return runFolderMutation<Folder>({ action: 'update', entityId: id }, async (database) => {
    const existing = await requireFolder(database, id)
    const baseVersion = existing.version ?? 1

    const row: CachedFolder = {
      ...existing,
      trashed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await database.folders.put(row)
    const folder = stripSyncFields(row)
    return { result: folder, payload: folder, expectedVersion: baseVersion }
  })
}

export async function purgeFolder(id: string): Promise<void> {
  await runFolderMutation<void>({ action: 'delete', entityId: id }, async (database) => {
    const existing = await requireFolder(database, id)
    const baseVersion = existing.version ?? 1

    await database.folders.put({
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
// 内部
// --------------------------------------------------------------------------- //

async function runFolderMutation<T>(
  context: { action: OutboxAction; entityId: string; payload?: FolderPayload },
  write: (database: PomodoroXIDB) => Promise<FolderMutationResult<T>>,
): Promise<T> {
  const database = spaceDBManager.current
  return withSpaceAuthorityFence(database.spaceId, (token: SpaceAuthorityToken) =>
    database.transaction('rw', database.folders, database.outbox, async () => {
      const written = await write(database)
      const hookPayload = written.payload ?? context.payload

      if (hookPayload) {
        await enqueueOutbox(
          database,
          database.spaceId,
          token,
          'folder',
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

async function requireFolder(database: PomodoroXIDB, id: string): Promise<CachedFolder> {
  const row = await database.folders.get(id)
  if (!row) throw new Error(`folder not found: ${id}`)
  return row
}

function stripSyncFields(row: CachedFolder): Folder {
  const { content_hash, deletion_state, version, _dirty, ...folder } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return folder
}
