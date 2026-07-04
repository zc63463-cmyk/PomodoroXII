# Phase C Sync 引擎 — 剩余 4 任务实施计划

> **For agentic workers:** 本计划采用 TDD 方法论(Red → Green → Refactor)。步骤使用 checkbox (`- [ ]`) 语法跟踪。

**Goal:** 完成 Phase C Sync 引擎剩余 4 个任务——Task 8 修复、Task 11 审计日志、Task 9 sync 路由、Task 12 集成测试

**Architecture:** 多空间架构(共享 meta.db + 每空间 SQLite)。Sync 引擎采用 client-first + LWW 冲突解决 + Tombstone 防复活。Note 实体走 NoteService(双存储 Saga)，其他实体走直接 ORM。SAVEPOINT 隔离每事件。

**Tech Stack:** Python 3.12, FastAPI 0.139.0, SQLAlchemy 2.0 (async), Pydantic v2, pytest, aiosqlite

---

## 摘要

Tasks 1-4, 7, 10, 5+6 已完成。Task 8 代码改动完成但有 1 个测试失败。本计划覆盖剩余 4 个任务，产出 ~18 个新测试 + 1 个新路由文件 + 1 个新集成测试文件 + sync.py 审计方法。

**目标项目**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**venv Python**: `.venv\Scripts\python.exe`
**pytest 配置**: `asyncio_mode = "auto"`, `testpaths = ["tests"]`, `pythonpath = ["."]`

---

## 当前状态分析

### 已完成

| 任务 | 状态 | 产出 |
|------|------|------|
| Task 1-4: push + safety + Saga + registry | ✅ | push() + ENTITY_REGISTRY + 4 schemas |
| Task 7: SAVEPOINT 兼容性 | ✅ | 3 个测试在 test_note_service.py |
| Task 10: REGISTRY 验证 | ✅ | 3 个测试在 test_sync_service.py |
| Tasks 5+6: pull/full/status | ✅ | 3 方法 + 3 schemas + 9 测试 |
| Task 8: sync_mode 集成(代码) | ⚠️ | _push_note_event + sync_mode in note.py + 4 测试(1 失败) |

### 待完成

| 任务 | 说明 | 新增测试 |
|------|------|----------|
| Task 8 修复 | 修复 test_push_note_update_rewrites_md LWW 冲突 | 0(修复1) |
| Task 11: 审计 | _write_audit + push/pull/status 调用 | +3 |
| Task 9: 路由 | 4 端点 + 注册 + 7 测试 | +7 |
| Task 12: 集成 | 8 个端到端测试 | +8 |

### 三层铁律

1. **Routers commit / Services flush / Models 纯数据**: Service 不导入 `fastapi`，不调 `commit()`
2. **Note 模型无 content 字段**: .md 文件是唯一 Source of Truth
3. **双 JWT 认证**: Master Token + Space Token

### Windows 路径大小写约束

所有后端文件写入必须通过 Python 脚本(`pathlib.Path.write_text(encoding="utf-8")`)使用小写路径 `e:\Development\MyAwesomeApp\pomodoroxi\...`。

---

## 执行依赖顺序

```
Task 8 修复 (独立) ──────────────────> 验证
Task 11 审计 (sync.py 修改) ─────────> 验证
Task 9 路由 (依赖 sync.py 最终态) ───> 验证
Task 12 集成 (依赖 Task 9 路由) ──────> 验证
全量验证
```

---

## Task 8 修复: test_push_note_update_rewrites_md

### 根因

第一次 push create 时 entity 没有 `updated_at`，`Note(**data)` 使用 SyncMixin default(`utc_now_iso()`) 填充为当前服务器时间(如 `2026-07-02T...`)。第二次 push update 的 `client_time: "2026-07-01T11:00:00.000Z"` 更旧 → LWW 拒绝 → .md 未重写。

### 修复

**文件**: `tests/test_sync_service.py` 第325-329行

当前:
```python
    await svc.push([{
        "type": "note", "action": "create",
        "entity": {"id": "note-upd", "title": "Upd", "content": "Old"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
```

改为:
```python
    await svc.push([{
        "type": "note", "action": "create",
        "entity": {"id": "note-upd", "title": "Upd", "content": "Old",
                   "updated_at": "2026-07-01T10:00:00.000"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
```

### 验证

```powershell
cd 'e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend'
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py::test_push_note_update_rewrites_md -v
```

---

## Task 11: Sync 审计 (SyncAuditLog)

### 涉及文件

- 修改: `app/services/sync.py`（添加 import + _write_audit 方法 + push/pull/status 调用）
- 修改: `tests/test_sync_service.py`（追加 3 个测试）

### sync.py 改动

#### 改动 1: 添加 import

在 `from app.models.tombstone import Tombstone` 之前添加:
```python
from app.models.sync_audit_log import SyncAuditLog
```

#### 改动 2: 添加 _write_audit 方法

在 `status()` 方法之后、`_push_note_event` 之前插入:
```python
    # ------------------------------------------------------------------ #
    # Audit logging
    # ------------------------------------------------------------------ #

    async def _write_audit(
        self,
        event_type: str,
        entity_type: str = "batch",
        entity_id: str = "",
        details: dict[str, Any] | None = None,
    ) -> None:
        """Write an append-only audit log entry.  Only flushes, never commits.

        Isolated in a savepoint so audit failures never break the main
        operation (push/pull/status must succeed regardless of audit state).
        """
        try:
            async with self.db.begin_nested():
                self.db.add(SyncAuditLog(
                    event_type=event_type,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    details=json.dumps(details or {}),
                ))
        except Exception as exc:
            logger.warning("[SYNC-AUDIT] failed to write audit log: %s", exc)
```

#### 改动 3: push() 返回前调用审计

当前 push() 末尾:
```python
        return {
            "applied": applied,
            "conflicts": conflicts,
            "errors": errors,
            "server_time": now,
        }
```

改为:
```python
        result = {
            "applied": applied,
            "conflicts": conflicts,
            "errors": errors,
            "server_time": now,
        }
        await self._write_audit("push", details={
            "events": len(events),
            "applied": len(applied),
            "conflicts": len(conflicts),
            "errors": len(errors),
        })
        return result
```

#### 改动 4: pull() 返回前调用审计

当前 pull() 末尾:
```python
        result["has_more"] = has_more
        result["next_since"] = max_updated if has_more else now
        return result
```

改为:
```python
        result["has_more"] = has_more
        result["next_since"] = max_updated if has_more else now
        await self._write_audit("pull", details={
            "since": cutoff,
            "has_more": has_more,
        })
        return result
```

#### 改动 5: status() 返回前调用审计

当前 status() 末尾:
```python
        tomb_res = await self.db.execute(select(func.count()).select_from(Tombstone))
        return {
            "server_time": now,
            "entity_counts": entity_counts,
            "tombstone_count": tomb_res.scalar() or 0,
        }
```

改为:
```python
        tomb_res = await self.db.execute(select(func.count()).select_from(Tombstone))
        tombstone_count = tomb_res.scalar() or 0
        result = {
            "server_time": now,
            "entity_counts": entity_counts,
            "tombstone_count": tombstone_count,
        }
        await self._write_audit("status", details={
            "entity_counts": entity_counts,
            "tombstone_count": tombstone_count,
        })
        return result
```

### 设计决策

1. **begin_nested 隔离**: 审计写入用 savepoint 隔离，失败时只回滚审计行
2. **try/except 保护**: 审计是辅助功能，绝不导致主操作失败
3. **full() 不写审计**: `full()` 内部调用 `pull()`，pull 已写审计
4. **不导入 fastapi**: `_write_audit` 无 fastapi import，gate 测试通过

### 新增 3 个测试

追加到 `tests/test_sync_service.py` 末尾:

```python


# --------------------------------------------------------------------------- #
# Audit log tests (Task 11)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_audit_log_push(space_session):
    """push() writes a SyncAuditLog entry with event_type='push'."""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select

    svc = SyncService(space_session)
    await svc.push([{
        "type": "task", "action": "create",
        "entity": {"id": "audit-push", "title": "Audit", "status": "todo"},
        "client_time": "2026-07-01T10:00:00.000Z",
    }])
    res = await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "push")
    )
    logs = res.scalars().all()
    assert len(logs) >= 1
    assert logs[-1].event_type == "push"


@pytest.mark.asyncio
async def test_audit_log_pull(space_session):
    """pull() writes a SyncAuditLog entry with event_type='pull'."""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select

    svc = SyncService(space_session)
    await svc.pull("")
    res = await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "pull")
    )
    logs = res.scalars().all()
    assert len(logs) >= 1
    assert logs[-1].event_type == "pull"


@pytest.mark.asyncio
async def test_audit_log_status(space_session):
    """status() writes a SyncAuditLog entry with event_type='status'."""
    from app.services.sync import SyncService
    from app.models.sync_audit_log import SyncAuditLog
    from sqlalchemy import select

    svc = SyncService(space_session)
    await svc.status()
    res = await space_session.execute(
        select(SyncAuditLog).where(SyncAuditLog.event_type == "status")
    )
    logs = res.scalars().all()
    assert len(logs) >= 1
    assert logs[-1].event_type == "status"
```

### 验证

```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -v --tb=short
```

预期: 全部通过(原 21 + Task 8 修复 1 + 审计 3 = 25)

---

## Task 9: Sync 路由 (4 端点 + 注册)

### 涉及文件

- 新建: `app/routes/v1/sync.py`（须用 Python 脚本创建）
- 修改: `app/routes/v1/__init__.py`（注册 sync_router）
- 新建: `tests/test_sync_routes.py`（须用 Python 脚本创建）

### 新建 `app/routes/v1/sync.py`

```python
"""REST routes for sync (push / pull / full / status).

Routes commit; the SyncService only flushes.  push/pull/full require a
FileSystem instance (for note content bridge); status does not.
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
async def push_events(
    body: SyncPushRequest,
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Push a batch of client sync events to the server replica."""
    events = [e.model_dump() for e in body.events]
    result = await SyncService(db, fs).push(events)
    await db.commit()
    return result


@router.get("/pull")
async def pull_changes(
    since: str = Query("", description="ISO timestamp cursor"),
    limit: int = Query(1000, ge=1, le=5000),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Incremental pull: entities with updated_at > since + new tombstones."""
    result = await SyncService(db, fs).pull(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/full")
async def full_sync(
    since: str = Query("", description="ISO timestamp cursor"),
    limit: int = Query(1000, ge=1, le=5000),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Full sync: all entities + all tombstones (unfiltered by since)."""
    result = await SyncService(db, fs).full(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/status")
async def sync_status(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return sync status summary (entity counts + tombstone count)."""
    result = await SyncService(db).status()
    await db.commit()
    return result
```

### 修改 `app/routes/v1/__init__.py`

在 import 区(`from app.routes.v1.settings import ...` 之后)添加:
```python
    from app.routes.v1.sync import router as sync_router
```

在 include_router 区(settings 之后、`return router` 之前)添加:
```python
    router.include_router(sync_router, prefix="/sync", tags=["sync"])
```

### 端点路径

- `POST /api/v1/sync/push`
- `GET /api/v1/sync/pull?since=...&limit=...`
- `GET /api/v1/sync/full?since=...&limit=...`
- `GET /api/v1/sync/status`

Gate 测试当前断言 `>= 35`，新增 4 条后达 39，**无需修改阈值**。

### 新建 `tests/test_sync_routes.py` (7 个测试)

```python
"""Tests for sync REST routes (Task 9).

7 tests covering POST /push, GET /pull, GET /full, GET /status,
conflict reporting, since-filtering, and auth gate.
"""

import pytest


async def _get_space_client(client):
    """Set up admin password, log in, create a space, issue a space token."""
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post("/api/v1/auth/login", json={"password": "test123"})
    master_token = resp.json()["access_token"]
    resp = await client.post("/api/v1/spaces", json={"name": "Sync Test Space"},
                             headers={"Authorization": f"Bearer {master_token}"})
    space_id = resp.json()["id"]
    resp = await client.post(f"/api/v1/spaces/{space_id}/token",
                             headers={"Authorization": f"Bearer {master_token}"})
    space_token = resp.json()["space_token"]
    return space_token, space_id


def _auth(space_token: str) -> dict:
    return {"Authorization": f"Bearer {space_token}"}


@pytest.mark.asyncio
async def test_sync_push_returns_applied(client):
    """POST /api/v1/sync/push creates a task and returns applied indices."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "route-push-1", "title": "Route Push", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=_auth(space_token))
    assert resp.status_code == 200
    assert 0 in resp.json()["applied"]


@pytest.mark.asyncio
async def test_sync_push_conflict_reported(client):
    """POST /api/v1/sync/push with stale update reports a conflict."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "route-conflict", "title": "Original", "status": "todo",
                               "updated_at": "2026-07-01T12:00:00.000"},
                    "client_time": "2026-07-01T12:00:00.000Z"}]
    }, headers=headers)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "update",
                    "entity": {"id": "route-conflict", "title": "Stale"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    assert resp.status_code == 200
    assert len(resp.json()["conflicts"]) >= 1


@pytest.mark.asyncio
async def test_sync_pull_returns_entities(client):
    """GET /api/v1/sync/pull returns pushed entities."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "route-pull-1", "title": "Pull Me", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/pull", headers=headers)
    assert resp.status_code == 200
    assert any(t["id"] == "route-pull-1" for t in resp.json()["tasks"])


@pytest.mark.asyncio
async def test_sync_pull_filters_by_since(client):
    """GET /api/v1/sync/pull?since=<future> excludes existing entities."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "route-since-1", "title": "Since", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/pull?since=2099-01-01T00:00:00.000", headers=headers)
    assert resp.status_code == 200
    assert all(t["id"] != "route-since-1" for t in resp.json()["tasks"])


@pytest.mark.asyncio
async def test_sync_full_returns_is_full(client):
    """GET /api/v1/sync/full returns is_full=True."""
    space_token, _ = await _get_space_client(client)
    resp = await client.get("/api/v1/sync/full", headers=_auth(space_token))
    assert resp.status_code == 200
    assert resp.json()["is_full"] is True


@pytest.mark.asyncio
async def test_sync_status_returns_counts(client):
    """GET /api/v1/sync/status returns entity_counts."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "route-status-1", "title": "Status", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/status", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["entity_counts"]["tasks"] >= 1


@pytest.mark.asyncio
async def test_sync_unauthorized_returns_401(client):
    """GET /api/v1/sync/status without a token returns 401."""
    resp = await client.get("/api/v1/sync/status")
    assert resp.status_code == 401
```

### 验证

```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_routes.py -v --tb=short
.venv\Scripts\python.exe -m pytest tests/test_integration.py::test_gate_all_v1_routes_registered -v
```

---

## Task 12: 集成测试 (8 个端到端测试)

### 涉及文件

新建: `tests/test_sync_integration.py`（须用 Python 脚本创建）

```python
"""End-to-end integration tests for the sync engine (Task 12).

8 tests exercising the full sync flow through the HTTP API:
push -> pull roundtrip, delete -> tombstone, note content bridge,
LWW conflict, full sync tombstones, status counts, batch mixed
events, and pull pagination.
"""

import pytest


async def _get_space_client(client):
    """Set up admin password, log in, create a space, issue a space token."""
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post("/api/v1/auth/login", json={"password": "test123"})
    master_token = resp.json()["access_token"]
    resp = await client.post("/api/v1/spaces", json={"name": "Sync E2E Space"},
                             headers={"Authorization": f"Bearer {master_token}"})
    space_id = resp.json()["id"]
    resp = await client.post(f"/api/v1/spaces/{space_id}/token",
                             headers={"Authorization": f"Bearer {master_token}"})
    space_token = resp.json()["space_token"]
    return space_token, space_id


def _auth(space_token: str) -> dict:
    return {"Authorization": f"Bearer {space_token}"}


@pytest.mark.asyncio
async def test_e2e_push_then_pull_roundtrip(client):
    """Push a task, then pull and verify it appears in the result."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-rt-1", "title": "Roundtrip", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    assert resp.status_code == 200
    assert 0 in resp.json()["applied"]
    resp = await client.get("/api/v1/sync/pull", headers=headers)
    assert resp.status_code == 200
    assert any(t["id"] == "e2e-rt-1" for t in resp.json()["tasks"])


@pytest.mark.asyncio
async def test_e2e_push_delete_then_pull_tombstone(client):
    """Push create + delete, then pull and verify tombstone appears."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-tomb-1", "title": "Tomb", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "delete",
                    "entity_id": "e2e-tomb-1",
                    "client_time": "2026-07-01T11:00:00.000Z"}]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/pull", headers=headers)
    assert resp.status_code == 200
    assert any(t["entity_id"] == "e2e-tomb-1" for t in resp.json()["tombstones"])


@pytest.mark.asyncio
async def test_e2e_push_note_with_content_pull_returns_content(client):
    """Push a note with content, then pull and verify content is included."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "note", "action": "create",
                    "entity": {"id": "e2e-note-1", "title": "E2E Note",
                               "content": "Hello from e2e"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/pull", headers=headers)
    assert resp.status_code == 200
    notes = resp.json()["notes"]
    target = [n for n in notes if n["id"] == "e2e-note-1"]
    assert len(target) == 1
    assert target[0]["content"] == "Hello from e2e"


@pytest.mark.asyncio
async def test_e2e_lww_conflict_resolution(client):
    """Push a task, then push a stale update -> conflict reported."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-lww-1", "title": "Original", "status": "todo",
                               "updated_at": "2026-07-01T12:00:00.000"},
                    "client_time": "2026-07-01T12:00:00.000Z"}]
    }, headers=headers)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "update",
                    "entity": {"id": "e2e-lww-1", "title": "Stale"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    assert resp.status_code == 200
    assert len(resp.json()["conflicts"]) >= 1


@pytest.mark.asyncio
async def test_e2e_full_sync_returns_all_tombstones(client):
    """Full sync with future since still returns all tombstones."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "create",
                    "entity": {"id": "e2e-full-1", "title": "Full", "status": "todo"},
                    "client_time": "2026-07-01T10:00:00.000Z"}]
    }, headers=headers)
    await client.post("/api/v1/sync/push", json={
        "events": [{"type": "task", "action": "delete",
                    "entity_id": "e2e-full-1",
                    "client_time": "2026-07-01T11:00:00.000Z"}]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/full?since=2099-01-01T00:00:00.000", headers=headers)
    assert resp.status_code == 200
    assert any(t["entity_id"] == "e2e-full-1" for t in resp.json()["tombstones"])


@pytest.mark.asyncio
async def test_e2e_status_reflects_pushed_entities(client):
    """Status endpoint reflects counts after pushing multiple entities."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-st-1", "title": "T1", "status": "todo"},
             "client_time": "2026-07-01T10:00:00.000Z"},
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-st-2", "title": "T2", "status": "todo"},
             "client_time": "2026-07-01T10:00:00.000Z"},
        ]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/status", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["entity_counts"]["tasks"] >= 2


@pytest.mark.asyncio
async def test_e2e_push_batch_mixed_events(client):
    """Push a batch with mixed events -> partial apply + error reported."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post("/api/v1/sync/push", json={
        "events": [
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-mix-1", "title": "Good", "status": "todo"},
             "client_time": "2026-07-01T10:00:00.000Z"},
            {"type": "nonexistent", "action": "create",
             "entity": {"id": "bad-1"},
             "client_time": "2026-07-01T10:00:00.000Z"},
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-mix-2", "title": "Also Good", "status": "todo"},
             "client_time": "2026-07-01T10:00:00.000Z"},
        ]
    }, headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert 0 in data["applied"]
    assert 2 in data["applied"]
    assert len(data["errors"]) >= 1


@pytest.mark.asyncio
async def test_e2e_pull_pagination(client):
    """Pull with limit returns has_more when more data exists."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post("/api/v1/sync/push", json={
        "events": [
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-page-1", "title": "P1", "status": "todo",
                        "updated_at": "2026-07-01T10:00:00.000"},
             "client_time": "2026-07-01T10:00:00.000Z"},
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-page-2", "title": "P2", "status": "todo",
                        "updated_at": "2026-07-02T10:00:00.000"},
             "client_time": "2026-07-02T10:00:00.000Z"},
            {"type": "task", "action": "create",
             "entity": {"id": "e2e-page-3", "title": "P3", "status": "todo",
                        "updated_at": "2026-07-03T10:00:00.000"},
             "client_time": "2026-07-03T10:00:00.000Z"},
        ]
    }, headers=headers)
    resp = await client.get("/api/v1/sync/pull?limit=2", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["has_more"] is True
```

### 验证

```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_integration.py -v --tb=short
```

---

## 文件变更总览

### 新建文件 (2 个)

| 文件路径 | 用途 | 创建方式 |
|---------|------|----------|
| `app/routes/v1/sync.py` | sync 路由(4 端点) | Python 脚本 |
| `tests/test_sync_routes.py` | 路由测试(7 个) | Python 脚本 |
| `tests/test_sync_integration.py` | 集成测试(8 个) | Python 脚本 |

### 修改文件 (3 个)

| 文件路径 | 修改内容 | 修改方式 |
|---------|---------|----------|
| `app/services/sync.py` | 添加 import + _write_audit + push/pull/status 审计调用 | Python 脚本 |
| `app/routes/v1/__init__.py` | 注册 sync_router | Python 脚本 |
| `tests/test_sync_service.py` | 修复 1 个测试 + 追加 3 个审计测试 | Python 脚本 |

---

## 假设与决策

1. **_write_audit 用 savepoint 隔离**: 审计失败不影响主操作
2. **full() 不写审计**: 内部调用 pull()，pull 已写审计
3. **路由不使用 response_model**: pull/full 返回 14 个动态 pull_key 字段，直接返回 dict
4. **push/pull/full 依赖 fs**: note content 需要 fs; status 不需要 fs
5. **Gate 测试阈值不变**: 35 + 4 sync = 39 >= 35
6. **SyncEvent.model_dump() 转换**: entity: None 时 push 方法中 `or {}` 处理

---

## 全量验证

```powershell
cd 'e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend'

# 全部测试
.venv\Scripts\python.exe -m pytest -v --tb=short

# Lint
.venv\Scripts\python.exe -m ruff check app/ --fix

# 三层铁律检查
# 1. Services 不导入 fastapi
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if 'fastapi' in f.read_text(encoding='utf-8')]"

# 2. Services 不调 commit
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if '.commit()' in f.read_text(encoding='utf-8')]"
```

预期: 262+ 个测试全绿(244 + 3 审计 + 7 路由 + 8 集成)，lint 无错误，铁律检查无输出。
