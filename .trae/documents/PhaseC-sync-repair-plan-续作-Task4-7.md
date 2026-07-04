# Phase C Sync 修复续作计划（Task 4-7）

> **派发文档**: [PhaseC-sync-repair-dispatch.md](file:///E:/Development/MyAwesomeApp/PomodoroXII/PhaseC-sync-repair-dispatch.md)
> **前作计划**: [PhaseC-sync-repair-plan.md](file:///E:/Development/MyAwesomeApp/PomodoroXII/.trae/documents/PhaseC-sync-repair-plan.md)（Task 1-3 已完成）
> **范围**: backend 已跟踪代码（**严禁**碰 `backend/app/mcp/` 与 `backend/tests/test_mcp_server.py`）
> **方法**: 严格 TDD（Red → Verify Red → Green → Verify Green → Refactor）
> **基线**: 406 passed（排除 MCP WIP），目标：基线 + 新增测试 全绿

---

## 当前状态分析

### 已完成（前一轮）
- ✅ **Task 1 (P0-1)**: Note content 随 pull/full 下发 — [sync.py:460-475](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L460-L475) 已注入 `content` / `content_missing`，[test_sync_note_content.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_note_content.py) 7 测试全绿
- ✅ **Task 2 (P0-2)**: Timestamp 规范化 + (updated_at, id) 排序 — [time.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/time.py) 3 位毫秒，[sync_safety.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_safety.py) `normalize_timestamp` 重写，[mixins.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/mixins.py) `updated_at` 用 `utc_now_iso_ms`，[sync.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py) 排序按 `(updated_at, id)`，alembic 006 数据迁移，[test_sync_cursor_pagination.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_cursor_pagination.py) 4 测试
- ✅ **Task 3 (P1-1)**: applied/conflicts 契约修正 — [sync.py:99-204](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L99-L204) `applied.append` 已包裹 `if resolution in ("ok", "conflict_remote"):`，[test_sync_service.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_service.py) 新增 5 测试

### 待实施
- ❌ **Task 4 (P1-3)**: Note sync update 保留 client_updated_at — `base.py:75-85`、`note.py:115-171`、`sync.py:399` 均未修改
- 🟡 **Task 5 (P1-2)**: Entity type alias map + meta sync_entity_type 字段 — 部分已实施（[entities.py:73](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/entities.py#L73) 已加 `sync_entity_type: str | None = None`，[builtin.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/builtin.py) 7 实体已填充 `sync_entity_type`）；剩余 sync.py alias map、meta.serialize、EntitySpecOut schema 均未实施
- ❌ **Task 6 (P2-1)**: RelationService.link 改用 SAVEPOINT — [relation.py:78](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/relation.py#L78) 仍 `await self.db.rollback()`
- ❌ **Task 7 (P2-2)**: CI lint 修复 — [ci.yml:71-72](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L71-L72) 仍 `|| true`，[pyproject.toml:23-28](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L23-L28) dev extras 无 ruff，[ci.yml:11](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L11) 注释仍 "361 tests"

### 架构铁律（必须遵守）
1. **routes commit / services flush** — services 永不调 `db.commit()`
2. **services 不调 `db.rollback()`** — 用 `begin_nested()` SAVEPOINT 或 `expunge()` 隔离失败
3. **services 不 import FastAPI**
4. **TDD 铁律**: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST（Task 7 CI 配置文件属于 TDD 例外）

---

## 修复任务清单（按推荐顺序）

### Task 4: P1-3 — Note sync update 保留 client_updated_at

**问题**:
- [sync.py:398-399](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L398-L399) `_push_note_event` update 分支设置 `update_data["updated_at"] = client_ts_n` 后调用 `await note_svc.update(eid, update_data)`
- [note.py:133](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L133) `update_content` 用 `obj.updated_at = utc_now_iso()` 覆盖
- [note.py:158](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L158) `update_metadata` 调用 `super().update(id, data)`
- [base.py:80](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py#L80) `update` 无条件 `obj.updated_at = utc_now_iso()` 覆盖

**TDD 步骤**:

#### Red — 在 [test_sync_service.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_service.py) 末尾追加 3 个测试

```python
@pytest.mark.asyncio
async def test_push_note_update_preserves_client_updated_at(space_session, tmp_path):
    """P1-3: sync push note update should preserve client_updated_at in DB row."""
    from app.services.sync import SyncService
    from app.models.note import Note

    fs = await _make_fs_for_sync(tmp_path)
    svc = SyncService(space_session, fs)
    eid = "p13-note-update-content"

    # Step 1: push note create with client_updated_at=10:00
    await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid, "title": "Original", "content": "old body", "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])

    # Step 2: push note update with client_updated_at=12:00 + new content
    result = await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "update",
        "payload": {"title": "Updated", "content": "new body"},
        "client_updated_at": "2026-07-04T12:00:00.000Z",
    }])

    assert len(result["applied"]) == 1
    row = await space_session.get(Note, eid)
    # DB row's updated_at should be client_ts (not server-now)
    assert row.updated_at == "2026-07-04T12:00:00.000Z"
    # FS content should be updated
    content = await fs.read_note(eid)
    assert "new body" in content


@pytest.mark.asyncio
async def test_push_note_update_preserves_client_updated_at_metadata_only(space_session, tmp_path):
    """P1-3: sync push note update with only metadata (no content) should preserve client_updated_at."""
    from app.services.sync import SyncService
    from app.models.note import Note

    fs = await _make_fs_for_sync(tmp_path)
    svc = SyncService(space_session, fs)
    eid = "p13-note-update-meta"

    # Create with client_updated_at=10:00
    await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid, "title": "Original", "content": "body", "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])

    # Update only title (no content) with client_updated_at=12:00
    result = await svc.push([{
        "entity_type": "note",
        "entity_id": eid,
        "action": "update",
        "payload": {"title": "Updated Title"},
        "client_updated_at": "2026-07-04T12:00:00.000Z",
    }])

    assert len(result["applied"]) == 1
    row = await space_session.get(Note, eid)
    assert row.updated_at == "2026-07-04T12:00:00.000Z"
    assert row.title == "Updated Title"


@pytest.mark.asyncio
async def test_sync_mode_update_does_not_bump_updated_at_in_base_service(space_session, tmp_path):
    """P1-3: BaseService.update with bump_updated_at=False should NOT bump updated_at/version."""
    from app.services.base import BaseService
    from app.models.task import Task

    # Seed a task directly via BaseService
    base = BaseService(space_session)
    base.model = Task
    eid = "p13-base-bump-false"
    obj = await base.create({
        "id": eid, "title": "Seed", "status": "todo",
        "priority": "medium", "tags": "[]",
        "updated_at": "2026-07-04T10:00:00.000Z",
    })
    original_ts = obj.updated_at
    original_version = obj.version

    # Update with bump_updated_at=False
    updated = await base.update(eid, {"title": "New"}, bump_updated_at=False)
    assert updated.title == "New"
    # updated_at and version should be unchanged
    assert updated.updated_at == original_ts
    assert updated.version == original_version

    # Update with default bump_updated_at=True should bump
    bumped = await base.update(eid, {"title": "Bumped"})
    assert bumped.updated_at != original_ts
    assert bumped.version == original_version + 1
```

#### 验证 Red
```powershell
cd backend
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at_metadata_only tests/test_sync_service.py::test_sync_mode_update_does_not_bump_updated_at_in_base_service -v
```
**预期**: 3 测试全部失败（`base.update()` 不接受 `bump_updated_at` 参数；`note.update_content/metadata` 覆盖 `updated_at`）

#### Green — 修改

1. **[base.py:75-85](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py#L75-L85)** `update`:
```python
async def update(
    self, id: str, data: dict[str, Any], *, bump_updated_at: bool = True,
) -> Any:
    """Update fields on the row with *id* and bump updated_at.

    When *bump_updated_at* is False (sync_mode=True path), the caller
    is responsible for setting ``updated_at`` and ``version`` in *data*.
    """
    obj = await self.get(id)
    for k, v in data.items():
        setattr(obj, k, v)
    if bump_updated_at:
        obj.updated_at = utc_now_iso()
        if hasattr(obj, "version"):
            obj.version = (obj.version or 0) + 1
    await self.db.flush()
    await self.db.refresh(obj)
    return obj
```

2. **[note.py:115-144](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L115-L144)** `update_content`:
```python
async def update_content(
    self, id: str, content: str, *, updated_at_override: str | None = None,
) -> Any:
    """Rewrite the .md file and sync content_hash/word_count.

    Saga: save old content before FS rewrite; if DB flush fails,
    restore the old .md content.

    When *updated_at_override* is provided (sync_mode=True), the DB
    row's updated_at is set to this value instead of server-now.
    """
    # ... (existing Saga logic unchanged)
    meta = await self.fs.edit_note(id, content)
    try:
        obj = await self.get(id)
        obj.content_hash = meta.content_hash
        obj.word_count = meta.word_count
        obj.updated_at = (
            updated_at_override if updated_at_override is not None
            else utc_now_iso()
        )
        await self.db.flush()
        await self.db.refresh(obj)
        return obj
    except Exception:
        # ... (existing compensation unchanged)
```

3. **[note.py:146-158](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L146-L158)** `update_metadata`:
```python
async def update_metadata(
    self, id: str, data: dict[str, Any],
    *, updated_at_override: str | None = None,
) -> Any:
    """Update DB-only fields (title, tags, category, etc.).

    Content-managed fields (content, content_hash, word_count) are
    stripped -- they must be updated via ``update_content``.
    """
    data = dict(data)
    data.pop("content", None)
    data.pop("content_hash", None)
    data.pop("word_count", None)
    if "tags" in data:
        data["tags"] = json.dumps(_parse_tags(data["tags"]))
    if updated_at_override is not None:
        data["updated_at"] = updated_at_override
    return await super().update(id, data, bump_updated_at=False)
```

4. **[note.py:160-171](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L160-L171)** `update`:
```python
async def update(
    self, id: str, data: dict[str, Any],
    *, updated_at_override: str | None = None,
) -> Any:
    """Dispatch update: content goes to fs, the rest to DB.

    When *updated_at_override* is provided (sync_mode=True), the
    client timestamp is preserved across both content and metadata
    updates instead of being bumped to server-now.
    """
    data = dict(data)
    content = data.pop("content", None)
    obj = None
    if content is not None:
        obj = await self.update_content(
            id, content, updated_at_override=updated_at_override,
        )
    if data:
        obj = await self.update_metadata(
            id, data, updated_at_override=updated_at_override,
        )
    if obj is None:
        obj = await self.get(id)
    return obj
```

5. **[sync.py:399](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L399)** `_push_note_event` update 分支:
```python
# Remote wins: apply update via NoteService.
note_svc = NoteService(self.db, self.fs, sync_mode=True)
update_data = dict(payload)
update_data["updated_at"] = client_ts_n
await note_svc.update(eid, update_data, updated_at_override=client_ts_n)
return "conflict_remote"
```

#### 验证 Green
```powershell
cd backend
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at_metadata_only tests/test_sync_service.py::test_sync_mode_update_does_not_bump_updated_at_in_base_service tests/test_note_service.py tests/test_sync_service.py -v --tb=short
```
**预期**: 3 新测试通过 + 现有 note/sync 测试无回归

---

### Task 5: P1-2 — Entity type alias map + meta sync_entity_type 字段

**问题**:
- [builtin.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/builtin.py) registry 用 snake_case（`quick_note`），[sync.py:51-66](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L51-L66) ENTITY_REGISTRY 用 camelCase（`quickNote`）
- 客户端按 `/meta/entities` 生成 payload 会被 `/sync/push` 拒绝（`Unknown entity_type`）
- 已实施部分: `EntitySpec` 类已加 `sync_entity_type` 字段，`builtin.py` 7 实体已填充此字段
- 待实施: sync.py alias map、meta.serialize 输出、EntitySpecOut schema

**TDD 步骤**:

#### Red — 新建 [test_sync_entity_alias.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_entity_alias.py) + 扩展 [test_routes_meta.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_routes_meta.py)

```python
# test_sync_entity_alias.py (新建)
"""P1-2: sync push should accept snake_case entity_type via alias map."""

import pytest
import uuid


@pytest.mark.asyncio
async def test_push_accepts_snake_case_quick_note(space_session):
    """push() with entity_type='quick_note' should be canonicalized to 'quickNote'."""
    from app.services.sync import SyncService
    from app.models.quick_note import QuickNote

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    result = await svc.push([{
        "entity_type": "quick_note",  # snake_case from registry
        "entity_id": eid,
        "action": "create",
        "payload": {"id": eid, "content": "hi", "tags": "[]"},
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert result["errors"] == []
    row = await space_session.get(QuickNote, eid)
    assert row is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("snake,camel", [
    ("quick_note", "quickNote"),
    ("habit_check_in", "habitCheckIn"),
    ("time_block", "timeBlock"),
    ("memo_comment", "memoComment"),
    ("session_quick_note", "sessionQuickNote"),
    ("schedule_quick_note", "scheduleQuickNote"),
    ("task_quick_note", "taskQuickNote"),
])
async def test_push_accepts_all_snake_case_aliases(space_session, snake, camel):
    """push() should accept all 7 snake_case aliases."""
    from app.services.sync import SyncService
    from app.services.sync import ENTITY_REGISTRY

    # Verify camelCase is in registry (sanity)
    assert camel in ENTITY_REGISTRY

    svc = SyncService(space_session)
    eid = f"alias-{snake}-1"
    payload = {"id": eid}
    # Add minimum required fields per entity type
    if snake == "quick_note":
        payload.update({"content": "x", "tags": "[]"})
    elif snake == "habit_check_in":
        payload.update({"habit_id": "h1", "date": "2026-07-04"})
    elif snake == "time_block":
        payload.update({"date": "2026-07-04", "start_time": "10:00", "end_time": "11:00"})
    elif snake == "memo_comment":
        payload.update({"note_id": "n1", "content": "x"})
    elif snake in ("session_quick_note", "schedule_quick_note", "task_quick_note"):
        payload.update({"quick_note_id": "qn1"})

    result = await svc.push([{
        "entity_type": snake,
        "entity_id": eid,
        "action": "create",
        "payload": payload,
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1, f"Failed for {snake}: {result}"
    assert result["errors"] == []


@pytest.mark.asyncio
async def test_push_still_accepts_camel_case_backward_compat(space_session):
    """push() with entity_type='quickNote' should still work (backward compat)."""
    from app.services.sync import SyncService
    from app.models.quick_note import QuickNote

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    result = await svc.push([{
        "entity_type": "quickNote",  # camelCase (legacy)
        "entity_id": eid,
        "action": "create",
        "payload": {"id": eid, "content": "hi", "tags": "[]"},
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert await space_session.get(QuickNote, eid) is not None


@pytest.mark.asyncio
async def test_push_unknown_entity_still_errors(space_session):
    """push() with truly unknown entity_type should still error."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    result = await svc.push([{
        "entity_type": "not_real",
        "entity_id": "x",
        "action": "create",
        "payload": {},
    }])
    assert len(result["errors"]) == 1
    assert "Unknown entity_type" in result["errors"][0]["error"]
```

```python
# test_routes_meta.py 追加
@pytest.mark.asyncio
async def test_meta_entity_response_includes_sync_entity_type(client):
    """GET /api/v1/meta/entities/quick_note should return sync_entity_type='quickNote'."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities/quick_note", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "quick_note"
    assert body["sync_entity_type"] == "quickNote"


@pytest.mark.asyncio
async def test_meta_entity_response_sync_entity_type_for_task(client):
    """GET /api/v1/meta/entities/task should return sync_entity_type='task' (no alias)."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities/task", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sync_entity_type"] == "task"  # falls back to name


@pytest.mark.asyncio
async def test_meta_list_entities_includes_sync_entity_type(client):
    """GET /api/v1/meta/entities should include sync_entity_type field."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    entities = resp.json()["entities"]
    # Find quick_note and verify
    qn = next(e for e in entities if e["name"] == "quick_note")
    assert qn["sync_entity_type"] == "quickNote"
    # Find task and verify fallback
    task = next(e for e in entities if e["name"] == "task")
    assert task["sync_entity_type"] == "task"
```

#### 验证 Red
```powershell
cd backend
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py::test_meta_entity_response_includes_sync_entity_type tests/test_routes_meta.py::test_meta_entity_response_sync_entity_type_for_task tests/test_routes_meta.py::test_meta_list_entities_includes_sync_entity_type -v
```
**预期**: 全部失败（snake_case push 报 Unknown entity_type；meta 响应缺 sync_entity_type 字段）

#### Green — 修改

1. **新建 [app/services/sync_entity_types.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_entity_types.py)**（避免 sync.py ↔ meta.py 循环依赖）:
```python
"""Sync entity_type alias map.

The registry uses snake_case names (e.g. ``quick_note``) for URLs and
metadata, while the sync protocol uses camelCase (e.g. ``quickNote``)
for ENTITY_REGISTRY keys. This module provides the canonicalization
function used by sync push to accept both forms.

Keeping this in a separate module avoids a circular import between
``app.services.sync`` and ``app.services.meta``.
"""
from __future__ import annotations

# snake_case registry name -> camelCase ENTITY_REGISTRY key
ENTITY_TYPE_ALIASES: dict[str, str] = {
    "quick_note": "quickNote",
    "habit_check_in": "habitCheckIn",
    "time_block": "timeBlock",
    "memo_comment": "memoComment",
    "session_quick_note": "sessionQuickNote",
    "schedule_quick_note": "scheduleQuickNote",
    "task_quick_note": "taskQuickNote",
}


def canonicalize_entity_type(etype: str) -> str:
    """Map snake_case registry names to camelCase ENTITY_REGISTRY keys.

    If *etype* is not in the alias map, it is returned unchanged (so
    camelCase keys and unknown names pass through for downstream
    validation).
    """
    return ENTITY_TYPE_ALIASES.get(etype, etype)


def resolve_sync_entity_type(registry_name: str) -> str:
    """Return the sync_entity_type for a registry name.

    Used by MetaService.serialize to populate ``sync_entity_type`` in
    the meta API response. If the name has no alias, it is returned
    unchanged (so ``task`` -> ``task``).
    """
    return ENTITY_TYPE_ALIASES.get(registry_name, registry_name)
```

2. **[sync.py:99-112](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L99-L112)** `push()`:
   - 在文件顶部添加 `from app.services.sync_entity_types import canonicalize_entity_type`
   - 在 `etype = event.get("entity_type", "")` 后添加 `etype = canonicalize_entity_type(etype)`

3. **[meta.py:98-115](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/meta.py#L98-L115)** `MetaService.serialize`:
   - 在文件顶部添加 `from app.services.sync_entity_types import resolve_sync_entity_type`
   - 在返回 dict 中添加 `"sync_entity_type": resolve_sync_entity_type(spec.name)` 字段
   - 注意：用 `spec.sync_entity_type or resolve_sync_entity_type(spec.name)` 优先使用 spec 中显式声明的值

```python
@staticmethod
def serialize(spec: EntitySpec) -> dict[str, Any]:
    return {
        "name": spec.name,
        "model_path": spec.model_path,
        "table_name": spec.table_name,
        "storage_type": spec.storage_type.value,
        "category": spec.category.value,
        "sync_enabled": spec.sync_enabled,
        "soft_delete": spec.soft_delete,
        "primary_key": spec.primary_key,
        "description": spec.description,
        "fields": [MetaService._field_dict(f) for f in spec.fields],
        # P1-2: expose the sync_entity_type so clients know which name
        # to use in /sync/push payloads. Falls back to `name` when None.
        "sync_entity_type": spec.sync_entity_type or spec.name,
    }
```

4. **[schemas/meta.py:38-52](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/meta.py#L38-L52)** `EntitySpecOut`:
```python
class EntitySpecOut(BaseModel):
    """Full metadata for one entity."""

    name: str
    model_path: str
    table_name: str
    storage_type: StorageType
    category: EntityCategory
    sync_enabled: bool
    soft_delete: bool
    primary_key: str = "id"
    description: str = ""
    fields: list[FieldSpecOut]
    # P1-2: sync protocol entity_type (camelCase for legacy clients)
    sync_entity_type: str = ""

    model_config = {"from_attributes": True}
```

#### 验证 Green
```powershell
cd backend
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py -v --tb=short
```
**预期**: 全部通过

---

### Task 6: P2-1 — RelationService.link 改用 SAVEPOINT

**问题**: [relation.py:78](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/relation.py#L78) `await self.db.rollback()` 会回滚调用方事务里其他改动，违反"services 不调 db.rollback()"铁律。

**TDD 步骤**:

#### Red — 在 [test_relation_service.py](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_relation_service.py) 末尾追加 2 个测试

```python
@pytest.mark.asyncio
async def test_link_does_not_rollback_outer_transaction_on_integrity_error(space_session):
    """P2-1: link() IntegrityError should only rollback SAVEPOINT, not outer transaction."""
    from app.services.relation import RelationService
    from app.services.task import TaskService
    from app.models.task import Task
    from app.models.task_quick_note import TaskQuickNote
    from sqlalchemy import select

    # Step 1: create a task in the outer transaction (flush, no commit)
    task_svc = TaskService(space_session)
    task = await task_svc.create({
        "id": "p21-task-1",
        "title": "Outer",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })

    # Step 2: pre-insert a duplicate row to trigger IntegrityError on link()
    existing_row = TaskQuickNote(
        id="p21-existing-link",
        task_id="p21-task-1",
        quick_note_id="p21-qn-1",
    )
    space_session.add(existing_row)
    await space_session.flush()

    # Step 3: call link() with the same (task_id, quick_note_id) — should
    # detect existing via pre-check OR hit IntegrityError via race.
    # Either way, the outer task should still be in the session.
    rel_svc = RelationService(space_session)
    link = await rel_svc.link("task", "p21-task-1", "p21-qn-1")
    assert link is not None
    assert link.task_id == "p21-task-1"
    assert link.quick_note_id == "p21-qn-1"

    # Step 4: verify the outer task is still queryable (not rolled back)
    row = await space_session.get(Task, "p21-task-1")
    assert row is not None
    assert row.title == "Outer"


@pytest.mark.asyncio
async def test_link_uses_savepoint_not_session_rollback(space_session):
    """P2-1: link() should use SAVEPOINT, not session.rollback()."""
    from app.services.relation import RelationService
    from app.models.task_quick_note import TaskQuickNote

    # Pre-insert a row to trigger the duplicate path
    existing = TaskQuickNote(
        id="p21-preexists",
        task_id="p21-task-2",
        quick_note_id="p21-qn-2",
    )
    space_session.add(existing)
    await space_session.flush()

    # Spy on session.rollback: if called, raise to fail the test
    original_rollback = space_session.rollback
    rollback_called = []

    async def spy_rollback(*args, **kwargs):
        rollback_called.append(True)
        # Call original to keep behavior, but record the call
        return await original_rollback(*args, **kwargs)

    space_session.rollback = spy_rollback  # type: ignore

    rel_svc = RelationService(space_session)
    # Force the IntegrityError path by adding a duplicate then flushing
    dup = TaskQuickNote(
        id="p21-dup",
        task_id="p21-task-2",
        quick_note_id="p21-qn-2",
    )
    space_session.add(dup)
    # link() should detect existing via pre-check and return it without
    # attempting the insert. Even if it did attempt, SAVEPOINT should
    # catch the IntegrityError, not session.rollback().
    link = await rel_svc.link("task", "p21-task-2", "p21-qn-2")
    assert link is not None
    # session.rollback() should NOT have been called
    assert len(rollback_called) == 0, "session.rollback() was called — should use SAVEPOINT"
```

#### 验证 Red
```powershell
cd backend
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py::test_link_does_not_rollback_outer_transaction_on_integrity_error tests/test_relation_service.py::test_link_uses_savepoint_not_session_rollback -v
```
**预期**: 至少 `test_link_uses_savepoint_not_session_rollback` 失败（当前实现调 `session.rollback()`）

#### Green — 修改 [relation.py:55-88](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/relation.py#L55-L88) `link`:
```python
async def link(self, kind: str, parent_id: str, quick_note_id: str) -> Any:
    """Create a junction row.  Idempotent -- returns existing if present.

    Handles TOCTOU races by catching IntegrityError inside a SAVEPOINT
    (begin_nested) so the outer transaction is not rolled back.
    """
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
        # SAVEPOINT automatically rolled back; expunge the failed row
        # so it doesn't linger in the session as pending.
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

#### 验证 Green
```powershell
cd backend
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py -v --tb=short
```
**预期**: 全部通过（含 2 个新测试）

---

### Task 7: P2-2 — CI lint 修复

**问题**:
- [ci.yml:71-72](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L71-L72) `uv run ruff check app tests || true` 让 lint 永远不失败
- [pyproject.toml:23-28](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L23-L28) dev extras 没 ruff
- [ci.yml:11](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L11) 注释写死"361 tests"已过时（当前 406+）
- [ci.yml:79-84](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L79-L84) pytest 命令未排除 MCP WIP

**TDD 步骤**: 此任务为配置修复，无单元测试（TDD 例外：Configuration files）。验证方式 = 本地跑 `ruff check` 确认 0 errors。

#### Green — 修改

1. **[pyproject.toml:23-28](file:///E:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L23-L28)** dev extras 增加 `"ruff>=0.8"`:
```toml
[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-asyncio>=0.24",
    "httpx>=0.28",
    "ruff>=0.8",
]
```

2. **[ci.yml:11](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L11)** 注释改为不写死数量:
```yaml
#   1. test   — pytest (excludes MCP WIP) + ruff lint (blocking)
```

3. **[ci.yml:71-72](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L71-L72)** 移除 `|| true`，lint 改为 blocking:
```yaml
      - name: Lint with ruff (blocking)
        run: uv run ruff check app tests
```

4. **[ci.yml:74-84](file:///E:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L74-L84)** pytest 加 `--ignore=tests/test_mcp_server.py`:
```yaml
      - name: Run pytest (excludes MCP WIP)
        env:
          PYTHONDONTWRITEBYTECODE: "1"
          PYTHONUNBUFFERED: "1"
        run: |
          uv run pytest tests/ \
            --ignore=tests/test_mcp_server.py \
            --no-header \
            -q \
            --tb=short \
            --maxfail=10 \
            -p no:cacheprovider
```

5. **本地跑 ruff check**，如有 lint 错误则修复（不新增功能）:
```powershell
cd backend
uv run ruff check app tests
```
**预期**: 0 errors（如有错误，逐个修复）

---

## 验证步骤

### 单元测试（每个 Task 完成后）
```powershell
cd backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_service.py tests/test_sync_entity_alias.py tests/test_routes_meta.py tests/test_relation_service.py tests/test_note_service.py tests/test_sync_note_content.py tests/test_sync_cursor_pagination.py tests/test_sync_safety.py tests/test_time.py -v --tb=short
```

### 全量回归（所有 Task 完成后）
```powershell
cd backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest --ignore=tests/test_mcp_server.py -q --tb=short
```
**期望**: 406（基线）+ Task 4 新增 3 + Task 5 新增 ~5 + Task 6 新增 2 = ~416 测试全绿

### Lint 验证（Task 7 完成后）
```powershell
cd backend
uv run ruff check app tests
```
**期望**: 0 errors

---

## 假设与决策

1. **Task 4 `bump_updated_at` 参数设计**: 用 keyword-only 参数（`*, bump_updated_at: bool = True`）避免污染位置参数；默认 True 保持向后兼容
2. **Task 4 `updated_at_override` 参数设计**: 同样用 keyword-only；`None` 时走原逻辑（`utc_now_iso()`），非 None 时用 override 值
3. **Task 5 alias map 模块位置**: 新建 `app/services/sync_entity_types.py`（纯常量+函数，无 FastAPI/SQLAlchemy 依赖），避免 sync.py ↔ meta.py 循环依赖
4. **Task 5 `EntitySpecOut.sync_entity_type` 默认值**: 用 `str = ""` 而非 `str | None = None`，简化客户端处理（永远有值，fallback 到 name）
5. **Task 5 `MetaService.serialize` 优先级**: 用 `spec.sync_entity_type or spec.name` — 优先用 registry 中显式声明的值，fallback 到 name（覆盖 task/session/note/folder/reflection/habit/schedule 等 camelCase=name 的实体）
6. **Task 6 SAVEPOINT 行为**: SQLAlchemy 2.0 async 中 `async with db.begin_nested()` 在 with 块退出时自动 commit SAVEPOINT；IntegrityError 会触发自动 rollback 到 SAVEPOINT，不影响外层事务
7. **Task 6 `expunge(row)` 必要性**: SAVEPOINT rollback 后，pending 状态的 `row` 仍存在于 session；`expunge` 将其移除，避免后续操作误用半成品对象
8. **Task 7 ruff 版本**: `>=0.8` 是当前主流稳定版本，与 Python 3.13 兼容
9. **Task 7 lint 错误修复**: 如 ruff 报现有代码错误，仅做最小修复（不重构、不新增功能）
10. **MCP WIP 隔离**: 严格执行，不读取、不修改 `backend/app/mcp/` 与 `backend/tests/test_mcp_server.py`；CI 中通过 `--ignore=tests/test_mcp_server.py` 排除

---

## 执行顺序

按 Task 4 → 5 → 6 → 7 顺序执行。每个 Task 严格遵循 TDD Red-Green-Refactor。

- Task 4 先做：P1-3 是 release blocker（client timestamp 丢失会导致 LWW 判断错误）
- Task 5 次之：P1-2 影响客户端兼容性
- Task 6 第三：P2-1 是架构铁律违反
- Task 7 最后：避免 lint 错误干扰前面 Task 的代码探索；且 Task 4-6 完成后 lint 一次跑完，避免重复修复

## 后续行动（不在本轮）

- P2-3: Runtime Alembic migration 接入（meta + space DB startup）— 派发文档明确延后
- P0-2 完美分页: 引入 `since_id` 或 opaque cursor 参数（breaking change，需客户端配合）— 前作计划已记录
- tombstone entity_type 是否统一到 snake_case（长期方案 B，breaking change）— 派发文档明确不在本轮
