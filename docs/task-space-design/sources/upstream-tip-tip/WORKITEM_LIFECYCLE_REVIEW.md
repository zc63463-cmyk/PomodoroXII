# WorkItem 生命周期规格

> 状态：已批准，作为工程实施计划的产品基线  
> 版本：v1.0  
> 依赖：[共享领域契约](./WORKITEM_SHARED_CONTRACT.md)

## 1. 问题与目标

固定状态语言无法覆盖开发、学习、研究和个人计划；完全自由状态又让完成率、容量和 Orbit 失去统一语义。本规格以六类稳定底层类别承载系统语义，用 Workspace 显示状态适配用户语言。

## 2. 非目标

- 不做 Type 专属状态机。
- 不做审批、SLA 和强制单向流转。
- 不根据状态名称触发逻辑。
- 不做复杂状态权限。

## 3. 用户故事

- 作为学生，我希望把 `completed` 显示为“已掌握”，以便状态符合学习语言。
- 作为项目成员，我希望自由切换状态，同时在完成、取消和重开时获得计划处理提示。
- 作为计划用户，我希望暂停与等待被区分，以便容量和风险正确解释。
- 作为整理历史的用户，我希望取消与归档分离，以便区分“不做”和“收起来”。

## 4. 状态定义字段

| 字段 | 类型 | 可空 | 规则 |
|---|---|---:|---|
| `statusId` | ID | 否 | 全局唯一、不可变 |
| `workspaceId` | ID | 否 | Workspace 边界 |
| `name` | string | 否 | Workspace 内活动定义不重名 |
| `category` | enum | 否 | 六类之一；使用后不可原地修改 |
| `color` | token | 否 | 不得是唯一语义载体 |
| `icon` | token | 否 | 可修改 |
| `rank` | number | 否 | 同类别内排序 |
| `archivedAt` | datetime | 是 | 归档显示状态定义 |
| `isSystemFallback` | boolean | 否 | 仅一个不可归档 `not_started` 兜底 |

Project 保存 `enabledStatusIds` 与 `defaultStatusId`。至少包含一个 `not_started` 和一个 `completed`；默认必须为 `not_started`。

## 5. 六类状态语义

| 类别 | 用户意图 | 容量 | 风险 | 提醒 |
|---|---|---:|---:|---|
| not_started | 尚未开始 | 计入 | 计入 | 正常 |
| in_progress | 正在推进 | 计入 | 计入 | 正常 |
| paused | 主动暂停 | 不计入 | 低打扰保留 | 默认暂停近期复盘 |
| waiting | 等待外部条件 | 不计入主动容量 | 保留阻塞风险 | 使用恢复复盘 |
| completed | 达到完成标准 | 不计入 | 退出未完成风险 | 停止未来触发 |
| cancelled | 明确不再继续 | 不计入 | 退出未完成风险 | 停止未来触发 |

## 6. 状态转换与副作用

首版允许 Project 已启用状态之间自由切换；软性提示不阻塞保存。

| 转换 | 必须行为 | 可选提示 |
|---|---|---|
| 任意 → completed | 记录 `completedAt`；停止未来未完成提醒和容量 | 有活动子项时进入关系确认流程 |
| 任意 → cancelled | 记录取消状态；停止提醒和容量 | 可填写取消原因 |
| 任意 → paused | 从主动容量移除 | 是否移动/清除窗口、暂停复盘 |
| 任意 → waiting | 从主动容量移除 | 填写等待原因、依赖、恢复复盘 |
| completed/cancelled → 活动类别 | 清除当前完成/取消结果时间的活动投影，记录重开 | 建立新窗口、投入和复盘 |
| paused → 活动类别 | 记录恢复 | 确认旧计划是否仍有效 |

完成后的复查必须创建独立提醒，不复用未完成任务复盘。

## 7. 取消与归档

- `cancelled` 是工作结果；`workItem.archivedAt` 是收纳属性。
- 取消不自动归档；归档不改状态。
- 完成、取消、暂停和其他旧项均可归档。
- 默认视图隐藏归档项；恢复后回到原状态并重算派生信号。
- 被活动 WorkItem 依赖的项归档前显示影响提示，但不强制阻止。

## 8. 状态与计划真值表

详见共享契约。补充规则：

- paused 保留旧窗口时仍可能重排，但默认低打扰。
- waiting 保留窗口和等待事实；依赖风险由关系事实计算，不依赖用户是否切换 Waiting。
- completed/cancelled 停止未来提醒，但窗口、复盘、硬截止和估算作为历史保留。
- archived 不改变真值，只影响默认展示。

## 9. 事件

| 事件 | 关键载荷 |
|---|---|
| `StatusDefinitionCreated` | statusId, name, category, color, icon |
| `StatusDefinitionRenamed` | oldName, newName |
| `StatusDefinitionArchived` | affectedProjects, migrationPlan |
| `ProjectStatusSetChanged` | enabledStatusIds, defaultStatusId |
| `WorkItemStatusChanged` | fromStatusId/category, toStatusId/category |
| `WorkItemCompleted` | completedAt, childDecision? |
| `WorkItemCancelled` | cancelledAt, reason? |
| `WorkItemReopened` | fromCategory, toStatusId, previousPlanRef |
| `WorkItemArchived` | archivedAt |
| `WorkItemRestored` | restoredAt |

## 10. P0 / P1 / P2

### P0

- 六类稳定类别。
- Workspace 显示状态创建、改名、排序、归档和迁移。
- Project 启用范围、默认和系统兜底。
- 自由切换与关键软提示。
- 完成、取消、暂停、等待的明确副作用。
- WorkItem 归档与恢复。

### P1

- 状态批量迁移预览。
- 完成后独立复查提醒。
- 状态使用分析。

### P2

- Type 专属状态机。
- 状态审批、权限、SLA 和自动化。

## 11. 验收标准

1. **状态语言自由**  
   Given Workspace 创建“已掌握”并映射 completed，When WorkItem 使用该状态，Then系统按 completed 计算且不读取名称。
2. **映射不可变**  
   Given状态已被引用，When管理员尝试将其从 in_progress 改为 completed，Then系统阻止并引导新建+迁移。
3. **Project 不变量**  
   Given Project 只有一个 completed 状态，When尝试移除，Then系统阻止直到选择替代。
4. **状态兜底**  
   Given默认状态配置异常，When快速创建，Then回退系统 not_started 状态且不产生空值。
5. **自由跳转**  
   Given WorkItem 未开始，When直接切换完成，Then允许保存并记录完成事件。
6. **完成副作用**  
   When进入 completed，Then未来未完成复盘和硬截止提醒停止，历史计划保留。
7. **等待与依赖分离**  
   Given依赖阻塞但用户保持进行中，Then `blockedByDependency=true` 且状态不自动变化。
8. **取消不归档**  
   When切换 cancelled，Then仍在默认未归档视图可见；只有用户归档后才隐藏。
9. **归档恢复**  
   Given进行中任务被归档，When恢复，Then保持进行中并重算复盘/重排信号。
10. **重开**  
    Given已完成任务，When重开到进行中，Then记录重开事件并提示新计划，不自动安排近一周。

## 12. 指标与验证假设

- 状态切换成功率 ≥ 99%。
- 因状态配置导致的快速创建失败率目标为 0。
- 用户研究验证：能否区分暂停、等待、取消、归档。
- 监测重开后补充新计划的比例，但不以低比例惩罚用户。

## 13. 开放问题

无阻塞产品问题。状态权限、审批和自动化进入后续规格。
