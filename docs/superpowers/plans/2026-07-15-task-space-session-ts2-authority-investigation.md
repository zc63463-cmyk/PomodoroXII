# TS2 ActiveSession Recovery Authority Contract — 权威调查结论

分支：`codex/ts2-active-session-authority`（worktree `ts2-authority-wt`）
基线：`a26b997` = S4 integration final = S5 Task 1 基线（干净）

本文件是 TS2 ActiveSession Recovery Authority Contract 的权威调查结论（交回报告第 3 项）。
所有行号均针对当前 worktree 真实复核。

## 1. locator state 合法值与转移

- 合法值：`claiming`、`active`、`releasing`。
  - `backend/app/db/models/meta.py:73-75`（`ActiveSessionLocator.state` CHECK）
  - `backend/alembic_meta/versions/002_active_session_locator.py:97-102`（迁移 CHECK，与 ORM 一致）
- 状态机转移（权威计划 `docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md` L2545-2557）：
  - `empty -> claiming(epoch=1) -> active`（claim/finish_claim）
  - `active -> claiming(同 epoch) -> active`（begin_action/finish_action；pause/resume/note/plan 等）
  - `active -> claiming(epoch+1) -> active`（begin_takeover/finish_takeover）
  - `claiming -> releasing -> empty`（begin_release/clear_release，end 流程）
  - 冲突：locator 保持 `claiming`，operation phase 进入 `awaiting_resolution`（L2590-2591, L3046）
- 恢复决策表（L3036-3054）明确列出 `claiming`/`active`/`releasing` 各分支。

## 2. operation kind/phase 合法值与组合

- kind 13 值：`start`、`heartbeat`、`pause`、`resume`、`end`、`takeover`、`update_note`、
  `set_current_plan_item`、`set_completion_draft`、`add_plan_item`、`remove_plan_item`、
  `activate_provisional`、`resolve_activation_conflict`（`meta.py:107-112`；迁移 `002:90-96`）
- phase 8 值：`prepared`、`claimed`、`space_committed`、`awaiting_resolution`、`transferred`、
  `completed`、`rejected`、`manual_intervention`（`meta.py:114-118`；迁移 `002:97-102`）
- 权威组合（计划 L3036-3054 + L2545-2557）：
  - `active` + `completed`
  - `claiming` + `claimed`（claim/begin_action/begin_takeover 后的恢复根）
  - `claiming` + `awaiting_resolution`（conflict 用户决策态）
  - `claiming` + `transferred`（仅 `resolve_activation_conflict`；L3047 resolution 操作）
  - `claiming` + `rejected`（L3041-3042 定义恢复动作，但不在本 authority 受支持证明集合内 → fail closed）
  - `releasing` + `space_committed`
  - `manual_intervention` 任何状态下均要求人工干预（S5 `coordinator.py:213-216`）
- 注意：S5 `backend/app/recovery/coordinator.py:100-104` 的 `_STATE_PHASE_RULES` 将 `claiming` 限为
  `{claimed, awaiting_resolution}`，不含 `transferred`；本 authority 依据权威计划将
  `claiming+transferred` 仅对 `resolve_activation_conflict` 判定为可证明。

## 3. intent_json closed schema

- **无生产实现依据**：`ActiveSessionCoordinator` 目前仅 Protocol（`contracts.py:175-180`）；
  `active_session_operations` 无生产写方（唯一写入路径在计划 Task 5，未落地）。
- S5 侧假定形态（`backend/tests/test_recovery.py:759-781` `_make_intent`，S5 单方面约定）：
  `{"command_id","space_id","session_id","ownership_epoch","payload_hash","kind", **business}`
  - identity 键（S5 `_INTENT_IDENTITY_KEYS`，`coordinator.py:107-109`）：
    `command_id/space_id/session_id/ownership_epoch/payload_hash/kind`
  - 其余字段为 business 子集，re-hash 必须等于 `payload_hash`。
- 本 authority 定义的 intent contract（在 `recovery_authority.py` 文档化）：
  - identity 键与 S5 一致；
  - business 子集字段（顶层非 identity 字段）参与 canonical hash；
  - 可选扩展字段（不参与 hash，作为 identity 声明）：`pair`（conflict active/candidate 复合身份）、
    `children`（child operation ID，按角色 `candidate/active/winner/loser`）。
- 无 `children`/`pair` 声明时按默认规则处理；需要声明但缺失 → 无法证明 → fail closed。

## 4. payload_hash canonical 算法

- `canonical_payload_hash(payload) = sha256(rfc8785 JCS over to_wire_json(require_frozen_object(payload)))`
  - `backend/app/mutation/types.py:63-68`
  - `require_frozen_object` 要求 JSON object（`types.py:50-54`）
  - `to_wire_json` 来自 `app/errors.py`
- `payload_hash` 必须为 64 位小写 hex（`meta.py:121-123` CHECK；`types.py:41`）。

## 5. child operation ID 生成规则

- `bounded_child_operation_id(parent_id, suffix)`：
  - 可读形式 `childp:<parent-byte-length>:<parent>:<suffix>`（≤128 ASCII 字节）
  - 超长回退 `childh:<sha256>`
  - `backend/app/mutation/types.py:89-108`；operation_id 校验 `types.py:83-86`
- 简单操作（start/pause/resume/end/note/plan/heartbeat）的原始 child：`FocusSessionCommand.command_id`
  直接等于 root `command_id`（即 `operation_id`），由 `FocusSessionModule` 经
  `MutationUnitOfWork.execute(scope, request, command.command_id)` 写入
  （`module.py:188`；计划 L2736-2743）。
- takeover/conflict/resolution child：确定性 bounded child ID，但具体 suffix 无权威定义
  （contract gap，见第 10 节）→ 本 authority 从 intent `children` 声明读取。

## 6. child receipt 真实存储位置

- `space.db` 的 `session_command_envelopes` + `session_command_receipts`
  - `backend/app/models/session_command.py:9-30`（envelope）、`:33-50`（receipt）
  - receipt.state 合法值：`not_needed/pending/succeeded/failed/conflict/unknown/abandoned`
    （`session_command.py:46-49` CHECK；`contracts.py:87-94` `CommandReceiptState`）
- terminal-success = `succeeded`；terminal-rejected = `failed`/`conflict`；
  unknown = `unknown`；pending = `pending`（非终态）。

## 7. matching Session 查询与终态规则

- 唯一公开只读 Session 查询：`FocusSessionQuery.load(scope, session_id)`（`query.py:129-258`）
  - 仅依赖 `scope.session_factory()` + `scope.scope.space_id`（`query.py:135-220`）→
    可对"复制品"只读数据库构造（测试已覆盖验证）。
- 本 authority 的 Session 事实查询使用真实 ORM `select(FocusSession)`（`models/focus_session.py:10-49`）：
  - 存在性：`FocusSession.id == session_id`
  - 终态：`ended_at IS NOT NULL`（`focus_session.py:31`）；nonterminal = `ended_at IS NULL`
  - conflict 态：`ownership_state == "activation_conflict"`（`focus_session.py:23-26, 47-49`）
- 终态规则依据：计划 L3039（Session ended）、L3050（matching nonterminal Session）。

## 8. conflict pair 身份与结果规则

- pair（active/candidate 复合 `(space_id, session_id)`）来自 persisted intent，绝不来自 caller
  （计划 L309, L3062, L3425-3427）。
- locator 在 conflict 期间锚定 active 身份（`claiming(conflict, old target, epoch=E)`，L3434）。
- 两个 Session 均保持 `ownershipState="activation_conflict"`（L3401）。
- winner/loser 由 `winnerRole` 从 pair 推导（L3425-3427）；child 角色命名无权威定义（contract gap）。

## 9. unknown child / original result 定义

- unknown child：`receipt.state == "unknown"`（S3 超时/无 terminal 结果）；计划 L2158。
- pending child：`receipt.state == "pending"`。
- unknown original result：原操作查询后仍无 terminal 结果（L3045, L3049）。
- authority 对 child 的判定：present/absent、terminal-success / terminal-rejected / unknown / pending，
  并保留在 `SpaceChildOutcome` 中。

## 10. Contract gaps（无实现依据，均 fail closed）

1. `intent_json` closed schema 无 TS2 生产实现（S5 侧假定形态与本 authority 定义兼容但不一致）。
2. `related_operation_id` 语义无权威实现（`meta.py:102` 仅建列，计划无定义；S5 假定 parent→child 链）。
3. takeover/conflict/resolution child 的 bounded suffix 命名无权威定义 →
   本 authority 要求 intent `children` 声明，缺失即 fail closed。
4. `ActiveSessionCoordinator` 无生产写方（`contracts.py:175-180` 仅 Protocol）。
5. `transferred` phase 仅 `resolve_activation_conflict` 上下文有定义（L3047）。
6. `claiming + rejected` 恢复动作在计划 L3041-3042 有定义，但不在本 authority 受支持证明集合内 → fail closed。
