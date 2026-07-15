# WorkItem 单人 Space 领域契约

> 状态：已批准领域总纲下的修订契约  
> 版本：v1.2  
> 日期：2026-07-11  
> 替代范围：若与 WorkItem v1.0 五份规格冲突，以本文件为准

## 1. 问题与目标

PomodoroXII 是单用户、多隔离 Space 产品，不需要团队 Workspace、成员、负责人和权限。WorkItem 必须支持长期项目管理，又允许用户只规划到一级/二级，临近执行时再像思维导图一样长出三级成果。

目标：

1. 保持一个统一 WorkItem 实体和最多三层单父树；
2. 让二级成为预计投入、Session 实际投入和 Cycle 容量口径；
3. 让三级表达具体成果，而不是时间分摊或临时行动项；
4. 用 WorkItemNote 承载更细行动指导，避免第四级任务；
5. 保持单人、低负担、可离线、可审计的事实边界。

## 2. Non-goals

- 不做成员、邀请、assignee、权限或审批；
- 不做跨 Pomodoro Space 引用、移动、依赖或统计；
- 不用子项数量生成父项完成百分比；
- 不把三级参考估时叠加到 Cycle 容量；
- 不让 Note Checklist 改变 WorkItem 状态；
- 不在本契约冻结 L2/L3 最终视觉与动画。

## 3. 作用域层级

```text
PomodoroSpace
└── ProjectGroup?（轻量项目分类）
    └── Project
        ├── Module?（轻量长期领域分类）
        └── WorkItem（最多三层，可选归属一个 Module）
```

### 3.1 Pomodoro Space

- 是业务数据、隐私、同步和统计的隔离边界；
- Project、WorkItem、Cycle、Session 和跨域关联必须携带相同 `spaceId`；
- 跨 Space 引用、移动、命令与聚合一律拒绝；
- 归档 Space 后业务事实只读；删除由 PomodoroXII 空间级流程负责。

### 3.2 Project Group

```text
ProjectGroup
- projectGroupId
- spaceId
- name
- color?
- rank
```

只用于整理 Project。它不拥有 WorkItem、Cycle、容量、类型库、权限或业务设置。Project 可不属于任何分组。

### 3.3 Module

Module 是 Project 内可选的长期领域分类，适用于 PomodoroXII、MarkVault-JS 等持续演进的产品型 Project；阶段性交付型 Project 可完全不启用。

```text
Module
- moduleId
- spaceId
- projectId
- name
- description?
- color?
- rank
- archivedAt?
- version
```

不变量：

- Module 与 Project 必须同 Space；
- Module 只归类 WorkItem，不形成第四层父子树；
- 每个 WorkItem 最多属于一个 Module，也可无 Module；
- Module 不拥有状态、完成时间、预计投入、Session、Cycle Membership、容量、权限或进度百分比；
- Module 不因其 WorkItem 全部完成而自动完成或归档；
- Module 归档后不再作为新归属候选，已有 WorkItem 的历史归属保留，活动 WorkItem 需要用户移动或显式保留只读归属；
- 删除 Module 前必须选择清空 WorkItem 的 `moduleId` 或迁移到同 Project 其他 Module，不删除 WorkItem；
- Module 与 Label 分工：Module 是唯一主要长期领域，Label 是可多选横切特征。

默认行为：

- 在有 Module 的父项下创建子 WorkItem 时，默认继承父项 `moduleId`；
- 用户可显式更改子项 Module，不强制整棵子树一致；
- 移动 WorkItem 不自动改变 `moduleId`，若新父项 Module 不同，仅提示确认；
- Module 变化不修改 WorkItem 状态、父子关系、预计投入、Cycle 或 Session 历史。

## 4. 稳定身份

| 对象 | 稳定 ID | 作用域 |
|---|---|---|
| PomodoroSpace | `spaceId` | 应用级隔离 |
| ProjectGroup | `projectGroupId` | Space 内 |
| Project | `projectId` | Space 内 |
| Module | `moduleId` | Project 内长期领域 |
| WorkItem | `workItemId` | Space 内稳定，全局可使用 UUID |
| Type | `typeId` | Space 内类型库 |
| Label | `labelId` | Space 内标签库 |
| StatusDefinition | `statusId` | Space 内状态库 |
| WorkItemNote | `noteId` | 与 WorkItem 一对一 |
| NoteBlock | `blockId` | Note 内稳定 |
| Relation | `relationId` | Space 内 |

## 5. WorkItem 核心字段

| 字段 | 类型 | 可空 | 默认/规则 |
|---|---|---:|---|
| `workItemId` | ID | 否 | 系统生成，不可变 |
| `spaceId` | ID | 否 | 当前 Space，不可跨域修改 |
| `projectId` | ID | 否 | 同 Space |
| `displayKey` | string | 否 | Project 内唯一 |
| `title` | string | 否 | 去首尾空白后非空 |
| `description` | rich text | 是 | 说明是什么、为什么、完成结果 |
| `typeId` | ID | 否 | Project 默认，回退 Space 兜底 Type |
| `statusId` | ID | 否 | Project 默认，回退 not_started |
| `labelIds` | ID[] | 否 | Space 内多选 |
| `priority` | enum | 是 | 可选；枚举值见 §5.1 |
| `moduleId` | moduleId | 是 | 同 Space、同 Project；最多一个 |
| `parentId` | workItemId | 是 | 同 Project，最大三层 |
| `childRank` | number | 否 | 同父项排序 |
| `completedAt` | datetime | 是 | 当前完成投影 |
| `cancelledAt` | datetime | 是 | 当前取消投影 |
| `archivedAt` | datetime | 是 | 收纳属性，不改状态 |
| `markedAsAttention` | boolean | 否 | 默认 false；用户显式标记关注，用于 progressAnomaly 条件 E |
| `createdAt` / `updatedAt` | datetime | 否 | 审计 |
| `version` | integer | 否 | 乐观并发版本 |

删除 `workspaceId` 和 `assigneeId`。单用户操作者通过事件 `actorId` 审计，不形成任务负责人。

### 5.1 Priority 枚举

```text
Priority
- low      # 可延后，无紧迫性
- medium   # 正常推进
- high     # 需要优先处理
- urgent   # 阻碍其他工作或不可延期
```

- 枚举按注册代码比较，不使用显示名称；
- `null` 表示未设置优先级，不等于 `low`；
- 排序时 `null` 排在最后；
- 枚举值不可自定义，后续扩展需升级 `fieldRegistryVersion`。

### 5.2 二级排期字段（ScheduleFields）

以下字段仅对二级 WorkItem 有完整语义；一级和三级可设置 `hardDeadline`，其余字段对一级和三级无意义。

```text
ScheduleFields
- completionWindowStart?:  datetime     // 完成窗口开始
- completionWindowEnd?:    datetime     // 完成窗口结束
- reviewPoint?:            datetime     // 复盘点
- hardDeadline?:           datetime     // 硬截止（1/2/3 均可设置）
- effortEstimateLowerSeconds?: integer  // 预计投入下限
- effortEstimateUpperSeconds?: integer  // 预计投入上限
- effortActualSeconds:     integer      // 派生：来自有效 Session revision 的净专注秒数
- confidence?:             enum         // 信心：low / medium / high
```

约束：

- `effortEstimateLowerSeconds` 和 `effortEstimateUpperSeconds` 同时设置或同时为空；
- `effortEstimateLowerSeconds <= effortEstimateUpperSeconds`；
- `effortEstimateUpperSeconds > 0` 时才可计算 `effortUpperBoundUsageRatio`；
- `effortActualSeconds` 是派生字段，由 EffortProjection 从最新有效 Session Attribution revision 求和得出，不由用户直接编辑；
- `effortActualSeconds >= effortEstimateUpperSeconds` 时触发 `effortLimitReached` 信号；
- `confidence` 枚举按注册代码比较，`null` 表示未设置；
- 所有时间字段使用 Space 时区，不使用设备本地时区。

## 6. 统一实体与层级派生

- `parentId = null`：一级；
- 父项为一级：二级；
- 父项为二级：三级；
- 不持久化 `level` 业务类型；
- 移动 WorkItem 只修改父子关系，但必须校验整棵子树不超过三层；
- 父子必须同 Space、同 Project；
- 三级继续拆解时提供：添加 Note，或人工提升当前项后再拆；
- 系统不自动提升。

### 6.1 深度默认行为

| 深度 | 产品默认 | 容量/Session |
|---|---|---|
| 一级 | 范围与主题 | 不直接承接 Session；从一级启动需先选择/新建二级 |
| 二级 | 可交付工作块与投入容器 | 唯一预计投入、实际 Session 投入和 Cycle Membership 口径 |
| 三级 | 可确认具体成果 | 不分配 Session 分钟；默认不估时、不独立加入 Cycle |

三级仍保留完整 WorkItem 能力，但 L3 默认只突出标题、状态、description、Note、来源与轻量关系。

## 7. WorkItemNote

每个 WorkItem 最多一份结构化 Note，不要求标题：

```text
WorkItem
├── description：是什么 / 为什么 / 完成结果
└── WorkItemNote：怎么推进 / 注意什么
```

### 7.1 Block

P0 支持：

- `paragraph`
- `heading`
- `ordered_list`
- `unordered_list`
- `checklist`

列表最多两层。每个 Block 与 ListItem 有稳定 ID 和排序。

### 7.2 Checklist

- 勾选是共享、跨设备同步的 Note 内容事实；
- 永久保留，只能手动重置；
- 不改变 WorkItem 状态、完成时间、容量、风险或 Cycle；
- 不作为 Session 成果计划对象；
- L3/Orbit 必须与正式成果勾选使用不同文案和视觉。

### 7.3 提升为 WorkItem

- 源 WorkItem 是一级/二级：创建其子 WorkItem；
- 源 WorkItem 是三级：创建为同一二级父项下的三级同级项；
- 原 Note Item 转为新 WorkItem 引用，停止维护独立 checked 状态；
- 保存 sourceNoteId/sourceBlockId/sourceItemId 追溯。

## 8. 状态模型

底层六类保持：

```text
not_started / in_progress / paused / waiting / completed / cancelled
```

Space 维护显示状态库，Project 选择启用范围与默认状态。状态名称不驱动逻辑。

关键规则：

- 三级可从 not_started 直接完成，不伪造 in_progress；
- 二级获得首个有效 Session 投入时，若为 not_started 自动转 in_progress；
- paused/waiting/completed/cancelled 不被 Session 静默覆盖；
- 完成/取消停止未来未完成提醒；
- 归档不改变状态；
- 三级已完成/已取消默认进入父级“成果与历史”。

## 9. 父子完成与进展

### 9.1 三级聚合

二级只展示计数和状态分布，例如：

```text
三级成果：已完成 2 / 共 4；等待 1
```

禁止换算父项百分比，禁止根据三级数量驱动二级完成。

### 9.2 二级完成

- 三级全部完成只形成成果摘要，不自动完成二级；
- 用户可随时主动完成二级；
- 二级完成时若存在活动三级，必须选择：取消、移动到其他未完成二级、重新打开原二级后继续，或返回；
- 不能留下仍可承接执行的悬挂三级；
- 纯历史完成/取消项可保留在成果区。

## 10. 计划与投入

### 10.1 柔性计划字段

保留完成窗口、预计投入区间、信心、复盘点和硬截止。所有时区默认读取当前 Space 设置，不再使用 Workspace 时区。

### 10.2 二级投入

- 二级预计投入覆盖完成该二级成果所需的全部工作；
- 包含已拆出与尚未拆出的三级成果；
- Session 净专注时长只累计到二级；
- 三级参考估时不叠加容量；
- 系统可用原预计与累计投入建议剩余区间，但不得自动覆盖；
- 达到或超过预计上限时产生显著复核信号。

### 10.3 三级默认

- 快速创建只需标题；
- 默认不要求预计投入、完成定义或 Note；
- 用户可在详情填写参考估时，但仅作局部判断；
- 三级不独立成为 Cycle Membership。

## 11. Type、Label 与状态库作用域

- 原 Workspace 级库全部迁移为当前 Space 级；
- Project 从 Space 类型/状态库选择启用项和默认项；
- Space 必须保留不可归档的兜底 Type、not_started 状态与 completed 状态；
- 名称、图标和颜色可改，稳定 ID 驱动逻辑；
- Project Group 不拥有这些定义。

## 12. Relation

- 父子仅同 Project；
- 正式依赖允许同一 Space 跨 Project；
- 禁止跨 Space 依赖；
- depends_on 禁止自环、重复边和新增有向环；
- 三级可使用正式依赖，但默认在详情维护，L3 只显示轻量阻塞提示；
- 被阻塞三级加入 Session 前需确认；
- relates_to/duplicates/evidence_for 不产生阻塞风险。

## 13. 派生信号

| 信号 | 条件 | 说明 |
|---|---|---|
| `needsReplan` | 活动项 `completionWindowEnd < now` 且状态非 completed/cancelled | 不等于失败 |
| `blockedByDependency` | 存在状态为 active 的 blocking 依赖 | 真正阻塞 |
| `reviewDue` | `reviewPoint <= now` 且状态非 completed/cancelled | 可进入待处理 |
| `effortLimitReached` | `effortActualSeconds >= effortEstimateUpperSeconds` 且 `effortEstimateUpperSeconds > 0` | 显著复核来源 |
| `progressAnomaly` | 满足以下任一条件 | 派生信号，不改状态 |

`progressAnomaly` 以二级为问题卡，三级提供原因证据。

### 13.1 progressAnomaly 精确判定条件

`progressAnomaly = true` 当且仅当二级 WorkItem 满足以下任一条件：

```text
条件 A — 过复盘点未完成
  reviewPoint IS NOT NULL
  AND reviewPoint < now
  AND status NOT IN (completed, cancelled)

条件 B — 投入达上限未完成
  effortLimitReached = true
  AND status NOT IN (completed, cancelled)

条件 C — 连续卡住
  最近 3 个有效 Session 中，该二级关联的三级成果
  出现 >= 2 次 stuck 结果
  AND status NOT IN (completed, cancelled)

条件 D — 多轮未完成
  最近 3 个有效 Session 均有该二级的成果计划，
  但无任一 Session 产出 completed 成果
  AND status NOT IN (completed, cancelled)

条件 E — 用户主动关注
  workItem.markedAsAttention = true
  （用户在待处理区或任务详情中显式标记关注）
```

约束：

- 所有"最近 N 个 Session"按 `sessionStartedAt` 降序取前 N 个 `validity=valid` 的 Session（`pending` 和 `invalid` 不计入）；
- `stuck` 和 `completed` 来自最新有效 `SessionOutcomeRevision`；
- 同一 Session 中对同一三级既有 stuck 又有 completed 时，分别计入；
- 用户取消 `markedAsAttention` 后条件 E 不再满足，但 A–D 仍可独立触发；
- `progressAnomaly` 每次相关事实变化时重新计算，不持久化历史值；
- 该信号只进入待处理区和 AST 布尔字段 `hasProgressAnomaly`，不改变 WorkItem 状态或 Cycle Membership；
- 首版判定算法由 `evaluatorVersion = evaluator-1.0` 锁定，后续调整需升级版本。

## 14. 工作面修订

默认列表删除“负责人”列。建议默认列：

1. 层级/标题；
2. Type；
3. 状态；
4. 计划窗口；
5. 二级投入（三级显示“随父项”或隐藏）；
6. Cycle 角色（只对二级）；
7. 可行动信号。

详情布局：

```text
Header: displayKey / title / status / actions
Summary: Type / labels / depth / parent
Planning: window / effort / confidence / review / hard deadline
Structure: parent / children counts / outcomes history
Relations: depends on / blocks / related
Attention: signals / next actions / open in L3
Content: description
WorkItemNote: structured blocks
Execution: recent Session evidence / recent persona distribution（派生，只读）
Activity: Project 级只读进展叙事投影（详见 `PROJECT_ACTIVITY_V10.md`）
```

## 15. 事件

所有事件必须携带 `spaceId`：

- `WorkItemCreated`
- `WorkItemParentChanged`
- `WorkItemStatusChanged`
- `WorkItemCompleted`
- `WorkItemCancelled`
- `WorkItemReopened`
- `WorkItemNoteBlockChanged`
- `NoteItemPromotedToWorkItem`
- `EffortEstimateChanged`
- `PlanningRevised`
- `WorkItemModuleChanged`
- `ModuleCreated/Updated/Archived/Deleted`
- `RelationCreated/Removed`
- `BlockerStarted`
- `BlockerResolved`
- `ScopeExpansionMarked`
- `EffortCapCrossed`
- `AttentionMarkedChanged`

事件 `actorId` 仅用于单用户操作审计，不等同 assignee。

### 15.2 AttentionMarkedChanged 事件定义

```text
AttentionMarkedChanged
- workItemId
- markedAsAttention: boolean
- changedAt
```

约束：

- 用户在待处理区或任务详情中显式标记/取消关注；
- 该事件不进入 Activity 白名单（属于用户标记，不是系统派生叙事）；
- `markedAsAttention = true` 是 progressAnomaly 条件 E 的唯一输入；
- 取消标记后条件 E 不再满足，但条件 A–D 仍可独立触发。

### 15.1 新增事件定义

```text
BlockerStarted
- workItemId
- blockerType: dependency | external | manual
- blockerDescription?
- startedAt

BlockerResolved
- workItemId
- blockerType
- resolvedAt
- resolution: resolved | cancelled_blocker

ScopeExpansionMarked
- workItemId
- previousScopeDescription?
- newScopeDescription?
- markedAt

EffortCapCrossed
- workItemId        // 二级
- beforeSeconds
- afterSeconds
- capSeconds        // effortEstimateUpperSeconds
- crossedAt
- sourceSessionId?  // 触发跨越的 Session
```

约束：

- `BlockerStarted` 和 `BlockerResolved` 仅记录正式阻塞，不记录 Note 中的 informal 标记；
- `ScopeExpansionMarked` 是用户主动操作，不由系统自动推断；
- `EffortCapCrossed` 是 EffortProjection 的派生事件，由 `beforeSeconds < capSeconds && afterSeconds >= capSeconds` 触发，不由用户直接创建；
- 这些事件均携带标准 `spaceId`、`projectId`、`occurredAt` 和 `recordedAt`；
- `EffortCapCrossed` 的 `aggregateType = effort_projection`。

## 16. 验收标准

1. **Space 隔离**：跨 Space 设置父项、依赖、Cycle 或 Session 关联时必须拒绝。
2. **三级快速创建**：在 Session 规划中连续输入标题即可创建多个三级，不要求估时。
3. **二级容量**：创建三级后 Cycle 总投入不自动增加。
4. **三级完成**：未开始三级可由 Session 结果直接完成并记录来源。
5. **父项不自动完成**：三级全部完成后只显示成果摘要。
6. **无百分比**：二级不得显示基于三级数量的完成百分比。
7. **Note 边界**：Checklist 勾选不改变 WorkItem 或 Session 成果。
8. **提升 Note Item**：提升后原 Item 变成 WorkItem 引用且不再有独立 checked 状态。
9. **二级完成冲突**：存在活动三级时不能留下可执行悬挂项。
10. **无负责人**：默认列表、详情和批量操作不出现成员/负责人字段。
11. **状态保护**：启动 Session 不得静默恢复 waiting/paused 或重开 completed/cancelled。
12. **历史冻结**：WorkItem 重组不改写历史 Session 的层级与父项快照。
13. **Module 不计容量**：创建、归档或切换 Module 不改变 Cycle 预计投入、实际投入或 Membership。
14. **Module 不计进度**：Module 不显示由 WorkItem 状态派生的完成百分比，也不因所有 WorkItem 完成而自动归档。
15. **Module 删除安全**：删除 Module 只能清空/迁移归属，不得删除或取消 WorkItem。

## 17. 优先级

### P0

- Space 同域约束；
- Project Group 轻量项目分类；
- 轻量 Module 长期领域分类；
- 统一三层 WorkItem；
- 六类状态；
- 二级/三级默认行为；
- WorkItemNote 五类 Block；
- 二级唯一容量与投入口径；
- 父项完成冲突处理；
- Space 级 Type/Label/Status；
- 正式依赖与环检测。

### P1

- Note Item 提升批量操作；
- 三级参考估时校准提示；
- 最近执行化身分布；
- 批量移动三级成果；
- Saved View 由独立 v1.0 契约定义，不在 WorkItem 中复制查询结果。

### P2

- 跨 Space 显式导出/导入；
- 更丰富 Note Block；
- 自动依赖建议；
- 多用户协作重新立项，不在当前模型预埋半套权限。

## 18. 开放问题

无阻塞产品问题。具体“多轮未完成”和“反复哈吉米”阈值进入待处理派生规则，不写入 WorkItem 核心状态机。
