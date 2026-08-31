# Project Activity 产品契约 v1.0

> 状态：产品契约候选基线  
> 日期：2026-07-11  
> 依赖：`WORKITEM_SINGLE_USER_V11.md`、`SAVED_VIEW_V10.md`、`../../tiptip-next-cycle-review/CYCLE_CAPACITY_SINGLE_USER_V10.md`、`../../tiptip-session-l3-review/SESSION_TASK_INTEGRATION_V10.md`

## 1. 问题与定位

WorkItem History、Session History 和 Cycle Changes 分别保存准确事实，但用户很难快速回答：

- 这个 Project 最近真正推进了什么？
- 新工作是如何被发现的？
- 为什么估算、范围或计划发生变化？

Project Activity 的定位是：

> 将已经发生的重要系统事实，按项目和二级工作块聚合为可阅读、可展开、可追溯的进展叙事流。

Activity 完全自动、只读、可重建，不是新的事实源。

## 2. 目标

1. 让用户在一分钟内理解 Project 最近的重要推进；
2. 过滤普通计时和编辑噪声；
3. 保留成果、发现、投入复核和计划调整之间的因果关系；
4. 每个摘要可追溯到 WorkItem、Session 或 Cycle 原始事实；
5. 同一事实更正后可稳定重建，不产生第二套历史。

## 3. Non-goals

首版不做：

- 用户手工创建、编辑、删除或批注 Activity；
- Activity 评论、点赞、通知或协作动态；
- Space 级跨项目 Activity 或每日摘要；
- 完整操作审计日志；
- 待处理问题的直接处置工作台；
- WorkItem、Session 或 Cycle 的可写副本；
- AI API 依赖、AI 自由总结或事实判断；
- Note 自动保存、Checklist 勾选等低价值编辑流水；
- 普通无成果 Session 的逐条展示。

用户补充说明必须写入对应事实源：WorkItemNote、Session 总结、Cycle 复盘或正式变更原因。

## 4. 事实源与投影边界

```text
WorkItem Events ─┐
Session Revisions ├─→ Activity Projector ─→ ActivityStory（派生）
Cycle Events ─────┘
```

- Activity 只读取领域事实；
- ActivityStory 可以缓存，但缓存可删除并从源事实重建；
- ActivityStory 不接受业务写命令；
- Story 标题、摘要和排序是投影结果，不是用户事实；
- Activity 不得反向修改 WorkItem、Session、Cycle、Module 或 Saved View；
- 完整审计仍由各事实源历史承担。

## 5. 作用域

- 每条 ActivityStory 固定属于一个 `spaceId` 和一个 `projectId`；
- 首版只在 Project 内展示；
- 不跨 Project 聚合；
- 不跨 Space 查询或合并；
- Project 归档后 Activity 只读；
- 删除 Project 按 Project 数据生命周期处理，Activity 不能独立保留成孤立事实源。

## 6. 事件白名单

### 6.1 WorkItem 事实

默认进入：

- 一级/二级重要 WorkItem 创建；
- 三级在 Session 规划、运行中或复盘后被创建/补建；
- WorkItem 完成、取消、重开；
- WorkItem 跨父项移动、提升或下沉；
- 二级预计投入或剩余估算调整；
- 标记范围扩大；
- 正式阻塞进入或解除；
- Module 归属变化，但仅在它改变项目叙事上下文时；
- Note Item 提升为正式 WorkItem。

默认不进入：

- 标题拼写修正；
- 普通 description 编辑；
- Note 自动保存；
- Checklist 勾选/重置；
- 排序变化；
- Label、颜色或显示字段的普通调整；
- Saved View 配置变化。

### 6.2 Session 事实

只有存在叙事价值时进入：

- 完成一个或多个三级成果；
- 对三级形成明确 progressed / stuck 结果；
- 运行中发现或复盘后补建三级；
- 导致二级累计投入达到预计上限；
- 用户将关键 Session 随记沉淀到 WorkItemNote；
- 产生范围扩大、阻塞或估算复核决定。

普通有效 Session 若没有上述变化，只更新 EffortProjection，不形成 Activity 条目。

### 6.3 Cycle 事实

默认进入：

- Cycle 开始与关闭摘要；
- 二级 Membership 加入/移出或角色重要变化；
- 二级估算/范围变化导致容量状态改变；
- Cycle 复盘中的结转、退回、等待、拆分等决策摘要；
- Committed / Planned 结构发生有解释价值的调整。

默认不进入：

- 普通容量计算刷新；
- 每次 Session 带来的实际投入自然增长；
- Stretch 未开始；
- 自动派生但没有用户决策的普通状态波动。

## 7. 推进故事聚合

### 7.1 聚合键

P0 默认聚合键：

```text
spaceId + projectId + level2WorkItemIdSnapshot + storyWindow
```

故事必须围绕同一二级 WorkItem 或同一 Project 级结构事件。

### 7.2 时间窗口

- 连续相关事件优先聚合；
- 默认建议窗口为 4 小时，具体值属于可配置投影策略，不是领域事实；
- 跨自然日默认另开故事；
- Cycle 开始/关闭、Project 级结构变更另开故事；
- 若事件因果关系明确，投影可在窗口内合并；不能只因时间接近合并无关事件。

### 7.3 Story 模型

```text
ActivityStory
- storyId                       // 可确定性生成或投影缓存 ID
- spaceId
- projectId
- level2WorkItemIdSnapshot?
- level2TitleSnapshot?
- moduleIdSnapshot?
- moduleNameSnapshot?
- storyType
- startedAt
- endedAt
- headlineTemplateKey
- summaryFacts                  // 结构化事实，不是自由文案
- sourceRefs[]                  // event/session/cycle/workItem 引用
- projectionVersion
- supersededByStoryId?
- rebuiltAt
```

`summaryFacts` 可包含：有效投入、完成成果、推进/卡住数量、发现项、估算变化、范围变化、Cycle 决策。

### 7.4 展示模板示例

```text
Session 集成 · 推进故事

投入 87 分钟
✓ 完成「补充离线冲突提示」
＋ 执行中发现「验证命令超时状态」
↗ 累计投入达到预计上限
  剩余估算调整为 2–4h
```

模板只表达已有结构化事实，不推断“进展很好”“效率低”等评价。

## 8. 快照与追溯

- Story 显示事件发生时的标题、父项和 Module 快照；
- WorkItem 后续改名、移动或换 Module 不改写故事中的当时上下文；
- 同时保留当前 `workItemId` 跳转能力；
- 源对象已删除/归档时，Story 仍显示快照并标记当前对象不可用；
- 点击 Story 可展开源 Session、WorkItem History、Cycle Change；
- Activity 摘要不能替代源历史。

## 9. 更正、撤销与重建

### 9.1 Session revision

- EffortProjection 只采纳最新有效 revision；
- Activity Projector 同样读取最新有效 revision；
- 时长更正后重新计算 Story 的投入摘要；
- Session 撤销后移除其投入贡献，但不自动删除独立存在的 WorkItem 完成事实；
- 归属更正后，时间贡献移动到新 Project/二级对应 Story；原三级成果历史仍按事实源归属展示；
- 不通过直接编辑 Activity 修补结果。

### 9.2 任务命令部分成功

- 只有 `succeeded` 的正式 WorkItem 状态事件进入成果事实；
- Session 的“当时结果”可在展开详情中显示，但不能冒充正式完成；
- failed / unknown / conflict 进入待同步/冲突区，不作为“已完成成果”叙事；
- 后续对账成功后投影重建并更新 Story。

### 9.3 Projection 版本

- Activity 规则和模板携带 `projectionVersion`；
- 升级投影规则可以重建 Story；
- 重建不得创建新的 WorkItem/Session/Cycle 事件；
- 旧缓存可被 supersede，但源事实不变；
- 用户不能依赖 Activity 文案作为唯一审计证据。

## 10. 与相邻能力边界

| 能力 | Activity 边界 |
|---|---|
| WorkItem History | 单任务完整事件；Activity 只取重要摘要 |
| Session History | 单次计时与复盘事实；Activity 只取有叙事价值部分 |
| Cycle Changes | 计划和容量变化事实；Activity 只取重要决策 |
| 待处理区 | 当前问题与处置；Activity 回顾已发生事实，不提供处置状态 |
| Saved View | 查询当前事实；Activity 回顾历史进展 |
| WorkItemNote | 用户说明和行动指导；Activity 不能承接自由写作 |

## 11. 确定性与 AI 边界

P0 完全使用规则与模板：

- 同一组源事实和同一投影版本必须生成相同 `summaryFacts`；
- 文案模板不得创造源事实不存在的因果、完成或评价；
- 不调用外部 AI API；
- 离线可以从本地事实生成；
- 未来 AI 只能作为显式可选的润色层，输入经过授权的结构化摘要，输出不得成为事实源。

## 12. 事件与存储

Activity 本身不发布业务事实事件。可以发布技术投影通知：

- `ActivityProjectionRebuilt`
- `ActivityStoryCacheInvalidated`

这些事件不得触发 WorkItem、Session 或 Cycle 状态变化，也不进入 Activity 自身造成递归。

## 13. 验收标准

1. 用户无法创建、编辑、删除或批注 Activity Story。
2. 删除 Activity 缓存后可从源事实重建相同结构化摘要。
3. 普通无成果 Session 不生成 Story。
4. Note 自动保存和 Checklist 勾选不生成 Story。
5. 同一二级连续相关事件聚合为一张可展开故事。
6. 不同二级的事件不能因时间接近被合并。
7. WorkItem 改名/移动后，旧 Story 保留当时快照并可跳转当前对象。
8. Session 时长更正后 Story 投入摘要更新，不生成第二套事实。
9. 命令 failed/unknown/conflict 不得写成正式成果完成。
10. Activity 中不能直接完成任务、重估、处理阻塞或重试同步。
11. Activity 不跨 Project 或 Space。
12. 不配置 AI API 时所有 P0 能力完整可用。

## 14. 优先级

### P0

- Project 级只读 Activity；
- 事件白名单；
- 同二级推进故事聚合；
- 结构化 summaryFacts 与固定模板；
- 快照和源引用；
- revision/部分成功/重建规则；
- Space/Project 隔离；
- 非 AI 确定性生成。

### P1

- Activity 类型筛选；
- 故事展开层级优化；
- 手动选择时间范围查看；
- 投影性能和增量重建。

### P2

- Space 每日摘要；
- 本地模型或用户自备 API 的可选润色；
- 导出项目周报；
- 不改变“Activity 不可手工写入”的原则。

## 15. 开放问题

无 P0 产品开放问题。故事窗口的具体时长、模板文案与缓存策略进入设计/工程规格，并由固定验收数据集校准。
