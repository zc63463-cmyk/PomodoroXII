# Phase C Sync 引擎续接计划（Tasks 5-12）

> **For agentic workers:** 本计划采用 TDD 方法论(Red → Green → Refactor)。步骤使用 checkbox (`- [ ]`) 语法跟踪。

**Goal:** 完成 Phase C Sync 引擎剩余 8 个任务——pull/full/status 方法、SAVEPOINT 兼容性测试、sync_mode 集成、ENTITY_REGISTRY 验证、审计日志、sync 路由、集成测试

**Architecture:** 多空间架构(共享 meta.db + 每空间 SQLite)。Sync 引擎采用 client-first + LWW 冲突解决 + Tombstone 防复活。Note 实体走 NoteService(双存储 Saga)，其他实体走直接 ORM。SAVEPOINT 隔离每事件。

**Tech Stack:** Python 3.12, FastAPI 0.139.0, SQLAlchemy 2.0 (async), Pydantic v2, pytest, aiosqlite

---

## 摘要

Tasks 1-4 已完成（push + sync_safety + NoteService Saga + ENTITY_REGISTRY + 4 个 schema）。本计划覆盖 Tasks 5-12 共 8 个任务，产出 ~30 个新测试 + 3 个新方法 + 1 个新路由文件 + 1 个集成测试文件。

**目标项目**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**venv Python**: `.venv\Scripts\python.exe`
**pytest 配置**: `asyncio_mode = "auto"`, `testpaths = ["tests"]`, `pythonpath = ["."]`

---

## 当前状态分析

### 已完成（Tasks 1-4）

| 任务 | 状态 | 产出 | 测试数 |
|------|------|------|--------|
| Task 1: Gate 测试修复 | ✅ | `test_integration.py` OpenAPI schema 计数 | 1 |
| Task 2: NoteService Saga | ✅ | `note.py` Try-Compensate + `sync_mode` 参数 | 14 |
| Task 3: sync_safety.py | ✅ | 5 道检查 + 3 辅助函数 | 12 |
| Task 4: SyncService.push | ✅ | push() + ENTITY_REGISTRY + 4 个 schema | 5 |

**当前测试基线**: 244 个测试全绿（含上述 32 个新测试）

### 待完成（Tasks 5-12）

| 任务 | 说明 | 新测试数 |
|------|------|----------|
| Task 5: pull() | 增量拉取 + note content 批量读 | 5 |
| Task 6: full() + status() | 全量快照(分页) + 统计计数 | 4 |
| Task 7: SAVEPOINT 兼容性 | NoteService Saga 在 begin_nested 内验证 | 3 |
| Task 8: sync_mode 集成 | push 委托 note 事件给 NoteService | 4 |
| Task 9: sync 路由 | 4 端点 + 注册 | 7 |
| Task 10: ENTITY_REGISTRY 验证 | 14 实体完整性门禁 | 3 |
| Task 11: sync 审计 | SyncAuditLog 写入 | 3 |
| Task 12: 集成测试 | 端到端双向同步 | 8 |

### 三层铁律（全程遵守）

1. **Routers commit / Services flush / Models 纯数据**: Service 不导入 `fastapi`，不调 `commit()`
2. **Note 模型无 content 字段**: .md 文件是唯一 Source of Truth，ORM 保留 `content_hash` + `word_count`
3. **双 JWT 认证**: Master Token(7天) + Space Token(8小时, 含 space_id)

### 关键代码现状

- `app/services/sync.py`: 仅 `push()` 方法，`SyncService.__init__(db, fs=None)` 已预留 fs 参数
- `app/services/note.py`: `__init__` 已有 `sync_mode: bool = False` 参数但未使用
- `app/file_system/engine/note_ops.py`: `read_notes_batch(note_ids)` 在 L116，返回 `list[str|None]`
- `app/models/sync_audit_log.py`: `SyncAuditLog(id, event_type, entity_type, entity_id, details, created_at)`
- `app/deps.py`: `get_file_system(ctx)` 依赖注入，返回 FileSystem 实例
- `app/routes/v1/__init__.py`: `build_v1_router()` 聚合所有子路由

### Windows 路径大小写约束

**关键**: Write 工具用大写 `PomodoroXII` 路径写入 `pomodoroxi` 目录时静默失败。所有后端文件写入必须通过 Python 脚本（`pathlib.Path.write_text(encoding="utf-8")`）使用小写路径 `e:\Development\MyAwesomeApp\pomodoroxi\...`。SearchReplace 同样不可靠。

---

## 执行依赖顺序

```
Task 7 (SAVEPOINT 测试) ─────── 纯测试,无新代码,可立即执行
Task 10 (REGISTRY 验证) ─────── 纯测试,可立即执行
    │
    ▼
Tasks 5+6 (pull/full/status) ── 核心读取方法
    │
    ├──▶ Task 8 (sync_mode 集成) ── 依赖 pull 存在
    │        │
    │        ▼
    └──▶ Task 11 (审计) ────────── 依赖所有方法存在
             │
             ▼
        Task 9 (sync 路由) ────── 依赖所有方法 + sync_mode
             │
             ▼
        Task 12 (集成测试) ────── 依赖全部完成
```

---

## 提议变更

### Task 7: C5 NoteService Saga SAVEPOINT 兼容性验证

**前置依赖**: Task 2 (已完成)

**涉及文件**: `tests/test_note_service.py`（追加 3 个测试）

**目标**: 验证 NoteService 的 Saga 方法在 `async with db.begin_nested()` 内正确工作——SAVEPOINT 回滚时 FS 补偿仍执行。

**测试代码**:

```python
# 追加到 tests/test_note_service.py 末尾

@pytest.mark.asyncio
async def test_saga_create_inside_savepoint_rolls_back_cleanly(space_session, tmp_path):
    """create() 在 SAVEPOINT 内 DB 失败 → SAVEPOINT 回滚 + FS 补偿删除。"""
    from app.services.note import NoteService
    from unittest.mock import patch, AsyncMock
    from app.services.base import BaseService

    fs = await _make_fs(tmp_path)

    async with space_session.begin_nested():
        svc = NoteService(space_session, fs)
        with patch.object(BaseService, "create", new=AsyncMock(side_effect=RuntimeError("DB down"))):
            with pytest.raises(RuntimeError, match="DB down"):
                await svc.create({"title": "SP", "content": "in savepoint"})

    # 补偿：.md 文件不应残留
    notes = await fs.list_notes()
    assert len(notes) == 0


@pytest.mark.asyncio
async def test_saga_update_inside_savepoint_restores_content(space_session, tmp_path):
    """update_content() 在 SAVEPOINT 内 DB 失败 → FS 内容恢复。"""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)
    note = await svc.create({"title": "Orig", "content": "Old content"})
    note_id = note.id

    original_flush = space_session.flush
    async def failing_flush(*args, **kwargs):
        raise RuntimeError("DB flush failed")
    space_session.flush = failing_flush

    try:
        async with space_session.begin_nested():
            with pytest.raises(RuntimeError, match="DB flush failed"):
                await svc.update_content(note_id, "New content")
    except Exception:
        pass  # SAVEPOINT 回滚可能抛出,忽略
    finally:
        space_session.flush = original_flush

    # 补偿：FS 内容应恢复为旧值
    content = await fs.read_note(note_id)
    assert content == "Old content"


@pytest.mark.asyncio
async def test_saga_delete_inside_savepoint_preserves_fs_on_rollback(space_session, tmp_path):
    """delete() 在 SAVEPOINT 内 DB 失败 → .md 保留。"""
    from app.services.note import NoteService

    fs = await _make_fs(tmp_path)
    svc = NoteService(space_session, fs)
    note = await svc.create({"title": "Keep", "content": "survive"})
    note_id = note.id

    original_flush = space_session.flush
    async def failing_flush(*args, **kwargs):
        raise RuntimeError("DB delete failed")
    space_session.flush = failing_flush

    try:
        async with space_session.begin_nested():
            with pytest.raises(RuntimeError, match="DB delete failed"):
                await svc.delete(note_id)
    except Exception:
        pass
    finally:
        space_session.flush = original_flush

    # .md 文件应仍可读
    content = await fs.read_note(note_id)
    assert content == "survive"
```

**验证命令**:
```powershell
cd 'e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend'
& '.venv\Scripts\python.exe' -m pytest tests/test_note_service.py -k savepoint -v
```

**验收标准**:
- [ ] 3 个 SAVEPOINT 兼容性测试全绿
- [ ] Saga 补偿在 SAVEPOINT 回滚后仍执行

---

### Task 10: C8 ENTITY_REGISTRY 验证

**前置依赖**: Task 4 (已完成)

**涉及文件**: `tests/test_sync_service.py`（追加 3 个测试）

**测试代码**:

```python
# 追加到 tests/test_sync_service.py

def test_entity_registry_has_14_entities():
    """ENTITY_REGISTRY 包含 14 个可同步实体。"""
    from app.services.sync import ENTITY_REGISTRY
    expected = {"task", "session", "reflection", "schedule", "quickNote",
                "note", "habit", "habitCheckIn", "timeBlock", "memoComment",
                "sessionQuickNote", "scheduleQuickNote", "taskQuickNote", "folder"}
    assert set(ENTITY_REGISTRY.keys()) == expected


def test_entity_registry_entries_have_required_keys():
    """每个条目含 model + schema_create + schema_update + pull_key。"""
    from app.services.sync import ENTITY_REGISTRY
    for etype, entry in ENTITY_REGISTRY.items():
        assert "model" in entry, f"{etype} missing 'model'"
        assert "schema_create" in entry, f"{etype} missing 'schema_create'"
        assert "schema_update" in entry, f"{etype} missing 'schema_update'"
        assert "pull_key" in entry, f"{etype} missing 'pull_key'"


def test_entity_registry_pull_keys_unique():
    """pull_key 必须唯一。"""
    from app.services.sync import ENTITY_REGISTRY
    pull_keys = [e["pull_key"] for e in ENTITY_REGISTRY.values()]
    assert len(pull_keys) == len(set(pull_keys)), "duplicate pull_keys"
```

**验证命令**:
```powershell
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -k entity_registry -v
```

**验收标准**:
- [ ] 14 个实体注册正确
- [ ] 每个含 model + schema_create + schema_update + pull_key
- [ ] pull_key 唯一

---

### Tasks 5+6: C3 pull + C4 full/status

**前置依赖**: Task 4 (已完成)

**涉及文件**:
- 修改: `app/services/sync.py`（追加 pull/full/status 方法）
- 修改: `app/schemas/sync.py`（追加响应 schema）
- 修改: `tests/test_sync_service.py`（追加 9 个测试）

#### pull() 方法

**签名**: `async def pull(self, since: str = "", limit: int = 1000) -> dict`

**返回结构**:
```python
{
    "server_time": "2026-07-02T10:00:00.000",
    "has_more": bool,
    "next_since": str,
    "tombstones": [{"entity_type": ..., "entity_id": ..., "deleted_at": ...}],
    "tasks": [...], "sessions": [...], ...  # 14 个 pull_key 分组
}
```

**实现逻辑**:
1. `now = normalize_timestamp(utc_now_iso_ms())`
2. 遍历 ENTITY_REGISTRY，每实体查询 `updated_at > since`，`limit+1` 条用于分页检测
3. Note 特殊处理: 收集 note_ids → `getattr(fs, 'read_notes_batch', None)` 批量读 content，无此方法则逐条 `fs.read_note()`
4. Tombstone 查询 `deleted_at > since`
5. 判断 `has_more`（任一实体查到 limit+1 条），`next_since` = 本页最大 updated_at

```python
async def pull(self, since: str = "", limit: int = 1000) -> dict[str, Any]:
    now = normalize_timestamp(utc_now_iso_ms())
    cutoff = normalize_timestamp(since) or ""
    result: dict[str, Any] = {"server_time": now}
    has_more = False
    max_updated = cutoff

    for etype, entry in ENTITY_REGISTRY.items():
        model = entry["model"]
        pull_key = entry["pull_key"]
        q = select(model)
        if cutoff:
            q = q.where(model.updated_at > cutoff)
        q = q.order_by(model.updated_at).limit(limit + 1)
        res = await self.db.execute(q)
        objs = res.scalars().all()
        if len(objs) > limit:
            has_more = True
            objs = objs[:limit]
        items = [serialize_entity(obj) for obj in objs]
        for obj in objs:
            ts = obj.updated_at or ""
            if ts > max_updated:
                max_updated = ts
        # Note: 附加 content
        if etype == "note" and self.fs and items:
            note_ids = [d["id"] for d in items]
            batch_fn = getattr(self.fs, "read_notes_batch", None)
            if batch_fn:
                contents = await batch_fn(note_ids)
                for d, c in zip(items, contents):
                    d["content"] = c or ""
            else:
                for d, nid in zip(items, note_ids):
                    try:
                        d["content"] = await self.fs.read_note(nid)
                    except (KeyError, FileNotFoundError):
                        d["content"] = ""
        result[pull_key] = items

    # Tombstones
    tomb_q = select(Tombstone)
    if cutoff:
        tomb_q = tomb_q.where(Tombstone.deleted_at > cutoff)
    tomb_res = await self.db.execute(tomb_q)
    result["tombstones"] = [
        {"entity_type": t.entity_type, "entity_id": t.entity_id,
         "deleted_at": t.deleted_at}
        for t in tomb_res.scalars().all()
    ]
    result["has_more"] = has_more
    result["next_since"] = max_updated if has_more else now
    return result
```

#### full() 方法

**签名**: `async def full(self, since: str = "", limit: int = 1000) -> dict`

**与 pull 的区别**: tombstones 不按 since 过滤（全量返回），附加 `"is_full": True`

```python
async def full(self, since: str = "", limit: int = 1000) -> dict[str, Any]:
    result = await self.pull(since=since, limit=limit)
    # full: tombstones 全量返回（不按 since 过滤）
    tomb_res = await self.db.execute(select(Tombstone))
    result["tombstones"] = [
        {"entity_type": t.entity_type, "entity_id": t.entity_id,
         "deleted_at": t.deleted_at}
        for t in tomb_res.scalars().all()
    ]
    result["is_full"] = True
    return result
```

#### status() 方法

**签名**: `async def status(self) -> dict`

**返回结构**:
```python
{
    "server_time": "...",
    "entity_counts": {"tasks": N, "sessions": N, ...},
    "tombstone_count": N
}
```

```python
async def status(self) -> dict[str, Any]:
    now = normalize_timestamp(utc_now_iso_ms())
    entity_counts: dict[str, int] = {}
    for etype, entry in ENTITY_REGISTRY.items():
        model = entry["model"]
        pull_key = entry["pull_key"]
        res = await self.db.execute(select(func.count()).select_from(model))
        entity_counts[pull_key] = res.scalar() or 0
    tomb_res = await self.db.execute(select(func.count()).select_from(Tombstone))
    return {
        "server_time": now,
        "entity_counts": entity_counts,
        "tombstone_count": tomb_res.scalar() or 0,
    }
```

#### 新增 Schema（`app/schemas/sync.py` 追加）

```python
class SyncPullResponse(BaseModel):
    server_time: str
    has_more: bool = False
    next_since: str = ""
    tombstones: list[dict] = []
    model_config = {"extra": "allow"}

class SyncFullResponse(BaseModel):
    server_time: str
    has_more: bool = False
    next_since: str = ""
    is_full: bool = True
    tombstones: list[dict] = []
    model_config = {"extra": "allow"}

class SyncStatusResponse(BaseModel):
    server_time: str
    entity_counts: dict[str, int]
    tombstone_count: int
```

#### TDD 测试（9 个）

```python
# --- pull 测试 (5) --- #

@pytest.mark.asyncio
async def test_pull_returns_all_entities(space_session):
    from app.services.sync import SyncService
    from app.models.task import Task
    space_session.add(Task(id="pull-1", title="Pull Me", status="todo"))
    await space_session.flush()
    svc = SyncService(space_session)
    result = await svc.pull("")
    assert "server_time" in result
    assert any(t["id"] == "pull-1" for t in result["tasks"])

@pytest.mark.asyncio
async def test_pull_filters_by_since(space_session):
    from app.services.sync import SyncService
    from app.models.task import Task
    space_session.add(Task(id="old-1", title="Old", status="todo",
                           updated_at="2026-06-01T00:00:00.000"))
    space_session.add(Task(id="new-1", title="New", status="todo",
                           updated_at="2026-07-01T00:00:00.000"))
    await space_session.flush()
    svc = SyncService(space_session)
    result = await svc.pull("2026-06-15T00:00:00.000")
    ids = [t["id"] for t in result["tasks"]]
    assert "new-1" in ids
    assert "old-1" not in ids

@pytest.mark.asyncio
async def test_pull_includes_tombstones(space_session):
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService
    await TombstoneService(space_session).create("task", "tomb-pull-1")
    svc = SyncService(space_session)
    result = await svc.pull("")
    assert any(t["entity_id"] == "tomb-pull-1" for t in result["tombstones"])

@pytest.mark.asyncio
async def test_pull_returns_all_14_groups(space_session):
    from app.services.sync import SyncService
    svc = SyncService(space_session)
    result = await svc.pull("")
    for key in ("tasks", "sessions", "reflections", "schedules",
                "quickNotes", "notes", "habits", "habitCheckIns",
                "timeBlocks", "memoComments", "sessionQuickNotes",
                "scheduleQuickNotes", "taskQuickNotes", "folders"):
        assert key in result, f"missing pull_key: {key}"

@pytest.mark.asyncio
async def test_pull_pagination_has_more(space_session):
    from app.services.sync import SyncService
    from app.models.task import Task
    for i in range(3):
        space_session.add(Task(id=f"pg-{i}", title=f"Page {i}", status="todo",
                               updated_at=f"2026-07-0{i+1}T00:00:00.000"))
    await space_session.flush()
    svc = SyncService(space_session)
    result = await svc.pull("", limit=2)
    assert result["has_more"] is True
    assert result["next_since"] != ""

# --- full 测试 (2) --- #

@pytest.mark.asyncio
async def test_full_returns_all_data_and_tombstones(space_session):
    from app.services.sync import SyncService
    from app.models.task import Task
    from app.services.tombstone import TombstoneService
    space_session.add(Task(id="full-1", title="Full", status="todo"))
    await TombstoneService(space_session).create("task", "full-tomb")
    await space_session.flush()
    svc = SyncService(space_session)
    result = await svc.full()
    assert result["is_full"] is True
    assert any(t["id"] == "full-1" for t in result["tasks"])
    assert any(t["entity_id"] == "full-tomb" for t in result["tombstones"])

@pytest.mark.asyncio
async def test_full_tombstones_not_filtered_by_since(space_session):
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService
    await TombstoneService(space_session).create("task", "old-tomb")
    await space_session.flush()
    svc = SyncService(space_session)
    result = await svc.full(since="2099-01-01T00:00:00.000")
    # full: tombstones 全量返回,不按 since 过滤
    assert any(t["entity_id"] == "old-tomb" for t in result["tombstones"])

# --- status 测试 (2) --- #

@pytest.mark.asyncio
async def test_status_returns_counts(space_session):
    from app.services.sync import SyncService
    from app.models.task import Task
    space_session.add_all([
        Task(id="s-1", title="S1", status="todo"),
        Task(id="s-2", title="S2", status="todo"),
    ])
    await space_session.flush()
    svc = SyncService(space_session)
    result = await svc.status()
    assert result["entity_counts"]["tasks"] >= 2
    assert "server_time" in result

@pytest.mark.asyncio
async def test_status_counts_tombstones(space_session):
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService
    await TombstoneService(space_session).create("task", "st-tomb-1")
    await TombstoneService(space_session).create("task", "st-tomb-2")
    svc = SyncService(space_session)
    result = await svc.status()
    assert result["tombstone_count"] >= 2
```

**验证命令**:
```powershell
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -v
```

**验收标准**:
- [ ] pull 返回 14 个实体分组 + tombstones + 分页信息
- [ ] pull note 含 content（来自 FS）
- [ ] full 的 tombstones 不按 since 过滤
- [ ] status 返回各实体计数 + tombstone 计数
- [ ] 不导入 fastapi，不调 commit

---

### Task 8: C6 NoteService sync_mode 集成

**前置依赖**: Tasks 2 + 5 (已完成/即将完成)

**涉及文件**:
- 修改: `app/services/sync.py`（push 中 note 事件委托给 NoteService）
- 修改: `app/services/note.py`（sync_mode 行为）
- 修改: `tests/test_sync_service.py`（追加 4 个测试）

**核心问题**: 当前 push() 对 note 执行 `Note(**entity_data)`，若 entity_data 含 `content` 会失败（Note 无 content 列）。

**push 侧改动**（在 savepoint 块内，通用 create/update 逻辑前）:

```python
# 在 push() 的 "async with self.db.begin_nested():" 块内:
if action in ("create", "update"):
    # Note 特殊处理：content 路由到 .md 文件
    if etype == "note" and self.fs is not None:
        event_applied = await self._push_note_event(
            action, str(entity_id), entity_data, now
        )
        if event_applied:
            applied.append(idx)
        continue  # 跳过通用逻辑
    # ... 通用 create/update 逻辑（现有代码不变）
```

**新增辅助方法 `_push_note_event()`**:

```python
async def _push_note_event(
    self, action: str, entity_id: str, entity_data: dict, now: str
) -> bool:
    """处理 note 实体的 push：content → .md，metadata → DB。

    委托给 NoteService(sync_mode=True)，在当前 savepoint 内执行。
    返回 True 表示应用成功，False 表示冲突/跳过。
    """
    from app.services.note import NoteService
    note_svc = NoteService(self.db, self.fs, sync_mode=True)

    if action == "create":
        existing = await self.db.execute(
            select(Note).where(Note.id == entity_id)
        )
        if existing.scalar_one_or_none():
            return await self._push_note_event("update", entity_id, entity_data, now)
        await note_svc.create(entity_data)
        return True

    elif action == "update":
        existing = await self.db.execute(
            select(Note).where(Note.id == entity_id)
        )
        obj = existing.scalar_one_or_none()
        if obj is None:
            return await self._push_note_event("create", entity_id, entity_data, now)
        # LWW 检查
        client_time = normalize_timestamp(entity_data.get("updated_at", now)) or now
        lww = self.safety.check_lww_conflict(obj, client_time)
        if lww:
            return False
        await note_svc.update(entity_id, entity_data)
        return True

    return False
```

**NoteService update_metadata sync_mode 改动**:

```python
async def update_metadata(self, id: str, data: dict[str, Any]) -> Any:
    data = dict(data)
    data.pop("content", None)
    data.pop("content_hash", None)
    data.pop("word_count", None)
    if "tags" in data and isinstance(data["tags"], list):
        data["tags"] = json.dumps(data["tags"])

    if self.sync_mode:
        # sync_mode: 保留客户端 updated_at，不覆盖为 utc_now_iso()
        obj = await self.get(id)
        for k, v in data.items():
            if hasattr(obj, k) and k != "id":
                setattr(obj, k, v)
        await self.db.flush()
        await self.db.refresh(obj)
        return obj
    return await super().update(id, data)
```

**TDD 测试（4 个）**:

```python
@pytest.mark.asyncio
async def test_push_note_create_writes_md_and_db(space_session, tmp_path):
    """push note create 含 content → 写 .md + DB 行。"""
    from app.services.sync import SyncService
    fs = await _make_fs(tmp_path)
    svc = SyncService(space_session, fs)
    result = await svc.push([{
        "type": "note", "action": "create",
        "entity": {"id": "note-sync-1", "title": "Synced Note",
                   "content": "Hello from sync"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
    assert 0 in result["applied"]
    content = await fs.read_note("note-sync-1")
    assert content == "Hello from sync"

@pytest.mark.asyncio
async def test_push_note_update_rewrites_md(space_session, tmp_path):
    """push note update 含 content → 重写 .md。"""
    from app.services.sync import SyncService
    fs = await _make_fs(tmp_path)
    svc = SyncService(space_session, fs)
    await svc.push([{
        "type": "note", "action": "create",
        "entity": {"id": "note-upd", "title": "Upd", "content": "Old"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
    await svc.push([{
        "type": "note", "action": "update",
        "entity": {"id": "note-upd", "content": "New content",
                   "updated_at": "2026-07-01T11:00:00.000"},
        "client_time": "2026-07-01T11:00:00.000Z",
    }])
    content = await fs.read_note("note-upd")
    assert content == "New content"

@pytest.mark.asyncio
async def test_push_note_delete_removes_both(space_session, tmp_path):
    """push note delete → 删 .md + DB + tombstone。"""
    from app.services.sync import SyncService
    from app.services.tombstone import TombstoneService
    fs = await _make_fs(tmp_path)
    svc = SyncService(space_session, fs)
    await svc.push([{
        "type": "note", "action": "create",
        "entity": {"id": "note-del", "title": "Del", "content": "bye"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
    await svc.push([{
        "type": "note", "action": "delete",
        "entity_id": "note-del",
        "client_time": "2026-07-01T11:00:00.000Z",
    }])
    with pytest.raises(KeyError):
        await fs.read_note("note-del")
    assert await TombstoneService(space_session).exists("note", "note-del") is not None

@pytest.mark.asyncio
async def test_pull_note_includes_content(space_session, tmp_path):
    """pull 返回的 note 包含从 .md 读取的 content。"""
    from app.services.sync import SyncService
    fs = await _make_fs(tmp_path)
    svc = SyncService(space_session, fs)
    await svc.push([{
        "type": "note", "action": "create",
        "entity": {"id": "note-pull-c", "title": "Pull", "content": "Pull content"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
    result = await svc.pull("")
    notes = result["notes"]
    target = [n for n in notes if n["id"] == "note-pull-c"]
    assert len(target) == 1
    assert target[0]["content"] == "Pull content"
```

**验证命令**:
```powershell
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -k "note" -v
```

**验收标准**:
- [ ] push note create 写 .md + DB（content 不进 DB）
- [ ] push note update 重写 .md + 更新 hash
- [ ] push note delete 删 .md + DB + tombstone
- [ ] pull note 含 content（从 .md 读取）
- [ ] 现有 5 个 push 测试不受影响（fs=None 不触发 note 分支）

---

### Task 11: C9 sync 审计（SyncAuditLog）

**前置依赖**: Tasks 5+6 (即将完成)

**涉及文件**:
- 修改: `app/services/sync.py`（push/pull/full/status 末尾追加审计写入）
- 修改: `tests/test_sync_service.py`（追加 3 个测试）

**新增辅助方法**:

```python
async def _write_audit(self, event_type: str, details: dict) -> None:
    """写入审计日志（仅 flush，不 commit）。"""
    from app.models.sync_audit_log import SyncAuditLog
    log = SyncAuditLog(
        event_type=event_type,
        entity_type="batch",
        entity_id="batch",
        details=json.dumps(details, ensure_ascii=False),
    )
    self.db.add(log)
    await self.db.flush()
```

**集成点**:

1. **push() return 前**:
```python
await self._write_audit("push", {
    "total_events": len(events),
    "applied_count": len(applied),
    "conflict_count": len(conflicts),
    "error_count": len(errors),
})
```

2. **pull() return 前**:
```python
await self._write_audit("pull", {
    "since": since,
    "has_more": has_more,
    "entity_counts": {k: len(v) for k, v in result.items()
                      if isinstance(v, list) and k != "tombstones"},
    "tombstone_count": len(result.get("tombstones", [])),
})
```

3. **status() return 前**:
```python
await self._write_audit("status", {
    "entity_counts": entity_counts,
    "tombstone_count": tombstone_count,
})
```

**TDD 测试（3 个）**:

```python
@pytest.mark.asyncio
async def test_push_writes_audit_log(space_session):
    """push 操作写入 SyncAuditLog 记录。"""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select
    svc = SyncService(space_session)
    await svc.push([{
        "type": "task", "action": "create",
        "entity": {"id": "audit-1", "title": "Audit", "status": "todo"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
    res = await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "push")
    )
    logs = res.scalars().all()
    assert len(logs) >= 1
    import json
    details = json.loads(logs[-1].details)
    assert details["applied_count"] == 1

@pytest.mark.asyncio
async def test_pull_writes_audit_log(space_session):
    """pull 操作写入 SyncAuditLog 记录。"""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select
    svc = SyncService(space_session)
    await svc.pull("")
    res = await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "pull")
    )
    assert len(res.scalars().all()) >= 1

@pytest.mark.asyncio
async def test_status_writes_audit_log(space_session):
    """status 操作写入 SyncAuditLog 记录。"""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select
    svc = SyncService(space_session)
    await svc.status()
    res = await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "status")
    )
    assert len(res.scalars().all()) >= 1
```

**验收标准**:
- [ ] push/pull/status 各写入 SyncAuditLog
- [ ] details 含操作摘要（事件数/计数等）
- [ ] 审计写入只 flush 不 commit

---

### Task 9: C7 sync 路由（4 端点 + 注册）

**前置依赖**: Tasks 5-8 + 11 (全部完成)

**涉及文件**:
- 新建: `app/routes/v1/sync.py`（须用 Python 脚本创建）
- 修改: `app/routes/v1/__init__.py`（注册 sync_router）
- 新建: `tests/test_sync_routes.py`（须用 Python 脚本创建）

**路由代码**:

```python
"""REST routes for sync.

4 endpoints:
- POST /sync/push  — push client changes (batch, max 500 events)
- GET  /sync/pull  — incremental pull (since cursor + limit)
- GET  /sync/full  — full sync (since + limit pagination)
- GET  /sync/status — sync status summary

Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context, get_file_system
from app.file_system.interfaces import FileSystem
from app.schemas.sync import SyncPushRequest
from app.services.sync import SyncService

router = APIRouter()


@router.post("/push")
async def push(
    data: SyncPushRequest,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Push client changes to server replica."""
    events = [e.model_dump() for e in data.events]
    result = await SyncService(db, fs).push(events)
    await db.commit()
    return result


@router.get("/pull")
async def pull(
    since: str = Query("", description="ISO timestamp cursor"),
    limit: int = Query(1000, ge=1, le=10000),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Incremental pull: entities updated after 'since'."""
    result = await SyncService(db, fs).pull(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/full")
async def full(
    limit: int = Query(1000, ge=1, le=10000),
    since: str = Query("", description="Pagination cursor"),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Full sync with pagination."""
    result = await SyncService(db, fs).full(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/status")
async def status(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return sync status summary."""
    result = await SyncService(db).status()
    await db.commit()
    return result
```

**注册到 v1 router**（修改 `app/routes/v1/__init__.py`）:

在 `build_v1_router()` 内添加:
```python
from app.routes.v1.sync import router as sync_router
# ...
router.include_router(sync_router, prefix="/sync", tags=["sync"])
```

**端点路径**:
- `POST /api/v1/sync/push`
- `GET /api/v1/sync/pull?since=...&limit=...`
- `GET /api/v1/sync/full?limit=...&since=...`
- `GET /api/v1/sync/status`

**TDD 路由测试（7 个）**:

```python
"""Tests for sync REST routes."""
import pytest


async def _get_space_token(client):
    """Helper: create space and return (token, space_id)."""
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post("/api/v1/auth/login", json={"password": "test123"})
    master_token = resp.json()["access_token"]
    resp = await client.post("/api/v1/spaces", json={"name": "Sync Space"},
                             headers={"Authorization": f"Bearer {master_token}"})
    space_id = resp.json()["id"]
    resp = await client.post(f"/api/v1/spaces/{space_id}/token",
                             headers={"Authorization": f"Bearer {master_token}"})
    return resp.json()["space_token"], space_id


@pytest.mark.asyncio
async def test_sync_push_endpoint(client):
    token, _ = await _get_space_token(client)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{
            "type": "task", "action": "create",
            "entity": {"id": "route-task-1", "title": "Route", "status": "todo"},
            "client_time": "2026-07-01T10:00:00.000Z",
        }]
    }, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert 0 in resp.json()["applied"]

@pytest.mark.asyncio
async def test_sync_pull_endpoint(client):
    token, _ = await _get_space_token(client)
    await client.post("/api/v1/sync/push", json={
        "events": [{
            "type": "task", "action": "create",
            "entity": {"id": "route-pull-1", "title": "Pull", "status": "todo"},
            "client_time": "2026-07-01T10:00:00.000Z",
        }]
    }, headers={"Authorization": f"Bearer {token}"})
    resp = await client.get("/api/v1/sync/pull",
                            headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert any(t["id"] == "route-pull-1" for t in resp.json()["tasks"])

@pytest.mark.asyncio
async def test_sync_full_endpoint(client):
    token, _ = await _get_space_token(client)
    resp = await client.get("/api/v1/sync/full?limit=10",
                            headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert "has_more" in resp.json()

@pytest.mark.asyncio
async def test_sync_status_endpoint(client):
    token, _ = await _get_space_token(client)
    resp = await client.get("/api/v1/sync/status",
                            headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert "entity_counts" in resp.json()

@pytest.mark.asyncio
async def test_sync_push_note_with_content(client):
    token, _ = await _get_space_token(client)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{
            "type": "note", "action": "create",
            "entity": {"id": "route-note-1", "title": "Route Note",
                       "content": "Via route"},
            "client_time": "2026-07-01T10:00:00.000Z",
        }]
    }, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert 0 in resp.json()["applied"]

@pytest.mark.asyncio
async def test_sync_unauthorized(client):
    resp = await client.post("/api/v1/sync/push", json={"events": []})
    assert resp.status_code == 401

@pytest.mark.asyncio
async def test_sync_push_exceeds_500_limit(client):
    token, _ = await _get_space_token(client)
    events = [{"type": "task", "action": "create",
               "entity": {"id": f"lim-{i}", "title": "x", "status": "todo"},
               "client_time": "2026-07-01T10:00:00.000Z"} for i in range(501)]
    resp = await client.post("/api/v1/sync/push", json={"events": events},
                             headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 422
```

**验证命令**:
```powershell
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_routes.py -v
```

**验收标准**:
- [ ] 4 端点全部用 space token
- [ ] push 后数据持久化（commit 在路由）
- [ ] pull 返回 note 含 content
- [ ] 无 token → 401, 超 500 events → 422
- [ ] Gate 测试 v1 路径数 >= 39（35 + 4 sync 端点）

---

### Task 12: C10 集成测试

**前置依赖**: Tasks 1-11 全部完成

**涉及文件**: 新建 `tests/test_sync_integration.py`（须用 Python 脚本创建）

**集成测试矩阵（8 个）**:

```python
"""End-to-end integration tests for sync engine."""
import pytest


async def _get_token(client):
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post("/api/v1/auth/login", json={"password": "test123"})
    master = resp.json()["access_token"]
    resp = await client.post("/api/v1/spaces", json={"name": "E2E"},
                             headers={"Authorization": f"Bearer {master}"})
    sid = resp.json()["id"]
    resp = await client.post(f"/api/v1/spaces/{sid}/token",
                             headers={"Authorization": f"Bearer {master}"})
    return resp.json()["space_token"]


@pytest.mark.asyncio
async def test_bidirectional_sync_push_then_pull(client):
    """push task → pull → task 在 pull 结果中。"""
    token = await _get_token(client)
    h = {"Authorization": f"Bearer {token}"}
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-1", "title": "E2E", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=h)
    resp = await client.get("/api/v1/sync/pull", headers=h)
    assert any(t["id"] == "e2e-1" for t in resp.json()["tasks"])

@pytest.mark.asyncio
async def test_lww_conflict_resolution(client):
    """服务器版本更新时 push 被拒(LWW)。"""
    token = await _get_token(client)
    h = {"Authorization": f"Bearer {token}"}
    # push v1
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-lww", "title": "v1", "status": "todo",
                               "updated_at": "2026-07-01T12:00:00.000"},
                    "client_time": "2026-07-01T12:00:00.000Z"}]
    }, headers=h)
    # push stale v2
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "update",
                    "entity": {"id": "e2e-lww", "title": "stale"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=h)
    assert resp.json()["conflicts"]

@pytest.mark.asyncio
async def test_tombstone_prevents_resurrection(client):
    """delete 后 push create 同 id → 冲突。"""
    token = await _get_token(client)
    h = {"Authorization": f"Bearer {token}"}
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-tomb", "title": "T", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=h)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "delete",
                    "entity_id": "e2e-tomb",
                    "client_time": "2026-07-01T11:00:00.000Z"}]
    }, headers=h)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-tomb", "title": "Resurrect"},
                    "client_time": "2026-07-01T12:00:00.000Z"}]
    }, headers=h)
    assert resp.json()["conflicts"]

@pytest.mark.asyncio
async def test_note_dual_storage_sync(client):
    """push note 含 content → pull content 正确。"""
    token = await _get_token(client)
    h = {"Authorization": f"Bearer {token}"}
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "note", "action": "create",
                    "entity": {"id": "e2e-note", "title": "E2E Note",
                               "content": "E2E content"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=h)
    resp = await client.get("/api/v1/sync/pull", headers=h)
    notes = resp.json()["notes"]
    target = [n for n in notes if n["id"] == "e2e-note"]
    assert len(target) == 1
    assert target[0]["content"] == "E2E content"

@pytest.mark.asyncio
async def test_savepoint_isolation_in_batch(client):
    """batch 中 1 个失败不影响其他。"""
    token = await _get_token(client)
    h = {"Authorization": f"Bearer {token}"}
    resp = await client.post("/api/v1/sync/push", json={
        "events": [
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-ok", "title": "OK", "status": "todo"},
             "client_time": "2026-07-01T10:00:00.000Z"},
            {"type": "nonexistent", "action": "create",
             "entity": {"id": "bad"},
             "client_time": "2026-07-01T10:00:00.000Z"},
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-ok2", "title": "OK2", "status": "todo"},
             "client_time": "2026-07-01T10:00:00.000Z"},
        ]
    }, headers=h)
    data = resp.json()
    assert 0 in data["applied"]
    assert 2 in data["applied"]
    assert len(data["errors"]) == 1

@pytest.mark.asyncio
async def test_sync_pagination(client):
    """full sync 分页 → 第二页无重叠。"""
    token = await _get_token(client)
    h = {"Authorization": f"Bearer {token}"}
    for i in range(3):
        await client.post("/api/v1/sync/push", json={
            "events": [{"type": "task", "action": "create",
                        "entity": {"id": f"e2e-pg-{i}", "title": f"P{i}",
                                   "status": "todo",
                                   "updated_at": f"2026-07-0{i+1}T00:00:00.000"},
                        "client_time": f"2026-07-0{i+1}T00:00:00.000Z"}]
        }, headers=h)
    p1 = (await client.get("/api/v1/sync/full?limit=1", headers=h)).json()
    p2 = (await client.get(f"/api/v1/sync/full?limit=1&since={p1['next_since']}",
                           headers=h)).json()
    p1_ids = {t["id"] for t in p1.get("tasks", [])}
    p2_ids = {t["id"] for t in p2.get("tasks", [])}
    assert not p1_ids & p2_ids

@pytest.mark.asyncio
async def test_sync_audit_logged(client):
    """push 后审计日志存在。"""
    token = await _get_token(client)
    h = {"Authorization": f"Bearer {token}"}
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-audit", "title": "A", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=h)
    # pull 也会写审计
    await client.get("/api/v1/sync/pull", headers=h)
    # 通过 status 验证（间接确认审计不阻塞）
    resp = await client.get("/api/v1/sync/status", headers=h)
    assert resp.status_code == 200

@pytest.mark.asyncio
async def test_sync_requires_authentication(client):
    """无 token → 401。"""
    resp = await client.get("/api/v1/sync/status")
    assert resp.status_code == 401
```

**验证命令**:
```powershell
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_integration.py -v
```

**验收标准**:
- [ ] 8 个集成测试全绿
- [ ] 覆盖: 双向同步、LWW、Tombstone、Note双存储、SAVEPOINT、分页、审计、认证

---

## 文件变更总览

### 新建文件（2 个）

| 文件路径 | 用途 | 创建方式 |
|---------|------|----------|
| `app/routes/v1/sync.py` | sync 路由(4 端点) | Python 脚本 |
| `tests/test_sync_integration.py` | 集成测试(8 个) | Python 脚本 |

### 修改文件（5 个）

| 文件路径 | 修改内容 | 修改方式 |
|---------|---------|----------|
| `app/services/sync.py` | 追加 pull/full/status + _push_note_event + _write_audit | Python 脚本 |
| `app/services/note.py` | update_metadata sync_mode 行为 | Python 脚本 |
| `app/schemas/sync.py` | 追加 3 个响应 schema | Python 脚本 |
| `app/routes/v1/__init__.py` | 注册 sync_router | Python 脚本 |
| `tests/test_sync_service.py` | 追加 ~20 个测试 | Python 脚本 |
| `tests/test_note_service.py` | 追加 3 个 SAVEPOINT 测试 | Python 脚本 |

**注意**: 所有后端文件写入必须通过 Python 脚本（`pathlib.Path.write_text(encoding="utf-8")`），使用小写路径 `e:\Development\MyAwesomeApp\pomodoroxi\...`。

---

## 假设与决策

1. **pull 使用 read_notes_batch 优先**: 有此方法时批量读(2次IO)，无则逐条读(2N次IO)
2. **full 复用 pull 逻辑**: 仅 tombstones 不过滤 since + 附加 is_full 标记
3. **sync_mode 保留客户端 updated_at**: 防止服务器覆盖客户端时间戳导致 LWW 误判
4. **push note 事件委托 NoteService**: 而非直接 ORM，确保 .md + DB 一致性(Saga)
5. **审计日志仅记录成功操作**: push 记录 applied/conflicts/errors 计数，不逐事件记录
6. **路由 push/pull/full 依赖 fs**: note content 需要 fs；status 不需要 fs
7. **ENTITY_REGISTRY 验证为同步测试**: 不需 async fixture，但 conftest autouse 会应用
8. **pull 分页用 limit+1 检测**: 查 limit+1 条，若返回 > limit 则 has_more=True

---

## 验证步骤

### 任务级验证

```powershell
cd 'e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend'

# Task 7: SAVEPOINT 兼容性
& '.venv\Scripts\python.exe' -m pytest tests/test_note_service.py -k savepoint -v

# Task 10: ENTITY_REGISTRY 验证
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -k entity_registry -v

# Tasks 5+6: pull/full/status
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -k "pull or full or status" -v

# Task 8: sync_mode 集成
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -k note -v

# Task 11: 审计
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -k audit -v

# Task 9: sync 路由
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_routes.py -v

# Task 12: 集成测试
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_integration.py -v
```

### 全量验证

```powershell
# 全部测试（预期 244 + ~37 新增 = ~281）
& '.venv\Scripts\python.exe' -m pytest -v

# Lint
& '.venv\Scripts\python.exe' -m ruff check app/ --fix

# 三层铁律检查
# 1. Services 不导入 fastapi
& '.venv\Scripts\python.exe' -c "import ast, pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if 'fastapi' in f.read_text(encoding='utf-8')]"

# 2. Services 不调 commit
& '.venv\Scripts\python.exe' -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if '.commit()' in f.read_text(encoding='utf-8')]"
```

### Gate 测试更新

`test_gate_all_v1_routes_registered` 当前断言 `>= 35`。新增 4 个 sync 端点后总数达 39+，**无需修改阈值**。

---

## 后续阶段概览（本计划不覆盖）

| 阶段 | 内容 | 前置 |
|------|------|------|
| Phase D | Notes/Search/Trash API + file_system 全集成 | Phase C |
| Phase E | 可靠性(backup/snapshot/consistency) + MCP Server | Phase D |
| Phase F | React 19 前端重建 | Phase B |
| Phase G | 数据迁移 + 端到端集成测试 | C/D/E/F |
| Phase H | 部署 + Docker Compose + CI/CD | Phase G |
