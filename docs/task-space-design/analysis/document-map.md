# Document Map

## 主依赖链

```text
PomodoroXII 单用户多 Space 架构
        | 约束所有实体同 Space、物理隔离和同步边界
        v
TipTip x PomodoroXII 领域批准记录
        | 批准修订方向，但声明尚不可直接工程实施
        v
WorkItem 单人 Space v1.2 领域契约
        +--------------------+----------------------+
        |                    |                      |
        v                    v                      v
Cycle 单人容量       FocusSession x Task Space     L3/专题原型规格
        |                    |                      |
        +--------------------+----------------------+
                             |
                             v
PomodoroXII Timer + WorkItem 本地适配规范
                             |
                             v
尚缺的数据库/API/Sync/前端迁移工程契约与实现
```

## 每条边的含义

### 多 Space 架构 -> 全部任务域实体

顶层 Pomodoro Space 已经是数据与授权边界。WorkItem v1.2 进一步规定 Project、
WorkItem、Cycle、Session 和跨域关联必须携带同一 `spaceId`，跨 Space 查询、移动、
命令和聚合一律拒绝。任务空间不能创造另一种可绕过 Space token 或 per-space DB
的容器。

### 批准记录 -> 修订契约

批准记录关闭了六项产品 P0，包括同域约束、Session 命令部分成功、运行中结构
变化以及二级完成时活动三级悬挂。它批准的是产品领域方向，并明确要求随后修订
WorkItem、Cycle 和 FocusSession 契约；它不是 ORM、API 或迁移规格。

### WorkItem v1.2 -> Cycle

Cycle 只把二级 WorkItem 作为容量口径。有效 Session 的净专注时间聚合到二级；
三级可表达成果和局部参考估时，但不能把估时叠加进 Cycle 容量。Cycle 契约依赖
WorkItem v1.2 的层级和状态语义。

### WorkItem v1.2 -> FocusSession 集成

集成契约引用 WorkItem 的稳定身份、父子结构、版本和正式状态，但把 Session 时间、
计划、结果、快照与回执留在 PomodoroXII。跨域状态变化必须通过显式幂等命令，
不能由计时结束直接改写任务状态。

### 集成契约 -> L3 交互

L3 浮窗和专题原型把领域边界转成交互：当前三级切换不重分配分钟，完成钩是
Session 草稿，WorkItemNote 编辑写长期任务事实，Session 随记仍是另一事实。
视觉规格不能反向改变领域规则。

### 上游链 -> PomodoroXII 本地适配

本地适配把上游模型裁剪到 Next.js/Zustand 项目，并决定首版不做 Orbit 浮窗、
不引入 ProjectGroup/Module、将 WorkItemNote 暂时简化为纯文本。该文件声明为待
工程评审，所以这些裁剪是候选适配，不等于已生效工程契约。

## 替代关系

`WORKITEM_SINGLE_USER_V11.md` 声明：与 WorkItem v1.0 五份规格冲突时，以 v1.2
为准。五件套包括：

- `WORKITEM_SHARED_CONTRACT.md`；
- `WORKITEM_FLEXIBLE_PLANNING_REVIEW.md`；
- `WORKITEM_LIFECYCLE_REVIEW.md`；
- `WORKITEM_RELATIONS_REVIEW.md`；
- `WORKITEM_WORKBENCH_REVIEW.md`。

这些历史批准文件仍提供详细事件、状态、关系和工作面规则，但其中的多人
Workspace、负责人、递归进度或父子容量假设不能直接进入 PomodoroXII。

## 旧模型关系

Pomodoroxi PRD v1.1 和 migration map 描述的是扁平 `Task`：一个 Session 可绑定
一个 Task，Task 使用预估/实际番茄数，Session 持有 plan/completion 文本。新的
本地适配不是简单换页面，而是要求数据迁移：Task -> WorkItem，Task 文本 ->
WorkItemNote，Session 文本 -> SessionWorkItemPlan/Outcome 或独立 Session 随记。

旧 Phase 2 的 `TaskRelation` 允许把 parent/subtask 当作独立关系边；WorkItem v1.2
则以单一 `parentId` 表示最多三层的父子树，Relation 只承载其他稳定关系。二者
不能并存为父子结构的双重事实源。
