# 取消不等于完成：依赖的真值表修正 + 「确认不再需要」两列落库

**状态**：已接受（2026-09-12）

依赖域合同要求「`cancelled` 不是完成，不能自动解除依赖；它产生 `broken_requires_resolution`」
（修订版 contract.md §3.4 / §4.2）。实现此前把 `completed` 与 `cancelled` 一起塞进
`TERMINAL_STATUS_CATEGORIES`（`backend/app/task_space/queries.py:61`）—— 取消上游 = **静默解除**阻塞，
这正是本次要修的病变。裁定如下，含三处容易走偏的边界。

- **真值表变更（task 本质，不是"给边加一个确认动作"）**：单条阻塞边 D→U 的边态是**纯派生**
  （`satisfied` / `broken_requires_resolution` / `open`，与既有 `blocked`/`depth` 同款：
  纯函数算出、wire 携带、**本地不存**、前端同算法重算）：
  - `completed` → `satisfied`；`cancelled` 未确认 → `broken_requires_resolution`（**仍阻塞**）；
  - `cancelled` + 已确认 → `satisfied`（**保留审计边**，不删边）；
  - 上游行缺失（孤儿边/未水合）→ `open`（既有语义保留：绝不静默解除，确认也不能解除未知端点）；
  - `blocked(D) = 存在任一边处于 {broken, open}`（AND 语义 D16 不变；`isBlocked` 仍仅二级定义）。
  `unknown_requires_resolution`（Project 归档/目标不可达）本期不做，见「Q4 裁剪」。
- **为什么确认必须落库（两列）而不是派生**：确认是**显式用户事实**（合同 §4.2 尾注：不能由状态变化
  或同步重放隐式生成），且必须**跨设备**（设备 B 看不到设备 A 的点击）。故 `relations` 加两列：
  `resolution`（`'confirmed_not_required' | NULL`，**不用布尔** —— 未来可能有别的 resolution 取值）
  与 `resolved_at`（服务端单调时钟戳，防伪）。
- **唯一写入者 = `ResolveDependency` 命令**：幂等 CAS（先例 `TrashWorkItem/RestoreWorkItem`）——
  重复确认 = 零效果回执（无 version bump / 无 sync 事件 / 无 DB 写），防止双击/意图重放产生
  伪 version bump 使其它 pending CAS 失效。外部 schema `extra="forbid"` 拒收调用方自带的
  时间戳与 resolution；只接受阻塞型边（`relates_to` 的确认无意义，fail-closed）。
  确认**不要求上游当前是 cancelled**：resolution 是**常驻声明**，只在真值表的 cancelled 分支被消费
  （先确认、后取消也成立，避免"确认与状态变化赛跑"的误拒）。
- **只出站 / 入站守卫——与 ADR-0003 的差异（关键取舍）**：work_item 的 pre_waiting 靠
  「`WORK_ITEM_SYNC_FIELDS` 精确相等」挡住入站；**relation 没有这层闸门**（"精确后像"校验只存在于
  work_item 与 note）。⇒ 采用**两层**：
  ① 出站由模型驱动携带（DB 行 / sync 事件 payload / REST 投影全部包含两列，行形状校验要求
  `set(row) == set(spec.field_names)`）；
  ② 入站由 `RelationDomainPolicy` 守卫（`app/commands/entity.py`）：**变更检测**（不是存在性拒绝）——
  post-image 原样回显服务端值可以（旧客户端缺字段也可），但**创建预置确认 / 变更两列**一律
  `server_managed_field_changed`（新码，已入 `MUTATION_REJECTION_SPECS` 闭集 + 前端映射表）。
  代价：relation 的 sync 事件与 journal 行形状随加列变化，升级瞬间若存在未 `FINALIZED` 的 relation
  命令批次会在 recovery 行形状校验处拒（降级 `FAILED_MANUAL`，非数据损坏）——与 ADR-0003 同一残留风险。
- **为什么不需要离线设计**：relation 的增删改**全部 online-only**
  （`task-space-repository.ts` `offline_formal_creation_forbidden` / `offline_formal_mutation_forbidden`），
  确认动作沿用同一纪律（`offline_formal_mutation_forbidden`）；离线调用直接被本地守卫拒绝。

## 语义（进 CONTEXT.md 术语表）

- **需要解决（Needs Resolution）**：上游已取消、未确认 —— **派生信号**，仍阻塞下游。
- **已确认不再需要（Confirmed Not Required）**：用户的**显式决定**（服务端事实）；确认后该边 satisfied、
  保留审计边，阻塞/恢复提示随之重算，**状态本身不自动变化**。
- 空上游 + 确认无效：孤儿边的确认不构成 satisfied 证据。

## ④ 接缝的「现状已严格」事实记录（防误诊）

B′ 的「依赖解除 → 建议恢复」gate（`relation-selectors.ts::selectWaitingResumeSuggestion`）
**今天就是严格口径**（要求上游全部 `completed`；注释明写 cancelled 属 broken 不算解除）——
**不存在**"取消了上游还提示恢复"的现行 bug。本单对它是双向锁死，不是修复：
a) 回归锁定：cancelled（无 resolution）→ 不提示（防 D2 改坏）；
b) 语义扩展：cancelled + `confirmed_not_required` → 视为 satisfied，提示（D2 新行为）。

## Q4 裁剪：Project 归档（待项目归档产品线，附复活触发条件）

- 合同 §3.3 要求 target Project 归档 → `unknown_requires_resolution`（阻塞且需解决）。
  但本仓 **projects.py 没有归档路由**（`archived_at` 只在 mapper 读取）⇒ 做了**无从验收**。
- 本期只保留**取值名与判定入口**（`queries.py::EDGE_STATE_UNKNOWN_REQUIRES_RESOLUTION`），
  ADR 显式标注"待项目归档产品线"。
- **复活触发条件**：项目归档产品线落地（归档/恢复路由 + Project 级真值语义）之日，在
  `derive_relation_edge_state` 增加 Project 维度判定并把该状态接入聚合。

## 合同三行逐行可追（修订版 contract.md）

| 合同行 | 本实现位置 |
|---|---|
| §3.4 / §4.2「`cancelled` 不是完成…产生 `broken_requires_resolution`」 | `queries.py::derive_relation_edge_state`（后端真值表）+ `relation-selectors.ts::deriveRelationEdgeState`（前端同算法）+ `compiler.py::_compile_ResolveDependency`（两列唯一写入者） |
| §3.4「WorkItem 归档…只增加 archived 提示，关系结果仍按底层状态计算」 | 归档提示：`work-item-relations-card.tsx` 行内「已归档」角标（`nameById[].archivedAt`）；真值表不额外分支（按底层类目计算） |
| §3.3「target Project 归档 → `unknown_requires_resolution`」 | **未实现（Q4 裁剪）**；取值名与判定入口预留在 `queries.py`；复活条件见上节 — 本行以 ADR 引用为准 |

## 加列触点（漏一处即失败）

`alembic_space/versions/015_relation_resolution.py` ・ `task_space/migration_preflight.py::TASK_SPACE_TARGET_HEAD`
（**忘了改会直接拒启动**，assets/014 各踩过一次）・ `models/relation.py` ・ `registry/builtin.py` FieldSpec
（行键集校验 `set(row) == set(spec.field_names)`，`unit_of_work.py` 三处 + sync 事件期望字段）・
`compiler.py` create/resolve 后像 ・ `routes/v1/relations.py` + `schemas/relation.py` 投影 ・
`contracts/entity.py::RelationDomainPolicy` 入站守卫 ・ 前端 `relationSchema`（**必填可空**，
z.strictObject 缺字段即拒收）・ `task-space-repository.ts::mapRelation` ・
store 错误映射表（`server_managed_field_changed`）。

## 验收条款

1. **真值表**：cancelled 未确认 → 阻塞（前后端矩阵逐条对齐）；确认 → 解除；孤儿边永不被确认解除。
2. **幂等 CAS**：首确认写两列 + 发 update 事件；重复确认零效果；陈旧版本 `version_conflict`。
3. **入站守卫**：客户端创建/变更两列 → `server_managed_field_changed`，零副作用；原样回显（含非空值）不误拒。
4. **跨设备**：A 确认后 B 增量 pull 到同一 `resolution`/`resolved_at`。
5. **接缝双向**：未确认不提示（锁定）；已确认提示（新行为）。
