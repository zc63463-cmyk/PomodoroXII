# Contract Differences

## 差异分类

- **resolved adaptation**：本地规范已经明确选择，与上游差异可直接追溯。
- **compatible simplification**：首版缩小范围但不破坏上游事实边界。
- **unresolved engineering decision**：产品文字不足以生成唯一的持久化/API/Sync 行为。

## 1. ProjectGroup 与 Module

**分类：resolved adaptation**

WorkItem v1.2 允许轻量 `ProjectGroup?` 和 Project 内 `Module?`，并规定二者不拥有
WorkItem 状态、容量或进度。PomodoroXII 本地适配明确采用
`Space -> Project -> WorkItem`，首版不引 ProjectGroup 和 Module。

这不会破坏 WorkItem 核心层级，但迁移和 API 必须避免提前加入空壳字段；未来若
重新引入，应作为分类实体而不是第四层 WorkItem。

## 2. WorkItemNote 内容模型

**分类：compatible simplification，含 unresolved engineering decision**

上游 v1.2 使用稳定 Block 和最多两层 Checklist，支持把 Note item 提升为正式
WorkItem；Checklist 勾选是长期内容事实，不改变任务状态。PomodoroXII 本地适配
把首版 `WorkItemNote.content` 简化为纯文本，后续再迁移 JSON Block。

纯文本首版与事实归属兼容，但尚未定义：文本到 Block 的版本字段、迁移算法、原文
保真、同步冲突粒度以及旧 Task plan/completion 合并后的分隔格式。

## 3. FocusSession 与 WorkItem 事实归属

**分类：上游已解决，本地工程未闭合**

上游明确：PomodoroXII 拥有 FocusSession、SessionTaskContext、AttributionRevision、
Plan、Outcome 和命令回执；任务空间拥有 WorkItem、WorkItemNote 和正式状态。
本地适配却把 WorkItem 与 Session 数据都放入同一个 PomodoroXII 产品工程语境。

即使物理上同属一个后端，也必须保持模块事实边界：Timer 不能直接更新 WorkItem
状态，WorkItem 服务不能改写 Session 历史。尚需决定跨模块命令是否在同一 Space
事务中执行，以及离线客户端如何保存待执行命令而不复制可写状态。

## 4. Orbit 浮窗与页面首版

**分类：resolved adaptation**

上游 L3 规格针对可移动 Orbit 桌宠窗口，包含紧凑全景、节点聚焦和窗口聚焦。
PomodoroXII 本地适配明确首版只建 Timer 页面，用页面内组件覆盖当前三级切换、
WorkItemNote 编辑、完成草稿和运行中新建三级，不实现浮窗。

应复用交互语义而不是照搬窗口布局。Orbit 仍是跨项目后续消费者，不能成为首版
PomodoroXII 的运行依赖。

## 5. 旧 Task 到 WorkItem

**分类：resolved product mapping，含 unresolved engineering decision**

旧 Task 是扁平实体，使用 `todo/in_progress/done/archived`、字符串 tags、预估/实际
番茄数、plan/completion 和 due date。本地规范映射为 WorkItem 六态、labelIds、
投入秒数、WorkItemNote 和 hardDeadline，并把旧 Task 迁成无 parentId 的一级项。

尚未解决的问题包括：Project 如何为旧数据生成；旧 archived 与新 archivedAt/
状态组合；字符串 tag 如何稳定生成 Label ID；实际番茄数是否只做迁移种子还是必须
由有效 Session 重算；重复迁移和回滚如何证明幂等。

## 6. 旧 Session 文本

**分类：存在产品冲突，unresolved engineering decision**

本地规范的迁移表写明旧 `Session.plan` 和 `Session.completion` 不迁移，而旧
`Session.note` 迁到 `sessionNote`。与此同时，文档目标又强调把 plan/completion
拆成 SessionWorkItemPlan/Outcome。这两句话可以解释为“新模型不承接旧自由文本”，
但会导致历史文本丢失。

正式迁移规范必须明确是有意丢弃、转存只读历史字段、导出备份，还是做有限解析。
在此裁决前不能编写不可逆迁移。

## 7. 层级与关系

**分类：resolved adaptation**

旧 Pomodoroxi Phase 2 允许 `parent`/`subtask` 作为 TaskRelation 类型，与 depends_on、
blocks、related 并列。WorkItem v1.2 使用 `parentId` 作为唯一单父树事实，并把其他
关系保留为独立 Relation。父子不能同时存 parentId 和 relation edge 后再尝试同步。

同一 Project 的最多三层、禁止祖先环和移动子树深度验证是新模型约束。`blocks`
应作为 `depends_on` 的反向表达还是持久化双边，仍需本地 Registry/API 契约确认，
但不能形成两条可独立修改的事实。

## 8. 状态与父项完成

**分类：上游 v1.2 覆盖历史 v1.0**

v1.0 工作面允许 Workspace 自定义显示状态并包含负责人、多选批量操作等多人语言；
v1.2 去除成员/负责人，仍保留六类底层状态与 Space 状态库。二级存在活动三级时，
完成必须处理冲突，三级全部完成也不能自动完成二级。

PomodoroXII 本地类型把 `statusId` 直接写成六态枚举，省略 StatusDefinition ID。
这究竟是首版裁剪还是丢失可配置状态库，文档没有明确，是一个本地工程/产品裁决点。

## 9. 投入语义

**分类：resolved adaptation**

旧模型以 `estimated_pomodoros` 和 `actual_pomodoros` 表示投入。新模型允许二级使用
上下界秒数，实际投入从最新有效 Session revision 的净专注秒数派生。Session
时间不分配到三级；三级完成数量也不换算父项百分比或增加 Cycle 容量。

本地迁移暂时用 `pomodoros * 1500` 转换，但最终实际值应从 Session 重算并记录差异，
避免把旧缓存当成永久事实。

## 10. Same-Space 约束

**分类：resolved architecture constraint**

上游与 PomodoroXII 多 Space 设计一致：Project、WorkItem、Session、Cycle 和关系
必须同 Space；跨 Space 查询、移动、命令、依赖和聚合拒绝。归档 Space 后业务事实
只读，删除由顶层 Space 生命周期负责。

REST 路由、JWT、Dexie 数据库和 Sync envelope 必须从授权上下文取得 Space，不能
接受 payload 中未经绑定的 `spaceId` 作为路由权威。
