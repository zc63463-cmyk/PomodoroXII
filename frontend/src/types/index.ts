/** Core type definitions for PomodoroXI. */

// Enums
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'archived'
export type SessionType = 'work' | 'short_break' | 'long_break' | 'free' | 'countdown'
export type Mood = 'great' | 'good' | 'normal' | 'bad' | 'terrible'
export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type ThemeName = 'light' | 'dark' | 'midnight' | 'nord' | 'daylight'
export type SoundscapeType =
  | 'rain' | 'white_noise' | 'pink_noise' | 'brown_noise'
  | 'forest' | 'cafe' | 'fire' | 'waves'
  | 'thunder' | 'wind' | 'stream'
  | 'alpha_waves' | 'beta_waves'
  | 'none'

// Priority metadata
export interface PriorityMeta {
  value: Priority
  label: string
  weight: number
  color: string
  bgColor: string
}

// View modes
export type ViewMode = 'list' | 'board' | 'calendar'

// Sorting
export type SortField = 'created_at' | 'updated_at' | 'priority' | 'due_date' | 'title'
export type SortOrder = 'asc' | 'desc'

export interface SortOption {
  field: SortField
  order: SortOrder
}

// Task filtering
export interface TaskFilter {
  status?: TaskStatus
  priority?: Priority
  tag?: string
  search?: string
  date_from?: string
  date_to?: string
}

// Task statistics
export interface TaskStats {
  total: number
  todo: number
  in_progress: number
  done: number
  archived: number
  total_estimated: number
  total_actual: number
}

// Create/Update task inputs
export interface CreateTaskInput {
  title: string
  description?: string
  priority?: Priority
  estimated_pomodoros?: number
  tags?: string[]
  due_date?: string | null
  plan?: string
  completion?: string
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: Priority
  estimated_pomodoros?: number
  tags?: string[]
  due_date?: string | null
  plan?: string
  completion?: string
  archived_at?: string | null
}

// Task
export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: Priority
  tags: string[]
  plan: string
  completion: string
  due_date: string | null
  estimated_pomodoros: number
  actual_pomodoros: number
  archived_at: string | null
  created_at: string
  updated_at: string
  // Phase 2: structured tag references (optional, backward compatible)
  tag_refs?: { tag_id: string; weight: number; source: 'user' | 'auto' | 'inferred' }[]
}

// Session (Pomodoro)
export interface Session {
  id: string
  task_id: string | null
  type: SessionType
  duration: number
  completed: boolean
  plan: string
  completion: string
  started_at: string
  ended_at: string | null
  synced: boolean
  updated_at: string
  created_at: string
  mood: Mood | null
  note: string
  // Phase 1: enhanced metrics (computed from event stream, optional)
  attention_score?: number | null
  flow_state_detected?: boolean | null
  flow_state_confidence?: number | null
  interruption_count?: number
  total_interruption_duration?: number
  avg_recovery_time?: number | null
  pause_count?: number
  total_pause_duration?: number
  cognitive_mark_summary?: Record<string, number>
}

// Create Session input
export interface CreateSessionInput {
  id?: string
  task_id?: string | null
  type: SessionType
  duration: number
  plan?: string
  completion?: string
  completed?: boolean
  started_at?: string
  ended_at?: string | null
  mood?: Mood | null
  note?: string
  created_at?: string
  updated_at?: string
  // Phase 1: enhanced metrics
  attention_score?: number | null
  flow_state_detected?: boolean | null
  flow_state_confidence?: number | null
  interruption_count?: number
  total_interruption_duration?: number
  avg_recovery_time?: number | null
  pause_count?: number
  total_pause_duration?: number
  cognitive_mark_summary?: Record<string, number>
}

// Reflection — daily review, independent from sessions
export interface Reflection {
  id: string
  date: string
  content: string
  mood: Mood | null
  related_task_ids: string[]
  tags: string[]
  created_at: string
  updated_at: string
  // Phase 2 extensions (optional, backward compatible)
  sections?: import('./reflection-extensions').ReflectionSection[]
  is_structured?: boolean
  auto_linked_session_ids?: string[]
}

// ---- Reflection Templates (v10) ----

/** 反思模板类型分类 */
export type ReflectionTemplateCategory = 'freeform' | '3-2-1' | 'orid' | 'kpt' | 'custom'

/** 反思模板 — 持久化到 IndexedDB，支持使用频次排序 */
export interface ReflectionTemplate {
  id: string                    // 唯一标识（builtin: 'builtin_*', custom: 'tpl_*'）
  name: string                  // 模板名称
  content: string               // 模板内容（Markdown）
  icon: string                  // 图标 emoji
  description: string           // 描述
  category: ReflectionTemplateCategory  // 分类
  use_count: number             // 使用次数（用于频次排序）
  is_builtin: boolean           // 是否内置模板
  created_at: string
  updated_at: string
}

// Settings
export interface TimerSettings {
  workDuration: number
  shortBreak: number
  longBreak: number
  freeDuration: number
  longBreakInterval: number
}

export interface SoundscapePreset {
  type: SoundscapeType
  volume: number
}

export interface SoundscapeConfig {
  enabled: boolean
  masterVolume: number
  presets: Record<SessionType, SoundscapePreset>
  fadeDuration: number
}

export interface AppSettings extends TimerSettings {
  theme: ThemeName
  soundEnabled: boolean
  notificationEnabled: boolean
}

// Full app configuration (localStorage + server)
export interface AppConfig extends TimerSettings {
  theme: ThemeName
  soundEnabled: boolean
  notificationEnabled: boolean
  autoStartBreak: boolean
  autoStartPomodoro: boolean
  weeklyFastForwardQuota: number
  weeklyFastForwardUsed: number
  weeklyFastForwardResetAt: string
  dailyGoal: number
  weeklyGoal: number
  monthlyGoal: number
  soundscape: SoundscapeConfig
  // Phase 1: data & privacy
  contextCaptureEnabled: boolean
  defaultExportPrivacy: 'full' | 'anonymized' | 'minimal'
}

// Timer completion data passed via callback
export interface TimerCompleteData {
  mode: SessionType
  duration: number
  remainingSeconds: number
  completedPomodoros: number
  pomodoroStreak: number
}

// API Pagination
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  per_page: number
  has_more: boolean
}

/** 客户端 sync 层字段；与 REST trashed_at 并存 */
export interface SyncFields {
  content_hash?: string
  deletion_state: 'active' | 'deleted'
  version: number
  _dirty: boolean
}

// Cached entities for IndexedDB
export interface CachedTask extends Task, SyncFields {}

export interface CachedSession extends Session, SyncFields {}

export interface CachedReflection extends Reflection, SyncFields {}

export interface CachedReflectionTemplate extends ReflectionTemplate, SyncFields {}

// ---- Schedule (calendar events with completion status) ----

export type SchedulePriority = 'high' | 'medium' | 'low'

export interface Schedule {
  id: string
  title: string
  due_at: string                     // ISO datetime, calendar positioning
  completed_at: string | null       // completion timestamp (null = pending)
  priority: SchedulePriority
  color: string                      // hex color, e.g. '#ef4444'
  all_day: boolean
  start_time: string | null          // 'HH:mm' or ISO datetime
  end_time: string | null
  created_at: string
  updated_at: string
}

export interface CachedSchedule extends Schedule, SyncFields {}

// ---- QuickNote (rapid capture with optional session link) ----

export type QuickNoteMood = 'normal' | 'happy' | 'sad' | 'tired' | 'excited' | 'calm'

export interface QuickNote {
  id: string
  content: string                    // Markdown
  mood: QuickNoteMood | null
  tags: string[]
  pinned: boolean
  archived_at: string | null
  archive_file_path?: string | null     // 归档文件相对路径（服务端生成，可选）
  session_id: string | null          // optional: link to pomodoro session
  folder_id: string | null           // virtual file system folder
  trashed_at: string | null          // soft delete timestamp
  migrated_to_note_id: string | null // set when converted to a Note
  created_at: string
  updated_at: string
}

export interface CachedQuickNote extends QuickNote, SyncFields {}

// ---- MemoComment (note-vault integration: comment persistence) ----

export interface MemoComment {
  id: string
  note_id: string
  content: string
  created_at: string
  updated_at: string
}

export interface CachedMemoComment extends MemoComment, SyncFields {}

// ---- Session ↔ QuickNote junction (many-to-many) ----

export interface SessionQuickNote {
  id: string
  session_id: string
  quick_note_id: string
  created_at: string
}

export interface CachedSessionQuickNote extends SessionQuickNote, SyncFields {}

// ---- Schedule ↔ QuickNote junction (many-to-many) ----

export interface ScheduleQuickNote {
  id: string
  schedule_id: string
  quick_note_id: string
  created_at: string
}

export interface CachedScheduleQuickNote extends ScheduleQuickNote, SyncFields {}

// ---- Task ↔ QuickNote junction (many-to-many) ----

export interface TaskQuickNote {
  id: string
  task_id: string
  quick_note_id: string
  created_at: string
}

export interface CachedTaskQuickNote extends TaskQuickNote, SyncFields {}

// ---- Note (lightweight knowledge base with category/search) ----

export interface Note {
  id: string
  title: string
  content: string                    // Markdown full text
  summary: string
  tags: string[]
  category: string | null            // flat or path-based category, e.g. 'work/daily'
  folder_id: string | null           // virtual file system folder
  status: 'active' | 'archived'
  trashed_at: string | null          // soft delete timestamp
  created_at: string
  updated_at: string
}

export interface CachedNote extends Note, SyncFields {}

export interface Folder {
  id: string
  name: string
  parent_id: string | null
  icon: string | null
  color: string | null
  sort_order: number
  is_system: boolean
  trashed_at: string | null
  created_at: string
  updated_at: string
}

export interface CachedFolder extends Folder, SyncFields {}

/** Tree node for folder hierarchy rendering. */
export interface FolderTreeNode {
  folder: Folder
  children: FolderTreeNode[]
  noteCount: number
}

// Outbox event for sync
export interface OutboxEvent {
  id?: number
  entityType: 'task' | 'session' | 'reflection' | 'habit' | 'habitCheckIn' | 'timeBlock'
    | 'schedule' | 'quickNote' | 'note' | 'memoComment' | 'folder'
    | 'sessionQuickNote' | 'scheduleQuickNote' | 'taskQuickNote'
  entityId: string
  action: 'create' | 'update' | 'delete'
  payload: string
  createdAt: number
  synced: boolean
}

// Sync meta stored in IndexedDB
export interface SyncMeta {
  key: string
  value: string
}

// Sync engine state
export interface SyncState {
  status: 'idle' | 'syncing' | 'error' | 'conflict' | 'infra-error'
  lastSyncAt: string | null
  pendingCount: number
  direction: 'pull' | 'push' | 'both' | null
  error: string | null
}

// Sync pull response
export interface SyncPullResponse {
  changes: {
    tasks: Task[]
    sessions: Session[]
    reflections: Reflection[]
    schedules: Schedule[]
    quickNotes: QuickNote[]
    notes: Note[]
    memoComments: MemoComment[]
    sessionQuickNotes: SessionQuickNote[]
    scheduleQuickNotes: ScheduleQuickNote[]
    taskQuickNotes: TaskQuickNote[]
    habits: Habit[]
    habitCheckIns: HabitCheckIn[]
    timeBlocks: TimeBlock[]
    folders: Folder[]
  }
  tombstones: Array<{ entity_type: string; entity_id: string; deleted_at: string }>
  server_time: string
  is_full?: boolean
  has_more?: boolean           // P2-4: pagination flag
  next_since?: string | null   // P2-4: cursor for next page
}

// Sync push response
export interface SyncPushResponse {
  applied: number[]
  conflicts: SyncConflict[]
  errors: Array<{
    index: number
    type: string
    action: string
    entity_id: string
    error: string
  }>
  server_time: string
}

// Sync conflict entry
export interface SyncConflict {
  index: number
  type: string
  entity_id: string
  reason: string
  server_time?: string
  client_time?: string
}

// ---- Daily Focus Report ----

/** Day-over-day comparison (today vs yesterday) */
export interface DayOverDay {
  current: number
  previous: number
  change: number       // percentage (absolute value)
  direction: 'up' | 'down' | 'flat'
}

/** Archived daily report snapshot */
export interface DailyReport {
  id: string                    // crypto.randomUUID()
  date: string                  // YYYY-MM-DD
  pomodoros: number             // today's completed work sessions
  focusDuration: number         // today's total focus duration (seconds)
  focusMinutes: number          // focus minutes (rounded)
  streak: number                // consecutive focus days
  moodTrend: Array<{            // 7-day mood snapshot
    date: string
    moodValue: number | null
  }>
  cognitiveMarkTrend?: Array<{  // 7-day cognitive mark trend
    date: string
    dominant: string | null
    total: number
  }>
  dayOverDay: {
    pomodoros: DayOverDay
    duration: DayOverDay
  }
  goalProgress: {
    current: number
    target: number
  }
  createdAt: string             // ISO timestamp
}

// ---- Habit Streak Chain ----

/** 习惯类型 */
export interface Habit {
  id: string                    // crypto.randomUUID()
  title: string                 // 习惯名称
  description: string           // 习惯描述
  color: string                 // 链条颜色 (hex)
  icon: string                  // 习惯图标 (emoji)
  target_count: number          // 每日目标次数 (默认 1)
  rest_day_protection: boolean  // 休息日保护 (跳过该日不中断链条)
  rest_days: number[]           // 休息日 (0=周日, 1=周一...6=周六)
  sort_order: number            // 排序顺序
  archived: boolean             // 是否归档
  created_at: string            // ISO timestamp
  updated_at: string            // ISO timestamp
}

/** 习惯打卡记录 */
export interface HabitCheckIn {
  id: string                    // crypto.randomUUID()
  habit_id: string              // 关联习惯 ID
  date: string                 // YYYY-MM-DD
  count: number                // 打卡次数 (当日可多次)
  note: string                 // 打卡备注
  created_at: string           // ISO timestamp
  updated_at: string           // ISO timestamp
}

/** 习惯链条状态 */
export interface HabitStreakState {
  habitId: string
  currentStreak: number
  longestStreak: number
  lastCheckInDate: string | null
  todayCheckedIn: boolean
  todayCount: number
  todayTarget: number
  isComplete: boolean
  chainBroken: boolean
  heatmap: HabitHeatmapCell[]
}

export interface HabitHeatmapCell {
  date: string
  count: number
  isComplete: boolean
  isRestDay: boolean
  isFuture: boolean
}

// ---- Time Blocking ----

export type TimeBlockStatus = 'planned' | 'in_progress' | 'completed' | 'skipped'

export interface TimeBlock {
  id: string
  task_id: string | null
  title: string
  date: string                   // YYYY-MM-DD
  start_time: string             // HH:mm
  end_time: string               // HH:mm
  planned_duration: number       // 秒
  actual_duration: number       // 秒
  block_type: 'work' | 'short_break' | 'long_break'
  status: TimeBlockStatus
  sort_order: number
  created_at: string
  updated_at: string
}

export interface TimeBlockPlanConfig {
  workDuration: number           // 分钟
  shortBreak: number
  longBreak: number
  longBreakInterval: number
  startTime: string             // HH:mm
  endTime: string               // HH:mm
}

// ---- Custom Report ----

export type ReportDimension = 'date_range' | 'tags' | 'task_type' | 'mood' | 'session_type'
export type ReportFormat = 'markdown' | 'csv' | 'json' | 'ics' | 'png'
export type ReportChartType = 'trend' | 'donut' | 'bar' | 'heatmap' | 'table'

export interface CustomReportConfig {
  name: string
  date_range: { start: string; end: string }
  dimensions: ReportDimension[]
  tags: string[]
  task_ids: string[]
  session_types: SessionType[]
  moods: Mood[]
  charts: ReportChartType[]
  format: ReportFormat
}

export interface ReportTemplate {
  id: string
  name: string
  config: CustomReportConfig
  created_at: string
  updated_at: string
}

export interface GeneratedReport {
  config: CustomReportConfig
  generatedAt: string
  summary: {
    totalSessions: number
    totalDuration: number
    totalPomodoros: number
    avgPerDay: number
    completionRate: number
  }
  charts: Array<{
    type: ReportChartType
    title: string
    data: unknown
  }>
}

export interface EfficiencyBenchmark {
  userValue: number
  benchmarkAvg: number
  benchmarkMedian: number
  benchmarkPercentile: number
  sampleSize: number
}

// Phase 1 — Advanced Metadata & Export Types
// Re-export from phase1.ts for unified import path
// ============================================================================
export * from './phase1'

// ============================================================================
// Phase 2 — Semantic Enhancement & Focus Pattern Recognition
// Re-export from phase2.ts for unified import path
// ============================================================================
export * from './phase2'

// ============================================================================
// Synced 别名 — plain 同步实体附加 SyncFields（用于 database.ts Table 泛型）
// phase1/phase2 的类型通过 export * re-export，但 Synced* 别名定义需要在本
// 文件作用域内引用，故显式 import type。
// ============================================================================
import type { SessionEvent, SessionContext, CognitiveMark } from './phase1'
import type { Tag, TaskTag, TaskRelation, FocusPattern } from './phase2'
export type SyncedDailyReport = DailyReport & SyncFields
export type SyncedReportTemplate = ReportTemplate & SyncFields
export type SyncedHabit = Habit & SyncFields
export type SyncedHabitCheckIn = HabitCheckIn & SyncFields
export type SyncedTimeBlock = TimeBlock & SyncFields
export type SyncedSessionEvent = SessionEvent & SyncFields
export type SyncedSessionContext = SessionContext & SyncFields
export type SyncedCognitiveMark = CognitiveMark & SyncFields
export type SyncedTag = Tag & SyncFields
export type SyncedTaskTag = TaskTag & SyncFields
export type SyncedTaskRelation = TaskRelation & SyncFields
export type SyncedFocusPattern = FocusPattern & SyncFields
