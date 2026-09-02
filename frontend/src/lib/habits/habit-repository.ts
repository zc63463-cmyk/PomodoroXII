/**
 * Habit repository —— 习惯与打卡的本地仓储。
 *
 * 与 note-repository / folder-repository 同一套铁律：写本地行 + 写 outbox
 * 必须在**同一个** `rw` 事务里，并由 `withSpaceAuthorityFence` 包裹。
 * 拆开会在崩溃时产生「本地改了没入队」或「入队了本地没改」两种脏状态。
 *
 * 与笔记/文件夹的差异：打卡是**按 (habit_id, date) 唯一**的计数行，
 * 同一天重复打卡是递增 count，而不是新建一行 —— 否则离线期间多次打卡
 * 会在恢复上线后产生一堆待推事件，且服务端难以合并。
 */

import { spaceDBManager } from '@/services/space-db'
import type { PomodoroXIDB } from '@/services/database'
import { buildOutboxIdentity, enqueueOutbox } from '@/lib/sync/outbox'
import type { SpaceAuthorityToken } from '@/lib/sync/space-authority-fence'
import { withSpaceAuthorityFence } from '@/lib/sync/space-authority-fence'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'
import type { SyncedHabit, SyncedHabitCheckIn, Habit, HabitCheckIn } from '@/types'

type Payload = Habit | HabitCheckIn | { id: string }

interface MutationResult<T> {
  result: T
  payload?: Payload
  /** CAS 期望版本：变更**之前**的 version。 */
  expectedVersion?: number | null
}

export interface CreateHabitInput {
  id: string
  title: string
  description?: string
  color?: string
  icon?: string
  target_count?: number
  rest_day_protection?: boolean
  rest_days?: number[]
}

// --------------------------------------------------------------------------- //
// 习惯
// --------------------------------------------------------------------------- //

/** 默认不返回已归档的习惯 —— 归档等于软删除，不应占据主列表。 */
export async function listHabits(options: { includeArchived?: boolean } = {}): Promise<Habit[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).habits.toArray()
  return rows
    .filter((row) => options.includeArchived || !row.archived)
    .map(stripHabit)
    .sort((a, b) => (a.sort_order - b.sort_order) || a.title.localeCompare(b.title))
}

/**
 * 返回带同步字段的原始行。
 * 与 listHabits 的区别：后者剥离了 `_dirty` / `version` 等，适合渲染；
 * 这里保留，供需要展示同步状态（如待推指示器）的 store 使用。
 */
export async function listSyncedHabits(
  options: { includeArchived?: boolean } = {},
): Promise<SyncedHabit[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).habits.toArray()
  return rows
    .filter((row) => row.deletion_state !== 'deleted')
    .filter((row) => options.includeArchived || !row.archived)
    .sort((a, b) => (a.sort_order - b.sort_order) || a.title.localeCompare(b.title))
}

export async function getHabit(id: string): Promise<Habit | null> {
  const row = await (spaceDBManager.current as PomodoroXIDB).habits.get(id)
  return row ? stripHabit(row) : null
}

export async function createHabit(input: CreateHabitInput): Promise<Habit> {
  const now = new Date().toISOString()
  const row: SyncedHabit = {
    id: input.id,
    title: input.title,
    description: input.description ?? '',
    color: input.color ?? '#3b82f6',
    icon: input.icon ?? '',
    target_count: input.target_count ?? 1,
    rest_day_protection: input.rest_day_protection ?? false,
    rest_days: input.rest_days ?? [],
    sort_order: 0,
    archived: false,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
  }

  return runMutation<Habit>(
    { action: 'create', entityId: input.id, entityType: 'habit' },
    async (database) => {
      await database.habits.put(row)
      const habit = stripHabit(row)
      return { result: habit, payload: habit, expectedVersion: null }
    },
  )
}

export async function updateHabit(id: string, patch: Partial<Omit<Habit, 'id'>>): Promise<Habit> {
  return runMutation<Habit>(
    { action: 'update', entityId: id, entityType: 'habit' },
    async (database) => {
      const existing = await requireHabit(database, id)
      const baseVersion = existing.version ?? 1

      const row: SyncedHabit = {
        ...existing,
        ...patch,
        id,
        updated_at: new Date().toISOString(),
        version: baseVersion + 1,
        _dirty: true,
      }

      await database.habits.put(row)
      const habit = stripHabit(row)
      return { result: habit, payload: habit, expectedVersion: baseVersion }
    },
  )
}

/** 归档 = 软删除（archived=true），可再改回来。 */
export async function archiveHabit(id: string, archived = true): Promise<Habit> {
  return updateHabit(id, { archived })
}

// --------------------------------------------------------------------------- //
// 打卡
// --------------------------------------------------------------------------- //

export async function listCheckIns(habitId?: string): Promise<HabitCheckIn[]> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).habitCheckIns.toArray()
  return rows
    // deletion_state 必须过滤 —— removeCheckIn 归零时是置 deleted 而非物理删除
    .filter((row) => row.deletion_state !== 'deleted')
    .filter((row) => habitId == null || row.habit_id === habitId)
    .map(stripCheckIn)
    .sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 打卡：按 (habit_id, date) 唯一。
 * 已有则递增 count（幂等，重复打卡不会堆事件），没有则新建。
 */
export async function checkIn(habitId: string, date: string, note = ''): Promise<HabitCheckIn> {
  const database = spaceDBManager.current
  const existingRow = await findCheckInRow(habitId, date)

  if (existingRow) {
    return runMutation<HabitCheckIn>(
      { action: 'update', entityId: existingRow.id, entityType: 'habitCheckIn' },
      async (db) => {
        const baseVersion = existingRow.version ?? 1
        const row: SyncedHabitCheckIn = {
          ...existingRow,
          count: existingRow.count + 1,
          note: note || existingRow.note,
          updated_at: new Date().toISOString(),
          version: baseVersion + 1,
          _dirty: true,
        }
        await db.habitCheckIns.put(row)
        const checkIn = stripCheckIn(row)
        return { result: checkIn, payload: checkIn, expectedVersion: baseVersion }
      },
    )
  }

  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const row: SyncedHabitCheckIn = {
    id,
    habit_id: habitId,
    date,
    count: 1,
    note,
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: true,
  }

  return runMutation<HabitCheckIn>(
    { action: 'create', entityId: id, entityType: 'habitCheckIn' },
    async (db) => {
      await db.habitCheckIns.put(row)
      const checkIn = stripCheckIn(row)
      return { result: checkIn, payload: checkIn, expectedVersion: null }
    },
  )
}

/** 撤销一次打卡：count 减到 0 就删除该行，避免留下无意义的空记录。 */
export async function removeCheckIn(habitId: string, date: string): Promise<void> {
  const existingRow = await findCheckInRow(habitId, date)
  if (!existingRow) return

  if (existingRow.count > 1) {
    await runMutation<HabitCheckIn>(
      { action: 'update', entityId: existingRow.id, entityType: 'habitCheckIn' },
      async (db) => {
        const baseVersion = existingRow.version ?? 1
        const row: SyncedHabitCheckIn = {
          ...existingRow,
          count: existingRow.count - 1,
          updated_at: new Date().toISOString(),
          version: baseVersion + 1,
          _dirty: true,
        }
        await db.habitCheckIns.put(row)
        const checkIn = stripCheckIn(row)
        return { result: checkIn, payload: checkIn, expectedVersion: baseVersion }
      },
    )
    return
  }

  await runMutation<void>(
    { action: 'delete', entityId: existingRow.id, entityType: 'habitCheckIn' },
    async (db) => {
      const baseVersion = existingRow.version ?? 1
      await db.habitCheckIns.put({
        ...existingRow,
        deletion_state: 'deleted',
        updated_at: new Date().toISOString(),
        version: baseVersion + 1,
        _dirty: true,
      })
      return { result: undefined, payload: { id: existingRow.id }, expectedVersion: baseVersion }
    },
  )
}

// --------------------------------------------------------------------------- //
// 内部
// --------------------------------------------------------------------------- //

async function findCheckInRow(
  habitId: string,
  date: string,
): Promise<SyncedHabitCheckIn | undefined> {
  const rows = await (spaceDBManager.current as PomodoroXIDB).habitCheckIns.toArray()
  return rows.find(
    (row) => row.habit_id === habitId && row.date === date && row.deletion_state !== 'deleted',
  )
}

async function runMutation<T>(
  context: { action: OutboxAction; entityId: string; entityType: SyncEntityType },
  write: (database: PomodoroXIDB) => Promise<MutationResult<T>>,
): Promise<T> {
  const database = spaceDBManager.current
  return withSpaceAuthorityFence(database.spaceId, (token: SpaceAuthorityToken) =>
    database.transaction(
      'rw',
      database.habits,
      database.habitCheckIns,
      database.outbox,
      async () => {
        const written = await write(database)
        const hookPayload = written.payload ?? { id: context.entityId }

        await enqueueOutbox(
          database,
          database.spaceId,
          token,
          context.entityType,
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
      },
    ),
  )
}

async function requireHabit(database: PomodoroXIDB, id: string): Promise<SyncedHabit> {
  const row = await database.habits.get(id)
  if (!row) throw new Error(`habit not found: ${id}`)
  return row
}

function stripHabit(row: SyncedHabit): Habit {
  const { content_hash, deletion_state, version, _dirty, ...habit } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return habit
}

function stripCheckIn(row: SyncedHabitCheckIn): HabitCheckIn {
  const { content_hash, deletion_state, version, _dirty, ...checkIn } = row
  void content_hash
  void deletion_state
  void version
  void _dirty
  return checkIn
}
