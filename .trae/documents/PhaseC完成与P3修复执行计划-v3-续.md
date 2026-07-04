# Phase C 完成与 P3 修复执行计划 v3-续

> **创建日期**: 2026-07-04
> **状态**: Plan Mode Phase 3 完成,待用户批准执行
> **上轮状态**: C9 进行中 (_write_audit 方法已添加,调用点未添加)
> **本轮目标**: 完成 C9 → C7 → C10 → P3.1-P3.6 → 收尾

## 1. 当前状态分析

### 1.1 已完成 (上轮)

- **C1-C6, C8**: SyncService push/pull/full/status + ENTITY_REGISTRY 14 实体 + _push_note_event (sync_mode) + sync_safety (LWW/timestamp sanitize) 全部完成
- **C9 部分完成**:
  - ✅ `app/services/sync.py` L433-462 新增 `_write_audit` 方法 (**设计改进**: 不调用 `db.rollback()`,仅捕获异常,避免撤销已应用的事件变更)
  - ✅ `tests/test_sync_service.py` L553-624 新增 3 测试 (push_writes_audit_log / pull_writes_audit_log / audit_failure_does_not_break_main_flow)
  - ❌ push() 中 L130-134 (note 路径) 和 L162-166 (通用路径) `applied.append` 后**未调用** `_write_audit`
  - ❌ pull() L370 `result["next_since"] = max_ts` 后**未调用** `_write_audit`
- **P0/P1 前置**: project_memory.md 修正 + P2-1/P2-5/P2-6 全部完成 (已通过验证)

### 1.2 待实施 (本轮)

| 任务 | 文件 | 内容 | 测试数 |
|------|------|------|--------|
| C9 收尾 | `app/services/sync.py` | push 两处 + pull 一处追加 `_write_audit` 调用 | 已写 3 |
| C7 | `app/routes/v1/sync.py` 新建 | 4 端点 (push/pull/full/status) + 注册到 `__init__.py` | 7 |
| C10 | `tests/test_sync_integration.py` 新建 | 端到端集成测试 (HTTP 层) | 8 |
| P3.1 | `app/services/task.py` | TaskService.update 处理 tags list→JSON | 1 |
| P3.2 | `app/routes/v1/trash.py` | purge_item N+1 修复 (单查询批量) | 1 |
| P3.3 | `app/services/serializers.py` | serialize_entity 的 json.loads 加 try/except | 2 |
| P3.4 | `app/models/note.py` + `alembic/versions/003_note_status_check.py` | Note status CheckConstraint | 1 |
| P3.5 | `app/models/task.py` + `alembic/versions/004_task_indexes.py` | Task status/priority/due_date index=True | 1 |
| P3.6 | `app/deps.py` | get_space_context 校验 space_id 存在性 | 1 |
| 收尾 | `c:\Users\20564\.trae-cn\memory\projects\-e-Development-MyAwesomeApp-PomodoroXII\project_memory.md` | 标注 Phase C 完成 + 更新进度表 | - |

**预计新增测试**: 7+8+1+1+2+1+1+1 = 22 测试

## 2. C9 收尾 — SyncService 审计调用点

### 2.1 修改 1: push() note 事件路径

**文件**: `backend/app/services/sync.py`
**位置**: L130-134 后追加
**当前代码** (L130-134):
```python
applied.append({
    "entity_type": etype,
    "entity_id": eid,
    "action": action,
})
```
**追加**:
```python
await self._write_audit(
    "push", etype, eid,
    details=f"action={action} resolution={resolution}",
)
```

### 2.2 修改 2: push() 通用事件路径

**位置**: L162-166 后追加 (与 2.1 相同代码)

### 2.3 修改 3: pull() 末尾

**位置**: L370 `result["next_since"] = max_ts` 后、`return result` 前追加
```python
await self._write_audit(
    "pull", "batch", "",
    details=f"since={since} limit={limit} has_more={result['has_more']}",
)
```

### 2.4 验证

```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -k audit -v
```
预期: 3 测试全绿 (含 audit_failure_does_not_break_main_flow 回归保护)

### 2.5 关键决策

- **`_write_audit` 不调用 `db.rollback()`**: 计划原文 `await self.db.rollback()` 会撤销整个事务 (包括已应用的事件变更)。改为仅捕获异常并记录日志。原因:`db.rollback()` 会回滚 SAVEPOINT 外的所有变更,导致事件丢失。
- **`status()` 不写审计**: 决策已确认,只读操作无需审计。

## 3. C7 — Sync REST 路由

### 3.1 文件: `backend/app/routes/v1/sync.py` (新建)

**4 端点**:
- `POST /api/v1/sync/push` — 接收 `SyncPushRequest`,调用 `SyncService.push()`
- `GET /api/v1/sync/pull` — query 参数 `since` + `limit`,调用 `SyncService.pull()`
- `GET /api/v1/sync/full` — 同 pull 但返回全量 tombstones
- `GET /api/v1/sync/status` — 返回 entity_counts + tombstone_count

**模板参考**: `app/routes/v1/notes.py` (get_space_db / get_file_system / get_space_context 依赖模式)

**代码骨架**:
```python
"""REST routes for sync (Phase C)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context
from app.file_system.interfaces import FileSystem
from app.deps import get_file_system
from app.schemas.sync import (
    SyncPushRequest, SyncPushResponse,
    SyncPullResponse, SyncFullResponse, SyncStatusResponse,
)
from app.services.sync import SyncService

router = APIRouter()


@router.post("/push", response_model=SyncPushResponse)
async def push_events(
    body: SyncPushRequest,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Apply a batch of sync events."""
    result = await SyncService(db, fs).push(
        [e.model_dump() for e in body.events]
    )
    await db.commit()
    return result


@router.get("/pull", response_model=SyncPullResponse)
async def pull_changes(
    since: str = Query("", description="ISO-8601 timestamp cursor"),
    limit: int = Query(1000, ge=1, le=5000),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Pull incremental changes since *since*."""
    result = await SyncService(db, fs).pull(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/full", response_model=SyncFullResponse)
async def full_sync(
    since: str = Query(""),
    limit: int = Query(1000, ge=1, le=5000),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Full sync: returns ALL tombstones regardless of since."""
    result = await SyncService(db, fs).full(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/status", response_model=SyncStatusResponse)
async def sync_status(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return entity counts + tombstone count."""
    result = await SyncService(db).status()
    await db.commit()
    return result
```

### 3.2 修改: `backend/app/routes/v1/__init__.py`

在 L34 后追加导入:
```python
from app.routes.v1.sync import router as sync_router
```

在 L59 `router.include_router(settings_router...)` 后追加:
```python
router.include_router(sync_router, prefix="/sync", tags=["sync"])
```

### 3.3 测试: `backend/tests/test_sync_routes.py` (新建)

**TDD Red-Green-Refactor 流程** — 7 测试:

1. `test_push_endpoint_requires_space_token_401` — 无 token 返回 401
2. `test_push_endpoint_applies_events` — POST /sync/push 创建 task,返回 applied
3. `test_pull_endpoint_returns_tasks` — GET /sync/pull 返回 tasks 列表
4. `test_pull_endpoint_filters_by_since` — since 参数过滤旧记录
5. `test_full_endpoint_returns_all_tombstones` — GET /sync/full 返回全量 tombstones (无视 since)
6. `test_status_endpoint_returns_counts` — GET /sync/status 返回 entity_counts + tombstone_count
7. `test_push_endpoint_returns_conflict_for_lww` — 旧 client_ts 不覆盖新 server_ts

**测试设置**:
- 复用 `test_routes_auth_spaces.py` 的 `_setup_and_login` helper (setup admin → login → create space → issue space token)
- 使用 `client` fixture + `Authorization: Bearer {space_token}` header
- 任务事件 payload 复用 `_make_event` 风格 (从 test_sync_service.py 抽取或内联)

### 3.4 验证

```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_routes.py -v
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -v  # 回归
```

## 4. C10 — 端到端集成测试

### 4.1 文件: `backend/tests/test_sync_integration.py` (新建)

**8 集成测试场景** (跨 HTTP 层 + Service 层 + DB 层):

1. `test_full_sync_roundtrip_create_pull` — push 1 task → pull 返回该 task → 验证 next_since 单调
2. `test_full_sync_roundtrip_update_lww` — push create → push update (新 ts) → pull 验证 title 更新
3. `test_full_sync_roundtrip_delete_tombstone` — push create → push delete → pull 返回 tombstones 含该 id
4. `test_sync_status_reflects_pushed_events` — push 3 tasks → status 返回 tasks=3
5. `test_sync_full_returns_all_tombstones_ignoring_since` — create 2 tombstones → full(since=future) 仍返回
6. `test_sync_handles_mixed_batch` — push 同时含 create + update + delete → 全部成功
7. `test_sync_push_unknown_entity_returns_error` — push entity_type="invalid" → errors 含该项
8. `test_sync_pagination_has_more` — push 5 tasks → pull(limit=2) → has_more=True

**测试设置**:
- 使用 `client` fixture (httpx ASGITransport)
- 通过 HTTP API 操作 (POST /sync/push, GET /sync/pull 等)
- 通过 space_token 认证
- _setup_and_login helper 抽取为共享 fixture 或复制

### 4.2 验证

```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_integration.py -v
```

## 5. P3.1 — TaskService.update 处理 tags

### 5.1 修改: `backend/app/services/task.py`

在 `delete` 方法后追加 `update` 方法:
```python
async def update(self, id: str, data: dict[str, Any]) -> Any:
    """Update a task, converting tags list to JSON string if present."""
    if "tags" in data and isinstance(data["tags"], list):
        data["tags"] = json.dumps(data["tags"])
    return await super().update(id, data)
```

**注意**: `BaseService.update` 已有 `hasattr(obj, "version")` 防护,会自动递增 version。

### 5.2 测试

在 `tests/test_task_service.py` (或合适位置) 追加 1 测试:
```python
@pytest.mark.asyncio
async def test_task_service_update_converts_tags_list_to_json(space_session):
    """TaskService.update should convert tags list to JSON string."""
    from app.services.task import TaskService
    from app.models.task import Task

    svc = TaskService(space_session)
    obj = await svc.create({"title": "T", "tags": ["a", "b"]})
    await space_session.commit()
    await space_session.refresh(obj)
    # Update with tags as list
    await svc.update(obj.id, {"tags": ["x", "y", "z"]})
    await space_session.commit()
    row = await space_session.get(Task, obj.id)
    assert row.tags == '["x", "y", "z"]'
```

## 6. P3.2 — trash.py purge_item N+1 修复

### 6.1 修改: `backend/app/routes/v1/trash.py` L178-186

**当前代码** (N+1):
```python
if entity_type == "folder":
    cascade = CascadeService(db)
    desc_ids = await cascade.get_descendant_ids(entity_id)
    for did in desc_ids:
        desc = await db.get(Folder, did)
        if desc is not None:
            await db.delete(desc)
            await tomb_svc.create("folder", did)
```

**修复为单查询批量删除**:
```python
if entity_type == "folder":
    cascade = CascadeService(db)
    desc_ids = await cascade.get_descendant_ids(entity_id)
    if desc_ids:
        # Batch-load all descendants in one query (avoid N+1).
        desc_rows = (
            await db.execute(
                select(Folder).where(Folder.id.in_(desc_ids))
            )
        ).scalars().all()
        for desc in desc_rows:
            await db.delete(desc)
            await tomb_svc.create("folder", desc.id)
```

**注意**: `select` 已在文件顶部导入 (L18)。如未导入,需补 import。

### 6.2 测试

```python
@pytest.mark.asyncio
async def test_purge_folder_cascades_descendants_in_one_query(client, space_session):
    """purge_item on a folder with N descendants should issue 1 SELECT, not N."""
    # ... 设置 folder + N descendants ...
    # ... mock 或计数 db.execute 调用次数 ...
```

(简化版: 直接验证功能正确性 — descendant 全部被删除 + tombstone 全部创建)

## 7. P3.3 — serializers json.loads 保护

### 7.1 修改: `backend/app/services/serializers.py` L19-22

**当前代码**:
```python
d = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
if "tags" in d and isinstance(d["tags"], str):
    d["tags"] = json.loads(d["tags"]) if d["tags"] else []
return d
```

**修复**:
```python
d = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
if "tags" in d and isinstance(d["tags"], str):
    if not d["tags"]:
        d["tags"] = []
    else:
        try:
            d["tags"] = json.loads(d["tags"])
        except (json.JSONDecodeError, ValueError):
            # Defensive: corrupted tags string should not crash serialization.
            d["tags"] = []
return d
```

### 7.2 测试

```python
def test_serialize_entity_handles_corrupted_tags():
    """serialize_entity should return [] for malformed tags JSON."""
    from app.services.serializers import serialize_entity

    class FakeObj:
        class _T:
            columns = []
        __table__ = _T()
        tags = "{not valid json"

    # Mimic __table__.columns containing "tags"
    class Col:
        def __init__(self, name): self.name = name
    FakeObj.__table__.columns = [Col("tags")]
    result = serialize_entity(FakeObj())
    assert result["tags"] == []


def test_serialize_entity_parses_valid_tags():
    """serialize_entity should parse valid JSON tags."""
    from app.services.serializers import serialize_entity

    class Col:
        def __init__(self, name): self.name = name
    class FakeObj:
        __table__ = type("T", (), {"columns": [Col("tags")]})
        tags = '["a", "b"]'

    result = serialize_entity(FakeObj())
    assert result["tags"] == ["a", "b"]
```

## 8. P3.4 — Note status CheckConstraint

### 8.1 修改: `backend/app/models/note.py`

追加 `__table_args__`:
```python
from sqlalchemy import String, Integer, CheckConstraint

class Note(Base, SyncMixin):
    __tablename__ = "notes"
    # ... 字段不变 ...

    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'archived')",
            name="check_note_status",
        ),
    )
```

### 8.2 新建 Alembic 迁移: `backend/alembic/versions/003_note_status_check.py`

```python
"""Add CheckConstraint on notes.status.

Revision ID: 003_note_status_check
Revises: 002_sync_indexes
Create Date: 2026-07-04
"""
from alembic import op


revision = "003_note_status_check"
down_revision = "002_sync_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_check_constraint(
        "check_note_status",
        "notes",
        "status IN ('active', 'archived')",
    )


def downgrade() -> None:
    op.drop_constraint("check_note_status", "notes", type_="check")
```

### 8.3 测试

```python
@pytest.mark.asyncio
async def test_note_invalid_status_raises_integrity_error(space_session):
    """Inserting a note with invalid status should raise IntegrityError."""
    import pytest
    from sqlalchemy.exc import IntegrityError
    from app.models.note import Note

    bad = Note(id="bad-status", title="T", status="invalid_status")
    space_session.add(bad)
    with pytest.raises(IntegrityError):
        await space_session.flush()
```

## 9. P3.5 — Task 字段索引

### 9.1 修改: `backend/app/models/task.py`

为 status / priority / due_date 添加 `index=True`:
```python
status: Mapped[str] = mapped_column(String(20), default="todo", index=True)
priority: Mapped[str] = mapped_column(String(20), default="medium", index=True)
due_date: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
```

### 9.2 新建 Alembic 迁移: `backend/alembic/versions/004_task_indexes.py`

```python
"""Add indexes on tasks.status, tasks.priority, tasks.due_date.

Revision ID: 004_task_indexes
Revises: 003_note_status_check
Create Date: 2026-07-04
"""
from alembic import op


revision = "004_task_indexes"
down_revision = "003_note_status_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_tasks_status", "tasks", ["status"])
    op.create_index("ix_tasks_priority", "tasks", ["priority"])
    op.create_index("ix_tasks_due_date", "tasks", ["due_date"])


def downgrade() -> None:
    op.drop_index("ix_tasks_due_date", "tasks")
    op.drop_index("ix_tasks_priority", "tasks")
    op.drop_index("ix_tasks_status", "tasks")
```

### 9.3 测试

```python
@pytest.mark.asyncio
async def test_task_indexes_exist(space_session):
    """Verify that tasks.status, priority, due_date have indexes."""
    from sqlalchemy import inspect

    inspector = inspect(space_session.bind.sync_engine)
    indexes = {idx["name"] for idx in inspector.get_indexes("tasks")}
    assert "ix_tasks_status" in indexes
    assert "ix_tasks_priority" in indexes
    assert "ix_tasks_due_date" in indexes
```

## 10. P3.6 — deps.py space_id 校验

### 10.1 修改: `backend/app/deps.py` L57-69

**当前代码** (仅校验 token 含 space_id):
```python
async def get_space_context(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if user.get("type") != "space":
        raise AuthorizationError("Space token required")
    space_id = user.get("space_id")
    if not space_id:
        raise AuthenticationError("Space token missing space_id")
    return {"space_id": str(space_id), "user_id": str(user.get("sub"))}
```

**修复** (查 meta DB 校验存在性):
```python
async def get_space_context(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if user.get("type") != "space":
        raise AuthorizationError("Space token required")
    space_id = user.get("space_id")
    if not space_id:
        raise AuthenticationError("Space token missing space_id")

    # Verify the space actually exists in the meta DB.
    from app.db.models.meta import Space
    from app.db.meta_session import get_meta_session

    async for session in get_meta_session():
        exists = await session.get(Space, str(space_id))
        break

    if exists is None:
        raise AuthenticationError(f"Space '{space_id}' does not exist")

    return {"space_id": str(space_id), "user_id": str(user.get("sub"))}
```

### 10.2 测试

```python
@pytest.mark.asyncio
async def test_get_space_context_rejects_nonexistent_space_id(client):
    """A space token with a non-existent space_id should be rejected."""
    from app.errors import AuthenticationError
    from app.deps import get_current_user, get_space_context

    # Forge a space token payload with a non-existent space_id.
    fake_user = {
        "sub": "admin",
        "type": "space",
        "space_id": "non-existent-space-id-xxx",
    }
    with pytest.raises(AuthenticationError):
        await get_space_context(user=fake_user)
```

## 11. 收尾 — 更新 project_memory.md

### 11.1 修改: `c:\Users\20564\.trae-cn\memory\projects\-e-Development-MyAwesomeApp-PomodoroXII\project_memory.md`

更新关键事实与 Phase 进度表:

```markdown
### 1. Phase C 实际进度 = 100% ✅
- ✅ `app/services/sync.py` SyncService push/pull/full/status + _push_note_event + _write_audit 全部完成
- ✅ `app/routes/v1/sync.py` 4 端点全部实现并注册
- ✅ `app/services/sync_safety.py` LWW + timestamp normalize 完成
- ✅ SyncAuditLog 审计日志 (push/pull 调用点 + best-effort 不破坏主流程)
- ✅ Alembic 002 (sync indexes) + 003 (note check) + 004 (task indexes) 全部应用

### 3. 测试总数 = 236 (214 原有 + 22 新增)
- 新增: C9 3 + C7 7 + C10 8 + P3.1-P3.6 共 6 = 24 测试
- 注: 22 为本轮新增,不含上轮已加的 C2-C6/C8 27 测试

## Phase 进度

| Phase | 实际状态 |
|-------|---------|
| A (file_system) | ✅ 完成 |
| B (业务层) | ✅ 完成（90%） |
| P0 修复 | ✅ 完成（2/2） |
| P1 修复 | ✅ 完成（5/5） |
| C (Sync 引擎) | ✅ **100% 完成** |
| D (性能优化) | ❌ 未开始 |
| E (部署) | ❌ 未开始 |
| F (前端) | ❌ 未开始 |
| G-H | ❌ 未开始 |

## 已修复问题（P0/P1/P2/P3）

新增:
- P3.1 TaskService.update tags 转换 ✅
- P3.2 trash.py N+1 修复 ✅
- P3.3 serializers json.loads 保护 ✅
- P3.4 Note status CheckConstraint ✅
- P3.5 Task 字段索引 ✅
- P3.6 deps.py space_id 校验 ✅
```

## 12. 执行计划表

| 顺序 | 任务 | 文件 | 测试 | 验证命令 |
|------|------|------|------|----------|
| 1 | C9 收尾 | sync.py | 已写 | `pytest tests/test_sync_service.py -k audit -v` |
| 2 | C7 路由 | sync.py (routes) + __init__.py | 7 | `pytest tests/test_sync_routes.py -v` |
| 3 | C10 集成 | test_sync_integration.py | 8 | `pytest tests/test_sync_integration.py -v` |
| 4 | P3.1 | services/task.py | 1 | `pytest tests/test_task_service.py -v` |
| 5 | P3.2 | routes/v1/trash.py | 1 | `pytest tests/test_trash_routes.py -v` |
| 6 | P3.3 | services/serializers.py | 2 | `pytest tests/test_serializers.py -v` |
| 7 | P3.4 | models/note.py + alembic 003 | 1 | `pytest -k note_status -v` |
| 8 | P3.5 | models/task.py + alembic 004 | 1 | `pytest -k task_indexes -v` |
| 9 | P3.6 | deps.py | 1 | `pytest -k nonexistent_space -v` |
| 10 | 收尾 | project_memory.md | - | (人工审查) |
| 11 | 最终 | 全量回归 | - | `pytest tests/ -v` |

## 13. 关键约束

- **三层铁律**: Routers commit / Services flush / Models 纯数据
- **TDD 流程**: Red (失败) → Green (最小代码) → Refactor
- **Alembic 链**: 001_initial → cab2ff7bcf37 → 002_sync_indexes → 003_note_status_check → 004_task_indexes
- **不破坏现有测试**: 每次修改后运行回归
- **`_write_audit` 不调 rollback**: 已确认设计 (避免撤销事件)

## 14. 风险与缓解

| 风险 | 缓解 |
|------|------|
| C7 路由 4 端点 schema 不匹配 | 使用 schemas/sync.py 已定义的 Pydantic 模型 |
| C10 集成测试 token 复杂 | 复用 test_routes_auth_spaces.py 的 _setup_and_login |
| P3.4 Note 已有数据违反约束 | CheckConstraint 默认针对 SQLite,如已有数据需先清理 |
| P3.6 异步 meta_session 使用 | 参考 deps.py get_meta_db 模式 |
| 全量测试速度慢 | 按任务逐步验证,最后全量回归 |

## 15. 假设决策

1. **C9 设计改进确认**: `_write_audit` 不调用 `db.rollback()`,仅捕获异常 (已在前述章节说明)
2. **C7 4 端点**: push/pull/full/status,不含 events/debounce 等 (按计划)
3. **C10 集成测试**: 使用 HTTP 客户端 + 真实 space DB (不 mock service)
4. **P3.4 Note 约束**: status 仅允许 'active'/'archived' (按现有注释)
5. **P3.5 Task 索引**: 仅 status/priority/due_date (其他字段不在 P3.5 范围)
6. **P3.6 校验**: 通过 meta DB 查询 Space 表,不存在则 AuthenticationError

## 16. 验证步骤 (最终回归)

```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'

# 全量测试
.venv\Scripts\python.exe -m pytest tests/ -v

# Alembic 链验证
.venv\Scripts\python.exe -m alembic history

# 关键模块导入检查
.venv\Scripts\python.exe -c "from app.services.sync import SyncService, ENTITY_REGISTRY; from app.routes.v1.sync import router; from app.models.sync_audit_log import SyncAuditLog; print('all imports ok')"
```

## 17. 执行顺序总览

1. **C9 收尾** (修改 sync.py 3 处 + 验证 3 测试)
2. **C7 路由** (新建 sync.py routes + 注册 + TDD 7 测试)
3. **C10 集成** (新建 test_sync_integration.py 8 测试)
4. **P3.1 TaskService.update** (修改 services/task.py + 1 测试)
5. **P3.2 trash N+1** (修改 trash.py + 1 测试)
6. **P3.3 serializers** (修改 serializers.py + 2 测试)
7. **P3.4 Note CheckConstraint** (修改 note.py + alembic 003 + 1 测试)
8. **P3.5 Task 索引** (修改 task.py + alembic 004 + 1 测试)
9. **P3.6 deps 校验** (修改 deps.py + 1 测试)
10. **收尾** (更新 project_memory.md + 全量回归)

## 18. TodoWrite 初始清单

```text
[ ] C9 收尾: sync.py 3 处 _write_audit 调用 + 3 测试验证
[ ] C7: 新建 routes/v1/sync.py 4 端点 + 注册 + 7 测试
[ ] C10: 新建 test_sync_integration.py 8 端到端测试
[ ] P3.1: TaskService.update 处理 tags list→JSON + 1 测试
[ ] P3.2: trash.py purge_item N+1 修复 + 1 测试
[ ] P3.3: serializers json.loads try/except + 2 测试
[ ] P3.4: Note status CheckConstraint + alembic 003 + 1 测试
[ ] P3.5: Task status/priority/due_date index + alembic 004 + 1 测试
[ ] P3.6: deps.py get_space_context 校验 space_id + 1 测试
[ ] 收尾: 更新 project_memory.md + 全量回归
```
