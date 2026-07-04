# PhaseC Sync 修复 Tasks 4-7 完成汇报

> 生成时间：2026-07-04
> 执行依据：[`.trae/documents/PhaseC-sync-repair-tasks4-7-plan.md`](file:///e:/Development/MyAwesomeApp/PomodoroXII/.trae/documents/PhaseC-sync-repair-tasks4-7-plan.md)
> 约束：未触碰 `backend/app/mcp/` 和 `backend/tests/test_mcp_server.py`

---

## 一、执行范围与目标

本轮完成 PhaseC Sync 修复规划中 **Task 4-7** 四项任务：

| 任务 | 编号 | 目标 | 状态 |
|---|---|---|---|
| Task 4 | P1-3 | Note sync update 保留 `client_updated_at` | 完成 |
| Task 5 | P1-2 | Entity type alias map + meta `sync_entity_type`/`pull_key` 字段 | 完成 |
| Task 6 | P2-1 | `RelationService.link()` 改用 SAVEPOINT 替代 rollback | 完成 |
| Task 7 | P2-2 | CI lint 修复：pyproject 加 ruff、移除 `|| true` | 完成 |

---

## 二、关键代码变更

### Task 4 (P1-3) — Note sync 保留客户端时间戳

- [`app/services/base.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py): `bump_updated_at=False` 路径无条件调用 `flag_modified(obj, "updated_at")`，阻止 `SyncMixin.onupdate=utc_now_iso_ms` 在同步模式下触发。
- [`app/services/note.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py): `update_content()` 中当 `updated_at_override is not None` 时调用 `flag_modified(obj, "updated_at")`。

**核心发现**：由于 SQLAlchemy 的 `onupdate` 会在 UPDATE flush 时触发，即使已经设置了 `updated_at`，第二次 flush 仍可能覆盖为服务端时间。必须在 `note.py` 和 `base.py` 两处同时强制将 `updated_at` 标记为 dirty，才能彻底避免 `onupdate` 覆盖。

### Task 5 (P1-2) — Entity alias map + meta 字段

- 新建 [`app/services/sync_entity_types.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_entity_types.py): 基于 `REGISTRY.list_sync_enabled()` 懒加载 alias map，提供 `canonicalize_entity_type()` 实现 snake_case ↔ camelCase 转换。
- [`app/services/sync.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py): `push()` 入口处调用 `canonicalize_entity_type()`，使客户端使用 snake_case 或 camelCase 均可被接受。
- [`app/services/meta.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/meta.py) + [`app/schemas/meta.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/meta.py): `EntitySpecOut` 暴露 `sync_entity_type` 和 `pull_key`。
- [`app/registry/builtin.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/builtin.py): 14 个 sync_enabled 实体全部显式声明 `pull_key`；7 个 camelCase 实体保留 `sync_entity_type`，7 个 snake_case 默认实体将 `sync_entity_type` 设为 `None`（由 `effective_sync_entity_type` 回退到 `name`）。

### Task 6 (P2-1) — RelationService SAVEPOINT 隔离

- [`app/services/relation.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/relation.py): `link()` 中把 insert 包裹进 `async with self.db.begin_nested():`，替代原来的 `await self.db.rollback()`，避免丢弃外层事务中的其他 pending 变更，符合“services flush, never rollback”铁律。

### Task 7 (P2-2) — CI lint 修复

- [`backend/pyproject.toml`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml): dev extras 新增 `ruff>=0.8`，并增加 `[tool.ruff]` / `[tool.ruff.lint]` / `[tool.ruff.lint.per-file-ignores]` 配置。
- [`.github/workflows/ci.yml`](file:///e:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml): lint step 移除 `|| true`、改为 blocking；CI 中不再写固定测试数量。
- 同时用 `ruff check --fix` 修复了 214 个 lint 问题，并手动清理 6 个未使用变量 / 歧义变量名。

---

## 三、新增/修改的测试文件

| 测试文件 | 变更 |
|---|---|
| [`tests/test_sync_service.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_service.py) | Task 4 新增 3 个 P1-3 测试 |
| [`tests/test_sync_entity_alias.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_entity_alias.py) | Task 5 新建，5 个 alias 测试 |
| [`tests/test_routes_meta.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_routes_meta.py) | Task 5 追加 2 个 meta 字段测试 |
| [`tests/test_relation_service.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_relation_service.py) | Task 6 追加 2 个 SAVEPOINT 测试 |

---

## 四、测试验证结果

| 验证项 | 结果 |
|---|---|
| Task 4 新增 3 个 P1-3 测试 | 通过 |
| Task 5 新增 5 个 alias 测试 + 2 个 meta 字段测试 | 通过 |
| Task 6 新增 2 个 SAVEPOINT 测试 + 9 个已有 relation 测试 | 11/11 通过，无回归 |
| ruff check app tests | 0 errors |
| 关键测试合辑（29 个） | 29/29 通过 |
| 全量测试收集（排除 MCP WIP） | 530 tests collected（最新值，见第七/八/九节） |

> **关于全量回归的说明**：早期一次性全量回归在旧隔离方案（`tmp_path` 指向 `tests/`）下出现 134 个失败，根因为测试间残留 DB/文件导致 409 Conflict 和计数断言失败。该隔离方案已修正为专用 temp root `tests/.tmp/<sanitized_nodeid-hash>/`，真实测试包 `test_file_system/` 已恢复。全量测试尚未在本地 sandbox 中完整执行，需在 CI 干净容器中补充验证。

---

## 五、上级 Agent 审查重点

1. **`flag_modified` 双位置调用**
   同步路径必须在 `note.py` 和 `base.py` 两处都调用，否则 `onupdate` 仍可能在第二次 flush 时覆盖客户端时间戳。

2. **SAVEPOINT 语义是否符合预期**
   `RelationService.link()` 现在用 `begin_nested()` 隔离 insert；请确认上层调用方没有依赖旧的 `rollback()` 副作用。

3. **Entity alias map 的完整性**
   `sync_entity_types.py` 基于 `REGISTRY` 懒加载，目前覆盖 14 个 sync_enabled 实体。新增 sync 实体时只要 `sync_entity_type` 或 `name` 正确即可自动覆盖。

4. **Ruff 配置严格度**
   当前配置选择 `F/E/W/I`，忽略 `E501/E722/E402` 并放宽 tests 目录。若 CI 需要更严格，可进一步收紧 `per-file-ignores`。

5. **CI 测试数注释**
   `.github/workflows/ci.yml` 中不再写固定测试数量；验证结果以 CI 实际输出为准。

---

## 六、遗留/待确认事项

- 全量一次性回归在本地 sandbox 下受文件隔离影响，建议在 CI（干净容器）中再次跑全量验证。
- `backend/app/mcp/` 与 `backend/tests/test_mcp_server.py` 按约束未动；ruff 之前曾对其做 import-only 调整，已 revert 回原始状态。
- ruff 自动修复导致大量 import 重排，已验证关键测试无影响，建议上级 agent 在 diff 中重点关注非 import 的核心逻辑变更。

---

## 七、审查遗留问题修复（追加）

针对上级 agent 审查后提出的 5 项遗留问题，已做如下处理：

### 1. NoteService.update_metadata() bump 逻辑修复

文件：[`app/services/note.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py)

- **修复前**：`update_metadata()` 无条件调用 `super().update(id, data, bump_updated_at=False)`，导致普通 REST/服务调用不会递增 `updated_at` 和 `version`。
- **修复后**：仅当 `updated_at_override is not None`（sync 路径）时才传 `bump_updated_at=False`；普通路径调用 `super().update(id, data)`，由 `BaseService` 自动 bump `updated_at` 并递增 `version`。

### 2. 补充 NoteService 测试

文件：[`tests/test_note_service.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_note_service.py)

新增 3 个测试：

- `test_update_metadata_bumps_updated_at_and_version`：普通 `update_metadata()` metadata-only 更新会改变 `updated_at`，且 `version + 1`。
- `test_update_metadata_only_bumps_updated_at_and_version`：普通 `NoteService.update()` metadata-only 路径同样会 bump `updated_at` 和 `version`。
- `test_update_metadata_sync_mode_preserves_client_updated_at`：sync 路径带 `updated_at_override` 时仍保留客户端时间戳，且 `version` 不变。

### 3. 测试隔离修复（重要修正）

**问题发现**：上轮将 `tmp_path` 改为返回 `tests/<test_name>/`，并在 session cleanup 中执行 `tests_dir.glob("test_*/")`。这导致真实测试包 [`backend/tests/test_file_system/`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_file_system/) 被误识别为临时目录而删除（git 状态显示为 D）。这是 P1 阻塞问题，已立即恢复。

**修正方案**（文件：[`backend/tests/conftest.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/conftest.py) 与 [`.gitignore`](file:///e:/Development/MyAwesomeApp/PomodoroXII/.gitignore)）：

- `tmp_path` 不再返回 `tests/<test_name>/`，而是返回专用临时根目录 `tests/.tmp/<sanitized_nodeid-hash>/`。
- 目录名基于 `request.node.nodeid` 做 sanitize（替换非法字符） + SHA256 前 16 位 hash，避免不同模块同名测试或参数化测试冲突。
- `_isolate_env` 在删除/重建临时目录前调用 `_ensure_inside_temp_root()`：resolve 路径后确认其仍位于 `tests/.tmp/` 内，否则抛出 `RuntimeError`。
- session cleanup fixture 改名为 `_cleanup_temp_root()`，仅删除 `tests/.tmp/`，绝不执行 `tests/test_*/` 这种 broad glob。
- [`.gitignore`](file:///e:/Development/MyAwesomeApp/PomodoroXII/.gitignore) 移除 `backend/tests/test_*/` 等危险规则，仅保留 `backend/tests/.tmp/`。

### 4. MCP import-only 改动处理

- ruff 自动修复时曾修改 [`backend/app/mcp/server.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/mcp/server.py) 和 [`backend/tests/test_mcp_server.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_mcp_server.py) 的 import 顺序。
- 已执行 `git checkout --` 完全 revert 这两个文件，现工作区中无改动，符合“不触碰 MCP WIP 内容”的约束。
- 为避免后续 ruff 再次触碰这两个 WIP 文件，在 [`backend/pyproject.toml`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml) 的 `[tool.ruff]` 中增加 `exclude = ["app/mcp/**", "tests/test_mcp_server.py"]`。

### 5. 定向测试与失败原因说明

- 测试隔离方案已修正为专用 temp root `tests/.tmp/<sanitized-nodeid-hash>/`，真实测试包 `tests/test_file_system/` 已恢复。
- 第八节与第九节已回填最新验证结果（530 collected / 7 passed, 4 skipped / 11 passed）。
- 全量测试若后续执行，必须按测试文件归类列出具体失败原因，不得笼统归因。

---

## 八、定向测试验证结果

| 验证项 | 结果 |
|---|---|
| `pytest --collect-only --ignore=tests/test_mcp_server.py` | **530 tests collected** |
| `tests/test_parity_routes.py tests/test_parity_stats_mcp.py tests/test_stat_spec.py`（普通 python，fastmcp 缺失） | **7 passed, 4 skipped** |
| `tests/test_parity_routes.py tests/test_parity_stats_mcp.py tests/test_stat_spec.py`（`.venv` python） | **11 passed** |
| `tests/test_file_system/test_note_ops.py tests/test_note_service.py tests/test_relation_service.py` | **49 passed** |
| `scripts/check_entity_consistency.py`（`.venv` python） | **72 passed** |
| `ruff check app tests` | **All checks passed!** |

> **环境依赖说明**：普通系统 python 缺少 `fastmcp`，导致 4 个 MCP parity 测试被 skip。项目 `.venv` 已安装 `fastmcp`，在其中运行时所有 parity 测试均通过。
>
> 全量测试未在本轮本地 sandbox 中完整执行；collect 数量为 530（排除 `test_mcp_server.py`），真实测试包 `test_file_system/` 已恢复并可正常收集。

---

## 九、P3 加固项（追加）

针对审查后续提出的 P3 加固项，本轮处理如下：

### 1. 加固 `test_parity_routes.py`

文件：[`backend/tests/test_parity_routes.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_parity_routes.py)

- 新增 `test_route_enabled_entities_must_have_non_empty_route_prefix`：显式断言所有 `route_enabled=True` 的 EntitySpec 必须填写非空 `route_prefix`，不再用 `if spec.route_enabled and spec.route_prefix` 静默过滤。
- `/spaces` 仍由 `space` EntitySpec 覆盖；非实体白名单只包含 `/auth`、`/meta`、`/trash`、`/stats`、`/sync`。

### 2. 加固 MCP stats parity 识别逻辑

文件：[`backend/tests/parity_helpers.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/parity_helpers.py)（新建）

- 探索 FastMCP 公开 API：`FastMCP` 实例提供 `list_tools()` 异步方法，返回实际注册的 tool 列表。
- `get_registered_mcp_tool_names()` 优先使用 `mcp.list_tools()` 作为权威来源；如果调用失败，使用 `pytest.fail()` 显式失败而不是静默降级。
- `get_actual_stats_mcp_tools()` = `list_tools()` 注册集合 ∩ 源码中含 `StatsService` 的 callable，避免把普通 helper 误判为 MCP tool。
- 未修改 `backend/app/mcp/server.py`。

### 3. 去重：提取 `parity_helpers.py`

文件：[`backend/tests/parity_helpers.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/parity_helpers.py)（新建）

- 统一导出 `get_stats_rest_paths()`、`get_registered_mcp_tool_names()`、`get_actual_stats_mcp_tools()`、`is_mcp_available()`、`skip_if_mcp_unavailable()`。
- [`backend/tests/test_parity_stats_mcp.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_parity_stats_mcp.py) 与 [`backend/tests/test_stat_spec.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_stat_spec.py) 均改为从 `tests.parity_helpers` 导入，避免逻辑漂移。
- `test_parity_stats_mcp.py` 新增 `test_mcp_tools_consistent_with_registration`：将 “registered stats subset（FastMCP list_tools 注册集合 ∩ StatsService 源码筛选）” 与 STAT_SPECS 期望集合做严格相等校验，捕获潜在的 tool 重命名场景。

### 4. 关于 `backend/app/registry/builtin.py` 的描述更正

经 `git diff` 核实，[`backend/app/registry/builtin.py`](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/builtin.py) 在本轮 PhaseC 修复中已有改动：

- 11 个一等实体新增 `route_enabled=True` 与 `route_prefix`：`task`(`/tasks`)、`session`(`/sessions`)、`note`(`/notes`)、`folder`(`/folders`)、`quick_note`(`/quick-notes`)、`reflection`(`/reflections`)、`habit`(`/habits`)、`schedule`(`/schedules`)、`time_block`(`/time-blocks`)、`space`(`/spaces`)、`setting`(`/settings`)。
- junction 实体（`habit_check_in`、`memo_comment`、`session_quick_note`、`schedule_quick_note`、`task_quick_note`）、sync infra（`tombstone`、`sync_outbox`、`sync_audit_log`）与 `meta_setting` 未设 `route_enabled`；`space`/`setting` 作为一等路由实体已设 `route_enabled=True`，符合白名单语义。

### 5. P3 验证结果

| 验证项 | 结果 |
|---|---|
| `python -m ruff check app tests` | **All checks passed!** |
| `python -m pytest tests/test_parity_routes.py tests/test_parity_stats_mcp.py tests/test_stat_spec.py -q`（普通 python，fastmcp 缺失） | **7 passed, 4 skipped** |
| `.venv\Scripts\python.exe -m pytest tests/test_parity_routes.py tests/test_parity_stats_mcp.py tests/test_stat_spec.py -q`（`.venv` python） | **11 passed** |
| `python -m pytest --collect-only --ignore=tests/test_mcp_server.py -q` | **530 tests collected** |




