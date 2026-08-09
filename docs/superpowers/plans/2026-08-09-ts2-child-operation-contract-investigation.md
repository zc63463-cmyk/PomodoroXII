# TS2 ActiveSession child-ID production contract — 调查文档

日期：2026-08-09
执行模型：deepseek-v4-flash（BC-DeepSeek-V4-Flash）
仓库：PomodoroXII（worktree 化开发）
调查基线：`a409ec9415d6e70c07a29488e52730e69379366d`（`codex/ts2-active-session-authority` HEAD）

## 结论（TL;DR）

**当前仓库不存在任何 ActiveSessionCoordinator 生产实现（writer 完全缺失）。** 唯一相关工件是
`backend/app/focus_session/contracts.py` 中的 `ActiveSessionCoordinator` **Protocol**（L175-205+）与
`backend/app/schemas/focus_session.py` 中 TS0 生成的 payload schema（无调用者）。按任务要求，从
`a409ec9` 创建独立 worktree 从头实现 contract + writer + authority 证明路径。

## 1. worktree 与分支调查（`git worktree list` / `git branch --all`）

所有相关 worktree 均为同一 PomodoroXII 仓库的检出：

| worktree | HEAD | 分支 | 与 TS2 ActiveSession 的关系 |
|---|---|---|---|
| `E:/Development/MyAwesomeApp/PomodoroXII` | cc3a3d4 | main | 主仓库 |
| `.../.worktrees/task3-ts2-envelopes` | d21a37b | codex/backend-95-ts2-task3 | TS2 Task 3（envelope/receipt/effort），**无 coordinator** |
| `.../.worktrees/task3-ts2-envelopes-repair` | 64a9e90 | codex/backend-95-ts2-task3-repair | 同上修复 |
| `.../.worktrees/task12-ts0-contracts*` | ad569d1 | codex/backend-95-ts0-* | TS0 contract（无 ActiveSession writer） |
| `E:/DevTemp/pomodoroxii-boundaries/ts2` | ea52de9 | detached | 早期 TS2 工作树，无 coordinator.py |
| `E:/DevTemp/pomodoroxii-boundaries/ts2-authority-wt` | a409ec9 | codex/ts2-active-session-authority | 本轮 authority（fail-closed，无 writer） |
| `E:/DevTemp/pomodoroxii-boundaries/s5-next` | cc6d644 | codex/s5-next | S5（禁止修改） |

`git log --all --oneline --decorate -- backend/app/focus_session`（节选，全部提交）：
`e2b58c4d`（freeze task space and focus session contracts）→ `3cd43677` → `e8cef186` → `09e2161a`
（persist fenced focus lifecycle）→ `4710d566` → `7e922a71` → `ad569d1e`（reject terminal
provisional activation）→ `d21a37b9`（append review and materialize effort）→ `4f8d396d` →
`871211df` → `64a9e900` → `82c501ef` → `f0fcfd9a` → `cdd5641d`（add TS2 active-session recovery
authority contract）→ `89ba1e5e` → `dfcee091`（enforce deterministic child operation identity）。
**没有任何提交引入 ActiveSessionCoordinator 实现或 focus_session/coordinator.py。**

## 2. 逐项确认（文件:行号）

1. **存在实现 ActiveSessionCoordinator Protocol 的真实生产类？** — 无。`rg -l "class .*ActiveSessionCoordinator"`
   仅命中 `backend/app/focus_session/contracts.py:175`（Protocol 声明，方法 `locate/start/activate_provisional/
   heartbeat/pause/resume/takeover/end/resolve_activation_conflict/...`，全部 `...` 占位）。
2. **存在未合入 a26b997/a409ec9 的 TS2 分支或提交？** — 无。`git log --all` 覆盖所有 refs，`focus_session` 目录下
   （`ls backend/app/focus_session/`：`__init__.py, command_reconciler.py, commands.py, contracts.py,
   effort_projection.py, module.py, policy.py, query.py, receipts.py, recovery_authority.py`）**没有 coordinator.py**。
3. **activate_provisional / resolve_activation_conflict 的 Meta intent 在哪里写入？** — 无处。
   `rg "activate_provisional|resolve_activation_conflict|awaiting_resolution|transferred" backend/app/focus_session
   backend/app/schemas/focus_session.py` 仅命中 `recovery_authority.py`（只读分类）与
   `schemas/focus_session.py`（payload 定义，如 `ActivateProvisionalPayload`/`ResolveActivationConflictPayload`
   winnerRole/validityCorrection，L261/1994-2010/2206-2211，**无调用者**）。
4. **candidate/active/winner/loser child command 在哪里创建？** — 无处。`commands.py` 无任何 `_compile*` 方法
   （`grep "def _compile" backend/app/focus_session/commands.py` 为空）；唯一 `bounded_child_operation_id`
   生产调用是业务 receipt/command/batch（`commands.py:149,154` `receipt:{state}`、`command:{index}`；
   `command_reconciler.py:277`；`unit_of_work.py:1898` batch index），与 ActiveSession role 无关。
5. **child payload hash 在哪里计算并持久化？** — 权威重算方是 `canonical_payload_hash`
   （`backend/app/mutation/types.py:63-68`，RFC 8785 JCS + SHA-256）；ActiveSession child 场景无生产调用者。
6. **related_operation_id 的真实写入方向？** — 无写方。`backend/app/db/models/meta.py:102` 仅建列；
   计划层面 TS2 `ts2-focus-session.md` L31/L1056 规定 child 派生，但无实现。
7. **production coordinator 缺失还是仅未合入？** — **完全缺失**（非"存在未合入"）。

## 3. 决策

按任务要求（"如果所有 Git refs/worktrees 都没有 writer"）：从
`a409ec9415d6e70c07a29488e52730e69379366d` 创建独立 worktree：

```
git worktree add E:/DevTemp/pomodoroxii-boundaries/ts2-child-contract-wt \
  -b codex/ts2-active-session-child-contract a409ec9415d6e70c07a29488e52730e69379366d
```

（已创建，HEAD=`a409ec9`）。开发只在此 worktree；authority worktree 与 S5 worktree 只读。

## 4. 权威依据速查（供实现引用）

- 派生算法：`bounded_child_operation_id(parent_id, suffix)` — `mutation/types.py:89-108`
  （`childp:<len>:<parent>:<suffix>` / 超长 `childh:<sha256>`；suffix 白名单 ASCII `[A-Za-z0-9._:-]`）
- canonical hash：`canonical_payload_hash` — `mutation/types.py:63-68`
- operation_id 校验：`validate_operation_id` — `mutation/types.py:83-86`（printable ASCII 1-128）
- canonical UTC：`schemas/focus_session.py:24-33`
- Protocol：`focus_session/contracts.py:175-205+`
- payload schema：`schemas/focus_session.py`（winnerRole/validityCorrection，L261；L1994-2010）
- 状态机：TS2 计划 `2026-07-15-task-space-session-ts2-focus-session.md` L2545-2557（claiming→active/releasing）
- 恢复决策表：同文档 L3036-3054（L3043-3048 冲突/解决分支）
- resolution 后状态：同文档 L308-314（winner 继续非 ended、loser ended interrupted + invalid
  `activation_conflict_loser`）
- Meta 表：`db/models/meta.py:72-128`（locator/operations CHECK 约束）
- Space child 表：`models/session_command.py:9-50`（envelope.payload_hash CHECK length=64、
  receipt.state CHECK）

## 5. 本任务将新建/修改（在 ts2-child-contract-wt）

- `backend/app/focus_session/child_operations.py`（公开 child-ID contract）
- `backend/app/focus_session/coordinator.py`（真实 ActiveSessionCoordinator 写方，若存在缺失）
- `backend/app/focus_session/contracts.py`（仅必要公开 contract）
- `backend/app/focus_session/__init__.py`
- `backend/app/focus_session/recovery_authority.py`（删除空注册表，用共享 contract）
- tests：`test_active_session_child_operations.py` / `test_active_session_coordinator.py` /
  `test_recovery_authority.py`
- 不改 `backend/app/recovery/**`、S5、integration 分支
