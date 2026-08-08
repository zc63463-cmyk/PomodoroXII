# TS2 ActiveSession Recovery Authority Contract — 交回报告

最终状态：**READY FOR S5 INJECTION**（剩余 contract gaps 见第 10 节，均 fail closed）

## 1. 真实基线 SHA

- 基线（S5 Task 1 基线，干净无污染）：`a26b997`（= S4 integration final）
- 本次分支提交：
  - `395ecd1` docs(recovery): record TS2 active-session authority investigation
  - `cdd5641` feat(recovery): add TS2 active-session recovery authority contract
- 主 worktree（只读，未写入）：`E:\DevTemp\pomodoroxii-boundaries\s5-next`，未创建分支/提交

## 2. 分支和 worktree

- worktree：`E:\DevTemp\pomodoroxii-boundaries\ts2-authority-wt`
- 分支：`codex/ts2-active-session-authority`（已 checkout，HEAD=`cdd5641`）
- 遗留文件 `backend/fix_editable.py`：保留未动（editable 安装修复脚本，非本任务产物）

## 3. Authority 调查结论及文件行号

完整结论见 `docs/superpowers/plans/2026-07-15-task-space-session-ts2-authority-investigation.md`，要点：

1. locator state 合法值 `claiming/active/releasing`：`backend/app/db/models/meta.py:73-75`；迁移 `backend/alembic_meta/versions/002_active_session_locator.py:97-102`。状态机转移：TS2 计划 `docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md` L2545-2557。
2. operation kind 13 值 / phase 8 值：`meta.py:107-112` / `meta.py:114-118`；迁移 `002:90-102`。权威组合 active+completed、claiming+{claimed,awaiting_resolution,transferred(仅 resolve)}、releasing+space_committed：计划 L3036-3054。
3. intent_json closed schema 无生产实现依据（ActiveSessionCoordinator 仅 Protocol `contracts.py:175-180`；active_session_operations 无生产写方）。S5 侧假定形态 `backend/tests/test_recovery.py:759-781`。本 authority 定义 identity 键 + 可选 `pair`/`children` 声明。
4. canonical payload_hash = sha256(rfc8785 JCS over to_wire_json(frozen object))：`backend/app/mutation/types.py:63-68`。
5. child operation ID：`bounded_child_operation_id` → `childp:<len>:<parent>:<suffix>` / `childh:<hash>`：`types.py:89-108`。简单操作原始 child envelope.command_id == operation_id：`backend/app/focus_session/module.py:188`（UoW.execute(scope, request, command.command_id)）。
6. child receipt 真实存储：space.db `session_command_envelopes`+`session_command_receipts`：`backend/app/models/session_command.py:9-50`；receipt state 枚举 `contracts.py:87-94`。
7. matching Session：唯一公开只读查询 `FocusSessionQuery.load`：`backend/app/focus_session/query.py:129-258`（已验证可对复制品只读库构造，测试 `test_focus_session_query_loads_from_readonly_copy`）。Session 终态 = ended_at 非空：`backend/app/models/focus_session.py:31`。
8. conflict pair 身份/结果：pair 来自 persisted intent（计划 L3062/L3401），locator 锚定 active 身份，两个 Session `ownership_state="activation_conflict"`（`focus_session.py:47-49`）。
9. unknown child/original result：receipt.state ∈ {unknown, pending}；terminal-success="succeeded"，terminal-rejected={failed,conflict}：`session_command.py:46-49`。

## 4. 新增公开接口

文件：`backend/app/focus_session/recovery_authority.py`（新增）

- `ActiveSessionRecoveryView`（只读 Meta 数据库视图，`meta_db_path`）
- `LocatorIdentity` / `OperationIdentity`（locator/operation 身份，不含原始 intent 或用户内容）
- `SpaceChildOutcome`（角色、child id、envelope 存在性、receipt state、terminal-success/rejected/unknown/pending）
- `SessionRecoveryFact`（space/session、存在性、ended、ownership_state、validity、validity_reason）
- `ConflictPairFact`（active/candidate 复合身份）
- `ActiveSessionRecoveryDecision`（frozen，含 classification/result/locator/operation/child_outcomes/session_facts/conflict_pair/failure_code/reason；`to_wire()`/`to_canonical_json()` 确定性序列化）
- `ActiveSessionCoordinationInspector`：`async def inspect_read_only(view, *, space_views: Mapping[str, SpaceDataView] | None = None) -> ActiveSessionRecoveryDecision`

只读实现：SQLite `mode=ro` URI engine + 真实 ORM select；不伪造 SpaceRuntimeHandle；`view` 兼容 S5 `SimpleNamespace(db_path=...)` 注入形态。

## 5a. S5 集成要求（第二轮审查确认，**非零改动注入**）

当前 S5 `RecoveryCoordinator` **不能无修改直接注入**本 authority：

- S5 必须为每个涉及的 Space 构造 **live/copied `space_views` 映射**（`SpaceDataView`，`space_id -> {db_path, ...}`），并通过
  `await inspector.inspect_read_only(meta_view, space_views=space_views)` 调用；
- 未提供某 Space 的 view 时，任何需要该 Space 证据的路径 fail closed（`space_view_missing`）；
- 因此 S5 侧 `coordinator.py` 需要改造：在 snapshot/verify 阶段为复制品数据库构造 `SpaceDataView`（指向复制品 `space.db`）并传入；当前 S5 内置 `ActiveSessionCoordinationInspector` 只消费 Meta `db_path`，不满足本 authority 的 Space 证据要求；
- 注入点：`RecoveryCoordinator(active_coordination_inspector=<本 authority 实例>)`，并把 `recovery_view_factory` 产出物映射为 `space_views`。

## 5. state/phase/child/session 决策表

| locator state | op phase | kind | Space/Session/child 验证 | 决策 |
|---|---|---|---|---|
| （无 locator） | - | - | 两表 schema 完整 | `empty` / clean |
| active | completed | any | matching Session 存在且非 ended | `active_consistent` / clean |
| active | completed | any | Session 缺失 → `session_missing`；Session ended → `session_unexpected_terminal` | recovery_required |
| active | completed | any | lease 过期 | `lease_expired` |
| active | 其他 | any | - | `state_phase_inconsistent` |
| claiming | claimed | start/pause/resume/update_note/set_current_plan_item/set_completion_draft/add_plan_item/remove_plan_item/heartbeat | 原始 child(envelope==operation_id) terminal-success + Session 非 ended | `recoverable_claiming` / clean |
| claiming | claimed | end | 原始 child terminal-success + Session ended | `recoverable_releasing` / clean |
| claiming | claimed | end/其它 | child missing→`child_missing`；unknown→`child_unknown`；pending→`child_pending`；rejected→`child_rejected`；Session 不匹配→`session_*` | recovery_required |
| claiming | claimed | activate_provisional + pair+children 对象声明 | candidate/active children 均 terminal-success 且 envelope.payload_hash == 声明 hash | `awaiting_resolution` / clean |
| claiming | claimed | takeover（无 children 声明） | - | `unproven_combination` |
| claiming | awaiting_resolution | activate_provisional | pair 有效、locator 锚定 active、两 Session ownership_state=activation_conflict；candidate/active child 均存在 envelope+receipt 且 terminal-success（failed/conflict/unknown/pending/missing receipt/missing envelope → 对应 `child_*` code） | `awaiting_resolution` / clean |
| claiming | transferred | resolve_activation_conflict | winner/loser children 均 terminal-success 且 envelope.payload_hash == 声明 hash；按 winner_role 选择 winner（active→pair.active_*，candidate→pair.candidate_*）；winner Session 存在、非 ended、ownership=authoritative；loser Session 存在、ended、validity=invalid + reason=activation_conflict_loser | `recoverable_claiming` / clean |
| claiming | rejected/prepared | any | - | `unproven_combination` |
| releasing | space_committed | end | matching Session ended | `recoverable_releasing` / clean |
| releasing | space_committed | end | Session 非 ended | `session_unexpected_nonterminal` |
| 任意 | manual_intervention | any | - | `manual_intervention` |
| 任意 | 非法组合 | - | - | `state_phase_inconsistent` / `unproven_combination` |

## 6. 每个 damage case 的测试

`backend/tests/test_recovery_authority.py`（68 测试：42 初始 + 26 第二轮审查修复；真实 SQLite + 真实只读 ORM 路径）：

- empty：`test_empty_clean`
- active completed：`test_active_completed_matching_nonterminal_session` / ended / missing session
- claiming claimed：`test_claiming_claimed_start_child_success_recoverable` / end ended / conflict children all success
- claiming awaiting_resolution：`test_claiming_awaiting_resolution_valid_pair`
- releasing space_committed：`test_releasing_space_committed_ended_recoverable` / nonterminal
- transferred resolution：`test_claiming_transferred_resolution_children_success`
- missing operation：`test_missing_operation_fails_closed`
- intent hash mismatch：`test_intent_hash_mismatch_fails_closed`
- malformed intent：`test_malformed_intent_json_fails_closed`
- unknown child：`test_unknown_child_fails_closed`；pending：`test_pending_child_fails_closed`
- terminal-rejected child：`test_terminal_rejected_child_fails_closed`
- missing child envelope：`test_missing_child_envelope_fails_closed`
- child Space mismatch / Session mismatch：`test_child_space_mismatch_fails_closed` / `test_child_session_mismatch_fails_closed`
- bad pair：`test_conflict_bad_pair_fails_closed`；pair missing：`test_conflict_pair_missing_fails_closed`
- conflict child not all success：`test_conflict_child_not_all_success_fails_closed`
- takeover 无 children 声明：`test_takeover_claim_without_children_declaration_fails_closed`
- active expired：`test_active_lease_expired_fails_closed`
- duplicate/conflicting child：`test_duplicate_conflicting_child_fails_closed`
- cycle/self-reference：`test_relation_self_cycle_fails_closed`；missing related：`test_missing_related_operation_fails_closed`
- malformed timestamp：`test_malformed_locator_timestamp_fails_closed`
- malformed descriptor：`test_malformed_descriptor_fails_closed`
- schema/column missing：`test_missing_locator_table_fails_closed` / `test_missing_operation_column_fails_closed`
- multiple locators：`test_multiple_locators_fails_closed`
- state/phase 不一致：`test_state_phase_inconsistent_fails_closed`
- manual intervention：`test_manual_intervention_fails_closed`
- invalid locator epoch：`test_invalid_locator_epoch_fails_closed`
- space view missing：`test_active_without_space_view_fails_closed`
- resolution rejected child：`test_resolution_rejected_child_fails_closed`
- read-only enforcement：`test_read_only_enforcement`
- deterministic serialization：`test_decision_serialization_is_deterministic`
- 连接不泄漏：`test_no_connection_leak`
- FocusSessionQuery 复制品只读构造：`test_focus_session_query_loads_from_readonly_copy`

每个损坏场景断言：classification=`recovery_required`、result=`not_clean`、无未处理异常。

### 6a. 第二轮审查修复的新增测试（26 个）

- awaiting_resolution child outcome 矩阵：`test_awaiting_resolution_child_outcome_fails_closed`（参数化 failed/conflict/unknown/pending 6 组合 → `child_rejected`/`child_unknown`/`child_pending`）、`test_awaiting_resolution_missing_child_receipt_fails_closed` / `test_awaiting_resolution_missing_child_envelope_fails_closed`（→ `child_missing`）
- transferred winner/loser 矩阵：`test_transferred_candidate_winner_clean` / `test_transferred_active_winner_clean`（正常）；`test_transferred_winner_missing_fails_closed`（`session_missing`）、`test_transferred_winner_ended_fails_closed`（`session_unexpected_terminal`）、`test_transferred_winner_ownership_invalid_fails_closed`（`session_ownership_invalid`）、`test_transferred_loser_not_ended_fails_closed`（`session_unexpected_nonterminal`）、`test_transferred_loser_not_marked_invalid_fails_closed`（`session_invalid_marker_mismatch`）、`test_transferred_loser_missing_fails_closed`（`session_missing`）
- exact child payload identity：`test_original_child_payload_hash_mismatch_fails_closed`（envelope.hash ≠ operation.hash → `child_payload_hash_mismatch`）、`test_named_child_payload_hash_mismatch_fails_closed`（envelope.hash ≠ children 声明 → `child_payload_hash_mismatch`）、`test_string_only_children_declaration_fails_closed`（旧字符串格式 → `children_declaration_invalid`）
- relation chain：`test_relation_single_level_chain_passes` / `test_relation_multi_level_chain_passes`（合法链通过）、`test_relation_chain_does_not_bind_child_to_parent_operation_id`（回归：child.operation_id ≠ parent 时链仍通过）、`test_relation_multi_node_cycle_fails_closed`（`relation_cycle`）、`test_relation_child_space_mismatch_fails_closed` / `test_relation_child_session_mismatch_fails_closed`（`relation_invalid`）、`test_relation_chain_beyond_depth_fails_closed`（`relation_invalid`）

## 7. 所有门禁真实输出（含耗时）

| 门禁 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| 新 authority 测试 | pytest tests/test_recovery_authority.py | 42 passed | 21.84s |
| TS2 focused + migration | pytest test_recovery_authority test_active_session_locator_migration test_task_space_session_migration test_focus_session_contracts test_focus_session_hash_contract | 107 passed, 4 skipped | 78.81s |
| FocusSession query/policy | pytest test_focus_session_policy contract_parity contract_routes module revisions sync_policy effort_projection | 217 passed | 655.77s |
| mutation recovery | pytest test_mutation_recovery journal migration staging | 166 passed, 1 skipped | 514.95s |
| 周边契约 | pytest test_meta_db db_isolation time session_command_reconciliation mutation_virtual_policy | 19 passed | 16.93s |
| Ruff | `.venv/Scripts/ruff.exe check --no-cache app/focus_session tests/test_recovery_authority.py` | All checks passed | - |
| Type checking | 仓库无 mypy/pyright 配置；以 `python -m compileall -q app/focus_session tests/test_recovery_authority.py` 编译门禁 | COMPILEALL OK | - |
| git diff --check | `git diff --check` | DIFF-CHECK OK | - |
| full collect | `pytest --collect-only -q` | 2270 tests collected | 3.71s |
| 第二轮：authority 测试 | `pytest -q backend/tests/test_recovery_authority.py -p no:cacheprovider` | **68 passed** | 48.10s |
| 第二轮：Ruff | `python -m ruff check backend/app/focus_session/recovery_authority.py backend/tests/test_recovery_authority.py` | All checks passed | - |
| 第二轮：compileall | `python -m compileall -q backend/app/focus_session/recovery_authority.py` | OK | - |
| 第二轮：diff check | `git diff --check a26b997..HEAD` | OK | - |
| 第二轮：ActiveSession 迁移回归 | `pytest -q tests/test_active_session_locator_migration.py` | 4 passed | 4.67s |

## 8. git diff --name-only（相对基线 a26b997）

```
backend/app/focus_session/recovery_authority.py
backend/tests/test_recovery_authority.py
docs/superpowers/plans/2026-07-15-task-space-session-ts2-authority-investigation.md
```

## 9. git status --short

```
?? backend/fix_editable.py   （上一轮遗留，禁止删除，未提交）
```

## 10. 剩余 contract gap（全部 fail closed，不影响注入）

1. `intent_json` closed schema 无 TS2 生产实现（S5 侧 `_make_intent` 假定形态与本 authority 定义兼容但不一致；本 authority 定义 identity 键 + `pair`/`children` 声明并文档化）。
2. `related_operation_id` 语义无权威实现（`meta.py:102` 仅建列；S5 假定 parent→child 链；本 authority 仅做结构校验：存在性、acyclic、Space/Session 一致、深度 ≤8，不解读语义）。
3. conflict/resolution child 的 exact payload hash 必须由 intent `children` 对象声明提供（`{"operation_id": ..., "payload_hash": ...}`）；字符串格式声明无法证明 payload identity → `children_declaration_invalid`（第二轮收紧；authority 不发明 hash）。
4. `ActiveSessionCoordinator` 无生产写方（`contracts.py:175-180` 仅 Protocol）。
5. `transferred` phase 仅 `resolve_activation_conflict` 上下文有定义（计划 L3047/L308-314）；winner 非 ended + ownership=authoritative、loser ended + invalid(activation_conflict_loser) 为权威 resolution 后状态；S5 `_STATE_PHASE_RULES`（`s5-next/backend/app/recovery/coordinator.py:100-104`）未包含它——S5 注入本 authority 后以本 authority 为准。
6. `claiming + rejected` 恢复动作在计划 L3041-3042 有定义，但不在本 authority 受支持证明集合内 → fail closed（决策表 L3036-3054 的 rejected 分支留给 S5 协调恢复实现，本 authority 不替代 TS2 状态机）。
7. **S5 集成前置**：S5 必须构造 live/copied `space_views` 映射并通过 `inspect_read_only(meta_view, space_views=...)` 注入（见第 5a 节），当前 S5 coordinator 需改造，不能零改动注入。
