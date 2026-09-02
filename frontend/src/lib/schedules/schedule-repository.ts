/**
 * Schedule repository —— 日程的本地仓储。
 *
 * 与其余域同一套铁律：写本地行 + 写 outbox 必须在**同一个** `rw` 事务里，
 * 并由 `withSpaceAuthorityFence` 包裹。
 *
 * 已按「TS 接口可选 ≠ 同步 schema 可选」那条守则核对过：
 * schedule 的十个字段在 TS 与 response-schema 里**都是必填**，
 * 不存在 reflection 那种需要补默认值的错配。
 */

import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'
import { buildOutboxIdentity, enqueueOutbox } from '@/lib/sync/outbox'
import type { SpaceAuthorityToken } from '@/lib/sync/space-authority-fence'
import { withSpaceAuthorityFence } from '@/lib/sync/space-authority-fence'
import type { OutboxAction } from '@/lib/sync/types'
import type { CachedSchedule, Schedule } from '@/types'

type Payload = Schedule | { id: string }

interface MutationResult<T> {
  result: T
  payload?: Payload
  /** CAS 期望版本：变更**之前**的 version。 */
  expectedVersion?: number | null
}

export interface CreateScheduleInput {
  id: string
  title: string
  due_at: string
  priority?: Schedule['priority']
  color?: string
  all_day?: boolean
  start_time?: string | null
  end_time?: string | null
}

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).schedules.toArray()
  return rows
    .filter((row) => row.deletion_state !== 'deleted')
    .map(toWire)
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const row = await (spaceDBManager.current as PomodoroXIDB).schedules.get(id)
  if (!row || row.deletion_state === 'deleted') return null
  return toWire(row)
}

/** 带同步字段的原始行，供 store 展示同步状态。 */
export async function listSyncedSchedules(): Promise<CachedSchedule[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).schedules.toArray()
  return rows
    .filter((row) => row.deletion_state !== 'deleted')
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
}

export async function createSchedule(input: CreateScheduleInput): Promise<Schedule> {
  const now = new Date().toISOString()
  const row: CachedSchedule = {
    id: input.id,
    title: input.title,
    due_at: input.due_at,
    completed_at: null,
    priority: input.priority ?? 'medium',
    color: input.color ?? '#3b82f6',
    all_day: input.all_day ?? false,
    start_time: input.start_time ?? null,
    end_time: input.end_time ?? null,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
  }

  return runMutation<Schedule>({ action: 'create', entityId: input.id }, async (database) => {
    await database.schedules.put(row)
    const wire = toWire(row)
    return { result: wire, payload: wire, expectedVersion: null }
  })
}

export async function updateSchedule(
  id: string,
  patch: Partial<Omit<Schedule, 'id'>>,
): Promise<Schedule> {
  return runMutation<Schedule>({ action: 'update', entityId: id }, async (database) => {
    const existing = await requireSchedule(database, id)
    const baseVersion = existing.version ?? 1

    const row: CachedSchedule = {
      ...existing,
      ...patch,
      id,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await database.schedules.put(row)
    const wire = toWire(row)
    return { result: wire, payload: wire, expectedVersion: baseVersion }
  })
}

/** 完成/取消完成。传 null 表示取消完成。 */
export async function completeSchedule(
  id: string,
  completedAt: string | null = new Date().toISOString(),
): Promise<Schedule> {
  return updateSchedule(id, { completed_at: completedAt })
}

export async function deleteSchedule(id: string): Promise<void> {
  await runMutation<void>({ action: 'delete', entityId: id }, async (database) => {
    const existing = await requireSchedule(database, id)
    const baseVersion = existing.version ?? 1

    await database.schedules.put({
      ...existing,
      deletion_state: 'deleted',
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    })
    return { result: undefined, payload: { id }, expectedVersion: baseVersion }
  })
}

async function runMutation<T>(
  context: { action: OutboxAction; entityId: string },
  write: (database: PomodoroXIDB) => Promise<MutationResult<T>>,
): Promise<T> {
  const database = spaceDBManager.current
  return withSpaceAuthorityFence(database.spaceId, (token: SpaceAuthorityToken) =>
    database.transaction('rw', database.schedules, database.outbox, async () => {
      const written = await write(database)
      const hookPayload = written.payload ?? { id: context.entityId }

      await enqueueOutbox(
        database,
        database.spaceId,
        token,
        'schedule',
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

async function requireSchedule(
  database: PomodoroXIDB,
  id: string,
): Promise<CachedSchedule> {
  const row = await database.schedules.get(id)
  if (!row) throw new Error(`schedule not found: ${id}`)
  return row
}

function toWire(row: CachedSchedule): Schedule {
  const { content_hash, deletion_state, version, _dirty, ...schedule } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return schedule
}
