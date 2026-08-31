# Saved View 产品契约 v1.0

> 状态：产品契约候选基线  
> 日期：2026-07-11  
> 依赖：`WORKITEM_SINGLE_USER_V11.md`、`../../tiptip-next-cycle-review/CYCLE_CAPACITY_SINGLE_USER_V10.md`

## 1. 问题与定位

单人用户会反复查看“当前 Cycle”“某 Module 的进行中工作”“跨项目复盘点已到”等任务集合。如果每次重新组合筛选、排序、分组和字段，会产生持续维护负担。

Saved View 的定位是：

> 保存一组动态查询和呈现规则，便于重复观察当前 WorkItem 事实。

Saved View 不是任务容器、任务快照、Orbit 空间层级、待处理状态或通知规则。

## 2. 目标

1. 支持 Project 内常用查询复用；
2. 支持当前 Pomodoro Space 内跨 Project 查询；
3. 查询结果随 WorkItem 事实变化动态重算；
4. 与待处理区、Cycle 工作台和 Orbit L1/L2/L3 保持清晰边界；
5. 不复制或拥有 WorkItem 状态。

## 3. Non-goals

首版不做：

- 看板、日历、时间线、甘特图等多展示器；
- 查询结果快照或历史审计；
- Saved View 自动通知、定时运行或任务自动化；
- Saved View 独立权限、成员或协作；
- 跨 Pomodoro Space 查询；
- 在 Saved View 中复制 WorkItem；
- 继承待处理区的异常级别、处置动作或复盘时限；
- 保存 Orbit 节点位置、L3 展开状态或 Session 当前上下文。

## 4. 两级作用域

### 4.1 Project Saved View

产品入口：“项目筛选方案”。

- 固定绑定一个 `projectId`；
- 只查询该 Project 的 WorkItem；
- 可自由包含一级、二级、三级；
- Module 条件只引用当前 Project 的 Module。

### 4.2 Space Saved View

产品入口：“跨项目筛选”。

- 固定绑定当前 `spaceId`；
- 可查询当前 Space 的多个 Project；
- 默认包含一级、二级 WorkItem；
- 用户可显式加入三级；
- 不得引用其他 Space 的 Project、Module、Label、Cycle 或 WorkItem。

### 4.3 作用域不变量

- 创建后 `scopeType` 不可静默改变；
- Project View 转为 Space View 必须使用“复制为跨项目筛选”，创建新 ID；
- Space View 缩为 Project View 同样使用复制；
- 原 View 不被修改；
- Project 删除/归档时，其 Project View 按项目生命周期只读保留或随项目删除策略处理，不升级为 Space View。

## 5. 数据模型

```text
SavedView
- savedViewId
- spaceId
- scopeType: project / space
- projectId?                  // project scope 必填
- name
- description?
- filters
- sortRules
- groupBy?
- visibleFields
- includedDepths              // 1 / 2 / 3
- includeCompleted
- isPinned
- sourceTemplate?: user / system_query_copy
- sourceSystemQueryType?
- createdAt
- updatedAt
- version
```

Saved View 只保存规则，不保存 `workItemIds` 结果集合。

## 6. 查询规则

P0 支持以下过滤维度：

- WorkItem 深度；
- Project（仅 Space View）；
- Module；
- Type；
- Status；
- Label；
- Cycle 及 Committed / Planned / Stretch；
- 完成窗口；
- 复盘点；
- 硬截止；
- 真正阻塞；
- 推进异常；
- 是否存在未完成三级成果；
- 是否归档/完成/取消。

P0 排序：

- 手工排序；
- 状态；
- 优先级；
- 复盘点；
- 完成窗口；
- 硬截止；
- 创建/更新时间；
- 二级实际投入或预计上限使用比例。

P0 分组：

- Project（仅 Space View）；
- Module；
- Status；
- Type；
- Cycle 角色；
- 一级父项。

`visibleFields` 只影响呈现，不改变查询结果。

## 7. 动态重算

- 每次打开 Saved View 时按当前事实重新查询；
- 相关 WorkItem、Module、Cycle、Label 或派生信号变化时更新结果；
- 新符合条件的 WorkItem 自动进入；
- 不再符合条件的 WorkItem自动退出；
- 查询重算不得修改 WorkItem；
- 查询失败只显示错误状态，不回退为旧结果快照冒充当前事实。

## 8. 从系统结果保存

待处理区或其他系统查询可以提供“保存为筛选方案”：

1. 只复制可表达为 Saved View 的查询条件；
2. 生成新的普通 Saved View；
3. `sourceTemplate = system_query_copy` 仅用于解释来源；
4. 不继承异常提醒、问题卡状态、复盘时限、同步重试、处置动作或系统优先级；
5. 原系统查询规则后续变化，不自动修改已保存 View；
6. 无法表达的系统语义必须在保存前明确提示被舍弃。

## 9. 引用失效与生命周期

- Module / Label / Type / Cycle 被归档：条件仍可显示，并标记归档引用；
- 引用对象被永久删除：对应条件标记失效，结果为空或按布尔规则计算，不得静默扩大查询；
- Project View 的 Project 不存在：View 不可执行，显示来源已删除；
- Space 归档：Saved View 只读；
- Saved View 删除只删除查询规则，不影响任何 WorkItem；
- Saved View 复制产生新 ID，后续互不联动。

## 10. 与相邻能力的边界

| 能力 | Saved View 边界 |
|---|---|
| Orbit L1/L2/L3 | Orbit 是空间观察层级；Saved View 是主工作台查询规则 |
| 待处理区 | 系统派生问题和处置；Saved View 只能复制条件 |
| Cycle | Cycle 拥有 Membership、角色、容量与复盘；Saved View 只观察 |
| Activity | Activity 回顾已发生事实；Saved View 查询当前事实 |
| Module | Module 是 WorkItem 的长期领域事实；Saved View 可按其过滤/分组 |

## 11. 事件

所有事件携带 `spaceId`：

- `SavedViewCreated`
- `SavedViewUpdated`
- `SavedViewDeleted`
- `SavedViewCopied`
- `SavedViewPinnedChanged`

这些事件只描述查询配置，不进入 Project Activity 默认叙事流。

## 12. 验收标准

1. Project View 不能返回其他 Project WorkItem。
2. Space View 不能引用或返回其他 Space 数据。
3. Space View 默认深度为一级、二级；三级需显式加入。
4. Saved View 数据模型不保存查询结果 `workItemIds`。
5. WorkItem 状态变化后，结果动态进入或退出。
6. 删除 Saved View 不影响 WorkItem、Cycle 或 Module。
7. 从待处理区保存后，不显示处置按钮、复盘时限或异常提醒继承。
8. 删除筛选引用对象时，不得静默移除条件并扩大查询。
9. Project/Space 作用域转换必须复制并产生新 ID。
10. Saved View 无法修改 WorkItem、Session、Cycle 或 Activity。

## 13. 优先级

### P0

- Project / Space 两级作用域；
- 动态 filters / sort / group / visibleFields；
- Space 默认一二级；
- Space 隔离；
- 系统查询条件复制；
- 引用失效安全；
- 只保存规则、不保存结果。

### P1

- 少量可隐藏系统预置 View；
- View 收藏、排序和快速复制；
- 查询条件可读性解释；
- 大结果集性能优化。

### P2

- 多展示器；
- 通知与自动化；
- 快照/报告；
- AI 自然语言生成过滤条件。

## 14. 开放问题

无 P0 产品开放问题。预置 View 清单和大结果集刷新策略进入交互/工程规格。
