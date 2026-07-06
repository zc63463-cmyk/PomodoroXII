/** Phase 1 — Advanced Metadata & Export Types
 *
 *  新增类型用于：
 *  1. 时序事件采集（SessionEvent, SessionContext, CognitiveMark, MoodSample）
 *  2. 统一导出容器（PomodoroXiExport）
 *  3. 导出格式（JSON-LD, NDJSON）
 *  4. Agent 分析提示（AnalysisHints）
 *
 *  原则：所有类型为纯数据结构，不依赖 Vue reactivity。
 */

import type { Mood, Session, SessionType, Task, Reflection, Habit, HabitCheckIn, TimeBlock } from './index'

// Re-export Mood for convenience
export type { Mood }

// ============================================================================
// 1. 时序事件层（Event Layer）
// ============================================================================

/** 一个 Session 生命周期中发生的所有事件类型 */
export type SessionEventType =
  // --- 生命周期 ---
  | 'session_started'
  | 'session_paused'
  | 'session_resumed'
  | 'session_completed'
  | 'session_skipped'
  | 'session_fast_forwarded'
  | 'session_cancelled'
  // --- 中断 ---
  | 'session_interrupted'
  | 'session_resumed_from_interruption'
  // --- 用户交互 ---
  | 'mood_sampled'
  | 'cognitive_marked'
  | 'note_added'
  | 'plan_updated'
  | 'completion_updated'
  // --- 系统 ---
  | 'audio_started'
  | 'audio_stopped'
  | 'notification_shown'
  | 'notification_clicked'

/** 事件来源标识 */
export type EventSource = 'user' | 'system' | 'inferred'

/** 事件载荷 — 根据 type 不同，payload 包含不同字段 */
export interface EventPayload {
  // 通用字段
  reason?: string
  description?: string

  // session_interrupted
  previous_visible?: boolean

  // session_fast_forwarded
  skipped_seconds?: number
  remaining_before?: number
  remaining_after?: number

  // mood_sampled
  mood?: Mood
  trigger?: string

  // cognitive_marked
  mark_type?: CognitiveMarkType
  confidence?: number

  // audio_started / audio_stopped
  soundscape_type?: string

  // 允许任意扩展
  [key: string]: unknown
}

/** 时序事件记录（IndexedDB: sessionEvents） */
export interface SessionEvent {
  id: string                    // crypto.randomUUID()
  session_id: string
  type: SessionEventType
  timestamp: string             // ISO 8601
  payload: EventPayload
  source: EventSource
}

// ============================================================================
// 2. 环境上下文（Context Layer）
// ============================================================================

/** 设备类型 */
export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown'

/** 环境上下文（IndexedDB: sessionContexts）
 *
 *  每个 Session 一条记录，用户可关闭采集。
 *  所有字段为可选，避免采集失败时数据缺失。
 */
export interface SessionContext {
  id: string                    // 使用 session_id 作为 id（1:1）
  session_id: string

  device_type: DeviceType
  viewport_width: number | null
  viewport_height: number | null
  os: string | null
  browser: string | null
  browser_version: string | null

  tab_visible: boolean | null
  tab_hidden_duration: number | null  // 页面隐藏总时长（秒）

  audio_playing: boolean | null
  audio_type: string | null

  // 采集时间戳
  captured_at: string
}

// ============================================================================
// 3. 认知标记（Cognitive Mark Layer）
// ============================================================================

/** 认知状态类型
 *
 *  Phase 1 (原始): flow, distraction, breakthrough, fatigue, momentum
 *  Phase 2 新增: struggle — 用户感到困难、挣扎的状态
 *
 *  注意：struggle 是 Phase 2 新增类型。如果未来后端同步策略变更，
 *  需要确保后端 schema 也支持此类型。当前数据仅本地存储，不上传服务器。
 */
export type CognitiveMarkType = 'flow' | 'struggle' | 'distraction' | 'breakthrough' | 'fatigue' | 'momentum'

/** 认知标记（IndexedDB: cognitiveMarks）
 *
 *  用户主动标记或系统推断。
 */
export interface CognitiveMark {
  id: string                    // crypto.randomUUID()
  session_id: string
  timestamp: string
  type: CognitiveMarkType
  confidence: number            // 0.0 - 1.0
  source: 'user' | 'inferred'
  context?: string              // 触发上下文（如 "刚刚完成了一个难题"）
}

// ============================================================================
// 4. 心情连续采样（Mood Sample Stream）
// ============================================================================

/** 过程心情采样（可以存储在 sessionEvents 中，type=mood_sampled，
 *  或单独存储。Phase 1 采用 sessionEvents 统一存储，减少表数量。）
 */
export interface MoodSample {
  timestamp: string
  mood: Mood
  trigger?: string
}

// ============================================================================
// 5. Session 增强字段（写入现有 sessions 表，不影响同步）
// ============================================================================

/** 注意力质量指标 — 在 Session 创建/完成后计算并写入 */
export interface SessionMetrics {
  // 注意力质量（0-100）
  attention_score: number | null

  // 心流状态推断
  flow_state_detected: boolean | null
  flow_state_confidence: number | null

  // 中断统计
  interruption_count: number
  total_interruption_duration: number  // 秒

  // 恢复能力：从中断恢复到专注的平均时间
  avg_recovery_time: number | null     // 秒

  // 暂停统计
  pause_count: number
  total_pause_duration: number          // 秒

  // 认知标记汇总
  cognitive_mark_summary: Record<string, number>
}

/** 扩展后的 Session（兼容现有 Session，新增字段均为可选） */
export interface EnhancedSession extends Session {
  // 所有新增字段为可选，确保旧数据兼容
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

// ============================================================================
// 6. 统一导出容器（Export Container）
// ============================================================================

/** 导出类型 */
export type ExportType = 'full' | 'incremental' | 'custom'

/** 导出范围 */
export interface ExportScope {
  date_range: { start: string; end: string }
  entities: ExportEntityType[]
  include_events?: boolean
  include_contexts?: boolean
  include_cognitive_marks?: boolean
}

export type ExportEntityType =
  | 'tasks'
  | 'sessions'
  | 'reflections'
  | 'habits'
  | 'habitCheckIns'
  | 'timeBlocks'
  | 'sessionEvents'
  | 'sessionContexts'
  | 'cognitiveMarks'
  | 'tags'
  | 'taskTags'
  | 'taskRelations'
  | 'focusPatterns'

/** 导出元数据头 */
export interface ExportMeta {
  schema_version: string                // '1.0.0'
  schema_url: string
  export_type: ExportType
  export_scope: ExportScope
  generated_at: string                  // ISO 8601
  generated_by: {
    app_version: string
    user_id: string
    device_id: string
  }
  checksum: string                      // SHA-256
  record_count: number
  // 数据来源声明
  data_provenance: {
    source: 'pomodoroxi-local-indexeddb'
    export_method: 'manual' | 'scheduled' | 'api'
    privacy_level: 'full' | 'anonymized' | 'minimal'
  }
}

/** 导出数据体 */
export interface ExportData {
  tasks: Task[]
  sessions: EnhancedSession[]
  reflections: Reflection[]
  habits: Habit[]
  habitCheckIns: HabitCheckIn[]
  timeBlocks: TimeBlock[]
  sessionEvents?: SessionEvent[]
  sessionContexts?: SessionContext[]
  cognitiveMarks?: CognitiveMark[]
  // Phase 2: semantic enhancement
  tags?: import('./phase2').Tag[]
  taskTags?: import('./phase2').TaskTag[]
  taskRelations?: import('./phase2').TaskRelation[]
  focusPatterns?: import('./phase2').FocusPattern[]
}

/** 图节点 */
export interface GraphNode {
  id: string
  type: string                      // 'task' | 'session' | 'reflection' | 'tag' | 'habit'
  label: string
  properties?: Record<string, unknown>
}

/** 图边 */
export interface GraphEdge {
  source: string                    // 源节点 id
  target: string                    // 目标节点 id
  relation: string                  // 'has_session' | 'depends_on' | 'related_to' 等
  properties?: Record<string, unknown>
}

/** 实体关系图（可选） */
export interface ExportGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ============================================================================
// 7. Agent 分析提示（Analysis Hints）
// ============================================================================

/** 建议分析项 */
export interface SuggestedAnalysis {
  id: string
  title: string
  description: string
  required_entities: ExportEntityType[]
  expected_insights: string[]
  data_quality_requirement: number  // 0-100，最低数据质量分
}

/** 已知数据缺失 */
export interface KnownGap {
  field: string
  reason: string
  impact: 'low' | 'medium' | 'high'
  recommendation: string
}

/** 关键指标速览 */
export interface KeyMetrics {
  total_sessions: number
  total_focus_hours: number
  avg_attention_score: number
  flow_rate: number               // 心流发生率
  interruption_rate: number      // 中断率
  // 可扩展...
  [key: string]: number
}

/** 用户画像摘要 */
export interface UserProfileSnapshot {
  recording_days: number
  peak_hour: number | null
  preferred_session_type: SessionType | null
  most_used_tags: string[]
  avg_daily_pomodoros: number
}

/** Agent 分析提示 */
export interface AnalysisHints {
  suggested_analyses: SuggestedAnalysis[]
  data_quality_score: number       // 0-100
  known_gaps: KnownGap[]
  key_metrics: KeyMetrics
  user_profile: UserProfileSnapshot
}

// ============================================================================
// 8. 统一导出容器（PomodoroXiExport）
// ============================================================================

/** Phase 1 统一导出容器
 *
 *  这是 Agent 消费的入口数据结构。
 */
export interface PomodoroXiExport {
  _meta: ExportMeta
  data: ExportData
  _graph?: ExportGraph
  _analysis_hints?: AnalysisHints
}

// ============================================================================
// 9. 导出格式配置
// ============================================================================

/** 导出格式 */
export type ExportFormatV2 = 'json' | 'json-ld' | 'ndjson' | 'csv' | 'markdown'

/** 导出选项 */
export interface ExportOptionsV2 {
  format: ExportFormatV2
  scope: ExportScope
  privacy: 'full' | 'anonymized' | 'minimal'
  include_graph?: boolean
  include_analysis_hints?: boolean
}

/** 导出结果 */
export interface ExportResultV2 {
  content: string                    // 导出内容（字符串形式）
  blob: Blob                          // 可直接下载的 Blob
  filename: string
  mimeType: string
  meta: ExportMeta
}

// ============================================================================
// 10. JSON-LD 专用类型
// ============================================================================

/** JSON-LD 上下文定义 */
export interface JSONLDContext {
  px: string
  schema: string
  time: string
  xsd: string
  [prefix: string]: string
}

/** JSON-LD 单条记录 */
export interface JSONLDRecord {
  '@context': JSONLDContext | string
  '@type': string
  '@id': string
  [key: string]: unknown
}

// ============================================================================
// 11. NDJSON 专用类型
// ============================================================================

/** NDJSON 记录行类型 */
export type NDJSONRecordType =
  | 'meta'
  | 'task'
  | 'session'
  | 'session_event'
  | 'session_context'
  | 'cognitive_mark'
  | 'reflection'
  | 'habit'
  | 'habit_check_in'
  | 'time_block'
  | 'graph_node'
  | 'graph_edge'
  | 'analysis_hint'

/** NDJSON 单行记录 */
export interface NDJSONRecord {
  record_type: NDJSONRecordType
  [key: string]: unknown
}
