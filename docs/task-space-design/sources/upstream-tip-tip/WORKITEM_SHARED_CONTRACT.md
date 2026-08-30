# WorkItem 共享领域契约

> 状态：已批准，作为工程实施计划的产品基线  
> 版本：v1.0  
> 日期：2026-07-10  
> 历史状态：v1.0 归档基线；单人 Pomodoro Space 产品以 [WorkItem v1.1 修订契约](./WORKITEM_SINGLE_USER_V11.md) 为准

本文保留早期独立任务产品的多人 Workspace 假设，不能直接作为 PomodoroXII 子系统的实施输入。凡 `Workspace`、`assigneeId`、递归完成百分比、父子容量模式等内容与 v1.1 冲突，均以 v1.1 为准。

## 1. 稳定身份

| 对象 | 稳定身份 | 用户可见身份 | 规则 |
|---|---|---|---|
| Workspace | `workspaceId` | 名称 | ID 全局唯一、不可变 |
| Project | `projectId` | 名称、项目代号 | ID 全局唯一、不可变 |
| WorkItem | `workItemId` | `displayKey`，如 `TIP-142` | 内部 ID 全局唯一；显示编号在 Project 内唯一 |
| Type | `typeId` | 名称、图标、颜色 | 名称不驱动逻辑 |
| Label | `labelId` | 名称、颜色 | 可多选，不替代 Type |
| StatusDefinition | `statusId` | 名称、图标、颜色 | 映射到底层状态类别 |
| Relation | `relationId` | 无 | 有向关系使用稳定端点 ID |

## 2. WorkItem 核心字段

| 字段 | 类型 | 可空 | 默认值 | 说明 |
|---|---|---:|---|---|
| `workItemId` | ID | 否 | 系统生成 | 全局唯一、不可变 |
| `projectId` | ID | 否 | 当前 Project | 所属 Project |
| `displayKey` | string | 否 | Project 号段生成 | Project 内唯一 |
| `title` | string | 否 | 无 | 去除首尾空白后至少 1 个字符 |
| `description` | rich text | 是 | 空 | 长描述 |
| `typeId` | ID | 否 | Project 默认 Type | 不可用时回退 Workspace 通用 Type |
| `statusId` | ID | 否 | Project 默认状态 | 不可用时回退系统 `not_started` 状态 |
| `labelIds` | ID[] | 否 | `[]` | Workspace Label，多选 |
| `assigneeId` | ID | 是 | 空 | 首版单负责人 |
| `priority` | enum | 是 | 空 | 可选字段，不进入首版核心风险 |
| `parentId` | workItemId | 是 | 空 | 同 Project，最大三层 |
| `childRank` | number | 否 | 末尾 | 同父项排序 |
| `completedAt` | datetime | 是 | 空 | 当前完成结果时间，重开后清空当前投影但历史事件保留 |
| `cancelledAt` | datetime | 是 | 空 | 当前取消结果时间，重开后清空当前投影但历史事件保留 |
| `archivedAt` | datetime | 是 | 空 | 收纳属性，不改工作状态 |
| `createdAt` | datetime | 否 | 系统时间 | 审计字段 |
| `updatedAt` | datetime | 否 | 系统时间 | 任一事实更新后变化 |
| `version` | integer | 否 | 1 | 乐观并发版本 |

计划字段由[类型与柔性排期规格](./WORKITEM_FLEXIBLE_PLANNING_REVIEW.md)定义；Relation 字段由[父子与依赖规格](./WORKITEM_RELATIONS_REVIEW.md)定义。

## 3. 六类底层状态

```text
not_started
in_progress
paused
waiting
completed
cancelled
```

显示状态通过 `statusId` 映射到其中一类。映射一旦被 WorkItem 使用，不允许原地修改；须新建状态、迁移 WorkItem、归档旧定义。

## 4. 派生字段

派生字段不作为第二套事实状态保存；可缓存，但必须能从事实重新计算。

| 派生字段 | 核心条件 | 消失条件 |
|---|---|---|
| `needsReplan` | `not_started/in_progress/paused/waiting` 且完成窗口已结束，且没有仍有效的“保持计划”确认 | 新窗口、暂不安排、完成、取消，或用户确认保持至新的复查时点 |
| `blockedByDependency` | 存在结果为 `blocking` 的依赖 | 所有阻塞依赖满足或被解决 |
| `dependencyNeedsResolution` | 依赖结果为 broken/unknown | 用户移除、替换或确认解除 |
| `reviewDue` | 活动 WorkItem 的复盘时间已到 | 复盘处理、重排、完成、取消 |
| `lowConfidenceAttention` | 有窗口且正式信心为 low | 修改信心或移除窗口 |
| `recursiveProgress` | 存在有效直接子项 | 子项变化后重算；无有效子项为 N/A |

归档只抑制默认工作视图中的派生信号，不改变派生事实；恢复后按当前事实重算。

## 5. 状态副作用矩阵

| 底层类别 | 主动容量 | 未完成风险 | 柔性复盘 | 硬截止提醒 | `needsReplan` | 依赖前置结果 |
|---|---:|---:|---|---|---|---|
| not_started | 计入 | 计入 | 启用 | 启用 | 可产生 | blocking |
| in_progress | 计入 | 计入 | 启用 | 启用 | 可产生 | blocking |
| paused | 不计入 | 低打扰保留 | 默认暂停，可手动保留 | 启用，除非用户处理 | 可产生，低打扰 | blocking |
| waiting | 不计入主动容量 | 保留阻塞风险 | 使用恢复复盘 | 启用 | 可产生 | blocking |
| completed | 不计入 | 不计入 | 停止未来触发 | 停止未来触发 | false | satisfied |
| cancelled | 不计入 | 不计入 | 停止未来触发 | 停止未来触发 | false | broken_requires_resolution |

`archivedAt != null` 时，状态语义保持不变。依赖目标不可访问、缺失或其 Project 被归档，依赖结果为 `unknown_requires_resolution`。

## 6. 一致性不变量

1. WorkItem 必须始终拥有有效 `typeId` 和 `statusId`。
2. Project 必须至少启用一个 `not_started` 和一个 `completed` 显示状态。
3. Project 默认状态必须映射到 `not_started`。
4. 父子关系只允许同一 Project、单一直接父项、最大三层、无祖先环。
5. 依赖允许同一 Workspace 跨 Project，禁止跨 Workspace。
6. 依赖禁止自环、重复语义边和新增有向环。
7. 标题、Type 名称、状态名称、Label 名称不得作为业务逻辑关键字。
8. Orbit、列表、Cycle、Module 和 View 不得复制或成为第二套 WorkItem 事实源。
9. 所有写操作必须经过统一应用服务，并产生可审计事件。
10. 派生计算失败不得静默改写用户事实。

## 7. 通用事件信封

所有领域事件至少包含：

| 字段 | 说明 |
|---|---|
| `eventId` | 全局唯一 |
| `eventType` | 版本化事件类型 |
| `workspaceId` | Workspace 边界 |
| `projectId` | 相关 Project |
| `workItemId` | 相关 WorkItem，可空 |
| `actorId` | 发起者 |
| `occurredAt` | 发生时间 |
| `expectedVersion` | 乐观并发版本 |
| `payload` | 事件数据 |
| `schemaVersion` | 事件模式版本 |

## 8. 并发、离线与恢复

- 写入使用 `expectedVersion`；版本冲突时不覆盖较新事实。
- 离线操作保留本地意图，重新连接后按事件重放；冲突需要用户确认或可解释合并。
- 派生信号在启动、同步、日期边界跨越后重新计算。
- 事件写入成功、派生刷新失败时，事实仍成立；界面显示“洞察更新中”，不得回滚用户写入。
- 删除只用于从未被引用的配置草稿；被引用的 Type、StatusDefinition 和 WorkItem 使用归档。

## 9. 隐私与可访问性

- 首版不把任务内容发送到外部服务。
- 风险解释只展示用户有权访问的事实。
- 状态、信号、计划不能只依赖颜色表达。
- 所有核心操作支持键盘；触控目标不小于 44px；文本缩放 200% 时仍可完成核心流程。
