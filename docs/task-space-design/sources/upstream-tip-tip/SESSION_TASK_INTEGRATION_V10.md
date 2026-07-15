# FocusSession × Task Space 集成契约 v1.0

> 状态：产品契约基线
>
> 日期：2026-07-10
>
> 上游基线：`DOMAIN_BASELINE_APPROVAL.md`、`GRILL_ME_SYNTHESIS.md`、`WORKITEM_SINGLE_USER_V11.md`、`CYCLE_CAPACITY_SINGLE_USER_V10.md`

## 1. 目的

本契约定义 PomodoroXII 与任务空间之间的正式产品边界，解决以下问题：

1. 一段 FocusSession 的实际投入如何归属任务；
2. Session 如何计划、处理和复盘第三级 WorkItem；
3. 计时事实、任务状态、执行化身和 Note Checklist 如何避免双重事实；
4. 离线、重试、更正、部分成功和结构变化时如何保持历史可解释；
5. Session 如何驱动二级投入投影、Cycle 容量和待处理区，而不把时间误当作进度。

## 2. 核心原则

1. **PomodoroXII 是 FocusSession 事实源。**
2. **任务空间是 WorkItem、WorkItemNote、父子结构和正式状态的唯一事实源。**
3. **每个 Session 只归属一个二级 WorkItem。**
4. **Session 时间只累计到二级，不分配给三级。**
5. **三级 WorkItem 是本轮成果对象，不是分钟容器。**
6. **WorkItemNote Checklist 是行动指导，不是 Session 成果对象。**
7. **计时结束、成果复盘和正式任务命令相互解耦。**
8. **历史使用稳定引用与当时快照，不因后续改名、移动或层级调整而重写。**
9. **所有引用必须同属一个 Pomodoro Space；首版不跨 Space 查询、关联或聚合。**
10. **任何自动建议都不能静默改变 WorkItem 状态、估算、Cycle 角色或执行化身。**

## 3. 领域对象与事实归属

| 对象 | 事实源 | 说明 |
|---|---|---|
| `FocusSession` | PomodoroXII | 时间、暂停、中断、有效性、总体评价、Mood、随记 |
| `SessionTaskContext` | PomodoroXII | 启动时 Space、Project、二级归属的不可变快照 |
| `SessionAttributionRevision` | PomodoroXII | 二级时间归属的追加式更正链，最新有效版本驱动投入投影 |
| `SessionWorkItemPlan` | PomodoroXII | 本轮三级计划、来源、顺序、加入与移除历史 |
| `SessionWorkItemOutcome` | PomodoroXII | 三级本轮结果、执行化身、完成/取消命令意图及执行结果 |
| `WorkItem` | 任务空间 | 标题、状态、类型、父子结构、描述、关系 |
| `WorkItemNote` | 任务空间 | 结构化行动指导、Checklist 共享勾选事实 |
| `EffortProjection` | 任务空间派生读模型 | 根据 Session 最新有效 revision 聚合二级实际投入 |
| `AttentionProjection` | 任务空间派生读模型 | 真正阻塞、推进异常、待成果复盘、待同步与冲突四类问题 |

禁止在 PomodoroXII 中维护可写的 WorkItem 状态副本；允许保存只读缓存、标题快照和待执行命令状态。

## 4. 最小数据模型

### 4.1 FocusSession

```text
FocusSession
- sessionId
- spaceId
- startedAt
- endedAt?
- grossSeconds
- pausedSeconds
- breakSeconds
- focusedSeconds
- validity: pending / valid / invalid
- validityReason?
- timerCompletion: completed / ended_early / interrupted
- overallProgress?: smooth / progressed / stuck / interrupted
- mood?: great / good / normal / bad / terrible
- sessionNote?
- reviewState: not_required / pending / completed / skipped
- revision
- correctedFromRevision?
- createdAt
- updatedAt
```

`timerCompletion` 只表示计时流程，不表示任务是否完成。

### 4.2 SessionTaskContext

```text
SessionTaskContext
- sessionId
- spaceId
- projectId
- level2WorkItemId
- level2TitleSnapshot
- level2ParentIdSnapshot?
- level2EstimateMinSnapshot?
- level2EstimateMaxSnapshot?
- level2StatusSnapshot
- structureVersionSnapshot
- linkedAt
- linkMethod: explicit / contextual_confirmed
```

首版不允许 `linkMethod = inferred_without_confirmation`。`SessionTaskContext` 是启动快照，后续归属更正不得覆盖它。

### 4.2.1 SessionAttributionRevision

```text
SessionAttributionRevision
- attributionRevisionId
- sessionId
- revision
- spaceId
- projectId
- level2WorkItemId
- reason?
- correctedFromRevision?
- effective: boolean
- createdAt
```

- Session 创建时写入 revision 1，与启动 `SessionTaskContext` 一致；
- 更正二级归属时追加 revision，不覆盖旧版本；
- 同一 Session 只有一个最新 `effective = true` 的归属版本；
- 新旧归属必须同 Space；
- EffortProjection 和 Activity 的时间贡献读取最新有效归属 revision；
- Session 历史仍展示启动 Context，并明确标记当前时间归属已更正。

### 4.3 SessionWorkItemPlan

```text
SessionWorkItemPlan
- sessionPlanItemId
- sessionId
- workItemId
- titleSnapshot
- level2WorkItemIdSnapshot
- level2TitleSnapshot
- planRank
- source: before_start / during_session / review_materialized
- addedAt
- removedAt?
- removalReason?
- currentDuringSession: boolean
- completionDraft: boolean
```

规则：

- 所有关联三级项必须在启动时与归属二级同父；
- `completionDraft` 是 Session 内可撤销草稿，不是正式 WorkItem 状态；
- 从本轮移除不删除或取消 WorkItem；
- 运行中新增必须记录 `during_session`；
- 结束后补建必须先由任务空间创建成功，再写入正式 `workItemId`。离线时禁止新建。

### 4.4 SessionWorkItemOutcome

```text
SessionWorkItemOutcome
- outcomeRevisionId
- sessionId
- sessionRevision
- revision
- correctedFromRevision?
- effective: boolean
- workItemId
- touched: boolean
- result: completed / progressed / stuck / untouched / cancelled
- executionPersona?: ox / pig / hajimi / wukong
- personaSwitched?: boolean
- personaNote?
- stateCommand?: complete / cancel / none
- commandId?
- commandStatus: not_needed / pending / succeeded / failed / conflict / unknown
- commandErrorCode?
- reviewedAt?
```

`result` 与 `executionPersona` 完全分离；任何化身都可以对应完成、有推进或卡住。Outcome 更正通过追加 `revision` 完成，同一 `sessionId + workItemId` 只有一个最新有效版本；旧 Outcome 不删除。Activity 和 Session 历史摘要读取最新有效 Outcome revision，但已成功的任务命令不会因 Outcome revision 自动回滚。`commandStatus` 只表示跨域命令的同步回执，不代表 WorkItem 当前状态。

命令生命周期独立于 Outcome 的“最新有效”标记：旧 Outcome revision 中已经生成的 pending / unknown / failed / conflict 命令信封必须继续保留并进入对账，直到得到 succeeded、明确 failed 后终止，或由用户生成新的补偿命令；创建新 Outcome revision 不得隐藏、删除或改写旧命令。建议工程实现将不可变命令信封独立存储，Outcome 只引用 `commandId`。

## 5. 启动规则

### 5.1 从三级启动

- 自动找到其当前二级父项作为 Session 归属；
- 该三级自动加入本轮计划；
- 若三级被阻塞、暂停、等待、已完成或已取消，必须先确认如何处理；
- 不自动把三级状态改为进行中。

### 5.2 从二级启动

- 直接作为 Session 唯一归属；
- 可选择同父三级、连续新建三级标题，或空计划开始；
- 二级原为未开始时，首个有效 Session 投入确认后，由 PomodoroXII 发出独立、幂等的 `StartWorkItemProgress` 命令；任务空间只允许 `未开始 → 进行中`，命令失败或冲突不影响 Session 时间保存；
- 暂停、等待、完成、取消状态不得静默覆盖，`StartWorkItemProgress` 不得跨越这些状态。

### 5.3 从一级启动

- 必须先选择或新建二级；
- Session 时间不得直接计入一级。

### 5.4 空计划启动

允许只归属二级直接开始。三级是推荐成果拆解，不是计时准入门槛；运行中或结束后可补建。

## 6. 计时中 Orbit 执行窗

执行窗分两层：

### 6.1 本轮成果清单

- 展示正式三级 WorkItem；
- 设为当前项只改变执行上下文；
- “打亮钩”写入 `completionDraft = true`，可撤销；
- “从本轮移除”只更新 Session 计划；
- “本项不再需要”需要二次确认，并生成取消命令草稿；
- 不提供语义含混的“划掉”。

### 6.2 当前项行动清单

- 读取当前三级的 `WorkItemNote Checklist`；
- 勾选通过任务空间 Note 命令写入共享内容事实；
- 不改变 WorkItem 状态、Session 成果、容量或风险；
- 与成果钩使用不同图形、颜色和文案。

### 6.3 执行化身

- 逐三级标注前必须存在唯一当前三级项；
- 用户主动选择，系统可以建议但不得自动写入；
- 当前项切换不分配或重算三级分钟；
- 未选当前项时，化身信号只属于 Session 总体临时上下文；
- 实际触达项可选填；未触达项不得编造化身。

## 7. Session 结束五组信息

| 信息组 | 作用 | 必填性 |
|---|---|---|
| 有效性 | 决定净专注时长是否计入二级 | 正常结束默认有效；提前结束需确认 |
| 三级成果结果 | 完成、有推进、卡住、未触达、取消；驱动任务命令 | 有三级计划时，必须逐项有结果或显式跳过整组复盘 |
| 总体推进评价 | 描述本轮对二级整体效果 | 选填 |
| Mood | 描述个人情绪 | 选填 |
| 逐三级执行化身 | 描述具体成果的主导执行模式 | 选填、轻提醒 |

### 7.1 正式完成与取消

- 完成草稿在结束复盘时统一提交 `CompleteWorkItem`；
- 取消必须在结束页再次明确展示“取消正式任务”，提交 `CancelWorkItem`；
- 未完成项默认保持当前状态和父项不变；
- 可选标记下轮候选、回父项待规划、暂停、等待或取消；
- 不自动结转到下一 Session。

### 7.2 延迟复盘

- Session 时间可先保存；
- 成果结果未确认时进入 `reviewState = pending`；
- 总体评价、Mood、化身为空不构成待复盘；
- 未触达项默认预填 `untouched`，允许批量确认；
- 用户可稍后完成或明确跳过整组；跳过不会生成任何 WorkItem 状态命令；
- 一旦成果被确认或显式跳过，`reviewState` 进入 `completed` 或 `skipped`，后续命令失败、未知或冲突不得把它回退为 `pending`；
- 再次启动同一二级时轻量提示，但不阻塞、不自动带入旧项。

### 7.3 延迟状态冲突

旧 Session 复盘时：

1. 先保存“当时结果”；
2. 若 WorkItem 当前状态已变化，不自动覆盖；
3. 显示当前状态与旧结果差异；
4. 由用户决定是否另行同步当前状态。

## 8. 命令提交、幂等与部分成功

提交顺序：

1. 保存 Session 最新 revision 与有效性；
2. 保存全部三级 Outcome；
3. 为每个正式状态变化生成独立 `commandId`，初始状态为 `pending`；
4. 按项提交任务命令；
5. 按回执逐项保存：明确成功为 `succeeded`，明确业务/校验失败为 `failed`，版本冲突为 `conflict`，请求超时或传输中断且服务端结果不可知为 `unknown`；
6. `pending` 仅表示尚未收到任何终态回执，`unknown` 表示可能已执行但结果未知；两者都进入对账队列，但重试规则不同；
7. 根据 Session 最新有效 revision 与最新有效 Attribution revision 更新二级 EffortProjection；
8. 重新计算上限复核和待处理投影。

要求：

- 每个命令使用不可变信封：`commandId`、`spaceId`、`workItemId`、`expectedVersion`、`targetTransition`、`sessionId`、`sessionRevision`、`payloadHash`；
- 同一 `commandId` 携带不同 `payloadHash` 时必须拒绝；
- 重复收到已成功命令时返回原成功结果，不产生第二次状态事件；
- `pending` 可使用原 `commandId` 和不可变信封首次提交或安全重试；
- 请求超时且结果未知时标记 `unknown`，必须先以原 `commandId` 查询结果；仅当服务端明确支持同一幂等信封重放时才可重试，绝不得生成新命令；
- `expectedVersion` 冲突时标记 `conflict`，用户处理后必须生成新的 commandId，不能改写旧信封；
- 一项失败不得回滚已成功项；
- 结束页必须明确展示“3 项成功、1 项待重试”等部分成功状态；
- 失败、未知和冲突命令进入同步/对账队列；
- 冲突不得由客户端静默覆盖。

## 9. 离线规则

允许：

- 对已缓存二级开始 Session；缓存必须记录 `cachedAt`、`spaceId` 和 WorkItem `version`，用于联网后的版本校验；
- 选择已缓存三级；
- 保存时间、随记、成果草稿、总体评价、Mood 和化身；
- 保存完成/取消意图并显示“待同步”。

禁止：

- 离线创建新的正式三级 WorkItem；
- 将本地临时项伪装成正式任务；
- 离线静默覆盖任务空间当前状态。

联网后：

- 使用稳定 `commandId` 与缓存中的 `expectedVersion` 重试；
- 成功后更新同步状态；
- 若任务已删除、改变 Space、重挂父级或状态/version 已变化，统一进入冲突处理，不自动覆盖。

## 10. 运行中结构变化

Session 启动后冻结 `SessionTaskContext` 与计划快照：启动历史永远显示当时二级归属，不迁移、不覆盖。当前 EffortProjection 和 Cycle 报表则按最新有效 `SessionAttributionRevision` 归属计算；发生显式归属更正时，可以从旧二级撤销并计入新二级，但这不改写启动快照。

| 运行中变化 | Outcome 历史 | 正式命令 |
|---|---|---|
| 改名 | 保存，显示启动快照 | 当前状态兼容时允许 |
| 同父排序/位置变化 | 保存 | 当前状态兼容时允许 |
| 移到同 Space 其他二级 | 保存 | 不自动提交，进入冲突确认 |
| 提升或下沉 | 保存 | 不自动提交，进入冲突确认 |
| 已被完成后又重开 | 保存 | 不覆盖当前状态 |
| 已取消或删除 | 保存 | 禁止提交，不自动复活 |
| 跨 Space 移动 | 保存启动快照 | 拒绝命令 |

任务空间结构变化立即生效，但不得改写本轮启动上下文。

## 11. Session 更正与撤销

### 11.1 时长、有效性与成果更正

- 追加 revision，不覆盖历史版本；
- EffortProjection 只采纳最新有效 revision；
- 有效性更正只改变投入贡献，不自动重放、撤销或反向执行任何已成功 WorkItem 命令；
- 成果结果更正先保存新的 Session 历史判断；若需要改变当前 WorkItem 状态，必须生成新的显式命令与新的 commandId；
- 不因 Session revision 自动回滚三级成果状态。

### 11.2 二级归属更正

- 新旧二级必须属于同一 Space，否则拒绝更正；
- 追加新的 `SessionAttributionRevision`，不得覆盖启动 `SessionTaskContext` 或旧归属版本；
- 从原最新有效二级撤销投入贡献，再计入新二级；
- 原三级计划与结果快照保留；若原三级与新二级不再同父，只作为历史，不生成新的任务状态命令；
- 不移动 WorkItem，不回滚状态；
- 标记“时间归属已更正”，并在相关 Cycle 报表留下审计记录。

### 11.3 Session 撤销

- 只撤销实际投入贡献；
- 已发生的 WorkItem 完成/取消不自动回滚；
- 提示存在关联成果，用户需要时另行重开或恢复。

## 12. 二级投入复核

```text
actualEffort < estimateMin
→ 不提示

estimateMin <= actualEffort < estimateMax
→ 静态信息，不弹窗

actualEffort >= estimateMax
→ 显著复核卡
```

显著复核动作：

- 完成二级；
- 更新剩余估算；
- 标记范围扩大；
- 处理阻塞；
- 延后到复盘点。

复核卡不阻止 Session 结束；关闭后进入当前 Space 的待处理区。

“三级全部完成”只展示成果信息，不改变提醒强度，也不自动完成二级。

## 13. 与 Cycle 的关系

- 只有二级 WorkItem 可成为 Cycle Membership；
- FocusSession 最新有效净时长形成二级实际投入；
- 三级计划、化身、Note Checklist 不占用或释放 Cycle 容量；
- Session 结束不自动修改 Membership、Committed / Planned / Stretch 或承诺容量；
- Session 更正或撤销只重算实际投入投影与相关 Cycle 报表，并留下审计记录；
- 只有二级估算、状态、角色或整体范围变化进入 Cycle 变化记录。

## 14. 待处理区投影

### 真正阻塞

来自正式 waiting 状态或依赖未解除。

### 推进异常

以二级问题卡展示，触发证据可包括：

- 实际投入达到或超过预计上限；
- 三级多轮未完成；
- 超过复盘点；
- 多次卡住或哈吉米；
- 用户主动关注。

### 待成果复盘

仅指 Session 有三级计划/结果草稿，但成果结果尚未确认。Mood、总体评价或化身为空不构成待成果复盘。

### 待同步与冲突

成果已经确认或显式跳过后，正式命令的 pending / failed / unknown / conflict 独立进入同步与对账分组，不再称为待复盘，也不改变 Session 的 reviewState。

## 15. 验收标准

1. 一个 Session 无法关联两个二级归属。
2. 跨 Space 的二级或三级引用被拒绝。
3. 空三级计划可以正常开始和结束。
4. 三级打亮钩在计时中可撤销，结束时才提交。
5. Note Checklist 勾选不会改变正式成果状态。
6. 未触达三级不要求化身。
7. Session 结束的单项命令失败不回滚其他成功项。
8. 重试同一 commandId 不产生重复状态事件。
9. 离线新建正式三级被禁止，但可对已缓存任务计时和复盘。
10. Session revision 更正不会重复计入实际投入。
11. 结构调整不改写运行中 Session 的启动快照。
12. 达到二级预计上限才出现显著复核，且不阻止结束。
13. 三级全部完成不自动完成二级。
14. 自我标定缺失不会进入待复盘，成果结果缺失会进入。
15. 所有统计均限制在当前 Space。
16. Outcome 更正必须追加 revision；Activity 和 Session 摘要只读取最新有效版本。
17. 二级归属更正必须追加 Attribution revision；启动 Context 永不覆盖。
18. pending、unknown、failed、conflict 的进入与对账转换必须可区分且可测试。

## 16. Non-goals

首版不做：

- 三级分钟分配；
- 跨二级单 Session；
- 自动执行化身判定；
- 跨 Space 任务关联或统计；
- Session 自动修改剩余估算；
- 自动完成二级；
- 离线创建正式 WorkItem；
- 多人负责人、成员权限或协作容量；
- Note Checklist 参与任务进度；
- 化身时间轴和化身积分。
