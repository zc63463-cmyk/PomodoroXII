# Phase 2 设计文档：语义增强 + 注意力模式识别 + 分析就绪数据包

> 版本: v1.0 | 对应报告阶段二（Month 3-4）
> 前置依赖: Phase 1 已完成（时序事件、统一导出、分析提示）

## 1. 设计目标

Phase 2 的核心目标：在 Phase 1 的元数据基础上，建立**语义增强层**和**注意力模式识别能力**，使数据从"可记录"升级为"可理解"。

具体目标：
1. **标签语义化**：从扁平字符串数组升级为带层级、权重、颜色的结构化标签系统
2. **Task 关系网络**：建立任务间的依赖、阻塞、父子关系图
3. **FocusPattern 识别**：从事件流中自动识别 6 种注意力模式
4. **Arrow 分析就绪导出**：将数据导出为 Apache Arrow IPC 格式，供 Python/Pandas/Polars 直接消费
5. **零破坏迁移**：所有新增字段为可选，旧数据完全兼容

## 2. 设计原则

- **向后兼容**：Task.tags 保持 `string[]`，新增 `tagRefs` 为可选字段
- **纯计算派生**：FocusPattern 是 SessionEvent 的派生数据，不写入同步 outbox
- **离线优先**：所有标签/关系/模式存储在 IndexedDB，不上传服务器
- **渐进式增强**：旧用户不感知新功能，新用户逐步启用

## 3. 新增数据实体

### 3.1 标签语义层（Tag Semantic Layer）

#### 3.1.1 Tag 实体（IndexedDB: tags）

```typescript
interface Tag {
  id: string                    // 唯一标识（如 "tag_focus", "tag_code"）
  name: string                  // 显示名称（如 "专注", "代码"）
  color: string | null          // 十六进制颜色（如 "#E74C3C"）
  parent_id: string | null     // 父标签ID，支持层级（如 "编程" → "前端" → "React"）
  weight: number               // 全局权重 0.0-1.0（用于标签排序/聚类）
  description: string           // 标签描述
  created_at: string
  updated_at: string
}
```

#### 3.1.2 Task-Tag 关联（IndexedDB: taskTags）

```typescript
interface TaskTag {
  id: string                    // 复合ID或直接uuid
  task_id: string
  tag_id: string
  weight: number                // 该任务上此标签的权重（0.0-1.0，默认1.0）
  applied_at: string           // 何时应用
  source: 'user' | 'auto' | 'inferred'  // 来源
}
```

#### 3.1.3 TagRef（Task 上的引用）

```typescript
interface TagRef {
  tag_id: string
  weight: number                // 0.0-1.0
  source: 'user' | 'auto' | 'inferred'
}
```

**向后兼容策略**：
- Task.tags 保持 `string[]`（字符串标签名）—— 用于 UI 快速显示和搜索
- 新增 Task.tag_refs?: TagRef[] —— 用于结构化分析和导出
- 当用户编辑 Task 标签时，系统同步：
  1. 更新 Task.tags（字符串数组）
  2. 创建/更新 Tag 实体（如果不存在）
  3. 写入 taskTags 关联表
- 导入旧数据时：字符串标签自动映射为 Tag 实体（name 作为 id，默认权重 1.0）

### 3.2 Task 关系网络（Task Relation Network）

#### 3.2.1 TaskRelation 实体（IndexedDB: taskRelations）

```typescript
interface TaskRelation {
  id: string
  from_task_id: string          // 源任务
  to_task_id: string            // 目标任务
  relation_type: TaskRelationType
  weight: number                // 关系强度 0.0-1.0
  description: string            // 关系描述（如"必须先完成登录才能做个人中心"）
  created_at: string
}

type TaskRelationType =
  | 'parent'          // from 是 to 的父任务
  | 'depends_on'      // from 依赖于 to（to 必须先完成）
  | 'blocks'          // from 阻塞 to（from 未完成则 to 无法开始）
  | 'related'         // from 与 to 相关（无强依赖，只是关联）
  | 'subtask'         // from 是 to 的子任务
```

**为什么用独立表而非 Task 字段？**

| 方案 | 优点 | 缺点 |
|------|------|------|
| Task 字段（parent_id + depends_on[]） | 简单直观 | 无法表达多对多、双向查询困难 |
| **独立表（TaskRelation）** | 双向查询、关系可加权、支持多类型、不污染 Task | 需要额外 JOIN/查询 | ✓ 选中 |

**查询模式**：
- "这个任务阻塞了谁？" → `taskRelations.where('from_task_id').equals(id).and(r => r.relation_type === 'blocks')`
- "这个任务被谁阻塞？" → `taskRelations.where('to_task_id').equals(id).and(r => r.relation_type === 'blocks')`
- "这个任务的所有子任务？" → `taskRelations.where('from_task_id').equals(id).and(r => r.relation_type === 'parent')`

### 3.3 注意力模式（FocusPattern）

#### 3.3.1 FocusPattern 实体（IndexedDB: focusPatterns）

```typescript
interface FocusPattern {
  id: string
  type: FocusPatternType
  start_time: string            // ISO 8601，模式开始时间
  end_time: string              // ISO 8601，模式结束时间
  session_ids: string[]         // 参与此模式的 Session ID 列表
  
  // 识别指标
  confidence: number            // 0.0-1.0，置信度
  indicators: PatternIndicator[] // 具体识别指标
  
  // 派生统计
  total_duration: number        // 总时长（秒）
  total_sessions: number        // 涉及的 Session 数
  avg_attention_score: number  // 平均注意力分数
  
  description: string           // 人类可读描述（如"连续3个深度工作块，平均注意力94分"）
  created_at: string
}

type FocusPatternType =
  | 'deep_work_block'      // 深度工作块：连续多个 work session 无中断，attention_score >= 90
  | 'procrastination_loop' // 拖延循环：频繁 start/skip/cancel，完成率极低
  | 'fatigue_signal'       // 疲劳信号：attention_score 持续下降，interruption 增加，出现 fatigue cognitive mark
  | 'interruption_recovery'  // 中断恢复模式：被中断后快速恢复（avg_recovery_time < 30s）
  | 'multi_task_switching' // 多任务切换：频繁在不同 task 之间切换（每 session 切换一次以上）
  | 'flow_state'           // 心流状态：attention_score >= 85，无中断，时长 >= 20min，有 flow cognitive mark

interface PatternIndicator {
  metric: string               // 指标名（如"attention_score_trend"）
  value: number | boolean | string
  threshold: number | boolean | string  // 触发阈值
  direction: 'above' | 'below' | 'equals' | 'trend_down' | 'trend_up'
}
```

**识别触发时机**：
1. **实时触发**：`closeEventStream` 完成后，对当前 Session 的事件流进行单 Session 模式识别
2. **批量触发**：每日/每周定时任务，对最近 N 天的事件流进行跨 Session 模式识别
3. **手动触发**：用户在 StatsView 点击"重新分析注意力模式"

#### 3.3.2 识别算法设计

**算法 A：Deep Work Block（深度工作块）**

```
输入：连续时间窗口内的 Session 列表（按 started_at 排序）
输出：是否识别为深度工作块

条件：
1. 连续 >= 2 个 work session
2. 每个 session.completed === true
3. 每个 session.attention_score >= 90
4. 相邻 session 间隔 <= 5 分钟（break 时间）
5. 总 interruption_count === 0（或极低）
6. 无 cognitive_mark.type === 'distraction'

指标：
- attention_score_trend: [94, 96, 92] → avg >= 90
- gap_between_sessions: [4min, 3min] → max <= 5min
- interruption_count: 0
- distraction_marks: 0
```

**算法 B：Procrastination Loop（拖延循环）**

```
输入：时间窗口内的 Session 列表

条件：
1. 在 30 分钟内，session_started 事件 >= 3 次
2. session_completed / session_started < 0.5（完成率 < 50%）
3. session_skipped 或 session_cancelled 事件频繁
4. 平均 session 时长 < 设定时长的 50%
5. 有 note_added 事件（用户写了"先做别的"等笔记）

指标：
- completion_rate: < 0.5
- start_frequency: >= 3 / 30min
- avg_duration_ratio: < 0.5
- skip_count: >= 2
```

**算法 C：Fatigue Signal（疲劳信号）**

```
输入：连续多个 Session 的 metrics 序列

条件：
1. attention_score 连续下降（如 95 → 80 → 60）
2. interruption_count 递增
3. pause_count 递增
4. 有 cognitive_mark.type === 'fatigue'
5. 连续 session 数 >= 3（未休息）
6. 时间 > 下午（可选：结合时间因素）

指标：
- attention_score_trend: trend_down（连续下降）
- interruption_count_trend: trend_up
- pause_count_trend: trend_up
- fatigue_marks: >= 1
- consecutive_sessions: >= 3
```

**算法 D：Interruption Recovery（中断恢复模式）**

```
输入：单个 Session 的事件流

条件：
1. 有 session_interrupted 事件
2. 有 session_resumed_from_interruption 事件
3. avg_recovery_time < 30 秒（快速恢复）
4. 恢复后 attention_score 未显著下降（< 10%）

指标：
- avg_recovery_time: < 30s
- post_recovery_attention_drop: < 10%
- recovery_event_count: >= 1
```

**算法 E：Multi-task Switching（多任务切换）**

```
输入：时间窗口内的 Session 列表

条件：
1. 连续多个 session 的 task_id 不同
2. 切换频率 >= 1 次 / 10 分钟
3. 每个 session 的平均 attention_score < 70（注意力分散）
4. 有 cognitive_mark.type === 'distraction'

指标：
- task_switch_frequency: >= 1 / 10min
- unique_task_count: >= 3
- avg_attention_score: < 70
- distraction_marks: >= 1
```

**算法 F：Flow State（心流状态）**

```
输入：单个 Session 的事件流 + metrics

条件：
1. attention_score >= 85
2. interruption_count === 0
3. pause_count === 0（或极低）
4. duration >= 1200 秒（20 分钟）
5. 有 cognitive_mark.type === 'flow'（用户主动标记）或系统推断
6. 无 session_interrupted 事件
7. 完成后 mood 为 great/good（可选验证）

指标：
- attention_score: >= 85
- interruption_count: 0
- pause_count: 0
- duration: >= 1200s
- flow_marks: >= 1（或 inferred）
```

### 3.4 Apache Arrow 分析就绪导出

#### 3.4.1 设计决策

**为什么用 Apache Arrow？**

| 特性 | JSON | NDJSON | CSV | **Arrow IPC** |
|------|------|--------|-----|-------------|
| 数据类型保留 | ❌ 全字符串 | ❌ 全字符串 | ❌ 全字符串 | ✅ 原生类型 |
| 嵌套结构 | ✅ 支持 | ✅ 支持 | ❌ 不支持 | ✅ 支持 |
| 列式存储 | ❌ 行式 | ❌ 行式 | ❌ 行式 | ✅ 列式 |
| Pandas/Polars 读取 | 需解析 | 需解析 | 需解析 | **零拷贝** |
| 文件大小 | 大 | 大 | 中等 | **紧凑** |
| 浏览器支持 | ✅ 原生 | ✅ 原生 | ✅ 原生 | ✅ apache-arrow JS |

**为什么不是 Parquet？**
- Parquet 写入在浏览器端需要 WASM 绑定（如 `parquet-wasm`），引入复杂依赖
- Arrow IPC 格式在浏览器中可由 `apache-arrow` 纯 JS 库直接写入/读取
- 用户可将 Arrow 文件导入 Python 后，用 `pyarrow` 轻松转换为 Parquet

#### 3.4.2 Arrow Schema 设计

```typescript
// Session Table Schema
const sessionSchema = new Schema([
  { name: 'id', type: new Utf8() },
  { name: 'task_id', type: new Utf8() },
  { name: 'type', type: new Utf8() },
  { name: 'duration', type: new Int32() },
  { name: 'completed', type: new Bool() },
  { name: 'started_at', type: new Timestamp(TimeUnit.MILLISECOND) },
  { name: 'ended_at', type: new Timestamp(TimeUnit.MILLISECOND) },
  { name: 'attention_score', type: new Float32() },
  { name: 'flow_state_detected', type: new Bool() },
  { name: 'interruption_count', type: new Int32() },
  { name: 'pause_count', type: new Int32() },
])

// Event Table Schema
const eventSchema = new Schema([
  { name: 'id', type: new Utf8() },
  { name: 'session_id', type: new Utf8() },
  { name: 'type', type: new Utf8() },
  { name: 'timestamp', type: new Timestamp(TimeUnit.MILLISECOND) },
  { name: 'source', type: new Utf8() },
])
```

#### 3.4.3 导出流程

```
PomodoroXiExport.data
  │
  ├── sessions → Arrow Table (sessionSchema)
  ├── sessionEvents → Arrow Table (eventSchema)
  ├── tasks → Arrow Table (taskSchema)
  ├── reflections → Arrow Table (reflectionSchema)
  ├── focusPatterns → Arrow Table (patternSchema)
  │
  └── 合并为 Arrow RecordBatch
      └── 序列化为 Arrow IPC 格式（.arrow 文件）
      └── 或 Feather 格式（.feather 文件）
```

## 4. 数据库迁移方案

### 4.1 Version 8：标签 + 关系

```typescript
this.version(8).stores({
  // Tag 实体表
  tags: 'id, name, parent_id, weight, created_at',
  
  // Task-Tag 关联表
  taskTags: 'id, task_id, tag_id, weight, [task_id+tag_id]',
  
  // Task 关系表
  taskRelations: 'id, from_task_id, to_task_id, relation_type, [from_task_id+relation_type], [to_task_id+relation_type]',
})
```

**数据迁移**：
- 从现有 Task.tags 字符串数组中提取所有唯一标签名
- 为每个标签创建 Tag 实体（name 作为 id 前缀，如 `tag_专注`）
- 为每个 Task 的每个标签创建 TaskTag 关联记录
- 写入 `tag_migration_done` 标记，避免重复迁移

### 4.2 Version 9：注意力模式

```typescript
this.version(9).stores({
  // FocusPattern 识别结果表
  focusPatterns: 'id, type, start_time, end_time, [type+start_time]',
})
```

**无数据迁移**：FocusPattern 是派生数据，首次运行时从现有 SessionEvent 中批量识别。

## 5. 数据流设计

### 5.1 标签编辑流程

```
用户编辑 Task 标签
  │
  ├── 写入 Task.tags（string[]）← 向后兼容
  │
  └── 异步触发标签同步
      ├── 检查每个标签名是否已有 Tag 实体
      │   ├── 无 → 创建 Tag（name, 默认 color, weight=1.0）
      │   └── 有 → 跳过
      ├── 删除旧的 taskTags 关联
      └── 创建新的 taskTags 关联（task_id, tag_id, weight=1.0）
```

### 5.2 关系编辑流程

```
用户在 TaskDetail 中设置"依赖关系"
  │
  ├── 选择 relation_type（depends_on / blocks / related）
  ├── 选择目标 Task
  └── 写入 taskRelations（from_task_id, to_task_id, relation_type, weight=1.0）
```

### 5.3 模式识别流程

```
单 Session 模式识别（实时）
  │
  ├── closeEventStream(sessionId) → 返回 SessionMetrics
  ├── 调用 useFocusPatterns().detectSingleSession(sessionId, metrics)
  │   ├── 检查 flow_state 条件
  │   ├── 检查 interruption_recovery 条件
  │   └── 检查 fatigue_signal 条件（基于最近 N 个 session）
  └── 如果识别到模式 → 写入 focusPatterns

批量模式识别（每日/手动）
  │
  ├── 获取最近 N 天的所有 Session + SessionEvent
  ├── 按时间窗口分组（如 2 小时窗口）
  ├── 调用 useFocusPatterns().detectBatch(sessions, events)
  │   ├── 滑动窗口检测 deep_work_block
  │   ├── 检测 procrastination_loop
  │   ├── 检测 multi_task_switching
  │   └── 去重（避免重复识别同一 session）
  └── 写入 focusPatterns
```

## 6. 类型定义总览

### 6.1 新增类型（types/phase2.ts）

```typescript
// Tag 实体
export interface Tag {
  id: string
  name: string
  color: string | null
  parent_id: string | null
  weight: number
  description: string
  created_at: string
  updated_at: string
}

// Task-Tag 关联
export interface TaskTag {
  id: string
  task_id: string
  tag_id: string
  weight: number
  applied_at: string
  source: 'user' | 'auto' | 'inferred'
}

// TagRef（Task 上的引用）
export interface TagRef {
  tag_id: string
  weight: number
  source: 'user' | 'auto' | 'inferred'
}

// Task 关系
export type TaskRelationType = 'parent' | 'depends_on' | 'blocks' | 'related' | 'subtask'

export interface TaskRelation {
  id: string
  from_task_id: string
  to_task_id: string
  relation_type: TaskRelationType
  weight: number
  description: string
  created_at: string
}

// 注意力模式
export type FocusPatternType =
  | 'deep_work_block'
  | 'procrastination_loop'
  | 'fatigue_signal'
  | 'interruption_recovery'
  | 'multi_task_switching'
  | 'flow_state'

export interface PatternIndicator {
  metric: string
  value: number | boolean | string
  threshold: number | boolean | string
  direction: 'above' | 'below' | 'equals' | 'trend_down' | 'trend_up'
}

export interface FocusPattern {
  id: string
  type: FocusPatternType
  start_time: string
  end_time: string
  session_ids: string[]
  confidence: number
  indicators: PatternIndicator[]
  total_duration: number
  total_sessions: number
  avg_attention_score: number
  description: string
  created_at: string
}

// Arrow 导出相关
export type ArrowExportFormat = 'arrow' | 'feather'

export interface ArrowExportOptions {
  format: ArrowExportFormat
  scope: {
    date_range: { start: string; end: string }
    tables: ArrowTableName[]
  }
  privacy: 'full' | 'anonymized' | 'minimal'
}

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

export interface ArrowExportResult {
  blob: Blob
  filename: string
  mimeType: string
  tableSchemas: Record<string, string>  // 表名 → Schema 描述
}
```

### 6.2 扩展现有类型

```typescript
// Task 扩展（types/index.ts）
interface Task {
  // ... 现有字段 ...
  tags: string[]                    // 保持向后兼容
  tag_refs?: TagRef[]               // Phase 2 新增：结构化标签引用
  // 关系通过 taskRelations 表查询，不直接存于 Task
}

// PomodoroXiExport 扩展（types/phase1.ts）
interface ExportData {
  // ... 现有字段 ...
  tags?: Tag[]
  taskTags?: TaskTag[]
  taskRelations?: TaskRelation[]
  focusPatterns?: FocusPattern[]
}
```

## 7. 服务层设计

### 7.1 Tag Store（tags.ts）

```typescript
export const useTagStore = defineStore('tag', () => {
  // State: tags[]
  // Actions:
  //   - createTag(name, color?, parent_id?, weight?)
  //   - updateTag(id, partial)
  //   - deleteTag(id) // 级联删除子标签
  //   - getTagHierarchy() // 返回树形结构
  //   - getTagByName(name) // 模糊搜索
  ])
})
```

### 7.2 TaskTag Store（taskTags.ts）

```typescript
export const useTaskTagStore = defineStore('taskTag', () => {
  // State: taskTags[]
  // Actions:
  //   - setTaskTags(taskId, tagIds[]) // 全量替换
  //   - addTaskTag(taskId, tagId, weight?)
  //   - removeTaskTag(taskId, tagId)
  //   - getTagsByTask(taskId) // 返回 Tag[]
  //   - getTasksByTag(tagId) // 返回 Task[]
  //   - syncFromTaskTags(taskId, stringTags[]) // 从 Task.tags 字符串同步
  ])
})
```

### 7.3 Task Relation Store（taskRelations.ts）

```typescript
export const useTaskRelationStore = defineStore('taskRelation', () => {
  // State: relations[]
  // Actions:
  //   - createRelation(fromTaskId, toTaskId, type, weight?, description?)
  //   - deleteRelation(id)
  //   - getRelationsByTask(taskId) // 返回该任务的所有关系
  //   - getBlockedTasks(taskId) // 返回阻塞该任务的任务列表
  //   - getBlockingTasks(taskId) // 返回被该任务阻塞的任务列表
  //   - getDependencyChain(taskId) // 返回依赖链（拓扑排序）
  //   - checkCircularDependency(fromId, toId) // 检查循环依赖
  ])
})
```

### 7.4 FocusPattern 识别引擎（useFocusPatterns.ts）

```typescript
export function useFocusPatterns() {
  return {
    // 单 Session 实时识别
    detectSingleSession(sessionId: string, metrics: SessionMetrics): Promise<FocusPattern | null>
    
    // 批量识别（跨 Session）
    detectBatch(
      sessions: Session[],
      events: SessionEvent[],
      windowHours?: number
    ): Promise<FocusPattern[]>
    
    // 每日定时识别
    detectDaily(date: string): Promise<FocusPattern[]>
    
    // 查询
    getPatternsByDateRange(start: string, end: string): Promise<FocusPattern[]>
    getPatternsByType(type: FocusPatternType): Promise<FocusPattern[]>
    getPatternsBySession(sessionId: string): Promise<FocusPattern[]>
    
    // 统计
    getPatternStats(start: string, end: string): Promise<PatternStats>
  }
}
```

### 7.5 Arrow 导出服务（export-arrow.ts）

```typescript
export async function exportToArrow(options: ArrowExportOptions): Promise<ArrowExportResult>
export function downloadArrowExport(result: ArrowExportResult): void
```

## 8. 实施计划

### 8.1 里程碑 1：标签语义化（Week 1-2）

1. 创建 `types/phase2.ts`（Tag, TaskTag, TagRef）
2. 数据库迁移 v8（tags + taskTags）
3. 创建 `stores/tag.ts` + `stores/taskTag.ts`
4. 创建 `composables/useTagSync.ts`（从 Task.tags 字符串自动同步）
5. 在 TaskView 中集成标签编辑（颜色选择、层级选择）
6. 导出服务扩展（包含 tags + taskTags）

### 8.2 里程碑 2：Task 关系网络（Week 3-4）

1. 数据库迁移 v8 续（taskRelations）
2. 创建 `stores/taskRelation.ts`
3. 在 TaskDetail 中集成关系编辑（依赖/阻塞/父子）
4. 实现拓扑排序和循环依赖检测
5. 导出服务扩展（包含 taskRelations）

### 8.3 里程碑 3：FocusPattern 识别（Week 5-6）

1. 数据库迁移 v9（focusPatterns）
2. 创建 `composables/useFocusPatterns.ts`
3. 实现 6 种识别算法
4. 集成到 `useSessionEvents.closeEventStream`（实时识别）
5. 创建批量识别定时任务（每日 cron）
6. 在 StatsView 中展示识别结果

### 8.4 里程碑 4：Arrow 导出（Week 7-8）

1. 安装 `apache-arrow` 依赖
2. 创建 `services/export-arrow.ts`
3. 定义 Arrow Schema（所有实体表）
4. 实现数据转换（IndexedDB → Arrow Table）
5. 实现 Arrow IPC 序列化
6. 在 DataExportModal 中新增 Arrow 格式选项
7. 测试与 Python/Pandas 的兼容性

## 9. 向后兼容策略

### 9.1 标签兼容

```typescript
// 旧 Task（无 tag_refs）
{ id: 'task1', tags: ['专注', '代码'], ... }

// 新 Task（有 tag_refs）
{ id: 'task1', tags: ['专注', '代码'], tag_refs: [
  { tag_id: 'tag_focus', weight: 1.0, source: 'user' },
  { tag_id: 'tag_code', weight: 1.0, source: 'user' }
], ... }
```

- 旧代码读取 `tags` 不受影响
- 新代码优先使用 `tag_refs`，缺失时回退到 `tags`
- 导出时两者都包含

### 9.2 导出兼容

Phase 1 的 `PomodoroXiExport` 结构不变：
- `data.tags` 和 `data.taskTags` 为可选字段
- 旧消费者忽略这些字段即可
- `_meta.schema_version` 升级到 `'2.0.0'`

### 9.3 同步兼容

- Tag / TaskTag / TaskRelation / FocusPattern 数据**不上传服务器**
- 仅本地存储，不进入 sync outbox
- 用户在新设备上需要重新同步标签和关系（从 Task.tags 字符串重建）

## 10. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| apache-arrow 浏览器包体积过大 | 首屏加载慢 | 懒加载（dynamic import），仅在用户选择 Arrow 导出时加载 |
| 标签迁移导致 IndexedDB 数据膨胀 | 存储超限 | 迁移时压缩旧数据，提供数据清理功能 |
| FocusPattern 识别算法误报 | 用户体验差 | 设置置信度阈值（默认 0.7），允许用户手动修正/删除 |
| 循环依赖检测性能差 | Task 多时卡顿 | 使用拓扑排序缓存，限制递归深度 |
| Task 关系编辑 UI 复杂 | 用户学习成本高 | 提供关系可视化小图（MiniGraph），直观展示关系 |

## 11. 验收标准

- [ ] 标签语义化：用户可以创建带颜色、层级的标签，Task 标签编辑支持颜色和权重
- [ ] Task 关系：用户可以设置任务的依赖/阻塞/父子关系，系统能检测循环依赖
- [ ] FocusPattern：系统能识别 6 种注意力模式，识别结果在 StatsView 展示
- [ ] Arrow 导出：用户可以导出 Arrow IPC 文件，该文件能在 Python Pandas 中直接读取
- [ ] 类型检查：零 TypeScript 错误
- [ ] 测试：新增测试覆盖率 >= 80%

---

## 附录：快速开始

### 安装依赖

```bash
cd frontend
npm install apache-arrow  # Arrow 导出
```

### 数据库迁移

```typescript
// database.ts
this.version(8).stores({
  tags: 'id, name, parent_id, weight, created_at',
  taskTags: 'id, task_id, tag_id, weight, [task_id+tag_id]',
  taskRelations: 'id, from_task_id, to_task_id, relation_type, [from_task_id+relation_type], [to_task_id+relation_type]',
})
this.version(9).stores({
  focusPatterns: 'id, type, start_time, end_time, [type+start_time]',
})
```

### 类型导出

```typescript
// types/index.ts
export * from './phase2'
```
