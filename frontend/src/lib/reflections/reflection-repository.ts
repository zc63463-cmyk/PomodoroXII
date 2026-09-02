/**
 * Reflection repository —— 反思的本地仓储。
 *
 * 与 note / folder / habit 同一套铁律：写本地行 + 写 outbox 必须在
 * **同一个** `rw` 事务里，并由 `withSpaceAuthorityFence` 包裹。
 *
 * ★ 本域特有的一个坑
 *   `Reflection.sections` 与 `is_structured` 在 TS 接口里是**可选**的，
 *   但同步层的 post-image schema（response-schema.ts 的 reflection 项）是
 *   `z.strictObject` 且把这两个字段列为**必填**。因此构造 payload 时必须
 *   补默认值，否则 push 会被服务端/校验层拒绝 —— 且这种失败发生在同步
 *   阶段，界面上看不出原因。payload 里也**不能多出**任何字段。
 */

import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'
import { buildOutboxIdentity, enqueueOutbox } from '@/lib/sync/outbox'
import type { SpaceAuthorityToken } from '@/lib/sync/space-authority-fence'
import { withSpaceAuthorityFence } from '@/lib/sync/space-authority-fence'
import type { OutboxAction } from '@/lib/sync/types'
import type { CachedReflection, Reflection } from '@/types'

type Payload = Reflection | { id: string }

interface MutationResult<T> {
  result: T
  payload?: Payload
  /** CAS 期望版本：变更**之前**的 version。 */
  expectedVersion?: number | null
}

export interface CreateReflectionInput {
  id: string
  date: string
  content?: string
  mood?: Reflection['mood']
  tags?: string[]
}

// --------------------------------------------------------------------------- //
// 读取
// --------------------------------------------------------------------------- //

export async function listReflections(): Promise<Reflection[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).reflections.toArray()
  return rows
    .filter((row) => row.deletion_state !== 'deleted')
    .map(toWire)
    .sort((a, b) => b.date.localeCompare(a.date))
}

export async function getReflection(id: string): Promise<Reflection | null> {
  const row = await (spaceDBManager.current as PomodoroXIDB).reflections.get(id)
  if (!row || row.deletion_state === 'deleted') return null
  return toWire(row)
}

/** 带同步字段的原始行，供需要展示同步状态的 store 使用。 */
export async function listSyncedReflections(): Promise<CachedReflection[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).reflections.toArray()
  return rows
    .filter((row) => row.deletion_state !== 'deleted')
    .sort((a, b) => b.date.localeCompare(a.date))
}

// --------------------------------------------------------------------------- //
// 写入
// --------------------------------------------------------------------------- //

export async function createReflection(input: CreateReflectionInput): Promise<Reflection> {
  const now = new Date().toISOString()
  const row: CachedReflection = {
    id: input.id,
    date: input.date,
    content: input.content ?? '',
    mood: input.mood ?? null,
    tags: input.tags ?? [],
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
  }

  return runMutation<Reflection>(
    { action: 'create', entityId: input.id },
    async (database) => {
      await database.reflections.put(row)
      const wire = toWire(row)
      return { result: wire, payload: wire, expectedVersion: null }
    },
  )
}

export async function updateReflection(
  id: string,
  patch: Partial<Omit<Reflection, 'id'>>,
): Promise<Reflection> {
  return runMutation<Reflection>({ action: 'update', entityId: id }, async (database) => {
    const existing = await requireReflection(database, id)
    const baseVersion = existing.version ?? 1

    const row: CachedReflection = {
      ...existing,
      ...patch,
      id,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await database.reflections.put(row)
    const wire = toWire(row)
    return { result: wire, payload: wire, expectedVersion: baseVersion }
  })
}

/** 硬删除：置 deletion_state，同步层会把它作为 delete 事件推上去。 */
export async function deleteReflection(id: string): Promise<void> {
  await runMutation<void>({ action: 'delete', entityId: id }, async (database) => {
    const existing = await requireReflection(database, id)
    const baseVersion = existing.version ?? 1

    await database.reflections.put({
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

async function runMutation<T>(
  context: { action: OutboxAction; entityId: string },
  write: (database: PomodoroXIDB) => Promise<MutationResult<T>>,
): Promise<T> {
  const database = spaceDBManager.current
  return withSpaceAuthorityFence(database.spaceId, (token: SpaceAuthorityToken) =>
    database.transaction('rw', database.reflections, database.outbox, async () => {
      const written = await write(database)
      const hookPayload = written.payload ?? { id: context.entityId }

      await enqueueOutbox(
        database,
        database.spaceId,
        token,
        'reflection',
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

      return written.result
    }),
  )
}

async function requireReflection(
  database: PomodoroXIDB,
  id: string,
): Promise<CachedReflection> {
  const row = await database.reflections.get(id)
  if (!row) throw new Error(`reflection not found: ${id}`)
  return row
}

/**
 * 转为同步线格式。
 * 注意补齐 `sections` / `is_structured` —— 它们在 TS 接口里可选，
 * 但同步 schema（strictObject）里必填，缺了 push 会被拒。
 */
function toWire(row: CachedReflection): Reflection {
  const { content_hash, deletion_state, version, _dirty, ...rest } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return {
    ...rest,
    sections: rest.sections ?? [],
    is_structured: rest.is_structured ?? false,
  }
}
