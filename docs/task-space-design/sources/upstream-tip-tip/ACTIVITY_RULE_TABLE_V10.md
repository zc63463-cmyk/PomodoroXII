# Project Activity 规则表 v1.1

> 日期：2026-07-11  
> 状态：P0 修复完成，待最终 P0 复审  
> 依赖：`PROJECT_ACTIVITY_V10.md`、`SESSION_TASK_INTEGRATION_V10.md`、`WORKITEM_SINGLE_USER_V11.md`、`CYCLE_CAPACITY_SINGLE_USER_V10.md`  
> 目标：定义可确定重建、可幂等验收的 Project Activity 投影规则

## 1. 定位与不变量

Activity 是 WorkItem、FocusSession、Cycle 正式事实的 Project 级只读投影，不是新的事实源。

给定以下输入：

- 相同的去重后 `DomainEvent` 集合；
- 相同的 `projectionVersion`；
- 相同的 Space 时区；

无论事件到达顺序、缓存状态或重建时间如何，规范化 Story 输出必须完全一致。

Activity 不承载 pending、unknown、failed、conflict 的处置事实；这些状态只进入统一待处理投影。

## 2. 统一 DomainEvent 信封

所有投影输入必须使用同一信封，不允许把自由 JSON 对象直接交给 Activity Projector。

```text
DomainEvent
- eventId: string                         // 全局唯一、不可变、幂等键
- eventType: string                       // 注册表中的正式事件名
- spaceId: string
- projectId: string
- occurredAt: ISO8601                     // 业务事实发生时间
- recordedAt: ISO8601                     // 服务端持久化时间
- aggregateType: work_item | focus_session | session_attribution |
                 session_outcome | work_item_command | effort_projection |
                 cycle | note | saved_view
- aggregateId: string
- aggregateRevision: integer >= 1         // 同一聚合内单调递增
- causationId?: string                    // 直接原因事件或命令 ID
- correlationId?: string                  // Session、命令或业务流程相关 ID
- payload: object
```

### 2.1 信封约束

1. `eventId` 重复时只接收第一份已持久化内容；同 ID 不同内容视为数据损坏并报警，不覆盖。
2. 缺少 `eventId`、`spaceId`、`projectId`、`occurredAt` 或聚合修订号的事件拒绝进入投影。
3. `recordedAt` 只用于诊断迟到程度，不参与 Story 分桶。
4. WorkItem 历史引用必须指向不可变 `eventId` 或 History ID，不得只引用当前 WorkItem ID。
5. Projector 先按 `eventId` 去重，再按规则选择每条 revision 链的最新有效版本。

## 3. 正式事件注册表

### 3.1 进入 Activity

Activity 使用投影层事件名。以下映射表说明投影事件与 WorkItem 契约领域事件的关系：

| 投影事件 | 源契约事件 | 说明 |
|---|---|---|
| `WorkItemStateCommandSucceeded` | `WorkItemCompleted` / `WorkItemCancelled` / `WorkItemReopened` / `WorkItemStatusChanged` | 投影层统一为命令成功事件，按 `toState` 区分 |
| `NoteItemPromoted` | `NoteItemPromotedToWorkItem` | 缩写 |
| `BlockerStarted` / `BlockerResolved` | 同名 | WorkItem v1.2 §15.1 已定义 |
| `ScopeExpansionMarked` | 同名 | WorkItem v1.2 §15.1 已定义 |
| `EffortCapCrossed` | 同名 | WorkItem v1.2 §15.1 已定义，`aggregateType=effort_projection` |
| `SessionNoteDistilled` | Session 契约中的 `SessionNoteDistilled` | 见 Session 集成 v1.0 |
| `SessionOutcomeRevisionAppended` | Session 契约中的 `SessionOutcomeRevisionAppended` | 见 Session 集成 v1.0 |
| `FocusSessionRevisionAppended` | Session 契约中的 `FocusSessionRevisionAppended` | 见 Session 集成 v1.0 |
| `SessionAttributionRevisionAppended` | Session 契约中的 `SessionAttributionRevisionAppended` | 见 Session 集成 v1.0 |

| # | eventType | 事实链 | 聚合范围 | storyType | 模板键 | 机器判定条件 |
|---|---|---|---|---|---|---|
| E01 | `WorkItemCreated` | WorkItem | structure | structure | `l1_created` / `l2_created` | `depth in [1,2]` |
| E02 | `WorkItemCreated` | WorkItem + Session | l2 | progress | `l3_discovered` | `depth=3 && payload.originSessionId != null` |
| E03 | `WorkItemStateCommandSucceeded` | WorkItem command | l2 | structure | `workitem_completed` | `depth in [1,2] && toState=completed` |
| E04 | `WorkItemStateCommandSucceeded` | WorkItem command | l2 | structure | `workitem_cancelled` | `toState=cancelled` |
| E05 | `WorkItemStateCommandSucceeded` | WorkItem command | l2 | structure | `workitem_reopened` | `fromState in [completed,cancelled] && toState active` |
| E06 | `WorkItemParentChanged` | WorkItem | old-l2 + new-l2 | structure | `workitem_moved` | `oldParentId != newParentId` |
| E07 | `EffortEstimateChanged` | WorkItem | l2 | plan_change | `estimate_adjusted` | 预计投入上下界发生变化 |
| E08 | `ScopeExpansionMarked` | WorkItem | l2 | plan_change | `scope_expanded` | 用户正式标记 |
| E09 | `BlockerStarted` | WorkItem | l2 | plan_change | `blocked_started` | 正式 blocker 创建 |
| E10 | `BlockerResolved` | WorkItem | l2 | plan_change | `blocked_resolved` | 对应 blocker 解除 |
| E11 | `WorkItemModuleChanged` | WorkItem | l2 | structure | `module_changed` | 二级的 Module ID 从无到有、有到无或 ID 改变 |
| E12 | `NoteItemPromoted` | Note + WorkItem | l2 | progress | `note_promoted` | 正式 WorkItem 创建成功 |
| E13 | `WorkItemStateCommandSucceeded` | WorkItem command | l2 | progress | `outcome_completed` | `depth=3 && toState=completed`，可关联 Session |
| E14 | `SessionOutcomeRevisionAppended` | Session outcome | l2 | progress | `outcome_resulted` | 最新有效 revision 的 result 为 progressed 或 stuck |
| E15 | `EffortCapCrossed` | EffortProjection | l2 | plan_change | `effort_cap_reached` | `beforeSeconds < capSeconds && afterSeconds >= capSeconds` |
| E16 | `SessionNoteDistilled` | Session + Note | l2 | progress | `note_distilled` | 随记正式沉淀成功 |
| E17 | `CycleStarted` | Cycle | cycle | cycle | `cycle_started` | Cycle 正式开始 |
| E18 | `CycleClosed` | Cycle | cycle | cycle | `cycle_closed` | Cycle 正式关闭 |
| E19 | `CycleMembershipChanged` | Cycle | cycle+l2 | cycle | `membership_changed` | 加入、移出或角色在 Committed/Planned/Stretch 间变化 |
| E20 | `CycleCapacityBandChanged` | Cycle | cycle+l2 | cycle | `capacity_state_changed` | 规范化 band ID 发生变化 |
| E21 | `CycleReviewDecisionRecorded` | Cycle | cycle | cycle | `cycle_decision` | 正式复盘决策写入 |
| E22 | `CycleStructureChanged` | Cycle | cycle | cycle | `cycle_structure_changed` | Committed/Planned 集合发生变化 |

### 3.2 不进入 Activity

| # | 事件或状态 | 原因 |
|---|---|---|
| X01 | 标题拼写、普通 description 编辑 | 低价值编辑；仅当前对象变化 |
| X02 | Note 自动保存 | 低价值编辑 |
| X03 | Checklist 勾选或重置 | 不影响正式成果 |
| X04 | 排序、Label、颜色、显示字段变化 | 无叙事价值 |
| X05 | Saved View 创建或修改 | 查询规则不是项目推进事实 |
| X06 | 普通有效 Session 且没有 E02/E13/E14/E15/E16 | 只更新 EffortProjection |
| X07 | 每次投入自然增长 | 不生成计时流水 |
| X08 | 普通容量刷新 | 自动派生，无正式决策 |
| X09 | WorkItem 状态命令 pending/unknown/failed/conflict | 进入待处理投影，不进入 Activity |
| X10 | FocusSession/Attribution/Outcome revision 自身 | 触发重算，不生成“更正”故事 |
| X11 | 投影版本升级或重建 | 部署配置，不是领域事件 |
| X12 | `PlanningRevised` 中的完成窗口、复盘点和硬截止调整 | 窗口微调无叙事价值；预计投入变化由 E07 覆盖，范围扩大由 E08 覆盖，阻塞由 E09/E10 覆盖 |
| X13 | `AttentionMarkedChanged` | 用户标记不是系统派生叙事事实 |
| X14 | `RelationCreated` / `RelationRemoved` | 依赖关系变化不直接进入叙事；由 `BlockerStarted` / `BlockerResolved` 覆盖真正阻塞 |

## 4. Revision 事实链

三条 Session revision 链必须独立选择最新有效版本。

| 修订链 | 正式事件 | 负责内容 | Activity 行为 |
|---|---|---|---|
| FocusSession revision | `FocusSessionRevisionAppended` | 净专注时长、有效性、暂停与撤销 | 重算 Story 的投入贡献；不改变成果事实 |
| Attribution revision | `SessionAttributionRevisionAppended` | Session 时间归属的 Project 与二级 | 移动投入贡献；普通无成果 Session 仍不生成 Story |
| Outcome revision | `SessionOutcomeRevisionAppended` | Session × 三级的当时结果与执行化身 | 最新有效 result 决定 E14；不直接完成 WorkItem |
| WorkItem 正式状态 | `WorkItemStateCommandSucceeded` | WorkItem 完成、取消、重开 | 永久独立事实；不随 Session 撤销自动回滚 |

### 4.1 revision 选择

1. 按 `(aggregateRevision, eventId)` 排序，选择最高 revision 中 `payload.effective=true` 且未被后续 revision 明确作废的版本。
2. FocusSession 无效时，其投入贡献为 0；独立的 WorkItem 状态成功事件仍保留。
3. Attribution 更正只移动时间贡献，不移动已经成功写入的 WorkItem 状态事实。
4. Outcome revision 的 completed 草稿只有在对应 WorkItem 命令成功后，才由 E13 表达正式完成。

## 5. 确定性聚合算法

### 5.1 effectiveAt

- 普通 WorkItem、Cycle、Note 事件：`effectiveAt = occurredAt`。
- Session 相关 E02/E13/E14/E15/E16：若存在 `payload.sessionStartedAt`，使用 Session 开始时间作为聚合锚点；Story 的 `endedAt` 仍取相关事实结束时间最大值。
- 迟到同步仍使用原始 `occurredAt/sessionStartedAt`，不得使用 `recordedAt`。

### 5.2 稳定排序

所有候选事实先按以下键升序排序：

```text
(effectiveAt, eventId)
```

输入数组顺序不参与结果。

### 5.3 aggregationScope

```text
l2 scope       = l2:{level2WorkItemIdSnapshot}
cycle scope    = cycle:{cycleId}
structure scope= structure:{eventId}
```

不同 scope 永不合并。E06 在旧父和新父分别产生一个派生事实，各有稳定派生 ID：`{eventId}:old`、`{eventId}:new`。

### 5.4 gap-based sessionization

对同一 `spaceId + projectId + aggregationScope` 的事实执行：

1. 按 `(effectiveAt,eventId)` 稳定排序。
2. 第一条事实开启 Story cluster。
3. 后续事实与当前 cluster 最后一条事实的间隔 `< 4 小时` 时合并。
4. 间隔 `>= 4 小时` 时开启新 cluster；恰好 4 小时不合并。
5. 0h、3h、6h 为一个 cluster，因为相邻间隔均小于 4 小时。
6. Space 时区用于自然日判断。跨自然日默认开启新 cluster。
7. 同一 `correlationId=sessionId` 的 Session 事实强制合并，优先于 4 小时和跨日边界；归入 Session 开始时间所在自然日。
8. Cycle scope 不与 l2 scope 合并；structure scope 每个结构事件单独成 Story。
9. 迟到事件到达后对受影响 Project 的候选事实完整重算；迟到事实可以导致 Story 合并、拆分或边界移动。

### 5.5 同 Session 强制合并

同一 Session 相关的 E02、E13、E14、E15、E16 共享 `correlationId=sessionId`，必须进入同一 cluster。命令后续对账成功仍保留原 correlationId 和原始业务时间。

## 6. Story 身份、版本与血缘

### 6.1 Story ID

```text
storyId = sha256(
  projectionVersion + "|" +
  spaceId + "|" +
  projectId + "|" +
  aggregationScope + "|" +
  orderedSourceFactIds.join(",")
)
```

`orderedSourceFactIds` 使用实际参与 Story 的不可变 eventId 或稳定派生事实 ID。

以下变化会生成新 Story ID：

- 成员事实增加、删除或被新 revision 替代；
- cluster 拆分或合并；
- aggregationScope 改变；
- `projectionVersion` 改变。

纯缓存刷新、分页读取或 `projectionRevision` 增加但规范化事实未变化，不改变 Story ID。

### 6.2 supersede 血缘

Story 保存：

```text
supersedesStoryIds: string[]
supersededByStoryIds: string[]
```

- 一旧一新：两个数组各含一个 ID。
- 一旧拆多新：旧 Story 的 `supersededByStoryIds` 含多个新 ID。
- 多旧合一新：新 Story 的 `supersedesStoryIds` 含多个旧 ID。
- 旧 Story 被完全删除且没有替代 Story（例如唯一叙事事实被作废）时，`supersededByStoryIds=[]`，并记录确定性终止原因 `supersedeReason=source_facts_removed`；它不再进入当前可见集合。
- 当前可见集合只展示最新构建产生且未被 supersede 的 Story。
- 不允许用单值 `supersededByStoryId` 表达拆分或合并。

### 6.3 projectionVersion 与 projectionRevision

| 字段 | 含义 | 何时变化 | 是否参与 Story ID |
|---|---|---|---|
| `projectionVersion` | 规则、模板与规范化算法版本 | 代码或配置发布 | 是 |
| `projectionRevision` | 某 Project 投影成功构建序号 | 迟到事件、revision、更正、手工重建 | 否 |
| `rebuiltAt` | 本次物化时间 | 每次构建 | 否；属于非确定性元数据 |

投影版本升级由部署配置触发，不使用 `ProjectionVersionUpgraded` 领域事件。

## 7. summaryFacts 与展示规则

### 7.1 稳定排序

- completed/progressed/stuck/discovered：按 `(factOccurredAt, sourceEventId, workItemId)` 排序。
- sourceRefs：按 `(occurredAt,eventId,refType)` 排序并按 `eventId` 去重。
- 同一三级在不同 Session 中出现 progressed/stuck 时，两条历史事实均保留，不推导“最终结果”。
- 投入先以整数秒求和，渲染时向下取整为分钟；1–59 秒显示 `<1 分钟`，0 秒不显示投入字段。

### 7.2 标题优先级

同一 Story 有多个候选模板时：

```text
E15 投入达上限 > E13 完成成果 > E14 stuck > E14 progressed > E02 发现 > E16 沉淀
```

标题只是模板选择，不改变 `summaryFacts`。

### 7.3 模板注册表

| storyType | templateKey | 模板 |
|---|---|---|
| progress | `l3_discovered` | `执行中发现「{l3Title}」` |
| progress | `outcome_completed` | 单个：`完成「{l3Title}」`；多个：`完成 {count} 项成果` |
| progress | `outcome_resulted` | `{resultLabel}「{l3Title}」` |
| progress | `note_promoted` | `Note 项提升为「{newWorkItemTitle}」` |
| progress | `note_distilled` | `沉淀关键说明到「{targetNoteTitle}」` |
| plan_change | `estimate_adjusted` | `预计投入调整为 {newRange}` |
| plan_change | `scope_expanded` | `标记范围扩大` |
| plan_change | `blocked_started` | `进入阻塞：{blockReason}` |
| plan_change | `blocked_resolved` | `阻塞解除` |
| plan_change | `effort_cap_reached` | `累计投入达到预计上限` |
| structure | `l1_created` | `新建阶段：{l1Title}` |
| structure | `l2_created` | `新建工作范围：{l2Title}` |
| structure | `workitem_completed` | `{workItemTitle} 已完成` |
| structure | `workitem_cancelled` | `{workItemTitle} 已取消` |
| structure | `workitem_reopened` | `{workItemTitle} 重新打开` |
| structure | `workitem_moved` | `{workItemTitle} 从 {oldParent} 移至 {newParent}` |
| structure | `module_changed` | `{l2Title} 移至 {moduleName}` |
| cycle | `cycle_started` | `{cycleName} 开始` |
| cycle | `cycle_closed` | `{cycleName} 关闭` |
| cycle | `membership_changed` | `{l2Title} {action} {cycleName}` |
| cycle | `capacity_state_changed` | `{l2Title} 容量状态变为 {newState}` |
| cycle | `cycle_decision` | `Cycle 复盘：{decisionSummary}` |
| cycle | `cycle_structure_changed` | `Cycle 结构调整：{changeSummary}` |

模板只引用源事实已提供字段，不得创造新估算、因果或评价。

## 8. 快照与 sourceRefs

每个进入 Story 的事实保存发生时快照：

- `level2WorkItemIdSnapshot`
- `level2TitleSnapshot`
- `moduleIdSnapshot?`
- `moduleNameSnapshot?`
- `cycleIdSnapshot?`
- `cycleNameSnapshot?`

后续改名、移动或 Module 调整不改写旧 Story 快照。

```text
sourceRef
- eventId: string
- refType: focus_session | workitem_history | cycle_history | note_history | effort_crossing
- aggregateType: string
- aggregateId: string
- aggregateRevision: integer
- occurredAt: ISO8601
- snapshot: object
```

跳转可使用当前 aggregateId；历史追溯必须使用不可变 eventId/History ID。

## 9. 更正、撤销、迟到与重建

### 9.1 FocusSession 时长更正

追加 `FocusSessionRevisionAppended`，选择最新有效 revision，重算投入。成员事实变化会生成新 Story ID，并通过血缘 supersede 旧 Story；不生成“更正”故事。

### 9.2 Session 撤销

FocusSession 最新 revision 变为 invalid 后，移除投入贡献。独立 `WorkItemStateCommandSucceeded` 仍保留。若移除后没有叙事事实，旧 Story 被 supersede 且不产生新可见 Story。

### 9.3 Attribution 更正

`SessionAttributionRevisionAppended` 只移动投入贡献。普通无成果 Session 在新旧二级两侧都不生成 Activity Story。若 Session 同时有叙事事实，成果历史仍按其正式 WorkItem/二级快照归属，不因时间归属更正而移动。

### 9.4 命令未成功与后续对账

pending/unknown/failed/conflict 不进入 Activity。后续成功时写入新的 `WorkItemStateCommandSucceeded`，使用命令原始业务时间和 correlationId，完整重算后按确定性算法聚合。

### 9.5 迟到同步

迟到只增加 `projectionRevision`。使用原业务时间完整重算，允许 cluster 合并或拆分；`projectionVersion` 不变。

### 9.6 重复投递

按 `eventId` 去重。相同 ID 不重复贡献投入、成果或 sourceRef，也不产生 supersede。

### 9.7 投影版本升级

部署配置提升 `projectionVersion` 后，从全部源事实重建。Story ID 因版本参与哈希而变化，新旧 Story 建立 supersede 血缘；不创建任何领域事件。

## 10. 严格验收规则

1. 每组数据先按 eventId 去重，再按规则规范化；不得依赖输入数组顺序。
2. 规范化 Story 必须严格深相等；只排除 `rebuiltAt`、数据库物理行 ID 等明确非确定性元数据。
3. 必须验证 4 小时边界：`<4h` 合并、`=4h` 拆分、`>4h` 拆分。
4. 必须验证链式窗口 0h/3h/6h 合并。
5. 必须验证同时间事件按 eventId 稳定排序。
6. 必须验证跨日拆分与同 Session 跨日强制合并。
7. 必须验证迟到事件引发的多旧合一或一旧拆多血缘。
8. 必须验证 projectionVersion 和 projectionRevision 不混用。
9. 必须验证普通无成果 Session 在 attribution 更正后仍不生成 Story。
10. 必须验证 Module、Saved View 与待处理状态不进入 Activity。
