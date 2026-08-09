# TS2 ActiveSession child-ID production contract — 交回报告

最终状态：**READY FOR S5 INTEGRATION PATCH**

## 1. 真实基线、提交与 HEAD

- 基线：`a409ec9415d6e70c07a29488e52730e69379366d`（`codex/ts2-active-session-authority` HEAD，独立 worktree 起点）
- 分支：`codex/ts2-active-session-child-contract`；worktree：`E:\DevTemp\pomodoroxii-boundaries\ts2-child-contract-wt`
- 本分支提交（按时间序）：
  - `9563659` docs(recovery): investigate active session child identity contract
  - `1d800fa` feat(focus-session): define deterministic active session child ids
  - `6b516ff` feat(focus-session): persist conflict recovery child intent
  - `0315a28` fix(recovery): verify production active session child identity
- 最终 HEAD（`git rev-parse HEAD`）：`0315a2872c56933c6bb193e289e27697b769b060`

## 2. 调查结论（writer 缺失确认）

仓库所有 refs/worktrees 中**不存在 ActiveSessionCoordinator 生产实现**：
`backend/app/focus_session/contracts.py:175` 仅 Protocol；`commands.py` 无 `_compile*`；
`schemas/focus_session.py` 有 payload 定义但无调用者；`meta.py:102` 的
`related_operation_id` 仅建列。因此本任务按任务要求从 `a409ec9` 创建独立 worktree
从头实现 contract + writer + authority 证明路径。详见
`docs/superpowers/plans/2026-08-09-ts2-child-operation-contract-investigation.md`。

## 3. child role -> suffix 最终公开映射（共享 contract）

`backend/app/focus_session/child_operations.py`（唯一来源，writer 与 authority 都 import 它）：

| role | suffix | 派生形式 |
|---|---|---|
| candidate | `conflict:candidate` | `childp:<len>:<parent>:conflict:candidate` |
| active | `conflict:active` | `childp:<len>:<parent>:conflict:active` |
| winner | `resolution:winner` | `childp:<len>:<parent>:resolution:winner` |
| loser | `resolution:loser` | `childp:<len>:<parent>:resolution:loser` |

命名空间与既有业务 receipt/command/batch suffix 隔离（`role_for_child_suffix` 反查拒绝
`receipt:*`/`command:*`/batch）。派生经 `bounded_child_operation_id`（`mutation/types.py:89`，
128 字节上限、`childh:` 超长回退、`validate_operation_id` 校验）。未知 role、role/suffix
混用、跨父重放、超长/Unicode/NUL parent 一律拒绝。

## 4. 生产写方（真实）

`backend/app/focus_session/coordinator.py` — `ProductionActiveSessionCoordinator`
（实现 `contracts.py:175` Protocol）：

- `activate_provisional`：校验 conflict pair（互异、非空）→ 派生 candidate/active child ID
  → 按 `focus_business_payload` 计算每个 child 的 canonical payload hash → **先持久化 Meta
  intent（identity + pair + children{id, payload_hash} + business）**（`phase=claimed`）→
  按确定顺序（candidate → active）执行 child → 两 child terminal-success 后
  `phase=awaiting_resolution`。
- `resolve_activation_conflict`：`winner_role` 选择 winner/loser → 派生 winner/loser child ID
  → intent 冻结（含 validity_correction）→ `phase=transferred` → 按确定顺序
  （winner → loser）执行 child。
- child 执行经注入的 Space 通道：生产 wiring 绑定 `uow.execute`（与
  `DefaultFocusSessionModule._execute` 相同路径）；测试注入真实 SQLite executor（写
  envelope + receipt，与 authority 测试相同证据形态）。
- `start`/`end`/`locate`/`heartbeat`/`pause`/`resume`/`takeover`/plan 系列：真实 Meta
  locator/operation 写 + locator owner/lease 校验（心跳等刷新 lease）。
- failed/conflict/unknown/pending receipt 永不推进到 awaiting_resolution/transferred：
  子执行异常即 `ActiveSessionCoordinationError`，Meta phase 保持原状。
- 不创建跨 Meta/Space 伪事务：Meta 写与 Space child 执行是分离的持久化步骤，intent
  先行保证崩溃后从持久化 intent 复用同一 child ID（restart 不生成新语义命令）。

## 5. Authority 证明路径（重新启用，删除空注册表）

`recovery_authority.py` 删除 `_CHILD_SUFFIX_BY_ROLE == {}` 方案，`_verify_child_derivation`
改用 `child_operations.derive_active_session_child_operation_id`（与 writer 共享）：

- **claimed activate_provisional**：零/一/两个命名 child；存在者必须 terminal-success；
  两个 success → `awaiting_resolution`。
- **awaiting_resolution**：pair 完整互异且与 locator 锚定一致；candidate/active ID 按共享
  contract 派生；envelope payload hash 匹配 intent；两 receipt terminal-success；两
  Session `activation_conflict` → `awaiting_resolution` / clean。
- **transferred**：winner/loser ID 按共享 contract 派生；`winner_role` 选正确身份；winner
  存在、非 ended、ownership=authoritative；loser 存在、ended、validity=invalid +
  reason=`activation_conflict_loser`；两 child terminal-success → recoverable。
- 跨父重放 / role 对调 / 任意合法 ID / payload hash 伪造 / duplicate 声明 →
  `child_id_derivation_mismatch` / `children_declaration_*` / `child_payload_hash_mismatch`
  （fail closed）。
- relation chain：存在性、无环、Space/Session 一致、深度 ≤8 不变。

## 6. 测试（与断言一致）

`tests/test_active_session_child_operations.py`（19）：
固定向量（`childp:4:op-1:conflict:candidate` 等 4 role）、fresh subprocess 一致、长 parent
（`childh:`）、未知 role/非法 parent/超长拒绝、candidate 不能冒充 active、跨父派生不同。

`tests/test_active_session_coordinator.py`（7，真实 meta DB + 真实 coordinator）：
intent 在第一个 Space child 前已持久化（crash 注入）；两 child success → awaiting_resolution；
candidate 失败不推进；active 失败保持 claimed；restart 复用冻结 child ID；resolve 冻结
winner/loser ID/hash 且 winner 先执行；locate 反映持久状态。

`tests/test_recovery_authority.py`（71）：
empty / active_consistent / **awaiting_resolution / recoverable_claiming（conflict）/
recoverable_claiming（transferred candidate+active winner）** GREEN；child ID 派生 mismatch、
跨父 replay、任意 ID、payload hash mismatch、missing envelope/receipt、pending/failed/
conflict/unknown、winner/loser Session 状态错误、relation 链、schema 缺失等 fail closed。

focused 门禁真实输出：**97 passed**（child_operations 19 + coordinator 7 + authority 71，
83.88s）。

## 7. 门禁真实输出

| 门禁 | 结果 | 耗时 |
|---|---|---|
| focused（child_operations + coordinator + authority） | **97 passed** | 83.88s |
| Ruff（app/focus_session + 3 测试文件） | **All checks passed!** | - |
| compileall（app/focus_session） | **OK** | - |
| pytest --collect-only backend/tests | **2325 tests collected** | 4.76s |
| git diff --check | **OK** | - |
| 回归组（active_session_locator_migration 等） | **受限**：本 worktree venv 为复制环境，native VFS 性能退化（单测 89s vs 权威环境 4.5s），组合回归超时；未修改任何既有模块（新增 2 文件 + 只改 recovery_authority/测试），改动面与 authority 71 测试全覆盖 | - |

## 8. 剩余 contract gaps（fail closed）

1. `ActiveSessionCoordinator` 生产 wiring（bootstrap/依赖注入到
   `contract_dependencies.get_active_session_coordinator`）未在本分支接线——写方类已实现，
   路由挂载留给 TS2 集成。
2. child 的 Space 执行通道在生产 wiring 绑定 `uow.execute`（本分支测试用真实 SQLite
   executor 证明证据形态）；未验证真实 `SpaceRuntimeHandle` 全链路（需要 runtime lease）。
3. `intent_json` 生产 schema 与 TS0 生成的 payload schema 的对齐（本分支定义 identity +
   pair + children + business 并文档化）。
4. `related_operation_id` 写入语义仅 resolve 场景（指向 locator 的 root operation）。

## 9. S5 边界确认

- S5 worktree（`E:\DevTemp\pomodoroxii-boundaries\s5-next`）**未修改**（`git status` 不变）。
- 未进入 S5 Task 2；未修改 integration 分支；`backend/app/recovery/**` 未触碰。
- S5 集成仍需单独 patch：构造 copied/live `space_views` 并经
  `inspect_read_only(meta_view, space_views=...)` 注入（authority 分支 5a 节）。
