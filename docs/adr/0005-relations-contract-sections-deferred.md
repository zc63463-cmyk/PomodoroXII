# 依赖域合同 §11/§12 显式降级：Orbit 边界与上游事件表首版不实现

**状态**：已接受（2026-09-12）

上游评审文档 `docs/task-space-design/sources/upstream-tip-tip/WORKITEM_RELATIONS_REVIEW.md`
（只读件）的 §11「Orbit 边界」与 §12「事件」以要求的形态挂在合同上，代码却零实现。
合同要保住权威性，必须能区分「没做」与「不打算做」——本 ADR 做显式降级裁决。
本地快照以 `docs/task-space-design/recovered/pxii-rescue-2026-09-01/contract.md` §14
增补登记（沿用 §13 体例：增补不改正文）。本裁决是纯文档裁决：零代码改动，
不改变任何已验证行为。

## 被降级条文清单（逐条）

### §11 Orbit 边界（上游 L130-137）—— 5 项功能条文降级

| 条文（上行号为上游原文行） | 降级 | 复活条件 |
|---|---|---|
| `depends_on` 进入 blocked risk（L132） | 首版不实现 | 出现跨 Project 风险传播的真实需求 |
| 关键链（L132） | 首版不实现 | 同上 |
| 异常检测（L132；与上游 §8「已有异常环」L102-107 同源） | 首版不实现 | 同上 |
| 跨 Project 弱应力（L132） | 首版不实现 | 同上 |
| 同一对 WorkItem 同时父子+依赖时风险适配器避免双重放大；公式进独立风险规格（L136） | 首版不实现（无风险适配器） | 风险适配器立项时 |

上游 §11 的 L133-135（父子只作 L3 骨架、进度和一次父级聚合，不作为第二依赖路径；
`relates_to`、`duplicates`、`evidence_for` 只展示；Type、Label、Module、Cycle 不推断依赖）
是**禁止性边界**——以「不实现」的方式天然满足，不在降级之列、无需复活。

### §12 事件表（上游 L138-150）—— 8 个事件名降级

`WorkItemParentChanged`、`WorkItemChildRankChanged`、`RelationCreated`、`RelationRemoved`、
`DependencyRejected`、`DependencyAnomalyDetected`、`DependencyResolutionConfirmed`、
`ParentCompletionDecisionRecorded` —— **首版不实现**。当前事件模型
（`SyncEventPlan`，`backend/app/mutation/types.py:307`；relation 的 create/delete
同步事件见 `backend/app/task_space/compiler.py:1009-1016`）已覆盖所需语义，
只是没采用上游命名。复活条件：出现事件消费者（外部订阅/审计）。

## 理由

1. **重型图算法被有意排除（代码自陈）**：`backend/app/task_space/cycle_detector.py:3-5`
   —— 首版刻意只做增量可达性 DFS（依赖域合同 D13），「不需要 Tarjan SCC / 关键链 /
   风险传播这类重型图算法」。blocked risk / 关键链 / 异常检测 / 跨 Project 弱应力
   全部属于这一类。
2. **8 个事件名零命中（实测）**：2026-09-12 对 `backend/app` 与 `frontend/src` 逐名
   grep，8 个事件名全部 0 命中 —— 不是「没做完」，是从未以该词汇表立项。
3. **无消费者**：当前事件只服务于本机同步通道（push/pull 传播事实），没有外部订阅者
   或审计消费者；为无消费者的载荷预定事件名，只会制造假合同。

## 纪律

- **上游原文副本一字不改**：`docs/task-space-design/sources/**` 是 MANIFEST SHA-256
  baseline（`docs/task-space-design/MANIFEST.md`，跟踪机制见 `.gitignore:189-203`）；
  降级只发生在本地快照的增补章节与本 ADR。
- **本地快照在 docs/ 下不分发**（默认 ignore），本 ADR 是唯一随仓库分发的裁决文本
  （`docs/adr/` 已白名单，`.gitignore:208-210`）。
- 快照以 §14 增补登记，上文历史正文一字不改。

## 复活条件（汇总）

- §11 全部 5 项：出现跨 Project 风险传播的真实需求（产品级需求，非演示）。
- §12 全部 8 个事件名：出现事件消费者（外部订阅/审计）；复活时按当前 SyncEventPlan
  词汇表做映射适配，不直接照抄上游命名。
