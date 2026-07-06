/** Phase 2 — Semantic Enhancement & Focus Pattern Recognition
 *
 *  新增类型用于：
 *  1. 标签语义化（Tag 实体 + 层级 + 权重）
 *  2. Task 关系网络（依赖 / 阻塞 / 父子 / 关联）
 *  3. 注意力模式识别（6 种 FocusPattern）
 *  4. Apache Arrow 分析就绪导出
 *
 *  原则：
 *  - 所有新增字段为可选，确保旧数据兼容
 *  - 派生数据（FocusPattern）不上传服务器，仅本地存储
 *  - 标签/关系数据不进入 sync outbox
 */

// ============================================================================
// 1. 标签语义层（Tag Semantic Layer）
// ============================================================================

/** 标签实体（IndexedDB: tags）
 *
 *  从 Task.tags 的扁平字符串数组升级为结构化标签系统。
 *  支持层级（parent-child）、权重、颜色。
 */
export interface Tag {
  id: string                    // 唯一标识（推荐格式：tag_{slug} 或 uuid）
  name: string                  // 显示名称（如 "专注", "代码", "前端"）
  color: string | null           // 十六进制颜色（如 "#E74C3C"）
  parent_id: string | null     // 父标签ID，支持层级（如 "编程" → "前端" → "React"）
  weight: number               // 全局权重 0.0-1.0（用于标签排序/聚类，默认 1.0）
  description: string           // 标签描述
  created_at: string
  updated_at: string
}

/** Task-Tag 关联（IndexedDB: taskTags）
 *
 *  多对多关联表，支持任务级标签权重。
 */
export interface TaskTag {
  id: string                    // 唯一标识
  task_id: string
  tag_id: string
  weight: number                // 该任务上此标签的权重（0.0-1.0，默认 1.0）
  applied_at: string           // 何时应用
  source: 'user' | 'auto' | 'inferred'  // 来源：用户手动 / 自动推断 / 系统推断
}

/** TagRef — Task 上的结构化标签引用
 *
 *  用于在 Task 实体中直接引用标签（可选字段，向后兼容）。
 */
export interface TagRef {
  tag_id: string
  weight: number                // 0.0-1.0
  source: 'user' | 'auto' | 'inferred'
}

/** 标签层级节点（用于树形展示） */
export interface TagNode extends Tag {
  children: TagNode[]           // 子标签递归
  depth: number                 // 层级深度（0 = 根标签）
  task_count: number            // 关联的任务数（派生）
}

// ============================================================================
// 2. Task 关系网络（Task Relation Network）
// ============================================================================

/** Task 关系类型 */
export type TaskRelationType =
  | 'parent'          // from 是 to 的父任务（to 是子任务）
  | 'depends_on'      // from 依赖于 to（to 必须先完成，from 才能开始）
  | 'blocks'          // from 阻塞 to（from 未完成则 to 无法开始）
  | 'related'         // from 与 to 相关（无强依赖，只是关联）
  | 'subtask'         // from 是 to 的子任务（与 parent 方向相反）

/** Task 关系记录（IndexedDB: taskRelations）
 *
 *  使用独立表而非 Task 字段，支持：
 *  - 双向查询（"谁依赖我" / "我依赖谁"）
 *  - 关系加权
 *  - 多对多关系
 */
export interface TaskRelation {
  id: string
  from_task_id: string          // 源任务
  to_task_id: string            // 目标任务
  relation_type: TaskRelationType
  weight: number                // 关系强度 0.0-1.0（默认 1.0）
  description: string            // 关系描述（如"必须先完成登录才能做个人中心"）
  created_at: string
}

/** 任务关系方向（查询辅助） */
export type RelationDirection = 'outgoing' | 'incoming' | 'both'

/** 拓扑排序结果 */
export interface TopoSortResult {
  ordered: string[]              // 排序后的任务 ID 列表
  cycles: string[][]           // 发现的循环（如果有）
  valid: boolean               // 是否无循环
}

// ============================================================================
// 3. 注意力模式（FocusPattern）
// ============================================================================

/** 注意力模式类型 — 6 种识别目标 */
export type FocusPatternType =
  | 'deep_work_block'        // 深度工作块：连续多个 work session 无中断，高注意力
  | 'procrastination_loop'   // 拖延循环：频繁 start/skip/cancel，完成率极低
  | 'fatigue_signal'         // 疲劳信号：注意力持续下降，中断增加，出现疲劳标记
  | 'interruption_recovery'  // 中断恢复模式：被中断后快速恢复（avg_recovery_time < 30s）
  | 'multi_task_switching'   // 多任务切换：频繁在不同 task 之间切换，注意力分散
  | 'flow_state'             // 心流状态：高注意力、无中断、时长 >= 20min、有 flow 标记

/** 模式识别指标 — 具体触发条件的记录 */
export interface PatternIndicator {
  metric: string               // 指标名（如 "attention_score_trend", "completion_rate"）
  value: number | boolean | string  // 实际值
  threshold: number | boolean | string  // 触发阈值
  direction: 'above' | 'below' | 'equals' | 'trend_down' | 'trend_up'  // 比较方向
}

/** 注意力模式实体（IndexedDB: focusPatterns）
 *
 *  从 SessionEvent 流派生计算得出，不上传服务器。
 */
export interface FocusPattern {
  id: string
  type: FocusPatternType
  start_time: string            // ISO 8601，模式开始时间
  end_time: string              // ISO 8601，模式结束时间
  session_ids: string[]         // 参与此模式的 Session ID 列表

  // 识别指标
  confidence: number            // 0.0-1.0，置信度（默认阈值 >= 0.7）
  indicators: PatternIndicator[]  // 具体识别指标（用于解释为什么识别为此模式）

  // 派生统计
  total_duration: number      // 总时长（秒）
  total_sessions: number      // 涉及的 Session 数
  avg_attention_score: number  // 平均注意力分数

  description: string         // 人类可读描述（如"连续3个深度工作块，平均注意力94分"）
  created_at: string
}

/** 模式识别配置 */
export interface FocusPatternConfig {
  // 通用阈值
  minConfidence: number        // 最小置信度（默认 0.7）
  minSessions: number          // 最小 Session 数（跨 Session 模式，默认 2）
  windowMinutes: number        // 滑动窗口分钟数（默认 120）

  // Deep Work Block
  deepWorkMinSessions: number  // 最小连续 Session 数（默认 2）
  deepWorkMinAttention: number // 最小注意力分数（默认 90）
  deepWorkMaxGapMinutes: number // 最大相邻间隔（默认 5）

  // Procrastination Loop
  procrastinationWindowMinutes: number // 检测窗口（默认 30）
  procrastinationMinStarts: number    // 最小 start 次数（默认 3）
  procrastinationMaxCompletionRate: number // 最大完成率（默认 0.5）

  // Fatigue Signal
  fatigueMinConsecutiveSessions: number // 最小连续 Session 数（默认 3）
  fatigueAttentionDropThreshold: number // 注意力下降阈值（默认 15）

  // Interruption Recovery
  recoveryMaxAvgTime: number   // 最大平均恢复时间（秒，默认 30）
  recoveryMaxAttentionDrop: number // 最大恢复后注意力下降（百分比，默认 10）

  // Multi-task Switching
  switchMaxFrequency: number  // 最大切换频率（次/10分钟，默认 1）
  switchMinUniqueTasks: number // 最小不同任务数（默认 3）
  switchMaxAttention: number   // 最大平均注意力（默认 70）

  // Flow State
  flowMinAttention: number     // 最小注意力（默认 85）
  flowMinDuration: number      // 最小时长（秒，默认 1200）
  flowMaxInterruptions: number // 最大中断数（默认 0）
  flowMaxPauses: number        // 最大暂停数（默认 0）
}

/** 模式统计（用于 StatsView 展示） */
export interface PatternStats {
  totalPatterns: number        // 总模式数
  byType: Record<FocusPatternType, number>  // 各类型数量
  avgConfidence: number        // 平均置信度
  mostFrequentType: FocusPatternType | null  // 最频繁的类型
  dateRange: { start: string; end: string }  // 统计时间范围
}

// ============================================================================
// 4. Apache Arrow 分析就绪导出
// ============================================================================

/** Arrow 导出格式 */
export type ArrowExportFormat = 'arrow' | 'feather'

/** 可导出的表名 */
export type ArrowTableName =
  | 'sessions'
  | 'sessionEvents'
  | 'tasks'
  | 'reflections'
  | 'tags'
  | 'taskTags'
  | 'taskRelations'
  | 'focusPatterns'
  | 'cognitiveMarks'
  | 'sessionContexts'

/** Arrow 导出选项 */
export interface ArrowExportOptions {
  format: ArrowExportFormat
  scope: {
    date_range: { start: string; end: string }
    tables: ArrowTableName[]
  }
  privacy: 'full' | 'anonymized' | 'minimal'
}

/** Arrow 导出结果 */
export interface ArrowExportResult {
  blob: Blob
  filename: string
  mimeType: string
  tableSchemas: Record<string, string>  // 表名 → Schema 描述（JSON）
  recordCount: Record<string, number> // 表名 → 记录数
}

// ============================================================================
// 5. 扩展 Phase 1 导出容器（PomodoroXiExport）
// ============================================================================

/** Phase 1 ExportData 的 Phase 2 扩展字段 */
export interface Phase2ExportData {
  tags?: Tag[]
  taskTags?: TaskTag[]
  taskRelations?: TaskRelation[]
  focusPatterns?: FocusPattern[]
}

/** 导出元数据扩展（Schema 版本升级） */
export interface Phase2ExportMeta {
  schema_version: '2.0.0'       // 升级自 Phase 1 的 '1.0.0'
  // ... 其余字段与 Phase 1 ExportMeta 相同
}
