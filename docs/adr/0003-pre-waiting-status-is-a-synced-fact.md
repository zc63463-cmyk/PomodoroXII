# 等待前态：一条同步事实（加列 + 只读投影），不进 sync 后像

**状态**：已接受（2026-09-11）

依赖域合同要求「所有阻塞解除后建议**恢复进入 Waiting 前的状态**」。前态此前从未落库，
实现只能固定切回 `in_progress` —— 原本 `paused` 的项会被一键改成进行中。
裁定如下，含三处容易走偏的边界。

- **为什么值得为一条"提示"加列**：前态**不可派生**（服务端只知道当前状态，进入 Waiting 的历史入口没有留痕）。
  合同 §10 只在**同一设备**上被兑现不算兑现 —— 跨设备同步是硬需求。
  故前态必须是**服务端事实**，落在 `work_items` 的可空列上，而非本地记忆。
- **为什么不进 `WORK_ITEM_SYNC_FIELDS`（决定性）**：该集合参与 `_full_work_item_sync_candidate`
  的**双向相等**校验（`backend/app/task_space/compiler.py:974-981`），字段进出失配即拒
  `full_post_image_required`。而仓库**没有 wire 版本协商**（零命中），现有 cutover 闸门也不覆盖
  此场景。⇒ 加列但**只走读投影**：跨设备在线一致，且对旧客户端零破坏（同 `depth` 先例：
  `frontend/src/lib/contracts/task-space.ts:86-99`；同 `blocked_map` 先例：`backend/app/task_space/queries.py:232-238`
  "Pure projection … Never persisted, never synced"）。
- **出站携带 / 入站严格（2026-09-12 实测确认）**：pull / full / sync 事件是**模型驱动**序列化
  （`backend/app/services/serializers.py:21` 遍历 ORM 全列；`sync.py:70-74` 的
  `TIMESTAMP_PULL_REGISTRY` 含 work_item）⇒ 新列会随**出站**通道到达客户端；
  而**入站** push 仍按 `WORK_ITEM_SYNC_FIELDS`（`compiler.py:202-210`）**精确相等**校验
  （多一个字段即拒 `full_post_image_required`），wire 兼容保住在入站侧。
  ⇒ 「本地不存」只能靠**读取边界显式忽略**兑现（Dexie 允许透传落库，读取时不得消费），
  不能指望传输层不来；前端读契约 `workItemReadSchema` 必须同步加可选字段，
  否则 wire 解析（strict）会拒收新列。
- **为什么"离线读取缺失"是零功能损失**：状态迁移**离线被禁止**
  （`frontend/src/lib/task-space/task-space-repository.ts:377` `offline_formal_mutation_forbidden`），
  而「恢复」本身就是一次状态迁移 ⇒ 前态**只在在线时被消费**。离线读不到不该被算作妥协。
- **为什么不让客户端上行该字段**：迁移编译时前像就是**服务端自己的行**
  （`compiler.py:653` `_require_row(overlay, "work_item", …)`），服务端完全可自行推导。
  让客户端上行会把它纳入业务载荷哈希、并允许伪造"前态" —— 明确否决。
- **不用审计账本当读模型**：`mutation_operations.db_before_json` 虽可推导，但读路径需全表
  JSON 扫描（无索引）、过滤 `FINALIZED`、按行 version 取最大 —— 仓库零先例。仅允许作为
  **一次性回填工具**（见下）。

## 语义（进 CONTEXT.md 术语表）

- **唯一写入者**：进入 Waiting 的那次状态迁移；重复进入则覆盖；离开 Waiting **不清除**（惰性，仅在 Waiting 状态下被消费）。
- **取值域**：记录**任意**前态（`waiting` 自身除外 —— 停在 Waiting 不是一次新的进入）。
  前态为**终态**（`completed` / `cancelled`）时**不提供一键恢复**，降级为显式选择：
  从终态进入 Waiting 属异常路径，「复活终态项」是危险动作，不值得为它做一个按钮。
- **不可猜**：无记录 / 前态不可用时**绝不**回退到任何默认状态。

## 验收条款（本仓自有口径，严于上游"建议"）

1. **跨设备在线一致**：设备 A 迁入 Waiting 后，设备 B 拉取即可一键恢复**同一**前态。
2. **未命中降级**：无记录或前态不可用时，不提供一键恢复，必须由用户显式选择；**绝不自动切状态**。
3. **存量回填**：仅回填**当前仍处于 Waiting** 的项（否则它们永远拿不到一键恢复）。
   仅对经 UoW 提交且批次 `FINALIZED` 的行可靠；非 UoW 直写（脚本 / SQL）与补偿批次不可推导。
   实测（2026-09-12）：全库 0 行处于 Waiting ⇒ 回填为空操作；落地前重查一次计数。

## 加列的强制触点（漏一处即失败）

`alembic_space/versions/014_*.py` ・ `backend/app/task_space/migration_preflight.py:26`
的 `TASK_SPACE_TARGET_HEAD`（**忘了改会直接拒启动**，assets 踩过一次）・
`backend/app/models/work_item.py` ・ `backend/app/registry/builtin.py` FieldSpec —— **不可省**：
行键集校验要求 `set(row) == set(spec.field_names)`（`mutation/unit_of_work.py:428-438`、
`:915-922`、`:959-971`，以及 sync 载荷未知字段拒绝 `:569-575`）；不加则 DB 行一旦带列
即 `SpaceRecoveryRequiredError` / `work_item_structure_changed` ・
transition 编译写入 ・ 读投影（`schemas/task_space.py::WorkItemResponse` +
`routes/v1/work_items.py::_work_item_response` + `queries.py`）・
前端 `workItemReadSchema` ・ **读模型读取边界**（wire 行携带 / 本地行忽略 —— 不是"Dexie 行留存"：
本地 Dexie 行恒不消费该值，离线点击也必然被 `offline_formal_mutation_forbidden` 拒绝）。
