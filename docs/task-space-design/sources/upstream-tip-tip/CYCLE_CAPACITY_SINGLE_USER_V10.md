# Cycle 与单人容量规划契约

> 状态：已批准领域总纲下的修订契约  
> 版本：v1.0 单人版  
> 日期：2026-07-10  
> 替代范围：若与 `CYCLE_CAPACITY_REVIEW.md` v0.9 冲突，以本文件为准  
> 依赖：`../tiptip-next-review/specs/WORKITEM_SINGLE_USER_V11.md`

## 1. 定位

Cycle 是当前 Pomodoro Space 内、单个 Project 的近期注意力计划窗口，不是 Sprint，也不是团队绩效容器。

它帮助单人用户：

- 区分 Committed、Planned、Stretch；
- 在多个 Project 之间分配个人周容量；
- 发现跨 Project 重复承诺；
- 记录计划变化而不自动结转；
- 用真实 Session 投入校准二级 WorkItem 估算。

## 2. Non-goals

- 不做成员、负责人、邀请、团队容量或绩效；
- 不把三级 WorkItem 独立加入 Cycle；
- 不用 Story Point、Velocity 或自定义容量单位；
- 不用单一完成率评价 Cycle；
- 不自动结转、排期、移动或修改角色；
- 不跨 Pomodoro Space 聚合容量；
- 不使用父子 `capacityMode` 切换容量口径；
- 不在首版自动读取日历会议。

## 3. 领域对象

| 对象 | 稳定 ID | 事实职责 |
|---|---|---|
| Cycle | `cycleId` | Project 内日期边界、类型和生命周期 |
| CycleMembership | `membershipId` | 二级 WorkItem 在 Cycle 内的角色、来源与结果 |
| WeeklyCapacity | `weeklyCapacityId` | 当前用户在当前 Space 的自然周可投入区间 |
| ProjectCapacityAllocation | `projectAllocationId` | 个人周预算到 Project 的分配 |
| CycleCapacityAllocation | `cycleAllocationId` | Project 周分配到 Cycle 的分配 |
| EffortProjection | 无独立可写事实 | 聚合 FocusSession 最新有效 revision |
| CycleBaseline | `baselineId` | Cycle 开始时的不可变计划快照 |

所有对象携带同一 `spaceId`。Project、WorkItem、Cycle 和容量分配跨 Space 时拒绝。

## 4. Cycle 契约

### 4.1 类型

- `regular`：正常注意力周期；
- `rest`：休整、假期或暂停推进，默认容量为零。

### 4.2 生命周期

```text
draft → upcoming → active → ended_review_pending → closed
```

| 状态 | 进入方式 | 允许行为 |
|---|---|---|
| draft | 创建 | 编辑日期、容量与 Membership |
| upcoming | 发布或日期临近 | 预览基线，仍可修改 |
| active | 到达开始边界或显式提前开始 | 捕获基线，记录变化 |
| ended_review_pending | 到达结束边界或提前结束 | 生成复盘队列，不自动结转 |
| closed | 用户完成 Cycle 复盘 | 冻结结果，只允许审计式更正 |

同一 Project 的 regular/rest Cycle 默认连续且不重叠。

## 5. Membership

### 5.1 资格

只有当前 Project 内的**二级 WorkItem**可成为 Cycle Membership：

- 一级是范围，不直接进入容量；
- 二级承接完整预计投入与 Session 实际投入；
- 三级继承二级的 Cycle 执行上下文，只作为成果拆解展示；
- 三级提升为二级后，才可独立加入 Cycle。

### 5.2 三档角色

| 角色 | 产品语义 | 容量顺序 |
|---|---|---|
| committed | 有真实交付承诺或外部后果 | 第一层 |
| planned | 预计在本周期推进 | 第二层 |
| stretch | 有余力再做 | 单列，不制造正常超载警报 |

`carry_over` 是来源，不是角色。

### 5.3 不变量

- 二级 WorkItem 同一时刻最多一个活动 Membership；
- Membership 与 WorkItem 必须同 Space、同 Project；
- 加入 Cycle 不修改 WorkItem 状态、窗口、硬截止和预计投入；
- WorkItem 完成/取消时关闭活动 Membership；
- Cycle 结束将活动 Membership 记为 unresolved，不覆盖已完成/取消结果；
- 进入下一 Cycle 必须重新选择角色；
- 三级状态不直接改变 Membership 结果。

来源：

```text
baseline / added / urgent / discovered / carry_over
```

结果：

```text
completed / cancelled / unresolved / carried_over / returned / paused / waiting / split
```

## 6. 单人容量模型

```text
当前 Space 内的个人自然周总预算
              ↓
       分配到各 Project
              ↓
       分配到各 Cycle
              ↓
按角色汇总二级 WorkItem 预计投入
```

### 6.1 WeeklyCapacity

```text
WeeklyCapacity
- weeklyCapacityId
- spaceId
- weekStartDate
- timezone
- capacityMinMinutes
- capacityMaxMinutes
- source: manual / inherited_previous / suggested_history
- version
```

首版支持手动填写并默认继承上一周值，用户只修改变化部分。历史 Session 只能生成建议，不自动覆盖周预算。

### 6.2 分配

- 每个 Project 获得周预算区间；
- 可保留未分配缓冲；
- Project 分配之和不得被静默强制等于总预算；
- 分配下限和上限超过总预算时显示解释，但不自动修改；
- 同一周发生 Cycle 切换时，显式分配到各 Cycle，不机械按天折算；
- rest Cycle 默认分配为零。

### 6.3 区间真值

设二级预计投入汇总 `W=[Wmin,Wmax]`，Cycle 容量 `C=[Cmin,Cmax]`：

| 条件 | 状态 | 文案 |
|---|---|---|
| `Wmax < Cmin` | robust | 计划稳健，存在明确缓冲 |
| `Wmax = Cmin` | robust_no_buffer | 可以容纳，但无明确缓冲 |
| 区间重叠 | pressured | 计划有压力，结果取决于实际投入与可用时间 |
| `Wmin > Cmax` | overloaded | 明确超载，即使按最低投入也装不下 |

分别显示 Committed、Committed + Planned、Stretch；Stretch 不计入正常超载警报主层。

## 7. 投入汇总

### 7.1 预计投入

进入主动容量的 WorkItem 必须：

- 是活动二级 Membership；
- 状态为 not_started 或 in_progress；
- 具有可解析的二级预计投入区间。

paused、waiting 单列，不计入主动容量。预计投入缺失或不可解析的二级归入派生分类 `estimate_missing`；用户明确标记“需要继续拆分/重新估算”的二级归入派生分类 `needs_split`。二者都不是 WorkItem 生命周期状态，均单列且不计入主动容量。

### 7.2 三级边界

- 二级预计投入天然包含其三级成果；
- 创建、完成或取消三级不直接改变 Cycle 预计投入；
- 三级参考估时不叠加；
- 三级全部完成不自动结束 Membership；
- 若三级变化暴露范围扩大，用户修订二级预计投入后，Cycle 才重算容量。

### 7.3 实际投入

- 实际投入来自归属该二级的 FocusSession 最新有效 revision；
- Session 时间不分配到三级；
- 误启动/撤销 Session 不贡献实际投入；
- Session 归属更正通过 revision 从旧二级撤销、计入新二级；
- 三级成果状态不随 Session 时间更正自动回滚。

## 8. 基线与变化

Cycle active 时捕获不可变基线：

- Cycle 日期、类型、时区和版本；
- 当前 Space 个人周预算；
- Project/Cycle 分配；
- 初始二级 Membership、角色和来源；
- 二级状态、预计投入、完成窗口、父子路径；
- 未估算、需拆分、暂停和等待明细；
- Committed、Committed+Planned 与 Stretch 汇总。

基线不记录成员、负责人或三级参考估时。

变化记录：

- 二级加入/移出 Cycle；
- 角色或来源变化；
- 容量分配变化；
- 二级预计投入、状态或整体范围变化；
- 基线后新增/完成/取消的二级。

不进入 Cycle 变化记录：

- 普通 Session 开始/结束；
- 三级加入/移出某次 Session；
- 三级 Note 和 Checklist 变化；
- 三级普通完成，除非导致二级范围或估算被用户修改；
- mood、化身、中断和暂停行为。

## 9. 二级投入上限复核

二级累计有效 Session 投入：

| 条件 | 行为 |
|---|---|
| 低于预计下限 | 不提示 |
| 进入预计区间但低于上限 | 二级卡与 Session 结束页显示静态信息 |
| 达到或超过预计上限 | 生成显著复核卡与 `effortLimitReached` |

显著复核动作：

- 完成二级；
- 更新剩余估算；
- 标记范围扩大；
- 处理阻塞；
- 延后到下次复盘点。

三级全部完成不改变提醒强度。复核不得阻止 Session 结束；关闭后进入当前 Space 待处理区。

## 10. Cycle 结束复盘

到达结束边界：

1. Cycle 进入 ended_review_pending；
2. 活动 Membership 关闭为 unresolved；
3. 不自动结转、退回或改 WorkItem 状态；
4. 用户逐项或批量选择：结转、退回未安排、等待、暂停、拆分、取消；
5. 结转到下一 Cycle 时重新选择角色；
6. 完成全部决策后关闭 Cycle。

复盘结构：

1. Committed 兑现；
2. Planned 完成或实质推进；
3. 基线后变化；
4. 真正阻塞与等待；
5. 二级预计/实际投入偏差；
6. 需拆分与推进异常；
7. 结转数量、原因和角色重选；
8. 下周期调整决定。

禁止总完成率、成员绩效、化身效率分和羞耻性文案。

## 11. 待处理区联动

Cycle 读取当前 Space 的统一待处理派生：

- 真正阻塞；
- 推进异常；
- 待成果复盘；
- 待同步与冲突。

Cycle 页面只显示与本 Cycle 二级 Membership 相关的投影，不创建第二套状态。

推进异常以二级问题卡为主，三级仅提供原因证据。用户延后处理时必须设置复盘点。

## 12. 事件

所有事件携带 `spaceId`：

- `CycleCreated/Started/Ended/Closed`
- `CycleBaselineCaptured`
- `CycleMembershipAdded/Changed/Closed`
- `WeeklyCapacitySet`
- `ProjectCapacityAllocated`
- `CycleCapacityAllocated`
- `CyclePlanChanged`
- `CycleReviewDecisionRecorded`

实际投入不复制为手工 EffortEntry；它是 FocusSession revision 的投影。未来如支持非 Session 手工投入，需独立来源和更正规则。

## 13. 验收标准

1. **单人模型**：页面和契约中不出现成员、负责人或未负责人工作。
2. **Space 隔离**：跨 Space 容量、Membership 或 Session 投影必须拒绝。
3. **二级资格**：一级/三级不能直接加入 Cycle。
4. **三级不叠加**：创建三个三级后，Cycle 预计投入不变化。
5. **周预算继承**：新周默认带入上周值，用户可修改，不自动使用 Session 建议覆盖。
6. **跨项目超分配**：两个 Project 分配合计超过个人周预算时显示压力/超载解释。
7. **三档角色**：Stretch 单列，不计入 Committed/Planned 主警报。
8. **Session 投影**：二级实际投入等于最新有效 Session revision 汇总，不重复计入。
9. **上限复核**：达到上限时显示显著卡，但不阻止 Session 结束。
10. **三级全完成**：不自动完成二级、Membership 或 Cycle。
11. **不自动结转**：Cycle 结束后 unresolved 项必须由用户决策。
12. **无总完成率**：复盘不输出统一完成百分比或化身效率分。

## 14. 优先级

### P0

- 单人 Cycle 生命周期；
- 二级 Membership；
- Committed/Planned/Stretch；
- 个人周预算→Project→Cycle 分配；
- 区间真值；
- 二级预计与 Session 实际投入；
- 基线与变化；
- 人工复盘与不自动结转；
- 上限复核与待处理区联动。

### P1

- 上周容量继承与历史建议优化；
- 批量复盘预览；
- 估算偏差趋势；
- 快速按 Project 调整分配。

### P2

- 日历自动扣减；
- 自动容量优化；
- 跨 Space 显式个人洞察；
- 多用户团队容量必须重新立项。

## 15. 开放问题

无阻塞产品问题。个人周预算建议算法、推进异常阈值和通知频率进入后续派生/指标规格。
