# PomodoroXII Task Space Design Archive

这是 PomodoroXII 的任务空间设计档案入口。档案将 tip-tip 上游契约、
PomodoroXII 本地适配、现有平台约束和旧 Pomodoroxi 行为基线放在一个可追溯
目录中。`sources/` 下的文件是原文副本；`analysis/` 下的文件是本档案新增的
导航与审查分析。

## 两种 Space

不要把两个概念混为一谈：

- **Pomodoro Space** 是顶层数据、隐私、Token、SQLite/Dexie 和同步隔离边界。
  Project、WorkItem、Session 和关系必须同属一个 Pomodoro Space。
- **Task Space（任务空间）** 是 Pomodoro Space 内围绕 Project、最多三层
  WorkItem、WorkItemNote、关系、计划和正式状态形成的长期工作域。它不是第二套
  数据库 Space。

事实边界同样重要：任务空间拥有 WorkItem、WorkItemNote、父子结构和正式状态；
PomodoroXII 拥有 FocusSession 时间事实、当时快照、Session 计划/结果和跨域命令
回执。二者不能各自维护一套可写的 WorkItem 状态。

## 当前结论

上游产品契约已经形成较完整的 WorkItem、Cycle、FocusSession 和 L3 交互链。
PomodoroXII 已有一份本地产品适配规范，但其声明状态仍是“待工程评审”，且归档时
原文件未被 Git 跟踪。当前代码仍以旧 `Task`、`Session` 和占位的 `/tasks`、
`/timer` 页面为基础；归档原文不能作为任何功能落地的证明。

## 推荐阅读顺序

1. [领域批准记录](sources/upstream-tip-tip/DOMAIN_BASELINE_APPROVAL.md)：先理解批准
   范围和不能直接进入工程实施的边界。
2. [WorkItem 单人 Space v1.2](sources/upstream-tip-tip/WORKITEM_SINGLE_USER_V11.md)：
   阅读当前上游领域总纲；冲突时它优先于 v1.0 五件套。
3. [FocusSession x Task Space](sources/upstream-tip-tip/SESSION_TASK_INTEGRATION_V10.md)
   与 [Cycle 容量](sources/upstream-tip-tip/CYCLE_CAPACITY_SINGLE_USER_V10.md)：理解
   时间为什么归二级、三级为什么是成果而不是分钟容器。
4. [PomodoroXII 本地适配](sources/pomodoroxii-existing/2026-07-11-timer-page-and-workitem-refactor-spec.md)
   与 [多 Space 架构](sources/pomodoroxii-existing/13-单用户多空间架构设计.md)：
   对照本项目裁剪和既有平台边界。
5. 阅读 [契约差异](analysis/contract-differences.md) 和
   [工程缺口](analysis/engineering-gaps.md)，确认仍需裁决与设计的内容。

需要理解设计演进时，再阅读 [Grill Me 决策总纲](sources/upstream-tip-tip/GRILL_ME_SYNTHESIS.md)、
v1.0 五件套以及原型规格。需要理解旧产品行为时，阅读
[Pomodoroxi PRD v1.1](sources/pomodoroxi-legacy/PRD-v1.1.md)。

## 导航

- [来源清单](analysis/source-inventory.md)：35 个候选的纳入/排除判断。
- [完整清单](MANIFEST.md)：21 个副本的来源、状态、权威级别和 SHA-256。
- [文档关系图](analysis/document-map.md)：依赖、替代和适配关系。
- [权威与状态](analysis/authority-and-status.md)：如何解释“批准”“基线”“待评审”。
- [契约差异](analysis/contract-differences.md)：上游、本地和旧模型的实质差异。
- [工程缺口](analysis/engineering-gaps.md)：进入代码实现前缺少的工程契约。

## 来源目录

- `sources/upstream-tip-tip/`：上游领域、集成、容量和交互契约。
- `sources/pomodoroxii-existing/`：本项目适配规范、平台约束和当前状态材料。
- `sources/pomodoroxi-legacy/`：旧产品行为与迁移参考，不是 WorkItem 权威。

## 使用边界

- 原文副本保持来源字节，不在副本内勘误或合并。
- 声明状态以来源原文为准；本档案不提升其批准级别。
- v1.2 明确替代与其冲突的 v1.0 内容，但 v1.0 文件仍保留用于追溯。
- 分析文件可以指出矛盾，不能替代正式工程评审作出未记录的产品裁决。
- 来源发生变化时，应先检查漂移，再决定是否重新归档和更新清单。
