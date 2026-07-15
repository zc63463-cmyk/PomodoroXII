# PomodoroXII 番茄钟页面与 WorkItem 任务模块重构产品规范

> 日期：2026-07-11
>
> 状态：产品规范，待工程评审
>
> 上游契约：tip-tip 项目 `SESSION_TASK_INTEGRATION_V10.md`、`WORKITEM_SINGLE_USER_V11.md`（v1.2）、`FOCUS_L3_FLOATING_WINDOW_SPEC.md`
>
> 目标项目：`E:\Development\MyAwesomeApp\PomodoroXII`（Next.js + Zustand + TypeScript）
>
> 决策来源：grill-me 五轮深度追问（2026-07-11）

---

## 1. 文档目的

定义 PomodoroXII 重建项目中两件同时进行的工作：

1. **任务模块深度重构**：将扁平 Task 模型迁移到 WorkItem v1.2 三层模型
2. **番茄钟页面对接**：基于新 WorkItem 模型重新设计番茄钟页面的使用逻辑，同时提升 UI/UX 质感

本文档不做像素级视觉设计，而是定义产品边界、数据模型、交互流程和验收标准。

---

## 2. 核心决策（来自 grill-me）

| # | 决策 | 要点 |
|---|------|------|
| 1 | 优化方向 | 不是减法，是使用逻辑重设计 + UI/UX 质感提升 |
| 2 | 任务模型 | 深度重构到 WorkItem v1.2：Space→Project→WorkItem 三层 parentId |
| 3 | 层级范围 | Space（已实现）→ Project（待建）→ WorkItem（待建）；不引 ProjectGroup、Module |
| 4 | plan/completion 迁移 | Session.plan→SessionWorkItemPlan；Session.completion→SessionWorkItemOutcome；Task.plan/completion 文本→WorkItemNote |
| 5 | "至简高级" | 保留现有元素数量，提升交互逻辑和视觉质感 |
| 6 | Orbit 关系 | 隔离但联动：番茄钟页面是主操作面，Orbit L3 浮窗是计时中思维导图交互面 |

---

## 3. 任务模块深度重构

### 3.1 类型定义

#### WorkItemStatus

```typescript
export type WorkItemStatus =
  | 'not_started'
  | 'in_progress'
  | 'paused'
  | 'waiting'
  | 'completed'
  | 'cancelled'
```

#### WorkItem

```typescript
export interface WorkItem {
  // 身份
  id: string
  spaceId: string
  projectId: string
  displayKey: string          // Project 内唯一

  // 内容
  title: string
  description: string | null  // 是什么/为什么/完成结果

  // 层级
  parentId: string | null     // null=一级；父一级=二级；父二级=三级
  childRank: number           // 同父排序

  // 状态
  statusId: WorkItemStatus
  priority: 'low' | 'medium' | 'high' | 'urgent' | null

  // 排期（仅二级有完整语义；一级和三级可设 hardDeadline）
  completionWindowStart: string | null
  completionWindowEnd: string | null
  reviewPoint: string | null
  hardDeadline: string | null
  effortEstimateLowerSeconds: number | null
  effortEstimateUpperSeconds: number | null
  effortActualSeconds: number  // 派生：来自有效 Session 的净专注秒数，默认 0
  confidence: 'low' | 'medium' | 'high' | null

  // 标签（Space 级多选）
  labelIds: string[]

  // 审计
  completedAt: string | null
  cancelledAt: string | null
  archivedAt: string | null
  markedAsAttention: boolean   // 默认 false
  createdAt: string
  updatedAt: string
  version: number              // 乐观锁
}
```

#### WorkItemNote

```typescript
export interface WorkItemNote {
  id: string
  workItemId: string           // 一对一
  content: string              // 首版：纯文本；后续升级为结构化 Block
  createdAt: string
  updatedAt: string
  version: number
}
```

首版 `content` 为纯文本字符串，在番茄钟页面和 L3 视图中作为 textarea 编辑。后续升级为结构化 Block（paragraph / heading / ordered_list / unordered_list / checklist），届时 `content` 改为 JSON 序列化的 Block 数组，前端做迁移。

#### Project

```typescript
export interface Project {
  id: string
  spaceId: string
  name: string
  description: string | null
  rank: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  version: number
}
```

### 3.2 深度派生规则

层级由 `parentId` 深度派生，不持久化 `level` 字段：

```text
parentId = null        → 一级（范围与主题）
parentId 指向一级      → 二级（可交付工作块 + 投入容器）
parentId 指向二级      → 三级（可确认具体成果）
```

约束：
- 父子必须同 Space、同 Project
- 最大三层，移动时校验整棵子树不超过三层
- 三级不能直接创建第四级；继续拆解时提供"添加 Note"或"人工提升后再拆"双出口
- 不自动提升

### 3.3 深度默认行为

| 深度 | 产品定位 | Session | Cycle |
|------|----------|---------|-------|
| 一级 | 范围与主题 | 不直接承接 Session；从一级启动需先选/建二级 | 不参与 |
| 二级 | 可交付工作块 + 投入容器 | 唯一预计投入、实际 Session 投入和 Cycle 口径 | 可成为 Membership |
| 三级 | 可确认具体成果 | 不分配 Session 分钟；默认不估时、不独立加入 Cycle | 不参与 |

### 3.4 Store 接口

#### task-store.ts（重构）

```typescript
interface WorkItemStore {
  // State
  workItems: WorkItem[]
  workItemNotes: WorkItemNote[]
  projects: Project[]
  currentProjectId: string | null
  isLoading: boolean
  error: string | null

  // WorkItem CRUD
  loadWorkItems: (projectId?: string) => Promise<void>
  createWorkItem: (input: CreateWorkItemInput) => Promise<WorkItem>
  updateWorkItem: (id: string, input: UpdateWorkItemInput) => Promise<void>
  deleteWorkItem: (id: string) => Promise<void>
  moveWorkItem: (id: string, newParentId: string | null) => Promise<void>

  // 派生
  getChildren: (parentId: string) => WorkItem[]
  getDepth: (id: string) => 1 | 2 | 3
  getL2Root: (id: string) => WorkItem | null   // 找到三级的二级父项

  // WorkItemNote
  getNote: (workItemId: string) => WorkItemNote | null
  updateNote: (workItemId: string, content: string) => Promise<void>

  // Project
  loadProjects: () => Promise<void>
  createProject: (name: string) => Promise<Project>
  selectProject: (projectId: string) => void

  // 状态流转
  startProgress: (id: string) => Promise<void>   // not_started → in_progress
  completeWorkItem: (id: string) => Promise<void>
  cancelWorkItem: (id: string) => Promise<void>
  reopenWorkItem: (id: string) => Promise<void>
  pauseWorkItem: (id: string) => Promise<void>
  waitWorkItem: (id: string) => Promise<void>
}
```

#### CreateWorkItemInput

```typescript
interface CreateWorkItemInput {
  title: string
  projectId: string
  parentId: string | null
  description?: string
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  // 仅二级有意义
  effortEstimateLowerSeconds?: number
  effortEstimateUpperSeconds?: number
  completionWindowStart?: string
  completionWindowEnd?: string
  reviewPoint?: string
  hardDeadline?: string
  confidence?: 'low' | 'medium' | 'high'
  labelIds?: string[]
}
```

### 3.5 旧数据迁移映射

| 旧字段（Task） | 新归属 | 迁移规则 |
|----------------|--------|----------|
| `id` | `WorkItem.id` | 保持不变 |
| `title` | `WorkItem.title` | 直接迁移 |
| `description` | `WorkItem.description` | 直接迁移 |
| `status: todo` | `WorkItem.statusId: not_started` | 枚举映射 |
| `status: in_progress` | `WorkItem.statusId: in_progress` | 枚举映射 |
| `status: done` | `WorkItem.statusId: completed` + `completedAt` | 枚举映射 |
| `status: archived` | `WorkItem.archivedAt` | 状态清空，设 archivedAt |
| `priority` | `WorkItem.priority` | 直接迁移 |
| `tags: string[]` | `WorkItem.labelIds: string[]` | 需要 Label 迁移或临时用 tag 名做 ID |
| `plan` | `WorkItemNote.content` | 迁移到关联 WorkItemNote |
| `completion` | `WorkItemNote.content` | 追加到同一 WorkItemNote |
| `due_date` | `WorkItem.hardDeadline` | 直接迁移 |
| `estimated_pomodoros` | `WorkItem.effortEstimateUpperSeconds` | `× 1500`（25分钟×60秒） |
| `actual_pomodoros` | `WorkItem.effortActualSeconds` | `× 1500`；后续从 Session 重新求和 |
| `archived_at` | `WorkItem.archivedAt` | 直接迁移 |
| `created_at` / `updated_at` | `WorkItem.createdAt` / `updatedAt` | 直接迁移 |

迁移后所有旧 Task 成为**无 parentId 的一级 WorkItem**。用户后续手动组织二级/三级结构。

| 旧字段（Session） | 新归属 | 迁移规则 |
|---------------------|--------|----------|
| `task_id` | `Session.level2WorkItemId` | 直接迁移（旧 Task 升为一级后，Session 归属指向它） |
| `plan` | 不迁移 | 旧文本 plan 丢弃；新 SessionWorkItemPlan 从零开始 |
| `completion` | 不迁移 | 旧文本 completion 丢弃；新 SessionWorkItemOutcome 从零开始 |
| `note` | `Session.sessionNote` | 直接迁移 |
| `mood` | `Session.mood` | 直接迁移 |
| `type` / `duration` / `completed` / `started_at` / `ended_at` | 保持不变 | 直接迁移 |

---

## 4. Session 数据模型

### 4.1 FocusSession（重构）

```typescript
export type SessionValidity = 'pending' | 'valid' | 'invalid'
export type SessionTimerCompletion = 'completed' | 'ended_early' | 'interrupted'
export type SessionOverallProgress = 'smooth' | 'progressed' | 'stuck' | 'interrupted'
export type SessionMood = 'great' | 'good' | 'normal' | 'bad' | 'terrible'
export type SessionReviewState = 'not_required' | 'pending' | 'completed' | 'skipped'

export interface FocusSession {
  id: string
  spaceId: string
  projectId: string
  level2WorkItemId: string
  level2TitleSnapshot: string       // 启动时冻结

  // 计时
  type: SessionType                  // work / short_break / long_break / free / countdown
  duration: number                   // 设定时长（秒）
  grossSeconds: number               // 总流逝
  pausedSeconds: number              // 暂停时长
  focusedSeconds: number             // 净专注 = gross - paused - break
  timerCompletion: SessionTimerCompletion
  validity: SessionValidity
  validityReason: string | null

  // 复盘
  overallProgress: SessionOverallProgress | null
  mood: SessionMood | null
  sessionNote: string                // Session 随记，独立于 WorkItemNote
  reviewState: SessionReviewState

  // 审计
  startedAt: string
  endedAt: string | null
  createdAt: string
  updatedAt: string
  version: number

  // 旧字段兼容（后续移除）
  completed: boolean                 // = timerCompletion === 'completed'
  synced: boolean
}
```

### 4.2 SessionWorkItemPlan（新增）

```typescript
export type SessionPlanItemSource = 'before_start' | 'during_session' | 'review_materialized'

export interface SessionWorkItemPlan {
  id: string
  sessionId: string
  workItemId: string                 // 三级 WorkItem ID
  titleSnapshot: string              // 启动时冻结
  level2WorkItemIdSnapshot: string
  level2TitleSnapshot: string
  planRank: number                   // 排序
  source: SessionPlanItemSource
  completionDraft: boolean           // 计时中可撤销的完成草稿
  cancelDraft: boolean               // 计时中可撤销的取消草稿
  touched: boolean                   // 是否实际触达
  addedAt: string
  removedAt: string | null
  removalReason: string | null
}
```

### 4.3 SessionWorkItemOutcome（新增）

```typescript
export type WorkItemResult =
  | 'completed'
  | 'progressed'
  | 'stuck'
  | 'untouched'
  | 'cancelled'
  | 'next'       // 下轮候选
  | 'paused'     // 暂停
  | 'waiting'    // 等待

export type ExecutionPersona = 'ox' | 'pig' | 'hajimi' | 'wukong'
export type CommandStatus = 'not_needed' | 'pending' | 'succeeded' | 'failed' | 'conflict' | 'unknown'

export interface SessionWorkItemOutcome {
  id: string
  sessionId: string
  workItemId: string
  result: WorkItemResult
  executionPersona: ExecutionPersona | null
  personaNote: string | null
  stateCommand: 'complete' | 'cancel' | 'none'
  commandId: string | null           // 幂等键
  commandStatus: CommandStatus
  commandErrorCode: string | null
  reviewedAt: string | null
}
```

### 4.4 session-store.ts（重构）

```typescript
interface SessionStore {
  // State
  sessions: FocusSession[]
  currentSession: FocusSession | null
  planItems: SessionWorkItemPlan[]           // 当前 Session 的计划项
  outcomes: SessionWorkItemOutcome[]         // 当前 Session 的成果项
  isLoading: boolean
  error: string | null

  // Session 生命周期
  startSession: (input: StartSessionInput) => Promise<FocusSession>
  endSession: () => Promise<void>
  pauseSession: () => void
  resumeSession: () => void
  tick: () => void

  // SessionWorkItemPlan
  addPlanItem: (workItemId: string, source: SessionPlanItemSource) => void
  removePlanItem: (workItemId: string) => void
  setCurrentItem: (workItemId: string) => void
  toggleCompletionDraft: (workItemId: string) => void
  toggleCancelDraft: (workItemId: string) => void
  createL3WorkItem: (title: string) => Promise<string>  // 返回新 workItemId

  // SessionWorkItemOutcome
  setItemResult: (workItemId: string, result: WorkItemResult) => void
  setPersona: (workItemId: string, persona: ExecutionPersona | null) => void

  // 复盘
  setValidity: (validity: SessionValidity, reason?: string) => void
  setOverallProgress: (progress: SessionOverallProgress | null) => void
  setMood: (mood: SessionMood | null) => void
  setSessionNote: (note: string) => void
  submitReview: () => Promise<void>
  skipReview: () => Promise<void>

  // 查询
  getCurrentItem: () => SessionWorkItemPlan | null
  getPlanItems: () => SessionWorkItemPlan[]
  getOutcomes: () => SessionWorkItemOutcome[]
}
```

#### StartSessionInput

```typescript
interface StartSessionInput {
  level2WorkItemId: string
  projectId: string
  type: SessionType
  duration: number
  initialL3ItemIds?: string[]       // 启动时选的三级 WorkItem
}
```

---

## 5. 番茄钟页面交互流程

### 5.1 三阶段状态机

```
idle（准备态）
  │ 用户选二级 WorkItem + 可选选三级 + 点击开始
  ↓
running（运行态）
  │ 用户点结束 / 计时自然结束
  ↓
reviewing（复盘态）
  │ 用户提交复盘 / 跳过 / 仅保存时间
  ↓
idle（回到准备态）
```

暂停是 running 的子状态，不改变阶段。

### 5.2 准备态（idle）

**布局（从上到下）：**

```
┌───────────────────────────────────┐
│  [Space标识]  [Project选择器]      │  顶部上下文
├───────────────────────────────────┤
│  [二级 WorkItem 选择器]            │  任务归属
│  [三级成果清单（可选）]             │  本轮计划
│  [+ 新建三级]                      │
├───────────────────────────────────┤
│                                   │
│         ⏱ TimerRing               │  钟（静止）
│         25:00                     │
│         专注时长                   │
│                                   │
├───────────────────────────────────┤
│  [时长预设]  [模式切换]            │  控制区
│  [▶ 开始专注]                      │
├───────────────────────────────────┤
│  [今日 N 个番茄]  [专注 Xh]       │  底部统计
└───────────────────────────────────┘
```

**交互：**

1. 选择 Project（如果当前 Space 有多个）
2. 选择二级 WorkItem（搜索 + 筛选；显示状态、投入进度）
3. 选中二级后展开同父三级列表；可勾选加入本轮计划
4. 可点"+"新建三级（只要求标题，自动加入计划）
5. 可空计划直接开始
6. 设置时长预设和模式
7. 点击"开始专注"→ 进入 running

**TaskSelector 升级要点：**

旧版 TaskSelector 是扁平下拉列表。新版升级为两级选择：
- 第一级：选二级 WorkItem（搜索 + Project 过滤 + 状态展示 + 投入进度 `effortActual / effortEstimateUpper`）
- 第二级：选中二级后展开三级列表（可多选加入本轮计划）
- 搜索结果同时匹配二级和三级标题

### 5.3 运行态（running）

**布局：**

```
┌───────────────────────────────────┐
│  [二级归属]  [⏱ 24:18 ●有效]     │  顶部
│  [暂停] [结束]                    │
├───────────────────────────────────┤
│                                   │
│         ⏱ TimerRing               │  钟（运行）
│         18:42                     │  （glow + 呼吸 + 数字翻转）
│         专注时长                   │
│                                   │
├───────────────────────────────────┤
│  本轮三级成果                      │  成果清单
│  ○ 三级A（当前）  ✓ 三级B（草稿） │  （可切换当前项、成果钩）
│  ○ 三级C          + 新建          │
├───────────────────────────────────┤
│  当前三级备注（WorkItemNote）      │  Note 编辑
│  ┌─────────────────────┐          │  （textarea，800ms 防抖保存）
│  │ 发现第三个按钮颜色…  │          │
│  └─────────────────────┘          │
│  已保存 / 待同步                   │
├───────────────────────────────────┤
│  [沉浸模式]  [声景]  [随记]       │  辅助控制
├───────────────────────────────────┤
│  [今日 N 个番茄]  [专注 Xh]       │  底部统计
└───────────────────────────────────┘
```

**交互（来自 SESSION_TASK_INTEGRATION_V10 §6）：**

| 操作 | 效果 | 数据写入 |
|------|------|----------|
| 切换当前三级 | 只切换执行上下文，不分配分钟 | `planItems[].currentItem` |
| 成果钩（完成草稿） | 可撤销草稿，不立即修改 WorkItem | `planItems[].completionDraft = true` |
| 从本轮移除 | 只修改 Session 计划，不改变 WorkItem | `planItems[].removedAt = now` |
| 新建三级 | 创建正式 WorkItem + 加入计划 | `createWorkItem()` + `addPlanItem()` |
| Note 编辑 | 直接写 WorkItemNote（正式内容事实） | `updateNote(workItemId, content)` |
| Session 随记 | 只写 Session，不沉淀到 WorkItem | `session.sessionNote = text` |
| 暂停 | 停止计时，画布保持可交互 | `pauseSession()` |

**沉浸模式：**
- 保留旧版的沉浸模式（钟放大、其余渐隐）
- 沉浸态仍保留成果清单和 Note 编辑的入口（可按需浮现）

**无三级计划的运行态：**
- 成果清单区域显示"本轮没有三级计划，可专注二级范围"
- 保留"+"新建三级入口
- Note 编辑区显示二级的 WorkItemNote

### 5.4 复盘态（reviewing）

**布局：**

```
┌───────────────────────────────────┐
│  Session 结束复盘 · #S-0711-01    │
├───────────────────────────────────┤
│  [净专注 24分钟] [正常结束·有效]  │  摘要
│  [3项成果]                        │
├───────────────────────────────────┤
│  1. 时间有效性                    │
│  [保留有效] [误启动不计入]        │
├───────────────────────────────────┤
│  2. 三级成果结果                   │
│  ├ 三级A  [完成 ▼]               │  逐三级标注
│  ├ 三级B  [有推进 ▼]             │
│  └ 三级C  [未触达 ▼]             │
│  [批量确认未触达] [稍后复盘]      │
├───────────────────────────────────┤
│  3. 总体推进（选填）[展开]        │
│  4. Mood（选填）[展开]            │
│  5. 逐三级化身（选填）[展开]      │
├───────────────────────────────────┤
│  [二级投入复核卡（条件出现）]     │  仅达上限时
├───────────────────────────────────┤
│  命令回执                         │
│  ├ 三级A CompleteWorkItem · ✓    │
│  ├ 三级B 无命令 · 原地保留        │
│  └ 三级C 无命令 · 原地保留        │
├───────────────────────────────────┤
│  [仅保存时间]  [保存并提交结果]   │
└───────────────────────────────────┘
```

**交互（来自 SESSION_TASK_INTEGRATION_V10 §7）：**

1. **时间有效性**：正常结束默认 valid；提前结束需确认保留/误启动
2. **三级成果结果**：未触达项预填 `untouched`，可批量确认；每个三级可选 completed/progressed/stuck/untouched/cancelled/next/paused/waiting
3. **选填三组**：总体推进、Mood、逐三级执行化身——可全部跳过，缺失不构成待复盘
4. **二级投入复核**：仅当 `effortActualSeconds >= effortEstimateUpperSeconds` 时出现显著复核卡，不阻止结束
5. **提交**：逐项生成命令（CompleteWorkItem / CancelWorkItem / none），提交到 task-store，展示回执
6. **延迟复盘**：可"仅保存时间"，成果进入 `reviewState = pending`
7. **跳过**：可显式跳过整组成果复盘，不生成任务命令，`reviewState = skipped`

**复盘完成后：**
- 更新二级 `effortActualSeconds`（累加 `focusedSeconds`）
- 回到 idle 准备态

---

## 6. WorkItemNote 在番茄钟页面中的编辑

### 6.1 编辑方式

- 准备态：选中二级后，可编辑二级的 WorkItemNote
- 运行态：当前三级展开 Note 编辑器，800ms 防抖保存
- 复盘态：Note 只读

### 6.2 数据流

```
用户在 textarea 输入
  ↓ 800ms 防抖
updateNote(workItemId, content)
  ↓
IndexedDB 写入 workItemNotes 表
  ↓
同步引擎推送到后端
  ↓
保存反馈：在线"已保存" / 离线"待同步"
```

### 6.3 与 L3 思维导图的衔接

WorkItemNote 的 `content` 同时是 L3 思维导图中方形 Note 节点的内容。当 Orbit L3 浮窗连接到同一个 Session 时：
- 番茄钟页面的 Note 编辑和 Orbit L3 的 Note 编辑写同一个 `WorkItemNote.content`
- 两者通过同步引擎保持一致
- 首版不处理实时协同编辑冲突（单用户、单设备为主）

---

## 7. 与 Orbit L3 浮窗的联动

### 7.1 关系定义

| 维度 | 番茄钟页面（PomodoroXII） | Orbit L3 浮窗（tip-tip） |
|------|--------------------------|--------------------------|
| 平台 | Next.js Web 应用 | Tauri 桌宠窗口 |
| 定位 | Session 主操作面 | 计时中思维导图交互面 |
| 覆盖阶段 | 准备态 + 运行态 + 复盘态 | 仅运行态 |
| 核心交互 | 选任务、计时控制、复盘 | 三级切换、Note 编辑、成果钩、状态标注 |
| 数据 | 读写同一 Session×WorkItem 数据源 | 读写同一数据源 |

### 7.2 聚焦模式

当二级 WorkItem 的 Session 开始时：
1. Orbit L3 浮窗收到 Session 开始事件
2. 自动进入"聚焦模式"，切换到该二级下的 L3 思维导图视图
3. 显示二级主圆 + 本轮三级圆 + 当前三级方形 Note
4. 支持返回查看其他 WorkItem（不暂停计时）
5. 支持"聚焦"按钮快速回到当前任务视图

### 7.3 浮窗提供的操作

| 操作 | 说明 |
|------|------|
| 三级切换 | 单击三级圆设为当前项 |
| Note 编辑 | 当前三级展开方形 Note，原位编辑 |
| 成果钩 | 三级圆边缘完成草稿钩，可撤销 |
| 状态标注 | 标注三级 WorkItem 完成/推进/卡住等结果 |
| 新建三级 | "+"原位输入标题创建正式三级 |

### 7.4 首版范围

PomodoroXII 首版**只建番茄钟页面**，不建 Orbit 浮窗。Orbit 浮窗是 tip-tip 项目后续的工作。但番茄钟页面的运行态需要覆盖以下交互（用页面内组件实现，不做成悬浮窗）：
- 当前三级切换
- WorkItemNote 编辑
- 成果钩（完成草稿）
- 运行中新建三级

---

## 8. UI/UX 质感提升方向

"至简高级"不是减法，是提质。保留现有元素数量，提升以下维度：

| 维度 | 提升方向 |
|------|----------|
| **间距与留白** | 增大元素间距，钟周围留白更大，减少视觉拥挤感 |
| **配色** | 背景从 mesh 渐变收敛为更克制的单色/极淡渐变；模式色保留但降低饱和度 |
| **字号层级** | 时间数字最大、任务标题中等、辅助信息小号；层级更分明 |
| **动效** | 保留钟的 glow + 呼吸 + 数字翻转；减少装饰性动画；过渡更柔和 |
| **组件精度** | 按钮圆角、阴影、边框统一设计令牌；选中和 hover 态更精致 |
| **TaskSelector** | 从朴素下拉升级为带层级展示、投入进度、状态标签的卡片式选择器 |
| **成果清单** | 从简单列表升级为带成果钩、草稿态、当前项高亮的交互列表 |
| **复盘面板** | 从 Modal 弹窗改为页面内渐进式展开，降低打断感 |

---

## 9. 验收标准

### 9.1 任务模块

| # | 验收项 |
|---|--------|
| T01 | WorkItem 支持三层 parentId，深度由 parentId 派生不持久化 level |
| T02 | 六态状态模型，paused/waiting/completed/cancelled 不被 Session 静默覆盖 |
| T03 | 二级获得首个有效 Session 投入时自动 not_started → in_progress |
| T04 | 三级可从 not_started 直接完成 |
| T05 | 三级全部完成不自动完成二级 |
| T06 | effortActualSeconds 是派生字段，从有效 Session 求和得出 |
| T07 | effortActualSeconds >= effortEstimateUpperSeconds 时触发复核信号 |
| T08 | WorkItemNote 一对一关联 WorkItem，首版纯文本 |
| T09 | 旧 Task 数据迁移后成为无 parentId 的一级 WorkItem |
| T10 | 旧 Task.plan + Task.completion 文本合并迁移到 WorkItemNote.content |

### 9.2 Session 联动

| # | 验收项 |
|---|--------|
| S01 | 一个 Session 只能归属一个二级 WorkItem |
| S02 | 空三级计划可正常开始和结束 |
| S03 | 切换当前三级不分配或重算分钟 |
| S04 | 完成草稿在计时中可撤销，结束时才提交 |
| S05 | WorkItemNote 编辑直接写任务空间，不是 Session 草稿 |
| S06 | Session 随记独立于 WorkItemNote |
| S07 | 运行中新建三级创建正式 WorkItem + 加入计划 |
| S08 | 三级全部完成不自动完成二级 |
| S09 | 达到二级预计上限出现显著复核，不阻止结束 |
| S10 | 复盘可延迟，时间先保存，成果进入 pending |
| S11 | 复盘可显式跳过，不生成任务命令 |
| S12 | 未触达三级不要求化身 |

### 9.3 番茄钟页面

| # | 验收项 |
|---|--------|
| P01 | 准备态可选二级 WorkItem + 可选三级成果 + 可空计划开始 |
| P02 | 运行态钟居中，成果清单和 Note 编辑在钟下方 |
| P03 | 运行态可切换当前三级、成果钩、新建三级、编辑 Note |
| P04 | 沉浸模式保留，钟放大其余渐隐 |
| P05 | 复盘态渐进式展开五组信息 |
| P06 | 复盘态逐三级标注结果 + 命令回执 |
| P07 | 旧版功能保留：时长预设、模式切换、声景、习惯打卡、统计栏 |
| P08 | TaskSelector 升级为两级选择（二级 + 三级） |

---

## 10. Non-goals（首版不做）

### 任务模块

- 不做 ProjectGroup、Module
- 不做 Label 管理界面（首版用旧 tags 直接迁移为 labelIds）
- 不做 WorkItemNote 结构化 Block（首版纯文本，后续升级）
- 不做 Note 列表项提升为 WorkItem（后续实现）
- 不做正式依赖关系（depends_on / blocks）
- 不做 Cycle 容量

### Session

- 不做 SessionAttributionRevision 归属更正链
- 不做命令信封的完整幂等重试（首版用同步调用代理）
- 不做离线创建正式三级（离线只禁建，不禁计时）
- 不做 Session revision 更正链
- 不做执行化身自动建议算法

### 番茄钟页面

- 不做 Orbit L3 浮窗（tip-tip 后续）
- 不做 L3 思维导图可视化（Orbit 后续）
- 不做实时协同编辑冲突处理
- 不做富文本编辑器（Note 首版纯文本 textarea）

---

## 11. 实施顺序建议

```
Phase 1: 任务模块重构
  1.1 定义 WorkItem / WorkItemNote / Project 类型
  1.2 实现 task-store（WorkItem CRUD + Note + Project）
  1.3 实现 IndexedDB schema 和迁移
  1.4 旧 Task → WorkItem 数据迁移脚本

Phase 2: Session 模块重构
  2.1 定义 FocusSession / SessionWorkItemPlan / SessionWorkItemOutcome 类型
  2.2 实现 session-store（生命周期 + Plan + Outcome + 复盘）
  2.3 实现 timer-store 重构（对接 session-store）
  2.4 旧 Session → 新 Session 数据迁移

Phase 3: 番茄钟页面
  3.1 准备态：TaskSelector 两级选择 + 时长/模式 + 开始
  3.2 运行态：TimerRing + 成果清单 + Note 编辑 + 成果钩
  3.3 复盘态：五组信息 + 命令提交 + 回执
  3.4 UI/UX 质感提升

Phase 4: Orbit L3 联动（后续，tip-tip 项目）
```

---

## 附录 A：旧版功能保留清单

以下旧版功能在首版中保留，不删除：

| 功能 | 来源组件 | 保留方式 |
|------|----------|----------|
| TimerRing | `TimerRing.vue` | 重建为 React 组件，保留 glow/呼吸/数字翻转/庆祝粒子 |
| 沉浸模式 | `TimerView.vue` | 保留，钟放大其余渐隐 |
| 模式切换 | `ModeSwitcher.vue` | 保留（work/short_break/long_break/free/countdown） |
| 时长预设 | `TimerView.vue` | 保留 |
| 声景 | `SoundscapePanel.vue` | 保留 |
| 习惯打卡 | `HabitCheckIn.vue` | 保留 |
| 每日进度 | `DailyProgressBar.vue` | 保留 |
| 连续天数 | `StreakBadge.vue` | 保留 |
| 任务进度 | `TaskProgressIndicator.vue` | 升级为投入进度（effortActual / effortEstimateUpper） |
| Session 随记 | `SessionNoteModal.vue` | 保留，改为 sessionNote 字段 |
| 认知标记 | `SessionCognitiveMarkModal.vue` | 保留 |
| 快速笔记 | 浮动按钮 | 保留 |
| 底部统计栏 | `TimerView.vue` | 保留 |
| �