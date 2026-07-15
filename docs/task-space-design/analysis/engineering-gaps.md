# Engineering Gaps

本文只列出从产品契约进入工程实施前必须关闭的契约缺口，不给出详细阶段计划。
每一项都以“可验收问题”表达，避免把候选答案伪装成已批准设计。

## 1. 权威本地规格

当前唯一 PomodoroXII WorkItem 适配仍是未跟踪、待工程评审文件。首先需要形成一个
被版本控制的本地权威规格，并逐条声明：继承上游、明确裁剪、延后或拒绝。

验收问题：

- 哪份文件是本地 WorkItem/Session 冲突的最终裁决源？
- v1.2 的 StatusDefinition、Type、ProjectGroup、Module、Block Note 各自是首版、
  延后还是明确不做？
- 上游文件发生变化时，本地适配如何识别和评审漂移？

## 2. 数据库迁移与回滚

现有 Space DB 已有 Task、Session、关系、标签和同步实体；尚无 Project、WorkItem、
WorkItemNote、SessionTaskContext、AttributionRevision、Plan、Outcome 和命令回执的
本地 ORM/Alembic 权威设计。

验收问题：

- 新实体属于 Space Alembic 链的哪些 revision，旧 Task 在何时停止写入？
- 是否采用扩展-回填-双读/单写-切换-清理，还是一次性离线迁移？
- 每条旧 Task 如何获得确定性的 Project、displayKey、Type/Status/Label ID？
- 旧 Session plan/completion 文本如何无损备份或显式处置？
- 失败、取消和进程崩溃后如何回滚或恢复，不留下双事实？

## 3. 持久化与领域不变量

产品类型不足以定义数据库约束和并发语义。

验收问题：

- `parentId` 如何强制同 Project、最多三层、非自身/后代，并在移动整棵子树时原子校验？
- WorkItem、Note 和 Session revision 的乐观锁字段及冲突响应是什么？
- 二级实际投入是查询时计算、物化投影还是缓存；其重建来源是什么？
- 二级完成时活动三级冲突由哪个命令原子处理？
- 状态、archive、completedAt/cancelledAt 的数据库 CHECK 和状态机如何表达？

## 4. REST 与错误契约

当前 `/api/v1/tasks` 契约不能自然承载 WorkItem 层级、命令回执和 Session revision。

验收问题：

- 新资源使用 `/projects`、`/work-items`、`/work-item-notes`，还是为旧 `/tasks`
  提供版本化兼容层？
- 树查询、移动、批量创建 L3、完成冲突和 Note 更新的请求/响应结构是什么？
- Space 从 token/path 解析时如何拒绝 payload 中的跨 Space 引用？
- `expectedVersion`、重复 `commandId`、未知结果、部分成功和结构变化分别使用什么
  稳定错误码、HTTP 状态和 retryable 标记？
- OpenAPI 如何生成前端类型并作为 drift gate？

## 5. Registry 与元数据目录

后端 Registry 当前围绕旧 Task/Session 实体提供 REST、Sync、ORM 和 Schema parity。

验收问题：

- `project`、`workItem`、`workItemNote`、Session 关联实体如何进入 EntitySpec？
- 旧 `task` 的 entity alias、route_enabled、sync_enabled 和退役窗口是什么？
- junction/revision/command receipt 是独立同步实体还是聚合内部数据？
- ORM、Pydantic、Alembic、Registry、OpenAPI 和 Dexie schema 如何同提交保持一致？

## 6. Sync、离线和冲突

上游要求稳定引用、追加 revision、幂等命令、未知结果对账和不静默覆盖，但尚未映射
到当前 PomodoroXII Sync v1/v2 事件目录。

验收问题：

- WorkItem 创建/移动/状态、Note 编辑、Plan/Outcome revision 各自产生什么 outbox 事件？
- parentId 移动与子树校验如何避免离线合并产生环或第四层？
- Note 纯文本首版采用 whole-document LWW、CAS 还是冲突副本？
- tombstone 如何处理 Project -> WorkItem -> Note，同时保留 Session 历史快照？
- 同一 `commandId` 重试如何返回原结果，`unknown` 如何对账？
- 旧客户端发送 `task` 事件期间，服务端如何避免新旧模型双写分叉？

## 7. 前端本地数据库与 Repository

当前 React 前端已有 per-space Dexie、同步引擎和 store 骨架，但 task-store 业务方法
仍是 no-op，Timer/Task 页面仍是占位。

验收问题：

- Dexie 新版本包含哪些表、索引、复合键和 upgrade 回填？
- UI 通过 repository 访问树和 Note，还是直接操作 Dexie；写入 outbox 的唯一入口是谁？
- WorkItem tree selectors 如何在大 Project 下保持稳定排序和局部更新？
- Space 切换、logout、跨 tab 和 sync pull 后如何清除/重建选择态与运行态？
- 本地草稿、正式 WorkItemNote、Session plan 草稿和 Session 随记如何避免状态混用？

## 8. Timer 与 Task 页面状态机

产品规范描述准备态、运行态、复盘态和沉浸态，但没有完整事件/恢复状态机。

验收问题：

- 页面刷新、浏览器崩溃、跨 tab 和设备切换后，活动 Session 从何恢复？
- 启动时二级/三级快照在哪个原子边界冻结？
- 运行中新建 L3 成功但加入计划失败，或反过来，UI 如何呈现和重试？
- 结束计时与成果复盘如何解耦，保证时间先持久化？
- 完成草稿撤销、延迟复盘、显式跳过和部分命令成功如何进入可恢复终态？

## 9. 旧数据转换与验证

字段映射表不是可执行迁移证明。

验收问题：

- 迁移前后 Task、Session、tag、relation、时间投入和文本内容如何盘点并出具差异报告？
- `actual_pomodoros * 1500` 与 Session 重算不一致时以谁为准，差异如何保留？
- 旧 parent/subtask relation 如何归一为 parentId，环和多父数据如何隔离？
- 迁移是否可重复执行并产生相同 ID、displayKey 和哈希？
- N-1 客户端、备份恢复和回滚分别如何验证？

## 10. Orbit 跨项目边界

PomodoroXII 首版不实现 Orbit 浮窗，但上游仍把 Orbit 视为 Task Space 消费者。

验收问题：

- Orbit 通过本地 API、MCP、事件流还是共享进程端口读取 WorkItem 与活动 Session？
- 哪些是只读投影，哪些命令可由 Orbit 发起，如何携带 Space 与 expectedVersion？
- Orbit 不可用时 Timer 是否完整可用？答案应为可验证的“是”。
- L3 窗口状态是否只属于 Orbit UI，不能回写 WorkItem 事实？

## 进入实施前的最小闭合条件

至少需要完成并评审以下工程契约，才适合编写不可逆迁移或正式业务代码：

1. 本地权威领域裁剪与事实源矩阵；
2. Space DB schema、迁移、备份和回滚设计；
3. REST/Error/OpenAPI 与 Registry/Sync 实体目录；
4. 前端 Dexie/repository/outbox 和页面状态机设计；
5. 旧数据转换、对账和兼容门禁。

这些闭合条件不要求先实现 Orbit，也不要求一次完成全部上游 P1/P2 能力。
