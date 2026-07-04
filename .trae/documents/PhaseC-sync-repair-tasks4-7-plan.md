# Phase C Sync 修复 — Tasks 4-7 续作计划

> **派发文档**: `E:/Development/MyAwesomeApp/PomodoroXII/PhaseC-sync-repair-dispatch.md`
> **范围**: Task 4 (P1-3) Green 验证 + Task 5 (P1-2) + Task 6 (P2-1) + Task 7 (P2-2) + 全量回归
> **基线**: 406 passed (排除 MCP WIP `tests/test_mcp_server.py`)
> **目标**: 406 + 新增测试全绿
> **铁律**: 严格 TDD (Red → Verify Red → Green → Verify Green → Refactor)
> **禁区**: 不修改 `backend/app/mcp/` 和 `backend/tests/test_mcp_server.py`

---

## 一、Current State Analysis (基于 Phase 1 探索)

### Task 4 (P1-3) — 代码已应用, 待 Green 验证

**已应用的修复** (上一轮 session):

1. `backend/app/services/base.py`:
   - 新增 `from sqlalchemy.orm.attributes import flag_modified` (line 16)
   - `update()` 方法新增 `bump_updated_at: bool = True` 参数 (line 77)
   - 当 `bump_updated_at=False` 且 `data` 不含 `updated_at` 时, 显式 `obj.updated_at = original_ts` + `flag_modified(obj, "updated_at")` (line 95-102)
   - **关键**: `flag_modified` 强制 SQLAlchemy 把 `updated_at` 列纳入 UPDATE SET 子句, 阻止 `SyncMixin.onupdate=utc_now_iso_ms` 触发

2. `backend/app/services/sync.py` `_push_note_event`:
   - create 分支 (line 371-380): 已加 `data["updated_at"] = client_ts_n` (line 376)
   - update 分支 idempotent upsert (line 389-395): 已加 `data["updated_at"] = client_ts_n` (line 392)
   - update 分支 remote wins (line 400-404): 已设 `update_data["updated_at"] = client_ts_n` (line 402) + 传 `updated_at_override=client_ts_n` (line 403)

3. `backend/app/services/note.py`:
   - `update_content`: 已加 `*, updated_at_override: str | None = None` 参数 (line 116), 用 `obj.updated_at = updated_at_override if updated_at_override is not None else utc_now_iso()` (line 138-141)
   - `update_metadata`: 已加 `*, updated_at_override: str | None = None` 参数 (line 155-156), 设 `data["updated_at"] = updated_at_override` 后调 `super().update(id, data, bump_updated_at=False)` (line 172-174)
   - `update`: 已加 `*, updated_at_override: str | None = None` 参数 (line 177-178), 透传给 `update_content` 和 `update_metadata` (line 191, 195)

**已存在的 Red 测试** (`backend/tests/test_sync_service.py`):
- `test_push_note_update_preserves_client_updated_at` (line 1158): push create (10:00) → push update with content (12:00) → DB `updated_at == "2026-07-04T12:00:00.000Z"`
- `test_push_note_update_preserves_client_updated_at_metadata_only` (line 1197): 同上但只 update title
- `test_sync_mode_update_does_not_bump_updated_at_in_base_service` (line 1235): 单测 `BaseService.update(bump_updated_at=False)` 不 bump updated_at/version

### Task 5 (P1-2) — 部分完成, 需补全

**已完成**:
- `backend/app/registry/entities.py`: `EntitySpec` 已有 `sync_entity_type: str | None = None` 字段 (line 73) 和 `pull_key: str | None = None` (line 74)
- `backend/app/registry/builtin.py`: 7 个 snake_case 实体已填充 `sync_entity_type` (quickNote/habitCheckIn/timeBlock/memoComment/sessionQuickNote/scheduleQuickNote/taskQuickNote)
- `backend/tests/test_parity_registry_sync.py`: 已验证 REGISTRY vs ENTITY_REGISTRY parity (用 `spec.sync_entity_type or spec.name`)

**缺失**:
- `backend/app/services/meta.py` `MetaService.serialize()` (line 98-115): **未输出** `sync_entity_type` 和 `pull_key` 字段
- `backend/app/schemas/meta.py` `EntitySpecOut` (line 38-52): **未声明** `sync_entity_type` 和 `pull_key` 字段
- **缺少 alias map + canonicalize 函数**: 客户端按 `/meta/entities` 拿到 snake_case `name`, 但 `/sync/push` 只认 camelCase, 需要在 sync 层做 canonicalize
- `backend/app/services/sync.py` `push()`: 当前 `if etype not in ENTITY_REGISTRY` (line 106) 直接拒绝 snake_case

### Task 6 (P2-1) — 未实现

- `backend/app/services/relation.py` line 78: `await self.db.rollback()` 在 `IntegrityError` handler 中
- 违背"routes commit, services flush"铁律: service 层 rollback 会撤销同事务中其他改动
- `backend/tests/test_relation_service.py`: 现有 9 个测试, 无 "同事务其他改动不被回滚" 的测试

### Task 7 (P2-2) — 未实现

- `backend/pyproject.toml` line 24-28: dev extras 只有 pytest/pytest-asyncio/httpx, 缺 `ruff`
- `.github/workflows/ci.yml`:
  - line 11: 注释 "pytest 361 tests" (实际 406)
  - line 71-72: `uv run ruff check app tests || true` (非阻塞)
  - line 74: 注释 "Run pytest (361 tests)" (实际 406)

---

## 二、Proposed Changes (按 TDD 顺序)

### Task 4: P1-3 Green 验证 (无新代码, 只跑测试)

**步骤**:
1. 跑 3 个 Task 4 测试 (只跑这 3 个, 避免状态污染):
   ```powershell
   cd e:\Development\MyAwesomeApp\PomodoroXII\backend
   $env:TEMP = (Resolve-Path .tmp).Path
   $env:TMP = $env:TEMP
   $site = (Resolve-Path .venv\Lib\site-packages).Path
   $env:PYTHONPATH = ".;$site"
   & 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at_metadata_only tests/test_sync_service.py::test_sync_mode_update_does_not_bump_updated_at_in_base_service -v --tb=short --no-header
   ```
2. 若全绿 → 跑 `test_note_service.py` + `test_base_service.py` 回归
3. 若有失败 → 分析失败原因, 修复, 再验证

**预期结果**: 3 个测试全绿, 回归无失败

---

### Task 5: P1-2 Entity alias map + meta sync_entity_type 字段

#### 5.1 Red 阶段 — 新增测试

**新建** `backend/tests/test_sync_entity_alias.py`:

```python
"""P1-2: sync entity_type alias map (snake_case ↔ camelCase) canonicalization."""
from __future__ import annotations

import pytest


def test_canonicalize_camelCase_unchanged():
    """camelCase entity_type 应原样返回 (ENTITY_REGISTRY 已有 key)."""
    from app.services.sync_entity_types import canonicalize_entity_type
    assert canonicalize_entity_type("quickNote") == "quickNote"
    assert canonicalize_entity_type("taskQuickNote") == "taskQuickNote"
    assert canonicalize_entity_type("task") == "task"
    assert canonicalize_entity_type("note") == "note"


def test_canonicalize_snakeCase_to_camelCase():
    """snake_case entity_type 应映射到 camelCase."""
    from app.services.sync_entity_types import canonicalize_entity_type
    assert canonicalize_entity_type("quick_note") == "quickNote"
    assert canonicalize_entity_type("habit_check_in") == "habitCheckIn"
    assert canonicalize_entity_type("time_block") == "timeBlock"
    assert canonicalize_entity_type("memo_comment") == "memoComment"
    assert canonicalize_entity_type("session_quick_note") == "sessionQuickNote"
    assert canonicalize_entity_type("schedule_quick_note") == "scheduleQuickNote"
    assert canonicalize_entity_type("task_quick_note") == "taskQuickNote"


def test_canonicalize_unknown_returns_none():
    """未知 entity_type 应返回 None (让 sync.py 走 errors 分支)."""
    from app.services.sync_entity_types import canonicalize_entity_type
    assert canonicalize_entity_type("nonexistent") is None
    assert canonicalize_entity_type("") is None


@pytest.mark.asyncio
async def test_push_accepts_snake_case_entity_type(space_session, tmp_path):
    """P1-2: /sync/push 应接受 snake_case entity_type 并 canonicalize."""
    from app.services.sync import SyncService
    from app.models.task import Task

    svc = SyncService(space_session)
    eid = "p12-snake-task"
    result = await svc.push([{
        "entity_type": "task",  # snake_case == camelCase for task, control
        "entity_id": eid,
        "action": "create",
        "payload": {"id": eid, "title": "Snake", "status": "todo",
                    "priority": "medium", "tags": "[]"},
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert len(result["errors"]) == 0


@pytest.mark.asyncio
async def test_push_accepts_snake_case_quick_note(space_session):
    """P1-2: /sync/push 应接受 'quick_note' 并 canonicalize 到 'quickNote'."""
    from app.services.sync import SyncService
    from app.models.quick_note import QuickNote

    svc = SyncService(space_session)
    eid = "p12-snake-qn"
    result = await svc.push([{
        "entity_type": "quick_note",  # snake_case
        "entity_id": eid,
        "action": "create",
        "payload": {"id": eid, "content": "hi", "tags": "[]"},
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert len(result["errors"]) == 0
    row = await space_session.get(QuickNote, eid)
    assert row is not None
```

**扩展** `backend/tests/test_routes_meta.py` (在文件末尾追加):

```python
@pytest.mark.asyncio
async def test_meta_serialize_includes_sync_entity_type(client):
    """P1-2: /meta/entities 应返回 sync_entity_type 字段."""
    from app.deps import _MASTER_TOKEN
    headers = {"Authorization": f"Bearer {_MASTER_TOKEN}"}
    res = await client.get("/api/v1/meta/entities", headers=headers)
    assert res.status_code == 200
    data = res.json()
    # 找到 quick_note 实体
    qn = next(e for e in data["entities"] if e["name"] == "quick_note")
    assert qn["sync_entity_type"] == "quickNote"
    # task 没有 sync_entity_type (name == sync_entity_type), 应为 None 或 "task"
    task = next(e for e in data["entities"] if e["name"] == "task")
    # task 的 sync_entity_type 应为 None (未显式设置)
    assert task.get("sync_entity_type") is None


@pytest.mark.asyncio
async def test_meta_serialize_includes_pull_key(client):
    """P1-2: /meta/entities 应返回 pull_key 字段."""
    from app.deps import _MASTER_TOKEN
    headers = {"Authorization": f"Bearer {_MASTER_TOKEN}"}
    res = await client.get("/api/v1/meta/entities", headers=headers)
    assert res.status_code == 200
    data = res.json()
    qn = next(e for e in data["entities"] if e["name"] == "quick_note")
    assert qn["pull_key"] == "quickNotes"
    task = next(e for e in data["entities"] if e["name"] == "task")
    assert task["pull_key"] == "tasks"
```

**验证 Red**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py::test_meta_serialize_includes_sync_entity_type tests/test_routes_meta.py::test_meta_serialize_includes_pull_key -v --tb=short --no-header
```
预期: 5 个测试全失败 (ModuleNotFoundError: No module named 'app.services.sync_entity_types' + KeyError: 'sync_entity_type')

#### 5.2 Green 阶段 — 实现

**新建** `backend/app/services/sync_entity_types.py`:

```python
"""P1-2: Entity type alias map — canonicalize snake_case ↔ camelCase.

The registry exposes snake_case entity names (e.g. 'quick_note'), while
SyncService.ENTITY_REGISTRY uses camelCase keys (e.g. 'quickNote') for
legacy client compatibility. This module bridges the two so that clients
using either convention are accepted by /sync/push.
"""
from __future__ import annotations

from app.registry import REGISTRY

# Build alias map from REGISTRY: snake_case name -> camelCase sync_entity_type.
# Entities without sync_entity_type fall back to their name (identity mapping).
_ALIAS_MAP: dict[str, str] = {}


def _build_alias_map() -> dict[str, str]:
    """Build the alias map lazily (REGISTRY may not be populated at import)."""
    alias: dict[str, str] = {}
    for spec in REGISTRY.list_sync_enabled():
        canonical = spec.sync_entity_type or spec.name
        # Always map the registry name -> canonical
        alias[spec.name] = canonical
        # If sync_entity_type differs from name, also map it (reverse direction
        # is identity since canonical is already the camelCase key)
        if spec.sync_entity_type and spec.sync_entity_type != spec.name:
            alias[spec.sync_entity_type] = spec.sync_entity_type
    return alias


def canonicalize_entity_type(etype: str) -> str | None:
    """Return the canonical camelCase entity_type, or None if unknown.

    Accepts both snake_case (registry name) and camelCase (sync_entity_type).
    """
    if not etype:
        return None
    # Lazy build + cache
    global _ALIAS_MAP
    if not _ALIAS_MAP:
        _ALIAS_MAP = _build_alias_map()
    return _ALIAS_MAP.get(etype)
```

**修改** `backend/app/services/sync.py` `push()`:

在 `push()` 方法的 `for event in events:` 循环开头 (line 99-106 附近), 把:
```python
etype = event.get("entity_type", "")
...
if etype not in ENTITY_REGISTRY:
    errors.append({...})
    continue
```
改成:
```python
from app.services.sync_entity_types import canonicalize_entity_type

etype_raw = event.get("entity_type", "")
etype = canonicalize_entity_type(etype_raw) or ""
...
if etype not in ENTITY_REGISTRY:
    errors.append({
        "entity_type": etype_raw,  # 原样返回, 方便客户端调试
        "entity_id": eid,
        "error": f"Unknown entity_type: {etype_raw}",
    })
    continue
```

注意: `canonicalize_entity_type` 的 import 放在文件顶部, 不在循环内。

**修改** `backend/app/services/meta.py` `MetaService.serialize()`:

在返回 dict 中加两个字段:
```python
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
    "sync_entity_type": spec.sync_entity_type,  # P1-2: 新增
    "pull_key": spec.pull_key,  # P1-2: 新增
}
```

**修改** `backend/app/schemas/meta.py` `EntitySpecOut`:

```python
class EntitySpecOut(BaseModel):
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
    sync_entity_type: str | None = None  # P1-2: 新增
    pull_key: str | None = None  # P1-2: 新增

    model_config = {"from_attributes": True}
```

**修改** `backend/app/registry/builtin.py`:

为 7 个 snake_case 实体之外的实体补 `pull_key` (从 ENTITY_REGISTRY 反推)。实际上, `EntitySpec` 已有 `pull_key` 字段但 builtin.py 没填充。需要为所有 14 个 sync_enabled 实体补 `pull_key`:
- task → "tasks"
- session → "sessions"
- note → "notes"
- folder → "folders"
- quick_note → "quickNotes" (已有 sync_entity_type)
- reflection → "reflections"
- habit → "habits"
- habit_check_in → "habitCheckIns"
- schedule → "schedules"
- time_block → "timeBlocks"
- memo_comment → "memoComments"
- session_quick_note → "sessionQuickNotes"
- schedule_quick_note → "scheduleQuickNotes"
- task_quick_note → "taskQuickNotes"

**验证 Green**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py -v --tb=short --no-header
```
预期: 全部通过

---

### Task 6: P2-1 RelationService.link 改用 SAVEPOINT

#### 6.1 Red 阶段 — 新增测试

**在** `backend/tests/test_relation_service.py` 末尾追加:

```python
@pytest.mark.asyncio
async def test_link_does_not_rollback_outer_transaction(space_session):
    """P2-1: link() IntegrityError 不应回滚外层事务的其他改动.

    场景: 同事务中先创建一个 Task, 再用 link() 触发 IntegrityError
    (通过先 insert 再 link 同一对), 验证 Task 仍在 session 中.
    """
    from app.services.relation import RelationService
    from app.models.task import Task
    from sqlalchemy import select

    # Step 1: 创建一个 Task (待会儿验证它没被回滚)
    task_id = uuid.uuid4().hex
    task = Task(
        id=task_id, title="Survivor", status="todo",
        priority="medium", tags="[]",
    )
    space_session.add(task)
    await space_session.flush()

    # Step 2: 创建一个 link, 然后再次 link 同一对触发 IntegrityError
    svc = RelationService(space_session)
    qn_id = uuid.uuid4().hex
    first = await svc.link("task", task_id, qn_id)
    assert first is not None

    # Step 3: 再次 link 同一对 — 应触发 IntegrityError 并被 handler 捕获
    # 注意: 这里不直接 flush 重复 PK, 而是依赖 link() 内部的 TOCTOU 路径
    # 通过手动 insert 一个重复行来模拟 race
    from app.models.task_quick_note import TaskQuickNote
    dup = TaskQuickNote(task_id=task_id, quick_note_id=qn_id)
    space_session.add(dup)
    # 现在 session 里有两个相同 (task_id, qn_id) 的行, link() 的 select
    # 会找到第一个, 但如果走 flush 路径会触发 IntegrityError
    second = await svc.link("task", task_id, qn_id)
    # second 应该返回 existing (不是 dup)
    assert second.id == first.id

    # Step 4: 验证 Task 没被回滚
    survived = await space_session.get(Task, task_id)
    assert survived is not None, "Task was rolled back by link() handler!"
    assert survived.title == "Survivor"


@pytest.mark.asyncio
async def test_link_savepoint_releases_cleanly(space_session):
    """P2-1: link() 正常路径下 SAVEPOINT 应正确 release, 不影响后续操作."""
    from app.services.relation import RelationService
    from app.models.task_quick_note import TaskQuickNote
    from sqlalchemy import select

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    # 正常 link
    link = await svc.link("task", task_id, qn_id)
    assert link is not None

    # 验证后续操作正常 (SAVEPOINT 已 release)
    res = await space_session.execute(
        select(TaskQuickNote).where(TaskQuickNote.task_id == task_id)
    )
    rows = res.scalars().all()
    assert len(rows) == 1
```

**验证 Red**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py::test_link_does_not_rollback_outer_transaction tests/test_relation_service.py::test_link_savepoint_releases_cleanly -v --tb=short --no-header
```
预期: `test_link_does_not_rollback_outer_transaction` 失败 (Task 被回滚), `test_link_savepoint_releases_cleanly` 可能通过 (现有代码正常路径)

#### 6.2 Green 阶段 — 实现

**修改** `backend/app/services/relation.py` `link()`:

把现有的:
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
        await self.db.flush()
        await self.db.refresh(row)
        return row
    except IntegrityError:
        # Race: another concurrent request inserted the same row.
        await self.db.rollback()
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

改成:
```python
async def link(self, kind: str, parent_id: str, quick_note_id: str) -> Any:
    """Create a junction row.  Idempotent -- returns existing if present.

    P2-1: Uses SAVEPOINT (begin_nested) so IntegrityError only rolls back
    the insert, not the caller's outer transaction.
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
            # SAVEPOINT: on IntegrityError, only this savepoint rolls back,
            # not the outer transaction. The row was added to session before
            # the savepoint; we need to expunge it on failure to keep
            # session state clean.
            await self.db.flush()
        await self.db.refresh(row)
        return row
    except IntegrityError:
        # Race: another concurrent request inserted the same row.
        # SAVEPOINT already rolled back; expunge the duplicate from session.
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

**验证 Green**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py -v --tb=short --no-header
```
预期: 全部通过 (含原有 9 个 + 新增 2 个)

---

### Task 7: P2-2 CI lint 修复

#### 7.1 修改 `backend/pyproject.toml`

dev extras 加 `ruff`:
```toml
[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-asyncio>=0.24",
    "httpx>=0.28",
    "ruff>=0.8",
]
```

#### 7.2 修改 `.github/workflows/ci.yml`

1. line 11 注释: `pytest 361 tests` → `pytest test suite (count tracked by tests/)`
2. line 71-72: `uv run ruff check app tests || true` → `uv run ruff check app tests` (移除 `|| true`)
3. line 74 注释: `Run pytest (361 tests)` → `Run pytest`

#### 7.3 验证 ruff 本地通过

```powershell
cd e:\Development\MyAwesomeApp\PomodoroXII\backend
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m ruff check app tests
```

若有 lint 错误, 修复 (只修新增代码引入的, 不动现有代码风格)。如果现有代码有大量 lint 错误且非本轮引入, 在计划中记录并跳过 (Task 7 范围只到 "让 lint 成为门禁", 不含 "修复所有历史 lint")。

---

## 三、Assumptions & Decisions

1. **Task 5 方案 A (alias map)**: 派发文档明确推荐短期兼容方案, 不做 breaking change。`canonicalize_entity_type` 接受 snake_case + camelCase, 输出 camelCase (ENTITY_REGISTRY key)。
2. **Task 5 pull_key 补全**: `EntitySpec` 已有 `pull_key` 字段但 builtin.py 未填充。本轮一并补全 14 个 sync_enabled 实体的 `pull_key`, 让 `/meta/entities` 完整暴露同步契约。
3. **Task 6 SAVEPOINT 设计**: `begin_nested()` 包住 `flush()`, IntegrityError 时 SAVEPOINT 自动回滚, 但 session 中的 `row` 对象需要手动 `expunge()` 避免状态污染。这是 SQLAlchemy 的标准模式。
4. **Task 6 测试策略**: 不直接 mock IntegrityError (难造), 而是通过 "手动 add 重复行 + link()" 让 flush 触发真实 IntegrityError。这样测试更接近真实 race 场景。
5. **Task 7 ruff 版本**: 选 `>=0.8` (2024 年稳定版本, 与 Python 3.13 兼容)。
6. **测试隔离**: `conftest.py` 重写了 `tmp_path` 返回 `tests/` 目录 (Trae 沙箱限制), 导致测试间共享文件系统。本轮验证时只跑相关测试文件, 避免状态污染。最后全量回归时再清理 orphaned 文件。
7. **不碰 MCP WIP**: 严格遵守派发文档约束, 不修改 `backend/app/mcp/` 和 `backend/tests/test_mcp_server.py`。

---

## 四、Verification Steps

### 阶段性验证 (每个 Task 完成后)

```powershell
# Task 4 验证
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at_metadata_only tests/test_sync_service.py::test_sync_mode_update_does_not_bump_updated_at_in_base_service tests/test_note_service.py tests/test_base_service.py -v --tb=short --no-header

# Task 5 验证
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py tests/test_parity_registry_sync.py -v --tb=short --no-header

# Task 6 验证
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py -v --tb=short --no-header

# Task 7 验证
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m ruff check app tests
```

### 全量回归 (最后一步)

```powershell
cd e:\Development\MyAwesomeApp\PomodoroXII\backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest --ignore=tests/test_mcp_server.py -q
```

**预期**: 406 (基线) + 5 (Task 5) + 2 (Task 6) = 413 passed, 0 failed

如果出现状态污染导致的失败, 清理 `tests/notes/`, `tests/index.db`, `tests/meta.db`, `tests/spaces/` 后重跑。

---

## 五、执行顺序 (TodoList)

1. ✅ Task 4 Green 验证 (跑 3 测试 + 回归)
2. ⏳ Task 5 Red: 新建 `test_sync_entity_alias.py` + 扩展 `test_routes_meta.py` + 验证 Red
3. ⏳ Task 5 Green: 新建 `sync_entity_types.py` + 修改 `sync.py`/`meta.py`/`schemas/meta.py`/`builtin.py` + 验证 Green
4. ⏳ Task 6 Red: 在 `test_relation_service.py` 追加 2 测试 + 验证 Red
5. ⏳ Task 6 Green: `relation.py` 改 SAVEPOINT + 验证 Green
6. ⏳ Task 7: `pyproject.toml` 加 ruff + `ci.yml` 移除 `|| true` + 跑 ruff check
7. ⏳ 全量回归 + lint 验证 (预期 413 passed)
