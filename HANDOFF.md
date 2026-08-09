# TS2 ActiveSession child-ID production contract — 交回报告

最终状态：**READY FOR S5 INTEGRATION PATCH**
（本分支累计：master-scoped runtime opener、真实 HTTP 精确 2xx、start 真实 UoW 数据链、
conflict-loser end policy、ABORTED journal 结构化判定、resolve/restart 真实 UoW 闭环、
authority 端到端 parity。全部门禁绿；剩余验证项见第 10 节）

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

## 0. 第 4 轮调查决策表（实现前锁定，来源：plan L3036-3054/L3401-3437 + meta.py + recovery_authority.py）

| 维度 | 值 |
|---|---|
| parent conflict operation | `activate_provisional`，phase=`awaiting_resolution`，locator 锚定 `claiming`（target=active side, epoch=E） |
| resolution operation | `resolve_activation_conflict`，phase=`claimed`（prepared），related_operation_id=conflict op id；locator.operation_id 保持指向 conflict op |
| locator operation | state=`claiming`，operation_id=conflict op id，space/session=active side，epoch=E |
| winner child | id=`derive(resolution_op, WINNER)`，action=`focus_session.resolve_activation_conflict`；pre: Session `activation_conflict`+未 ended；post: ownership=`authoritative`、non-ended、validity 保留 |
| loser child | id=`derive(resolution_op, LOSER)`，action=`focus_session.resolve_conflict_loser`（新增，普通 end 不放宽）；pre: Session `activation_conflict`+未 ended；post: ended_at=validated decision time、timer_completion=`interrupted`、validity=`invalid`、validity_reason=`activation_conflict_loser`、ownership=非冲突（`authoritative`，与普通 ended Session 一致，authority 只查 ended+invalid marker） |
| expected Meta phase | resolution op `claimed`→（双 child 真实 receipt terminal-success）→`transferred`；conflict op 保留；locator 保持 `claiming` |
| expected Space Session | winner: `activation_conflict`→`authoritative`（non-ended）；loser: `activation_conflict`→ended/invalid（interrupted），gross/focused/paused/break 秒按真实时钟重算，version+1 |
| receipt/journal outcome | 双 child receipt=`succeeded`；journal `FINALIZED`+applied（operation.error_code=None） |
| 允许恢复动作 | receipt missing→query journal（结构化 OriginalChildOutcome）；`ABORTED` 绝不视为成功→recovery_required（除非有确定 rejected evidence）；unknown→query-original→仍 unknown→recovery_required；terminal-rejected→fail closed 不重放 |

child 身份验证（policy 侧，仅注入 locator_reader + derive contract）：
request.operation_id == derive(payload.resolution_operation_id, role)；locator.state==claiming 且
locator.operation_id==payload.related_operation_id（conflict op 锚定）且 space/session/epoch 匹配；
Session ownership_state==activation_conflict 且未 ended。persisted intent 的 pair/role/children 验证
由 coordinator（Meta 侧）与 recovery_authority（parity）完成。


## 9. 第 4 轮（conflict-loser / journal / resolve / restart / parity）完成记录

基线 `9fd818c` → 4 个提交：
1. `feat(focus-session): authorize deterministic conflict loser end`
2. `fix(focus-session): classify durable child journal outcomes`
3. `test(focus-session): cover resolution restart through real uow`
4. `docs(recovery): update verified resolution handoff`

### 9.1 conflict-loser policy（`focus_session.resolve_conflict_loser`，普通 end 不放宽）
- 新 action 只接受服务端 deterministic loser child：`request.operation_id ==
  derive_active_session_child_operation_id(payload.resolution_operation_id, LOSER)`；
- Meta locator：state=`claiming`、operation_id == resolution_operation_id（resolve 首步 CAS，
  plan L3046）、space/session == pair[active]（anchor）、epoch 匹配；
- persisted pair（active/candidate）+ winner_role ∈ {active, candidate} 校验；target Session 必须
  是 pair 的 loser 侧、`activation_conflict`、未 ended；
- 强制 post-image：ended_at=decision time、timer_completion=`interrupted`、validity=`invalid`、
  validity_reason=`activation_conflict_loser`、ownership 非冲突终态；clock invariants
  （ended_at>=started_at、gross/focused/paused 重算、version+1、sync event）；
- 普通 `focus_session.end` 对 `activation_conflict` Session 继续拒绝（`session_activation_conflict`）；
- winner child（`focus_session.resolve_activation_conflict` 严格化）：同 derive/locator/pair 验证，
  post-image ownership=`authoritative`、non-ended、validity 保留。

### 9.2 journal outcome 结构化（ABORTED 绝不成功）
- `OriginalChildOutcome`：NOT_EXECUTED/APPLIED/REJECTED/CONFLICT/UNKNOWN/ABORTED/INCONCLUSIVE；
- 判定读 MutationBatch.state + MutationOperation.error_code + journal；
  ABORTED 仅在存在确定 rejected evidence 时 terminal_rejected，否则 recovery_required；
- envelope/receipt/journal 全矩阵（missing/matching/mismatch × succeeded/failed/conflict/
  pending/unknown/missing × applied/rejected/conflict/aborted/inconclusive）；
  receipt succeeded 与 rejected/aborted journal 冲突 → evidence mismatch → recovery_required；
  envelope 永不重复 INSERT；仅 proven NOT_EXECUTED 才执行。

### 9.3 resolve 真实 UoW 闭环 + restart + 安全反例
- active winner / candidate winner：winner→authoritative、loser→ended/invalid、双 receipt
  succeeded、resolution op CAS claimed→transferred、authority 读回 recoverable（parity）；
- winner 成功 + loser 被拒：phase 保持 claimed、winner receipt 保留、authority recovery_required；
- winner 被拒：loser 不执行；child ID/hash mismatch：policy 拒绝、无 mutation、无 Meta 推进；
- restart：新 coordinator 复用原 winner/loser deterministic IDs、winner 不重复执行
  （ALREADY_SUCCEEDED）、loser provably NOT_EXECUTED 时执行一次、无重复 envelope、
  双 success 后 CAS transferred；ABORTED journal 重启后不视为成功（recovery_required）；
- 安全反例矩阵（真实 policy 编译，稳定错误码，无 Space mutation / Meta 推进 / 身份泄漏）：
  普通 end conflict Session、伪造 winner_role、wrong parent / wrong pair / wrong epoch /
  wrong Space / wrong Session / wrong hash / locator 非 claiming / Session ended /
  Session 非 conflict —— 全部拒绝。

### 9.4 authority 端到端 parity（只经 inspect_read_only）
coordinator 真实写出的 Meta/Space 数据：active/candidate winner transferred → recoverable_claiming；
loser rejected / ABORTED journal → recovery_required。

### 9.5 关键架构修正
resolve 首步 Meta 事务把 locator CAS 到 resolution operation（operation_id + epoch+1，
plan L3046），children 在 transferred claim 下执行；restart 复用 resolution 行（幂等）。

## 10. 门禁真实结果与剩余验证项

| 门禁 | 结果 |
|---|---|
| focused（policy 49 + coordinator 19 + uow_integration/recovery_authority/child_operations 92） | 全绿 |
| HTTP 防回归（http_integration 7 + routes 6 + mounting + handle_lifecycle 19） | 全绿 |
| 回归（locator_migration+contracts+hash 59+2sk / mutation_recovery 54） | 全绿 |
| Ruff（focus_session + 4 测试文件） | All checks passed |
| compileall（focus_session） | OK |
| OpenAPI（test_openapi_contract.py） | 44 passed |
| collect-only | 2358 tests collected（不视为全量通过） |
| git diff --check / status | OK / 干净 |

剩余验证项（权威环境复核）：
- resolve 的成功 HTTP 端到端（routes 未暴露 resolve 成功用例；HTTP 层仅 start/locate/duplicate 覆盖）；
- 双 Space conflict 的完整 HTTP 双 handle 流程（handle_lifecycle 已覆盖 provider 层）。
