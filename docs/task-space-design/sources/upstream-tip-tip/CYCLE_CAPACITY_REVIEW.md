# TipTip Next Cycle 与容量规划产品审查规格

> 状态：可供产品审查  
> 版本：v0.9  
> 日期：2026-07-10  
> 依赖：WorkItem v1.0 产品基线  
> 方向来源：`tip-tip-next-sandbox/docs/specs/CYCLE_CAPACITY.md` v0.8  
> 历史状态：多人/成员容量探索基线；PomodoroXII 单人产品以 [Cycle 单人容量 v1.0](./CYCLE_CAPACITY_SINGLE_USER_V10.md) 为准

## 1. 审查摘要

Cycle 是 Project 内连续、默认不重叠的**注意力计划窗口**，不是“进入后必须全部完成”的 Sprint。它通过三档角色、时间投入区间、轻量计划基线和人工复盘，帮助用户在不确定条件下安排近期工作。

本规格不依赖尚未冻结的风险数学模型。首版容量判断只使用确定性的 `interval-v1` 区间代数。

## 2. 用户问题

传统周期工具通常存在四个问题：

1. 把所有周期成员都解释为同等承诺；
2. 用单一完成率把 Stretch、研究项和真实承诺压成一个成绩；
3. 各 Project 各自声明容量，导致跨项目超分配不可见；
4. 周期结束自动结转，长期形成滚动债务和挫败感。

## 3. 产品目标

- 用户能区分真实承诺、普通计划和余力候选；
- 用户能用区间表达时间投入和可用容量；
- 用户能看见跨 Project 重复承诺；
- 周期变化被记录，但不用于追责或绩效排名；
- 未完成项必须经过明确决策，不自动滚入下一周期；
- 没有 Orbit 风险模型时，Cycle 仍完整可用。

## 4. Non-goals

本版明确不做：

- AI 自动排期、自动移出任务或自动修改角色；
- Cycle Goal / OKR 对象；
- Velocity、Story Points、自定义容量单位；
- 日历会议自动扣减容量；
- 成员绩效分、红黄绿排名；
- Orbit 风险权重、颜色或运动映射；
- 跨 Workspace 容量共享。

## 5. 用户故事

1. 作为同时推进多个 Project 的用户，我希望声明每周可投入区间并分配到项目，以便看见重复承诺。
2. 作为周期规划者，我希望把工作分为 Committed、Planned、Stretch，以便区分真实承诺和余力候选。
3. 作为估算不确定的用户，我希望看到“稳健 / 无缓冲 / 有压力 / 明确超载”的解释，而不是虚假的精确利用率。
4. 作为执行者，我希望周期中可以加入紧急或发现的工作，并在复盘中识别这些变化。
5. 作为周期复盘者，我希望逐项决定未完成工作的去向，而不是被系统自动结转。
6. 作为不习惯计时的用户，我希望实际投入可空，不记录也不被判定失败。

## 6. 领域对象与稳定身份

| 对象 | 稳定 ID | 事实职责 |
|---|---|---|
| Cycle | `cycleId` | Project 内时间边界、类型和生命周期 |
| CycleMembership | `membershipId` | WorkItem 在 Cycle 内的角色和历史结果 |
| WeeklyCapacity | `weeklyCapacityId` | 成员自然周总可投入区间 |
| ProjectCapacityAllocation | `projectAllocationId` | 周预算到 Project 的分配 |
| CycleCapacityAllocation | `allocationId` | Project 周分配到 Cycle 的分配 |
| EffortEntry | `effortEntryId` | 实际投入追加记录，P1 |

所有名称只用于显示，不驱动业务逻辑。所有写入经过统一应用服务，使用共享事件信封、`commandId`、`expectedVersion` 和审计事件。

## 7. Cycle 契约

### 7.1 类型

- `regular`：正常注意力周期；
- `rest`：休整、假期或暂停推进，默认容量为零。

### 7.2 生命周期

```text
draft → upcoming → active → ended_review_pending → closed
```

| 状态 | 进入方式 | 允许行为 |
|---|---|---|
| draft | 创建 | 编辑日期、容量、成员和 Membership |
| upcoming | 日期临近或显式发布 | 预览基线，仍可修改 |
| active | 到达 `activeStartAt` 或显式提前开始 | 记录基线和所有计划变化 |
| ended_review_pending | 到达 `effectiveEndAt` 或显式提前结束 | 关闭活动 Membership，生成复盘队列 |
| closed | 用户完成复盘 | 冻结结果；仅允许审计式更正 |

### 7.3 日期边界

- `startDate` / `endDate` 是冻结时区中的 local date；
- `activeStartAt` 默认物化为开始日 00:00；
- `effectiveEndAt` 默认物化为结束日次日 00:00；
- 修改 Workspace 时区不改变已有 Cycle 边界；
- 同一 Project 的 regular/rest Cycle 默认连续且不重叠。

## 8. CycleMembership 契约

### 8.1 角色

| 角色 | 产品语义 | 容量顺序 |
|---|---|---|
| committed | 存在真实交付承诺或外部后果 | 第一层 |
| planned | 预计本周期推进 | 第二层 |
| stretch | 有余力再做 | 单列，不制造正常超载警报 |

`carry_over` 是来源，不是第四种角色。

### 8.2 核心不变量

- WorkItem 同一时刻最多一个活动 Membership；
- Membership 与 WorkItem 必须属于同一 Project；
- 加入 Cycle 不修改 WorkItem 状态、完成窗口、硬截止和预计投入；
- 结转关闭旧 Membership、新建新 Membership，并重新选择角色；
- WorkItem 完成或取消时关闭活动 Membership，并保留历史；
- Cycle 结束只把仍活动的 Membership 记为 `unresolved`，不得覆盖已完成/取消结果。

### 8.3 计划来源和结果

来源：`baseline / added / urgent / discovered / carry_over`。

结果：`completed / cancelled / unresolved / carried_over / returned / paused / waiting / split`。

## 9. 轻量计划基线

Cycle 开始时追加不可变 `CycleBaselineCaptured` 事件。基线至少记录：

- Cycle 日期、类型、时区和版本；
- 周预算、Project 分配和 Cycle 分配的 ID、版本与区间；
- 初始 Membership、角色、来源和 `capacityMode`；
- WorkItem 的版本、底层状态、投入模式/区间、父子路径和负责人；
- 未估算、需拆分、暂停、等待和未负责人的纳入/排除明细；
- committed、committed+planned、stretch 初始汇总。

基线用于解释“计划后来发生了什么”，不是可编辑 WorkItem 副本，也不能恢复或覆盖当前事实。

## 10. 容量分配模型

```text
成员自然周总预算
        ↓
Project 周分配
        ↓
Cycle 周分配
        ↓
按成员与角色汇总 WorkItem 投入
```

### 10.1 规则

- 容量统一使用分钟区间；
- 单人和多人 Workspace 使用同一模型；
- 多人先按成员计算，再汇总 Project/Cycle；
- 未负责人工作单列，不由团队剩余容量自动吸收；
- 同一周发生 Cycle 切换时，必须显式分配给各 Cycle，不按天机械折算；
- rest Cycle 默认分配为零。

### 10.2 区间真值

设投入 `W=[Wmin,Wmax]`，容量 `C=[Cmin,Cmax]`：

| 条件 | 状态 | 唯一文案 |
|---|---|---|
| `Wmax < Cmin` | robust | 计划稳健，存在明确缓冲 |
| `Wmax = Cmin` | robust_no_buffer | 可以容纳，但无明确缓冲 |
| 区间重叠且不属于其他情况 | pressured | 计划有压力，结果取决于实际投入与可用时间 |
| `Wmin > Cmax` | overloaded | 明确超载，即使按最低投入也装不下 |

角色分层必须分别显示：Committed、Committed + Planned、Stretch。

## 11. 投入汇总与父子边界

- 仅活动 Membership、`not_started/in_progress`、可解析投入进入主动容量；
- `paused/waiting`、`unknown/needs_split`、未负责人项单独展示；
- WorkItem 的投入始终表达自身工作，不得写回后代总量；
- `capacityMode=own`：本 WorkItem 自身投入进入本周期容量；
- `capacityMode=summary_only`：仅展示范围，不计入该父项自身投入；
- 父项和子项都是 own 时分别计算各自真实投入，不视为重复；
- 投影可显示后代汇总，但不得把它再次计入父项。

## 12. 周期中变更

Cycle active 后仍允许：

- 加入、移出 WorkItem；
- 修改角色和来源；
- 调整容量区间；
- 更新 WorkItem 预计投入；
- 提前结束或显式延长。

任何变更都追加事件并即时重算容量。系统不强制“加入一个就移出一个”，但必须解释容量变化来源。

## 13. 周期结束与复盘

到达结束边界：

1. Cycle 进入 `ended_review_pending`；
2. 活动 Membership 关闭为 `unresolved`；
3. 未完成项进入复盘队列；
4. 不自动结转、不自动退回、不自动改状态；
5. 用户逐项或批量选择结转、退回未安排、等待、暂停、拆分或取消；
6. 进入下一 Cycle 时必须重新选择角色。

复盘顺序：

1. Committed 兑现；
2. Planned 完成或有实质推进；
3. 基线后新增、移出和角色变化；
4. 阻塞与等待；
5. 可选的实际投入偏差；
6. 未估算和需拆分项；
7. 结转数量与原因；
8. 下周期调整决定。

禁止输出单一总完成率、成员绩效分或羞耻性文案。

## 14. 工作面信息架构

### 14.1 Cycle 页面

- Header：名称、日期、类型、生命周期；
- 容量摘要：成员预算、Project/Cycle 分配、三段式解释；
- 工作分区：Committed、Planned、Stretch、Waiting/Paused、未估算；
- 变化摘要：基线后新增、移出、角色和容量变化；
- 复盘区：结果、结转决策和关闭周期。

### 14.2 WorkItem 联动

- WorkItem 列表可选显示 Cycle 和 Cycle role；
- WorkItem 详情可加入、移出 Cycle 或修改角色；
- Cycle 与完成窗口冲突只提示，不自动改写；
- Cycle 页面与 WorkItem 页面写入同一 Membership 事实。

## 15. 派生投影与算法边界

首版投影：

- `CyclePlanProjection`；
- `CycleCapacityProjection`；
- `CycleChangeProjection`；
- `CycleReviewProjection`。

`CycleCapacityProjection.algorithmVersion = interval-v1`。投影必须携带解释事实、计算时间和 stale 状态，且可从事实重建。

未来 Orbit 或风险模型可以读取投影，但不得：

- 修改 Cycle/Membership；
- 自动调整角色；
- 自动移出 WorkItem；
- 改写容量区间；
- 把风险分保存为 Cycle 事实。

## 16. P0 / P1 / P2

### P0

- Cycle 类型、生命周期、连续性与日期边界；
- Membership 三档角色、来源、结果和唯一归属；
- 轻量基线与中途变更事件；
- 周预算 → Project → Cycle 分配；
- interval-v1 分层容量判断；
- `capacityMode`、未负责人、未估算和暂停/等待处理；
- 周期结束、人工结转、基础复盘；
- Cycle 页面和 WorkItem 联动；
- 投影重建、并发、权限和可访问性。

### P1

- EffortEntry 手动记录与番茄钟/会话接入；
- 高级批量结转预览；
- 历史估算趋势；
- 团队容量隐私细粒度设置。

### P2

- AI 排期与自动调整建议；
- 日历自动扣减；
- 自定义容量单位；
- 风险数学模型与 Orbit 映射。

## 17. 关键验收标准

1. Given Project 默认两周 Cycle，When 创建下一 Cycle，Then 默认从当前 Cycle 结束次日开始且不重叠。
2. Given 用户创建 rest Cycle，Then 时间线连续且默认容量为零。
3. Given WorkItem 已有活动 Membership，When 加入另一 Cycle，Then 系统要求先关闭旧 Membership 或执行结转。
4. Given WorkItem 完成窗口在 Cycle 外，When 加入 Cycle，Then 仅提示且不改写窗口。
5. Given active Cycle 新增 urgent WorkItem，Then 容量即时重算且复盘识别为计划后新增。
6. Given Committed 可容纳而加入 Planned 后区间重叠，Then 显示“承诺稳健，整体计划有压力”，Stretch 单列。
7. Given `Wmin > Cmax`，Then 显示明确超载及事实解释，不输出风险分。
8. Given父项和子项均为 own，Then分别计算自身投入，后代汇总不再次计入父项。
9. Given WorkItem 为 unknown，Then不换算分钟并显示未估算数量。
10. Given WorkItem paused/waiting，Then不占主动容量但在独立区展示。
11. Given多个 Project 分配总区间与周预算重叠，Then显示有压力；仅 `Wmin > Cmax` 时显示明确超分配。
12. Given Cycle 结束且有未完成项，Then进入复盘队列，不自动结转。
13. Given WorkItem 结转，Then下一 Cycle 必须重新选择角色并记录 carry_over 来源。
14. Given没有 EffortEntry，Then复盘不计算估算偏差，也不按零处理。
15. Given Committed 全完成、部分 Planned 未完成、Stretch 未开始，Then不显示总完成失败。
16. Given风险模型不可用，Then Cycle 容量、解释和结转仍正常工作。
17. Given投影缓存被删除，When重建，Then interval-v1 结果一致。
18. Given旧 Cycle 尚未完成复盘，When将未完成 WorkItem 加入下一 Cycle，Then旧 Membership 已在结束边界关闭，新 Membership 可创建。
19. Given Cycle 内已完成 Membership，When到结束边界，Then outcome 保持 completed。
20. Given文本缩放到 200%，Then用户仍可完成角色调整、容量编辑和结转。

## 18. 成功指标与研究计划

由于暂无真实用户基线，以下均为需验证假设，不作为伪造承诺：

- 三档角色选择完成率；
- 用户能否正确解释四种容量状态；
- 周期结束后复盘队列处理率；
- 自动结转率保持为 0；
- 计划后新增工作被识别的比例；
- 使用周预算后，跨 Project 明确超分配比例是否下降；
- 用户对周期结束挫败感是否低于单一完成率方案；
- 维护周预算和复盘的认知成本是否可接受。

首轮可用性研究应重点测试：角色命名、区间理解、周预算维护意愿、复盘负担和 rest Cycle 语义。

## 19. 审查结论选项

- **批准**：冻结为 Cycle v1.0 产品基线，并进入工程实施计划；
- **有条件批准**：列出必须修订项，修订后冻结；
- **退回讨论**：指出产品语义冲突，回到相应章节逐项确认。
