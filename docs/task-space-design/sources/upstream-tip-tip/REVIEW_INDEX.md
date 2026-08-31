# TipTip Next WorkItem 产品审查包

> 状态：产品负责人已批准  
> 版本：v1.0  
> 批准日期：2026-07-10

> 本版本作为 WorkItem 工程实施计划的产品基线。新增或改变 P0 语义的需求必须进入显式变更审查，不在实施过程中静默扩展范围。

## 审查目标

确认 WorkItem 第一组产品规格是否足以作为后续工程计划的产品基线，重点验证：

1. 多场景 Type/Status 是否既自由又有稳定系统语义；
2. 柔性排期是否真正区别于硬截止；
3. 父子、依赖和风险是否没有重复计算；
4. 列表是否把行动与计划放在首屏，而非传统精确日期；
5. 异常、离线、并发和可访问性是否有明确边界。

## 文档顺序

1. [共享领域契约](./specs/WORKITEM_SHARED_CONTRACT.md)
2. [类型与柔性排期](./specs/WORKITEM_FLEXIBLE_PLANNING_REVIEW.md)
3. [状态生命周期](./specs/WORKITEM_LIFECYCLE_REVIEW.md)
4. [父子与依赖](./specs/WORKITEM_RELATIONS_REVIEW.md)
5. [列表与详情工作面](./specs/WORKITEM_WORKBENCH_REVIEW.md)
6. [交互式 HTML 原型](./prototype/workitem-workbench-review.html)

## 已收敛的关键规则

- WorkItem、Type、Status、Relation 使用不可变 ID；显示名称不是关键字。
- Type 和显示状态由 Workspace 管理，Project 选择启用范围并设置默认。
- WorkItem 状态固定六类；取消与归档正交。
- 完成窗口、投入、信心、复盘与硬截止分离。
- `needsReplan`、`blockedByDependency` 等是派生信号，不占用状态。
- 父子最多三层、同 Project、单一父项、无祖先环。
- 依赖允许 Workspace 内跨 Project，禁止新环。
- 默认列表以树形标题、Type、状态、计划、投入、负责人和信号为核心。

## 本轮明确不做

- Type 专属状态机和自定义字段。
- 强制审批工作流。
- AI 自动排期。
- 跨 Workspace 依赖。
- 正式 CPM、lag 和资源约束排程。
- 容量超载、planning uncertainty 的首版信号。
- 完整 Saved View、看板和移动端应用。

## 审查结论

**批准。** WorkItem 第一组产品规格及交互原型可以作为工程实施计划的产品基线。

批准范围包括：

- 共享领域契约；
- Type 与柔性排期；
- 六类状态生命周期；
- 父子任务与依赖；
- 列表与详情工作面；
- 本文“本轮明确不做”中的范围边界。

本次批准不代表数学阈值、容量模型、Orbit 风险权重、看板或完整 Saved View 已确定。

## 后续顺序

1. 编写工程实施计划、领域模型和持久化策略；
2. 明确旧 Phase14C 中可迁移算法与禁止迁移的 UI/事实模型；
3. 在 `tip-tip-next-sandbox` 初始化全新工程；
4. 按共享契约 → Type/Status → WorkItem → Relation → 派生信号 → 工作台的依赖顺序实施；
5. WorkItem P0 验收通过后，再进入 Cycle 与容量规划。
