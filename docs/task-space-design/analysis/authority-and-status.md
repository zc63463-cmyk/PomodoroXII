# Authority And Status

## 解释规则

“已批准”只说明文件声明的产品评审状态，不表示 PomodoroXII 已完成工程评审或
代码实现。上游批准不能自动批准本地裁剪；历史 v1.0 批准也不能覆盖 v1.2 的明确
替代条款。Git 跟踪状态只是可追溯性证据，不等同于产品权威。

## upstream-approved

### 当前主链

- `DOMAIN_BASELINE_APPROVAL.md`：批准产品领域决策基线，明确尚不可直接作为工程规格。
- `GRILL_ME_SYNTHESIS.md`：当前产品语义总纲，解释五轮关键纠偏。
- `WORKITEM_SINGLE_USER_V11.md`：v1.2 单人 Space 修订契约；WorkItem 冲突裁决的
  上游第一顺位。
- `CYCLE_CAPACITY_SINGLE_USER_V10.md`：已批准单人容量契约；受 v1.2 WorkItem 约束。
- `SESSION_TASK_INTEGRATION_V10.md`：FocusSession 与任务空间的产品契约基线。
- `TOPIC_PROTOTYPE_SPEC.md`：页面设计与验收基线。
- `FOCUS_L3_FLOATING_WINDOW_SPEC.md`：已完成产品对齐、进入视觉原型阶段。

这些文件来自一个非 Git worktree 的 tip-tip 快照。内容可用，但缺少提交 SHA 和
分支证明；清单中的 SHA-256 只证明本次复制内容。

### 历史批准链

- `WORKITEM_SHARED_CONTRACT.md`；
- `WORKITEM_FLEXIBLE_PLANNING_REVIEW.md`；
- `WORKITEM_LIFECYCLE_REVIEW.md`；
- `WORKITEM_RELATIONS_REVIEW.md`；
- `WORKITEM_WORKBENCH_REVIEW.md`。

它们均声明为 v1.0 已批准产品基线，但共享契约同时声明其多人 Workspace 假设不
能直接作为 PomodoroXII 输入；v1.2 规定冲突时由 v1.2 覆盖。正确用法是读取未被
替代的详细约束和设计演进，不是恢复多人模型。

## pomodoroxii-adaptation

- `2026-07-11-timer-page-and-workitem-refactor-spec.md`：唯一直接把上游 WorkItem、
  Session 与 PomodoroXII Timer 页面结合的本地产品规范。其状态是“待工程评审”，
  归档时原文件未被 Git 跟踪。

因此它目前是最相关的本地候选主规范，但不是已经生效的数据库/API/Sync 契约。

## architecture-constraint

- `13-单用户多空间架构设计.md`：已跟踪的 PomodoroXII 顶层 Space 隔离设计。
- `frontend-requirements-delta.md`：已跟踪的 React 迁移、双 JWT、per-space Dexie、
  路由与阶段边界记录。

这两份文件描述已进入现有架构的约束。后续 WorkItem 设计必须适配它们，除非另有
正式迁移决策；不能把 WorkItem 上游的 `Workspace` 当成新的共享数据库租户。

## candidate-or-exploration

- `frontend/README.md`：当前实现记录；适合判断 S0/S1 与占位业务页，不是产品契约。
- `phase-f-f2-task-explore-agent-prompt.md`：未跟踪的旧 F2 探索 prompt；以旧 Vue
  `TaskView` 和旧 Task store 为起点，不能覆盖后来的 WorkItem 适配。
- `PomodoroXII重构项目深度开发规划v4.md`：已跟踪的早期重构计划和旧 Task/Session
  基线；其阶段完成数字是历史快照。

## legacy-reference

- `PRD-v1.1.md`：旧 Pomodoroxi 产品需求和 Timer-Task-Session 用户闭环。
- `migration-map.md`：PomodoroX 到 PomodoroXI 的旧组件/字段迁移。
- `phase2-design.md`：旧标签与 TaskRelation 设计。

这些文件只回答“旧产品有什么、数据从哪里来”。它们不能决定 WorkItem 的新事实
模型，尤其不能恢复 `estimated_pomodoros`、父子 relation 双写或 plan/completion
文本的旧归属。

## 当前权威顺序

遇到同一问题时，建议按以下顺序判断：

1. 已实现的 Pomodoro Space 安全与隔离约束；
2. WorkItem v1.2 和 FocusSession 集成契约的明确不变量；
3. PomodoroXII 本地适配中已记录的裁剪，但先标记其待工程评审状态；
4. v1.0 历史批准文件中未被 v1.2 替代的细节；
5. 旧 Pomodoroxi 行为，仅作为兼容与迁移输入。

若第 2 与第 3 层冲突，不能靠本档案自动裁决，应在正式本地工程规格中明确选择。
