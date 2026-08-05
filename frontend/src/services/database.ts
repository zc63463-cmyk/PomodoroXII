/**
 * Dexie.js IndexedDB wrapper for offline-first data.
 *
 * Design: F0-A §3.4–§3.5 · s0-1 plan D1–D4
 * - No singleton `export const db` (SpaceDBManager proxy in S0-2).
 * - v16: `content_hash` index + strip `_etag` + default `deletion_state` / `version`.
 * - `deletion_state` ≠ REST `trashed_at` (see types/sync.ts).
 */

import Dexie, { type Table } from 'dexie'
import { dexieDbNameForSpace } from '@/lib/platform'
import { toDexieStoreStrings, V18_STORE_DEFINITIONS } from './dexie-v18-schema'
import type { SessionCommandReceiptView } from '@/lib/contracts/focus-session'
import type {
  CachedReflection,
  CachedReflectionTemplate,
  CachedSchedule,
  CachedQuickNote,
  CachedNote,
  CachedMemoComment,
  CachedScheduleQuickNote,
  CachedFolder,
  SyncedDailyReport,
  SyncedReportTemplate,
  SyncedHabit,
  SyncedHabitCheckIn,
  SyncedTimeBlock,
  OutboxEvent,
  SyncMeta,
  DailyReport,
  ReportTemplate,
  Habit,
  HabitCheckIn,
  TimeBlock,
  ReflectionTemplate,
} from '@/types'

// Re-export for convenience (used by stores that already import from database.ts)
export type { DailyReport, ReportTemplate, Habit, HabitCheckIn, TimeBlock, ReflectionTemplate }

/**
 * Deep-clone an object to strip any reactive Proxy wrappers.
 * IndexedDB's structured clone algorithm cannot serialize Proxy objects,
 * so any reactive ref/computed value passed to db.*.put() must be plain JS.
 */
export function toPlain<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * Tables that participate in client-side sync and therefore receive the
 * `content_hash` index in v16 + the v16 upgrade (fill deletion_state/version).
 * outbox / settings / syncMeta are intentionally excluded — they are local
 * plumbing, not synced entities.
 */
/** Synced entity stores — v16 upgrade iterates these only (F0 §3.4). */
export const V16_SYNC_TABLES = [
  'tasks', 'sessions', 'reflections', 'reports', 'reportTemplates',
  'habits', 'habitCheckIns', 'timeBlocks', 'sessionEvents', 'sessionContexts',
  'cognitiveMarks', 'tags', 'taskTags', 'taskRelations', 'focusPatterns',
  'reflectionTemplates', 'schedules', 'quickNotes', 'notes', 'memoComments',
  'sessionQuickNotes', 'scheduleQuickNotes', 'taskQuickNotes', 'folders',
] as const

export type V16SyncTableName = (typeof V16_SYNC_TABLES)[number]

export class PomodoroXIDB extends Dexie {
  reflections!: Table<CachedReflection>
  outbox!: Table<OutboxEvent>
  settings!: Table<{ key: string; value: string }>
  syncMeta!: Table<SyncMeta>
  tags!: Table<Record<string, unknown>>

  // v6 tables: daily reports, report templates, habits, time blocks
  reports!: Table<SyncedDailyReport>
  reportTemplates!: Table<SyncedReportTemplate>
  habits!: Table<SyncedHabit>
  habitCheckIns!: Table<SyncedHabitCheckIn>
  timeBlocks!: Table<SyncedTimeBlock>

  // v10 tables: reflection templates
  reflectionTemplates!: Table<CachedReflectionTemplate>

  // v11 tables: note-vault integration — schedules, quick notes, notes
  schedules!: Table<CachedSchedule>
  quickNotes!: Table<CachedQuickNote>
  notes!: Table<CachedNote>

  // v12 tables: memo comments + session/schedule ↔ quickNote junction tables
  memoComments!: Table<CachedMemoComment>
  scheduleQuickNotes!: Table<CachedScheduleQuickNote>

  // v15 tables: folder virtual file system
  folders!: Table<CachedFolder>

  // TS3 v18 final business/coordinator tables. Rows are intentionally typed at
  // repository boundaries so the schema can remain one shared Dexie authority.
  projects!: Table<Record<string, unknown>>
  workItems!: Table<Record<string, unknown>>
  workItemNotes!: Table<Record<string, unknown>>
  workItemNoteConflicts!: Table<Record<string, unknown>>
  focusSessions!: Table<Record<string, unknown>>
  sessionTaskContexts!: Table<Record<string, unknown>>
  sessionAttributionRevisions!: Table<Record<string, unknown>>
  sessionWorkItemPlans!: Table<Record<string, unknown>>
  sessionWorkItemOutcomes!: Table<Record<string, unknown>>
  sessionCommandEnvelopes!: Table<Record<string, unknown>>
  sessionCommandReceipts!: Table<SessionCommandReceiptView, [string, number]>
  sessionCommandQueue!: Table<Record<string, unknown>>
  sessionCommandReconciliationAttempts!: Table<Record<string, unknown>>
  sessionReviewDrafts!: Table<Record<string, unknown>>
  sessionActivationConflicts!: Table<Record<string, unknown>>
  sessionActivationApplications!: Table<Record<string, unknown>>
  directCommandIntents!: Table<Record<string, unknown>>
  timerNoteComposerDrafts!: Table<Record<string, unknown>>
  statusDefinitions!: Table<Record<string, unknown>>
  typeDefinitions!: Table<Record<string, unknown>>
  labels!: Table<Record<string, unknown>>
  workItemLabels!: Table<Record<string, unknown>>

  constructor(readonly spaceId: string, dbName = dexieDbNameForSpace(spaceId)) {
    super(dbName)
    if (!spaceId.trim() || dbName !== dexieDbNameForSpace(spaceId)) {
      throw new Error('space_database_identity_mismatch')
    }
    this.version(3).stores({
      tasks: 'id, status, created_at, updated_at, due_date, _dirty',
      sessions: 'id, task_id, started_at, type, synced, _dirty',
      reflections: 'id, date, synced, _dirty',
      outbox: '++id, entityType, entityId, synced, createdAt',
      settings: 'key',
      syncMeta: 'key',
    })
    // version(4): remove stale `synced` index from reflections
    this.version(4).stores({
      reflections: 'id, date, _dirty',
    })
    // version(5): add mood index to sessions for daily mood tracking
    this.version(5).stores({
      sessions: 'id, task_id, started_at, type, synced, _dirty, mood',
    })
    // version(6): reports, report templates, habits, time blocks (v2 features)
    this.version(6).stores({
      reports: 'id, date',
      reportTemplates: 'id, created_at',
      habits: 'id, sort_order, archived_at, created_at',
      habitCheckIns: 'id, habit_id, date',
      timeBlocks: 'id, date, task_id, status, start_minute',
    })
    // version(7): Phase 1 — session events, context, cognitive marks
    this.version(7).stores({
      sessionEvents: '++id, session_id, type, timestamp',
      sessionContexts: 'id, session_id',
      cognitiveMarks: '++id, session_id, type, timestamp',
    })
    // version(8): Phase 2 — tags, taskTags, taskRelations
    this.version(8).stores({
      tags: 'id, name, parent_id, weight, created_at',
      taskTags: 'id, task_id, tag_id, weight, [task_id+tag_id]',
      taskRelations: 'id, from_task_id, to_task_id, relation_type, [from_task_id+relation_type], [to_task_id+relation_type]',
    })
    // version(9): Phase 2 — focus patterns
    this.version(9).stores({
      focusPatterns: 'id, type, start_time, end_time, [type+start_time]',
    })
    // version(10): Reflection enhancement — mood index on reflections + reflection templates
    this.version(10).stores({
      reflections: 'id, date, mood, _dirty',
      reflectionTemplates: 'id, category, use_count, is_builtin',
    })
    // version(11): note-vault integration — schedules, quick notes, notes
    this.version(11).stores({
      schedules: 'id, due_at, completed_at, priority, all_day, _dirty',
      quickNotes: 'id, created_at, mood, pinned, session_id, _dirty',
      notes: 'id, title, updated_at, category, *tags, _dirty',
    })
    // version(12): memo comments + session/schedule ↔ quickNote junction tables
    this.version(12).stores({
      memoComments: 'id, note_id, created_at, _dirty',
      sessionQuickNotes: 'id, session_id, quick_note_id, [session_id+quick_note_id], _dirty',
      scheduleQuickNotes: 'id, schedule_id, quick_note_id, [schedule_id+quick_note_id], _dirty',
    })
    // version(13): task ↔ quickNote junction table
    this.version(13).stores({
      taskQuickNotes: 'id, task_id, quick_note_id, [task_id+quick_note_id], _dirty',
    })
    // version(14): add archived_at index to quickNotes for archive filtering
    this.version(14).stores({
      quickNotes: 'id, created_at, mood, pinned, session_id, archived_at, _dirty',
    })
    // version(15): folder virtual file system + folder_id/trashed_at indexes on notes/quickNotes
    this.version(15).stores({
      folders: 'id, parent_id, sort_order, trashed_at, _dirty',
      notes: 'id, title, updated_at, category, folder_id, status, trashed_at, *tags, _dirty',
      quickNotes: 'id, created_at, mood, pinned, session_id, archived_at, folder_id, trashed_at, migrated_to_note_id, _dirty',
    })
    // version(16): client-side sync layer — add content_hash index to every
    // synced entity table; fill deletion_state/version on upgrade.
    this.version(16).stores({
      tasks: 'id, status, created_at, updated_at, due_date, _dirty, content_hash',
      sessions: 'id, task_id, started_at, type, synced, _dirty, mood, content_hash',
      reflections: 'id, date, mood, _dirty, content_hash',
      reports: 'id, date, content_hash',
      reportTemplates: 'id, created_at, content_hash',
      habits: 'id, sort_order, archived_at, created_at, content_hash',
      habitCheckIns: 'id, habit_id, date, content_hash',
      timeBlocks: 'id, date, task_id, status, start_minute, content_hash',
      sessionEvents: '++id, session_id, type, timestamp, content_hash',
      sessionContexts: 'id, session_id, content_hash',
      cognitiveMarks: '++id, session_id, type, timestamp, content_hash',
      tags: 'id, name, parent_id, weight, created_at, content_hash',
      taskTags: 'id, task_id, tag_id, weight, [task_id+tag_id], content_hash',
      taskRelations: 'id, from_task_id, to_task_id, relation_type, [from_task_id+relation_type], [to_task_id+relation_type], content_hash',
      focusPatterns: 'id, type, start_time, end_time, [type+start_time], content_hash',
      reflectionTemplates: 'id, category, use_count, is_builtin, content_hash',
      schedules: 'id, due_at, completed_at, priority, all_day, _dirty, content_hash',
      quickNotes: 'id, created_at, mood, pinned, session_id, archived_at, folder_id, trashed_at, migrated_to_note_id, _dirty, content_hash',
      notes: 'id, title, updated_at, category, folder_id, status, trashed_at, *tags, _dirty, content_hash',
      memoComments: 'id, note_id, created_at, _dirty, content_hash',
      sessionQuickNotes: 'id, session_id, quick_note_id, [session_id+quick_note_id], _dirty, content_hash',
      scheduleQuickNotes: 'id, schedule_id, quick_note_id, [schedule_id+quick_note_id], _dirty, content_hash',
      taskQuickNotes: 'id, task_id, quick_note_id, [task_id+quick_note_id], _dirty, content_hash',
      folders: 'id, parent_id, sort_order, trashed_at, _dirty, content_hash',
    }).upgrade(async (tx) => {
      // Only runs when an existing DB is upgraded from v15 → v16.
      // For brand-new DBs Dexie creates v16 directly and skips upgrade.
      for (const name of V16_SYNC_TABLES) {
        await tx.table(name).toCollection().modify((row: Record<string, unknown>) => {
          delete row._etag
          if (row.deletion_state == null) {
            row.deletion_state = 'active'
          }
          if (row.version == null) {
            row.version = 1
          }
        })
      }
    })
    // version(17): S3-Task10 - backfill outbox rows with idempotency fields.
    // operationId: UUID for each row.
    // expectedVersion: null for create; payload.version-1 for update/delete with
    //   reliable version (integer >= 2); null for unreliable update/delete.
    // requiresVersionRebase: true for update/delete with no reliable version.
    this.version(17).stores({
      outbox: '++id, entityType, entityId, synced, createdAt',
    }).upgrade(async (tx) => {
      await tx.table('outbox').toCollection().modify((row: Record<string, unknown>) => {
        if (typeof row.operationId !== 'string' || row.operationId.length === 0) {
          row.operationId = crypto.randomUUID()
        }

        const needsExpectedVersion = row.expectedVersion === undefined
        const needsRebaseState = row.requiresVersionRebase === undefined
        if (!needsExpectedVersion && !needsRebaseState) return

        const action = row.action as string
        let expectedVersion: number | null
        let requiresVersionRebase: boolean
        if (action === 'create') {
          expectedVersion = null
          requiresVersionRebase = false
        } else {
          let payloadVersion: unknown = undefined
          try {
            const payload = JSON.parse(row.payload as string) as { version?: unknown }
            payloadVersion = payload.version
          } catch {
            // payload is not valid JSON -- treat as no reliable version
          }
          if (Number.isInteger(payloadVersion) && (payloadVersion as number) >= 2) {
            expectedVersion = (payloadVersion as number) - 1
            requiresVersionRebase = false
          } else {
            expectedVersion = null
            requiresVersionRebase = true
          }
        }

        if (needsExpectedVersion) row.expectedVersion = expectedVersion
        if (needsRebaseState) row.requiresVersionRebase = requiresVersionRebase
      })
      })

    // version(18): TS3 breaking Task Space + FocusSession cutover. The native
    // scan-before-DDL is performed by openPomodoroXIDB; this Dexie declaration
    // mirrors the final store inventory for normal opens and transactions.
    this.version(18).stores(toDexieStoreStrings(V18_STORE_DEFINITIONS))
  }
}
