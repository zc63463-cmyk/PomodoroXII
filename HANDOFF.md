# TS2 ActiveSession child-ID production contract — 交回报告

最终状态：**BLOCKED BY MISSING CONFLICT LOSER END CONTRACT**
（第 10 节记录本轮完成：master-scoped runtime opener、真实 HTTP 精确 2xx、start 真实 UoW 数据链、
envelope/receipt 决策表、cleanup fail-open 修复、child executor 旁路移除；
BLOCKED 原因：resolve 的 loser child（end）在真实 policy
`_compile_clock_transition._require_locator_claim` 被拒 —— child operation_id ≠ locator
operation_id，且 `_reject_activation_conflict` 拒绝 conflict Session 的 end；
policy.py 不在本任务允许修改列表，transferred 成功矩阵无法达成）

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
- 本分支提交（续，master-scoped / 真实 HTTP / resolve UoW 轮次）：见第 10 节提交列表
- 最终 HEAD（`git rev-parse HEAD`）：见交回报告（提交后由 `git rev-parse HEAD` 提供，文档不声称包含自身 SHA）

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

## 10. master-scoped / 真实 HTTP / resolve UoW 轮次

### 完成

- **master/space token 互斥解除（P0）**：`get_active_session_coordinator` 移除
  `Depends(get_space_runtime_handle)`，改为 `Depends(require_master_token)` +
  `get_mutation_uow`；provider 不再要求 space token（代码证据：
  `contract_dependencies.get_active_session_coordinator` 依赖树无
  `get_space_context`）。Space identity 由 coordinator 从 payload / Meta locator /
  persisted pair 解析。
- **master-authorized internal Space opener**：request 级单一 global lease
  （`runtime.leases.acquire_global(SHARED, "active-session", 5)`）+ 每 Space
  `AuthorizedSpaceScope.resolve(principal, space_id, "write")`（Meta registry 注册/
  删除/路径 containment 校验，不拼接路径）+ `runtime.open_resolved(..., owns_global_lease=False)`；
  同 Space 复用 handle；多 Space 稳定 ID 顺序；finally 先关 handle 再释放 global lease（LAST）。
  修复 `asyncio.shield` 造成 lease Task 归属错误 + 重复 acquire_global 的 lease-order 违约。
- **真实 HTTP 精确 2xx**（`test_active_session_http_integration.py` 7 passed，无 provider
  override、真实 lifespan/bootstrap、真实 UoW）：
  master start **201**（含 session aggregate，字段来自真实 Space DB）/ locate **200** /
  空库 locate **404** / space token **403** / anonymous **403** / 未注册 Space **404**
  （规范 AppError）/ duplicate 同 command+hash **201 幂等重放**。
- **start 真实 UoW 数据链**：真实 API 创建 Space → project → depth-1 root work item →
  depth-2 level2 work item → master start → coordinator 经真实
  `MutationUnitOfWork.execute` 创建 FocusSession（policy `_compile_start` 校验
  project/work_item 树）+ Meta claiming intent 正确时机持久化 + 返回真实
  `FocusSessionQuery` aggregate。start 幂等重放（同 command_id + 同 payload_hash 返回
  原状态；不同 hash 稳定冲突）。
- **activate pair 矩阵**（`test_active_session_routes.py` 6 passed，真实 provider）：
  合法 pair **200**（ActivationConflictResponse，真实双 Space aggregate）/ 缺 pair /
  相同两侧 / anchor mismatch / 非法 identity 全 **422**；Idempotency-Key mismatch 4xx。
- **envelope/receipt 决策表**：`ChildExecutionDecision`（execute / already_succeeded /
  terminal_rejected / original_unknown / recovery_required）；执行前查 envelope+receipt：
  envelope 缺失插一次 / 已存在校验 identity+hash+replay+target（mismatch 稳定冲突，
  绝不重复 INSERT）；receipt succeeded 跳过 / failed|conflict|abandoned fail closed /
  pending|unknown|missing 先 `_query_child_original`（mutation journal terminal batch）
  再决定，仍 unknown → recovery_required；receipt 只基于真实 UoW outcome（rejected →
  failed/conflict receipt；CancelledError/其它 → unknown receipt）。
- **coordinator 全部 handle 访问包 mutation lease**（真实 runtime 的 engine 仅在 lease 内
  激活）；`_execute_children` 每 child 一个 mutation lease（UoW 复用同 lease）。
- **cleanup fail-open 修复**：`_close_opened_handles` 尝试关闭全部 handle（一个失败不阻断
  其它）、收集 failures、无主异常（含 GeneratorExit/aclose）时传播稳定
  `ActiveSessionCoordinationError`、有业务异常时保留主异常并记录 log。
- **child executor 旁路移除（方案 A）**：`ProductionActiveSessionCoordinator.__init__`
  不再接受任何 child callback；coordinator 测试全部改用真实 MutationUnitOfWork。
- **authority parity**：`test_authority_reads_coordinator_written_intent`（真实 UoW 证据 →
  `inspect_read_only` 读回 awaiting_resolution GREEN）+ uow_integration 2 测试同。

### BLOCKED 项（resolve 成功矩阵）

- **`test_resolve_activation_conflict_freezes_winner_loser`（coordinator 测试，真实 UoW）**：
  winner child（resolve_activation_conflict）真实成功（receipt succeeded）；**loser child
  （end）被真实 policy 拒绝**：`_compile_clock_transition` 首行
  `_require_locator_claim(context, request, require_owner=True)` 要求 child operation_id
  == locator.operation_id（child 是确定性派生 ID，恒不匹配）→ `stale_session_owner`；
  且 `_reject_activation_conflict` 拒绝 conflict Session 的 end。Meta phase 保持
  `claimed`（不 transferred）。**policy.py 不在本任务允许修改列表** —— loser 终结需要
  policy 新增 conflict-loser end 语义（豁免 locator claim / 允许 conflict→ended），
  属 S5 integration patch 或后续轮次。

### 门禁真实输出

- focused 八件套：**119 passed**（373.94s）
- 回归：migration+contracts+hash **59 passed + 2 skipped**（30.90s）/
  policy **49 passed**（单跑 83.61s；批量时 1 个 setup 迁移文件锁竞态，环境性）/
  mutation_recovery **53 passed**
- Ruff（focus_session + routes/v1 + deps.py + 7 测试文件）：**All checks passed!**
- compileall（focus_session + routes/v1 + deps.py）：**OK**
- OpenAPI（test_openapi_contract.py）：**44 passed**
- collect-only：**2347 tests collected**
- git diff --check：**OK**
- S5 worktree 未修改；未进入 S5 Task 2；`backend/fix_editable.py` 保留未提交。
