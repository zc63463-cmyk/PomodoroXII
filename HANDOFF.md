# TS2 ActiveSession child-ID production contract — 交回报告

最终状态：**READY FOR S5 INTEGRATION PATCH**
（第 10 节记录本分支生产 REST / 路由挂载 / 聚合响应 / 跨 Space handle / durable receipt 全部完成；
剩余为权威环境复核项：start 的 project/work_item 数据链与 resolve 真实 UoW 矩阵、HTTP-runtime 层）

## 1. 真实基线、提交与 HEAD

- 基线：`a409ec9415d6e70c07a29488e52730e69379366d`（`codex/ts2-active-session-authority` HEAD，独立 worktree 起点）
- 分支：`codex/ts2-active-session-child-contract`；worktree：`E:\DevTemp\pomodoroxii-boundaries\ts2-child-contract-wt`
- 本分支提交（按时间序）：
  - `9563659` docs(recovery): investigate active session child identity contract
  - `1d800fa` feat(focus-session): define deterministic active session child ids
  - `6b516ff` feat(focus-session): persist conflict recovery child intent
  - `0315a28` fix(recovery): verify production active session child identity
- 本分支提交（续，生产 REST / routing / UoW 轮次）：
  - `6b46b6b` fix(focus-session): mount active session production routes
  - `7ed6f8c` fix(focus-session): complete activate pair and aggregate response contract
  - `52c83ae` fix(focus-session): require durable child receipts and close multi-space handles
  - `bcdbf88` test(focus-session): cover production HTTP, real UoW and authority parity
- 最终 HEAD（`git rev-parse HEAD`）：`bcdbf88973bdc00fb52bd6d223800ad09b2eb945`

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

focused 门禁真实输出：**119 passed**（child_operations 19 + coordinator 8 + authority 71 +
routes 10 + mounting 5 + uow_integration 2 + handle_lifecycle 4，104.30s）。

## 7. 门禁真实输出

| 门禁 | 结果 | 耗时 |
|---|---|---|
| focused（child_operations + coordinator + authority + routes + mounting + uow_integration + handle_lifecycle） | **119 passed** | 104.30s |
| Ruff（app/focus_session + app/routes/v1 + 6 测试文件） | **All checks passed!** | - |
| compileall（app/focus_session + app/routes/v1） | **OK** | - |
| OpenAPI（test_openapi_contract.py） | **44 passed** | 52.42s |
| pytest --collect-only backend/tests | **2347 tests collected** | 3.81s |
| git diff --check | **OK** | - |
| 回归组 | **migration 4 passed**（4.79s）/ **mutation_recovery 54 passed**（292.26s）/ **contracts+hash+policy 104 passed, 2 skipped**（51.56s） | - |

## 8. 剩余 contract gaps / 复核项（fail closed）

1. **start 的 Space 数据链**：coordinator.start 经真实 UoW 创建 Session 需要 Space 中已存在
   project + work_item（policy `_compile_start` 要求），本分支集成测试覆盖
   activate_provisional（mark_activation_conflict 仅需 Session row）；start 的 project/work_item
   预置数据链需权威环境复核。
2. **resolve 真实 UoW 矩阵**：resolve（winner=resolve_activation_conflict / loser=end）的真实
   UoW 执行路径与 activate 共用 `_execute_children`（envelope→mutation→receipt），但未在
   轻量 UoW 集成测试中独立覆盖（loser=end 的 policy 校验链需权威环境复核）。
3. **HTTP-runtime 层**：真实 `create_app()` + lifespan（bootstrap_runtime）在本 sandbox 环境
   VFS 性能退化下不可行（25min 未完成）；HTTP 层经真实 runtime 的 201/conflict 响应由权威
   环境复核。REST 层（手工挂载 + coordinator 直测 + OpenAPI/mounting/auth）已全绿。
4. `related_operation_id` 写入语义仅 resolve 场景（指向 locator 的 root operation）。

## 9. S5 边界确认

- S5 worktree（`E:\DevTemp\pomodoroxii-boundaries\s5-next`）**未修改**（`git status` 不变）。
- 未进入 S5 Task 2；未修改 integration 分支；`backend/app/recovery/**` 未触碰。
- S5 集成仍需单独 patch：构造 copied/live `space_views` 并经
  `inspect_read_only(meta_view, space_views=...)` 注入（authority 分支 5a 节）。

## 10. 生产 REST / 路由挂载 / 聚合响应 / durable receipt 轮次（HEAD bcdbf88）

本轮完成（代码位置 + 测试名称）：

- **生产路由挂载**：`routes/v1/__init__.py` `build_v1_router()` 挂载
  `/api/v1/active-session`（14 个端点）；`active_session.py` 删除"生产未挂载"过时文档；
  `create_app().openapi()` 验证 14 路径 + master 允许 / space / anonymous 拒绝。
  测试：`test_active_session_mounting.py`（5 passed）。
- **Activate pair wire schema**：`ActivateProvisionalPayload` 新增不可变
  `ConflictPairIdentity`（active/candidate Space+Session，CommandId 字符集、两侧互异、
  与 request anchor 一致校验）；`_map_activate_payload` 完整传递 pair。
  测试：`test_http_activate_valid_pair_no_longer_422`（200 非 422）/ missing pair /
  identical sides / anchor mismatch / invalid identity（全 422）。
- **聚合响应**：coordinator 注入真实 `FocusSessionQuery`；`start`/`locate`/`pause`/`resume`/
  `takeover`/note/plan/`end`/`resolve` 全部经 `_load_session_aggregate`（真实 query.load，
  不伪造时间戳/默认数据；Session 缺失 fail-closed）；activate 返回真实双 Space aggregate
  （`ActivationConflictResponse`）。修复 `_locator_view` 缺 ownerDeviceId/ownerTabId 的
  wire bug。
- **跨 Space handle 生命周期**：`get_active_session_coordinator` 改为 async generator，
  request 级收集 cross-space handles，finally 全路径 `aclose()`（成功/child 失败/
  CancelledError/provider 异常）；primary 由 `get_space_runtime_handle` 关闭、不重复。
  测试：`test_active_session_handle_lifecycle.py`（4 passed）。
- **durable child receipts**：`_execute_children` 生产分支 = 幂等复用（terminal-success
  receipt 跳过）→ `_record_child_envelope`（真实 Session context work item，缺失
  fail-closed）→ 真实 `uow.execute`（mutation）→ `_record_child_receipt`
  （record_receipt mutation，payload command_id 保留为 child_id）→ 校验 receipt
  terminal-success 才推进 phase。`child_executor` 仅 TEST-ONLY（必须返回 receipt state）。
- **真实 UoW 集成**：`test_active_session_uow_integration.py`（2 passed）——真实
  MutationUnitOfWork（CATALOG/compiler/interpreter/journal/recovery + 真实 SQLite Space）：
  activate children 真实落 envelope/mutation/receipt → awaiting_resolution →
  authority `inspect_read_only` 读回 **awaiting_resolution GREEN**（parity）；candidate
  Session 缺失 → 真实 policy 拒绝 → phase 保持 claimed。
- **Authority parity**：`test_authority_reads_coordinator_written_intent`——coordinator 写
  intent + 真实 SQLite child 证据 → 完整 `inspect_read_only` 入口读回 awaiting_resolution。
  同时修复 payload_hash 契约：coordinator 落库 hash 改为 authority 可重算的
  `_contract_payload_hash`（业务子集，排除 pair/children）。

### 本轮边界

- S5 worktree（`E:/DevTemp/pomodoroxii-boundaries/s5-next`）**未修改**；未进入 S5 Task 2；
  未修改 integration 分支；`backend/app/recovery/**` 未触碰（authority 共享 contract 导入
  仅限本分支 `recovery_authority.py`）。
- 最终状态：**READY FOR S5 INTEGRATION PATCH**（权威环境复核项见第 8 节）。
