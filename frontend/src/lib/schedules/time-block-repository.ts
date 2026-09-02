/**
 * TimeBlock repository —— 时间块的本地仓储。
 *
 * 与其余域同一套铁律：写本地行 + 写 outbox 必须在**同一个** `rw` 事务里，
 * 并由 `withSpaceAuthorityFence` 包裹。
 *
 * 与 Schedule 的差异：时间块以 `date`（YYYY-MM-DD）定位，
 * 同一天可有多块，且允许时段重叠（重叠与否是产品决策，见
 * schedule-selectors 的 timeRangesOverlap —— 仓储层不拦）。
 */

import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'
import { buildOutboxIdentity, enqueueOutbox } from '@/lib/sync/outbox'
import type { SpaceAuthorityToken } from '@/lib/sync/space-authority-fence'
import { withSpaceAuthorityFence } from '@/lib/sync/space-authority-fence'
import type { OutboxAction } from '@/lib/sync/types'
import type { SyncedTimeBlock, TimeBlock } from '@/types'

type Payload = TimeBlock | { id: string }

interface MutationResult<T> {
  result: T
  payload?: Payload
  /** CAS 期望版本：变更**之前**的 version。 */
  expectedVersion?: number | null
}

export interface CreateTimeBlockInput {
  id: string
  title: string
  date: string
  start_time: string
  end_time: string
  planned_duration?: number
  block_type?: TimeBlock['block_type']
}

/** 按日期筛选；不传 date 则返回全部。 */
export async function listTimeBlocks(date?: string): Promise<TimeBlock[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).timeBlocks.toArray()
  return rows
    .filter((row) => row.deletion_state !== 'deleted')
    .filter((row) => date == null || row.date === date)
    .map(toWire)
    .sort((a, b) => (a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date)))
}

export async function getTimeBlock(id: string): Promise<TimeBlock | null> {
  const row = await (spaceDBManager.current as PomodoroXIDB).timeBlocks.get(id)
  if (!row || row.deletion_state === 'deleted') return null
  return toWire(row)
}

/** 带同步字段的原始行，供 store 展示同步状态。 */
export async function listSyncedTimeBlocks(date?: string): Promise<SyncedTimeBlock[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).timeBlocks.toArray()
  return rows
    .filter((row) => row.deletion_state !== 'deleted')
    .filter((row) => date == null || row.date === date)
    .sort((a, b) => (a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date)))
}

export async function createTimeBlock(input: CreateTimeBlockInput): Promise<TimeBlock> {
  const now = new Date().toISOString()
  const row: SyncedTimeBlock = {
    id: input.id,
    title: input.title,
    date: input.date,
    start_time: input.start_time,
    end_time: input.end_time,
    planned_duration: input.planned_duration ?? 0,
    actual_duration: 0,
    block_type: input.block_type ?? 'work',
    status: 'planned',
    sort_order: 0,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
  }

  return runMutation<TimeBlock>({ action: 'create', entityId: input.id }, async (database) => {
    await database.timeBlocks.put(row)
    const wire = toWire(row)
    return { result: wire, payload: wire, expectedVersion: null }
  })
}

export async function updateTimeBlock(
  id: string,
  patch: Partial<Omit<TimeBlock, 'id'>>,
): Promise<TimeBlock> {
  return runMutation<TimeBlock>({ action: 'update', entityId: id }, async (database) => {
    const existing = await requireTimeBlock(database, id)
    const baseVersion = existing.version ?? 1

    const row: SyncedTimeBlock = {
      ...existing,
      ...patch,
      id,
      updated_at: new Date().toISOString(),
      version: baseVersion + 1,
      _dirty: true,
    }

    await database.timeBlocks.put(row)
    const wire = toWire(row)
    return { result: wire, payload: wire, expectedVersion: baseVersion }
  })
}

export async function deleteTimeBlock(id: string): Promise<void> {
  await runMutation<void>({ action: 'delete', entityId: id }, async (database) => {
    const existing = await requireTimeBlock(database, id)
    const baseVersion = existing.version ?? 1

    await database.timeBlocks.put({
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
    database.transaction('rw', database.timeBlocks, database.outbox, async () => {
      const written = await write(database)
      const hookPayload = written.payload ?? { id: context.entityId }

      await enqueueOutbox(
        database,
        database.spaceId,
        token,
        'timeBlock',
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

async function requireTimeBlock(
  database: PomodoroXIDB,
  id: string,
): Promise<SyncedTimeBlock> {
  const row = await database.timeBlocks.get(id)
  if (!row) throw new Error(`time block not found: ${id}`)
  return row
}

function toWire(row: SyncedTimeBlock): TimeBlock {
  const { content_hash, deletion_state, version, _dirty, ...block } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return block
}
