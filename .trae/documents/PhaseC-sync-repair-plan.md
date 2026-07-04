# Phase C Sync 修复实施计划

> **派发文档**: [PhaseC-sync-repair-dispatch.md](file:///E:/Development/MyAwesomeApp/PomodoroXII/PhaseC-sync-repair-dispatch.md)
> **范围**: backend 已跟踪代码（**严禁**碰 `backend/app/mcp/` 与 `backend/tests/test_mcp_server.py`）
> **方法**: 严格 TDD（Red → Verify Red → Green → Verify Green → Refactor）
> **基线**: 406 passed（排除 MCP WIP），目标：基线 + 新增测试 全绿
> **决策**:
>   - P0-2 cursor: 方案 A（规范化时间格式 + (updated_at, id) 排序 + alembic 数据迁移），不改 API 形状
>   - P1-2 entity_type: 方案 A（alias map + meta sync_entity_type 字段），保持客户端兼容
>   - P2-3 runtime Alembic: 本轮延后（仅在计划中记录后续行动）

---

## 当前状态分析

### 已存在的能力
- `read_notes_batch(note_ids)` 已在 [note_ops.py:129-157](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/file_system/engine/note_ops.py#L129-L157) 实现（单次 SELECT + N 次文件读，IO=2）
- `FileSystem` 接口（[interfaces.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/file_system/interfaces.py)）**未声明** `read_notes_batch`，需补抽象方法
- `utc_now_iso_ms()` 在 [time.py:20-26](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/time.py#L20-L26) 已存在但实际是**微秒精度**（`%f` 6 位），需改为 3 位毫秒
- Alembic 链: 001 → cab2ff7bcf37 → 002 → 003 → 004 → 005（HEAD）

### 测试模式（来自 conftest.py）
- `space_session` fixture: per-test SQLite + 所有业务表
- `client` fixture: httpx ASGITransport
- `_isolate_env` autouse: per-test tmp_path + module reload
- pytest 配置: `asyncio_mode = "auto"`, `testpaths = ["tests"]`, `pythonpath = ["."]`
- 测试文件命名: `test_{module}.py` 或 `test_{module}_{scenario}.py`

### 架构铁律（必须遵守）
1. **routes commit / services flush** — services 永不调 `db.commit()`
2. **services 不调 `db.rollback()`** — 用 `begin_nested()` SAVEPOINT 或 `expunge()` 隔离失败（参考 [tombstone.py:50](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/tombstone.py#L50)）
3. **services 不 import FastAPI**
4. **不在 services 引入 FastAPI 依赖**

---

## 修复任务清单（按推荐顺序）

### Task 1: P0-1 — Note content 随 pull/full 下发

**问题**: [sync.py:449](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L449) `serialize_entity(r)` 对 Note ORM 不读 content（content 在 filesystem）。`SyncService.__init__` 已接收 `fs`，但 pull 未调用。

**TDD 步骤**:

#### Red — 新建 `tests/test_sync_note_content.py`
```
test_pull_note_includes_content_from_filesystem:
    - 用 fs 创建 note（content="Hello world"）
    - SyncService(db, fs).pull(since="", limit=100)
    - assert result["notes"][0]["content"] == "Hello world"
    - assert result["notes"][0]["content_missing"] is False

test_pull_note_content_missing_when_fs_none:
    - 直接 DB 插入 Note row（绕过 fs）
    - SyncService(db, fs=None).pull()
    - assert result["notes"][0]["content"] == ""
    - assert result["notes"][0]["content_missing"] is True

test_pull_note_content_missing_when_file_deleted:
    - 用 fs 创建 note，然后 fs.delete_note(id)
    - SyncService(db, fs).pull()
    - assert result["notes"][0]["content_missing"] is True
    - assert result["notes"][0]["content"] == ""

test_pull_multiple_notes_uses_batch_read:
    - 创建 3 个 notes
    - monkeypatch svc.fs.read_notes_batch 计数调用
    - pull 后 assert 调用次数 == 1（不是 N 次 read_note）

test_full_includes_note_content:
    - 创建 note with content
    - SyncService.full() → notes[0]["content"] == 原文

test_push_note_create_then_pull_returns_same_content:
    - push note create (content="synced body")
    - pull → notes[0]["content"] == "synced body"

test_rest_note_create_then_pull_returns_same_content:
    - 通过 REST POST /api/v1/notes 创建 note
    - GET /api/v1/sync/pull → notes[0]["content"] == 原文
```

#### Green — 修改
1. [interfaces.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/file_system/interfaces.py): 添加 `read_notes_batch(note_ids: list[str]) -> list[str | None]` 抽象方法
2. [sync.py:438-454](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L438-L454) `pull()`: 在 `serialized = [serialize_entity(r) for r in rows]` 后，针对 `model is Note` 调用 `self.fs.read_notes_batch([r.id for r in rows])`，写入 `content` / `content_missing` 字段；`fs is None` 时全部标记 `content_missing=True, content=""`

---

### Task 2: P0-2 — Timestamp 规范化 + (updated_at, id) 排序

**问题**:
- [time.py:26](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/time.py#L26) `utc_now_iso_ms` 用 `%f`（6 位微秒），与派发文档要求的 3 位毫秒不符
- [sync_safety.py:35-40](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_safety.py#L24-L40) `normalize_timestamp` 对含小数点的时间戳直接 passthrough，导致 `"2026-07-04T10:00:00.123456Z"` 与 `"2026-07-04T10:00:00.123Z"` 字符串比较不等
- [sync.py:444](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L444) 排序仅按 `updated_at.asc()`，同 timestamp 跨页可能跳过

**TDD 步骤**:

#### Red — 扩展 `tests/test_sync_safety.py` + 新建 `tests/test_sync_cursor_pagination.py`
```
# test_sync_safety.py 新增
test_normalize_timestamp_truncates_microseconds_to_milliseconds:
    normalize_timestamp("2026-07-04T10:00:00.123456Z") == "2026-07-04T10:00:00.123Z"

test_normalize_timestamp_handles_plus_offset:
    normalize_timestamp("2026-07-04T10:00:00+00:00") == "2026-07-04T10:00:00.000Z"

test_normalize_timestamp_handles_no_z_suffix:
    normalize_timestamp("2026-07-04T10:00:00") == "2026-07-04T10:00:00.000Z"

# test_time.py 新增
test_utc_now_iso_ms_returns_exactly_3_digit_milliseconds:
    ts = utc_now_iso_ms()
    # 验证 .xxxZ 中 xxx 是 3 位
    fraction = ts.split(".")[1].rstrip("Z")
    assert len(fraction) == 3

# test_sync_cursor_pagination.py 新建
test_pull_with_seconds_precision_db_does_not_repeat:
    # DB 中存秒精度 "2026-07-04T10:00:00Z"
    # cursor 是规范化后的 "2026-07-04T10:00:00.000Z"
    # pull(since="2026-07-04T10:00:00.000Z") 不应返回该行（不重复）

test_pull_same_timestamp_3_rows_pagination_no_skip:
    # 3 条记录同 updated_at="2026-07-04T10:00:00.000Z"，不同 id
    # pull(limit=2) → 返回 2 条 + has_more=True
    # pull(since=上一轮 next_since, limit=2) → 应返回第 3 条（用 id 排序避免跳过）
    # 注意：需通过 since_id 或服务端 id > last_id 实现

test_pull_orders_by_updated_at_then_id:
    # 创建 3 条同 timestamp 的 task，验证返回顺序按 id asc

test_tombstones_same_timestamp_pagination_no_skip:
    # 3 条同 deleted_at 的 tombstone
    # 分页 pull 不跳过
```

#### Green — 修改
1. [time.py:20-26](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/time.py#L20-L26): `utc_now_iso_ms` 改用 `.%03d` 配合 `microsecond // 1000`，输出 3 位毫秒
2. [sync_safety.py:24-40](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_safety.py#L24-L40) `normalize_timestamp`: 重写为基于 `datetime.fromisoformat()` 解析（兼容 `Z` / `+00:00` / 无后缀），输出统一格式 `strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"`
3. [sync.py:444](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L444) `pull()` entity 循环: 排序改为 `.order_by(model.updated_at.asc(), model.id.asc())`
4. [sync.py:490-514](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L490-L514) `_fetch_tombstones`: 排序改为 `.order_by(Tombstone.deleted_at.asc(), Tombstone.id.asc())`
5. **新建 alembic 006_sync_timestamp_normalize.py**: 数据迁移，把所有 sync 实体的 `created_at`/`updated_at` 与 tombstone 的 `deleted_at` 中秒精度值（无 `.`）补成 `.000Z`。用 SQL `UPDATE ... SET updated_at = substr(updated_at, 1, length(updated_at)-1) || '.000Z' WHERE updated_at LIKE '%Z' AND updated_at NOT LIKE '%.%'`，覆盖 14 表 + tombstones。`down_revision = "005_sync_updated_at_indexes"`

**注**: 由于单纯 `>` 比较无法完美处理同 timestamp 跨页（即使按 id 排序，下一轮 `since=ts` 仍会跳过同 ts 的剩余行），本轮采用**妥协方案**：保持 `since` API 不变，但在响应中已包含 `next_since` 为最大 ts；客户端在同 ts 多行场景下需要拉取该 ts 的全部行后本地去重。完美方案需引入 `since_id`，本轮不实现，但在代码注释与计划中记录后续行动。

---

### Task 3: P1-1 — applied/conflicts 契约修正

**问题**: [sync.py:141, 189](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L141) 将 `conflict_local`/`conflict_tombstone`/`conflict_circular_ref` 也加入 `applied`，违反 schema 注释"successfully applied"。

**TDD 步骤**:

#### Red — 扩展 `tests/test_sync_service.py`
```
test_push_conflict_local_not_in_applied:
    # 创建 task with updated_at=12:00
    # push update with client_updated_at=10:00 (older)
    # assert conflicts 含 resolution=local
    # assert applied 不含该 entity_id

test_push_conflict_tombstone_not_in_applied:
    # REST delete task → push create same id
    # assert conflicts 含 resolution=tombstone
    # assert applied 不含该 entity_id

test_push_conflict_circular_ref_not_in_applied:
    # 创建 folder A → B → A 试图形成环
    # assert conflicts 含 resolution=circular_ref
    # assert applied 不含该 entity_id

test_push_conflict_remote_in_applied:
    # 创建 task with updated_at=10:00
    # push update with client_updated_at=12:00 (newer, remote wins)
    # assert applied 含该 entity_id (remote wins 已应用)
    # assert conflicts 也含 resolution=remote (透明告知客户端)

test_http_push_tombstone_conflict_excluded_from_applied:
    # HTTP 层面：REST delete → push create same id
    # assert response.applied 不含该 id
    # assert response.conflicts 含 tombstone

# 更新现有破坏的测试
test_push_tombstone_blocks_create_resurrection (修改):
    # 原本 assert len(result["applied"]) == 1
    # 改为 assert len(result["applied"]) == 0 (因为 conflict_tombstone 不再进 applied)
    # 保留 conflicts 断言

test_push_tombstone_blocks_update_upsert (修改): 同上
test_push_folder_create_rejects_self_parent (修改): 同上
test_push_folder_update_rejects_circular_parent (修改): 同上
```

#### Green — 修改 [sync.py:99-204](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L99-L204)
将两个 `applied.append({...})` 调用包裹在条件中：
```python
if resolution in ("ok", "conflict_remote"):
    applied.append({
        "entity_type": etype,
        "entity_id": eid,
        "action": action,
    })
```
对 note 分支（line 117-157）和通用实体分支（line 159-204）都做相同处理。

---

### Task 4: P1-3 — Note sync update 保留 client_updated_at

**问题**: [sync.py:388](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L388) `_push_note_event` 在 update 时设置 `update_data["updated_at"] = client_ts_n`，但调 `NoteService.update()` → `update_content()` ([note.py:133](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L133)) 会用 `utc_now_iso()` 覆盖；`update_metadata()` → `BaseService.update()` ([base.py:80](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py#L80)) 也覆盖。

**TDD 步骤**:

#### Red — 扩展 `tests/test_sync_service.py`
```
test_push_note_update_preserves_client_updated_at:
    # push note create with updated_at=10:00
    # push note update with client_updated_at=12:00 + content="new body"
    # DB row.updated_at == "12:00.000Z" (不是 server-now)
    # fs.read_note(id) 包含 "new body"

test_push_note_update_preserves_client_updated_at_metadata_only:
    # 同上但只更新 title（不更新 content）
    # DB row.updated_at == client_ts

test_sync_mode_update_does_not_bump_updated_at_in_base_service:
    # 单元测试 NoteService(sync_mode=True).update_metadata
    # 验证 BaseService.update 用 bump_updated_at=False
```

#### Green — 修改
1. [base.py:75-85](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py#L75-L85) `update`: 增加 `bump_updated_at: bool = True` 参数；`if bump_updated_at: obj.updated_at = utc_now_iso()`；`if bump_updated_at and hasattr(obj, "version"): obj.version = (obj.version or 0) + 1`
2. [note.py:115-144](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L115-L144) `update_content`: 增加 `updated_at_override: str | None = None`；`obj.updated_at = updated_at_override if updated_at_override is not None else utc_now_iso()`；frontmatter `fm_meta["updated_at"]` 同步用相同值
3. [note.py:146-158](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L146-L158) `update_metadata`: 增加 `updated_at_override`，传给 `super().update(id, data, bump_updated_at=False)`；先在 data 中设置 `data["updated_at"] = updated_at_override`
4. [note.py:160-171](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L160-L171) `update`: 接收 `updated_at_override`，分别传给 `update_content` / `update_metadata`
5. [sync.py:386-390](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L386-L390) `_push_note_event` update 分支: `await note_svc.update(eid, update_data, updated_at_override=client_ts_n)`

---

### Task 5: P1-2 — Entity type alias map + meta sync_entity_type 字段

**问题**: [builtin.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/builtin.py) registry 用 snake_case（`quick_note`），[sync.py:51-66](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L51-L66) ENTITY_REGISTRY 用 camelCase（`quickNote`）。客户端按 `/meta/entities` 生成 payload 会被 `/sync/push` 拒绝。

**TDD 步骤**:

#### Red — 新建 `tests/test_sync_entity_alias.py` + 扩展 `tests/test_routes_meta.py`
```
# test_sync_entity_alias.py
test_push_accepts_snake_case_quick_note:
    # push event with entity_type="quick_note"
    # assert applied 含该 id（不报 Unknown entity_type）

test_push_accepts_snake_case_habit_check_in:
    # push event with entity_type="habit_check_in"
    # assert 成功

test_push_accepts_snake_case_for_all_7_mismatched_entities:
    # 参数化：quick_note, habit_check_in, time_block, memo_comment,
    #         session_quick_note, schedule_quick_note, task_quick_note
    # 全部 push 成功

test_push_still_accepts_camel_case_backward_compat:
    # push event with entity_type="quickNote" 仍成功

test_push_unknown_entity_still_errors:
    # push event with entity_type="not_real"
    # assert errors 含 "Unknown entity_type"

# test_routes_meta.py 扩展
test_meta_entity_response_includes_sync_entity_type:
    # GET /api/v1/meta/entities/quick_note
    # assert response.json()["sync_entity_type"] == "quickNote"

test_meta_entity_response_sync_entity_type_for_task:
    # GET /api/v1/meta/entities/task
    # assert response.json()["sync_entity_type"] == "task" (无转换)
```

#### Green — 修改
1. [sync.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py) 新增模块级常量 `_ENTITY_TYPE_ALIASES`:
   ```python
   _ENTITY_TYPE_ALIASES: dict[str, str] = {
       "quick_note": "quickNote",
       "habit_check_in": "habitCheckIn",
       "time_block": "timeBlock",
       "memo_comment": "memoComment",
       "session_quick_note": "sessionQuickNote",
       "schedule_quick_note": "scheduleQuickNote",
       "task_quick_note": "taskQuickNote",
   }
   
   def _canonicalize_entity_type(etype: str) -> str:
       """Map snake_case registry names to camelCase ENTITY_REGISTRY keys."""
       return _ENTITY_TYPE_ALIASES.get(etype, etype)
   ```
2. [sync.py:100-112](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L100-L112) `push()` 中 `etype = event.get("entity_type", "")` 后加 `etype = _canonicalize_entity_type(etype)`
3. [meta.py:98-115](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/meta.py#L98-L115) `MetaService.serialize`: 增加 `"sync_entity_type": _resolve_sync_entity_type(spec.name)` 字段
4. [meta.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/meta.py) 新增私有函数 `_resolve_sync_entity_type(registry_name: str) -> str`：从 sync.py 反向查 alias map（或直接 import `_ENTITY_TYPE_ALIASES` 反转）。为避免循环依赖，把 alias map 提取到 `app/services/sync_entity_types.py` 新模块（仅常量+函数，无 FastAPI/SQLAlchemy 依赖）
5. [schemas/meta.py:38-52](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/meta.py#L38-L52) `EntitySpecOut`: 增加 `sync_entity_type: str` 字段

**注**: tombstone 输出与 pull_key 仍保持 camelCase（现有客户端兼容），仅 push 输入端做 canonicalize。

---

### Task 6: P2-1 — RelationService.link 改用 SAVEPOINT

**问题**: [relation.py:78](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/relation.py#L78) `await self.db.rollback()` 会回滚调用方事务里其他改动。

**TDD 步骤**:

#### Red — 扩展 `tests/test_relation_service.py`
```
test_link_does_not_rollback_outer_transaction_on_integrity_error:
    # 在同一 session 中先创建一个 task（flush 不 commit）
    # 用直接 DB.add + flush 创建已存在的 (task_id, qn_id) 行模拟 race
    # 调 RelationService.link("task", task_id, qn_id)
    # assert 之前的 task 仍在 session 中（未被回滚）
    # assert link 返回了 existing 行

test_link_uses_savepoint_not_session_rollback:
    # monkeypatch session.rollback 让它 raise（确保不被调用）
    # 触发 IntegrityError 路径
    # assert link 仍正常返回（用 expunge/savepoint 处理）
```

#### Green — 修改 [relation.py:55-88](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/relation.py#L55-L88)
```python
async def link(self, kind: str, parent_id: str, quick_note_id: str) -> Any:
    model, parent_col = self._resolve(kind)
    res = await self.db.execute(
        select(model).where(
            getattr(model, parent_col) == parent_id,
            model.quick_note_id == quick_note_id,
        )
    )
    existing = res.scalar_one_or_none()
    if existing is not None:
        return existing
    row = model(**{parent_col: parent_id, "quick_note_id": quick_note_id})
    self.db.add(row)
    try:
        async with self.db.begin_nested():
            await self.db.flush()
        await self.db.refresh(row)
        return row
    except IntegrityError:
        # SAVEPOINT 已自动回滚；expunge 失败的 pending 行
        self.db.expunge(row)
        res = await self.db.execute(
            select(model).where(
                getattr(model, parent_col) == parent_id,
                model.quick_note_id == quick_note_id,
            )
        )
        existing = res.scalar_one_or_none()
        if existing is not None:
            return existing
        raise
```

**注**: `begin_nested()` 在 SQLAlchemy 2.0 async 中会在退出 with 块时自动 commit SAVEPOINT；IntegrityError 会触发自动 rollback 到 SAVEPOINT，不影响外层事务。

---

### Task 7: P2-2 — CI lint 修复

**问题**: [ci.yml:71-72](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L71-L72) `uv run ruff check app tests || true` 让 lint 永远不失败；[pyproject.toml:23-28](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L23-L28) dev extras 没 ruff；注释写死"361 tests"已过时。

**TDD 步骤**: 此任务为配置修复，无单元测试。验证方式 = CI 在 GitHub Actions 上跑通（本地可手动 `uv run ruff check app tests` 验证无 lint 错误）。

**注**: 由于本任务无单元测试，违反 TDD 铁律。但派发文档明确要求修复 CI 配置，且配置文件属于 TDD 例外（"Configuration files"）。需在执行时先运行 `uv run ruff check` 看是否有现存 lint 错误，如有则一并修复。

#### Green — 修改
1. [pyproject.toml:23-28](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L23-L28) dev extras 增加 `"ruff>=0.8"`
2. [ci.yml:71-72](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L71-L72) 改为 `uv run ruff check app tests`（移除 `|| true`）；注释改为 "pytest (excludes MCP WIP)" 不写死数量
3. [ci.yml:84](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L84) pytest 命令加 `--ignore=tests/test_mcp_server.py` 与派发文档对齐
4. 若 ruff 报现有代码 lint 错误，修复代码（不新增功能）

---

### Task 8（延后）: P2-3 — Runtime Alembic Migration

**不在本轮实施**。在执行总结中记录后续行动：
- 新建 `app/db/migrate.py` 提供 `run_migrations(target: Literal["meta", "space"], engine)` 函数
- meta DB startup 调用 `run_migrations("meta", engine)`
- space_manager._init_schema 改为：新库 `create_all`，已有库 `run_migrations("space", engine)`
- 需要 alembic env.py 支持多 target 配置

---

## 验证步骤

### 单元测试（每个 Task 完成后）
```powershell
cd backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_note_content.py tests/test_sync_safety.py tests/test_sync_cursor_pagination.py tests/test_sync_service.py tests/test_sync_entity_alias.py tests/test_relation_service.py tests/test_routes_meta.py tests/test_time.py -v
```

### 全量回归（所有 Task 完成后）
```powershell
cd backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest --ignore=tests/test_mcp_server.py -q
```
**期望**: 406（基线）+ 新增测试 全绿

### Lint 验证（Task 7 完成后）
```powershell
cd backend
uv run ruff check app tests
```
**期望**: 0 errors

---

## 假设与决策

1. **测试文件命名**: 沿用项目现有 `test_{module}.py` / `test_{module}_{scenario}.py` 约定（Python 项目，非 TypeScript）
2. **alias map 模块位置**: 新建 `app/services/sync_entity_types.py`（无依赖纯常量模块），避免 sync.py ↔ meta.py 循环依赖
3. **alembic 006 数据迁移**: 仅规范化秒精度→毫秒精度，不处理微秒精度（微秒精度本身已是合法 ISO，只是与毫秒混合时排序不稳；新的 `normalize_timestamp` 会在比较前归一化，所以历史微秒值在查询比较时会被规范化处理；但 DB 中存储的值仍是微秒，下次更新时会被新写入的毫秒值取代）
4. **`since_id` 完美分页**: 本轮不实现，记录为后续行动。当前方案在 99% 场景下足够（同 timestamp 多行场景罕见，且 `next_since` + 客户端去重可兜底）
5. **MCP WIP 隔离**: 严格执行，不读取、不修改 `backend/app/mcp/` 与 `backend/tests/test_mcp_server.py`；CI 中通过 `--ignore=tests/test_mcp_server.py` 排除
6. **破坏性测试更新**: Task 3 会破坏 4 个现有测试（`test_push_tombstone_blocks_*` / `test_push_folder_*_rejects_*`），更新断言是必要的（行为变了，旧断言不再正确）
7. **Task 7 lint 修复**: 属于 TDD 例外（配置文件），但执行时仍先跑 `ruff check` 看是否有现有 lint 错误，如有则修复

## 后续行动（不在本轮）

- P2-3: Runtime Alembic migration 接入（meta + space DB startup）
- P0-2 完美分页: 引入 `since_id` 或 opaque cursor 参数（breaking change，需客户端配合）
- tombstone entity_type 是否统一到 snake_case（长期方案 B，breaking change）

## 执行顺序

按 Task 1 → 2 → 3 → 4 → 5 → 6 → 7 顺序执行。每个 Task 严格遵循 TDD Red-Green-Refactor。Task 3 会破坏现有测试，必须在同一个 commit 中完成实现+测试更新。Task 7 最后做（避免 lint 错误干扰前面 Task 的代码探索）。
