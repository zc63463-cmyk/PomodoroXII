# Phase C 完成与 P3 修复执行计划

> **生成时间**: 2026-07-04（Plan Mode Phase 3，基于已批准的 v3 计划延续执行）
> **方法论**: TDD (Red → Green → Refactor)
> **Skill 协同**: `test-driven-development`（TDD 流程引导）；`agent-browser` 仅在 C10 可选
> **基线测试数**: 326（P1.3 + C1 + C2 + C3 + C4 + C5 + C8 完成后实际全量）
> **本计划目标**: 完成 C6 + C7 + C9 + C10 + P3.1-P3.6 + 收尾，预期新增 ~32 测试

---

## 一、当前状态分析

### 1.1 进度基线（基于本次 Phase 1 探索）

| 任务 | 状态 | 证据 |
|------|------|------|
| P0 修正 project_memory.md | ✅ 完成 | memory 中已标注 Phase C 0% |
| P1.1 P2-1 list 端点 total | ✅ 完成 | `PaginatedResponse[T]` 已应用 |
| P1.2 P2-5 sync 索引 | ✅ 完成 | `002_sync_indexes.py` + 模型 `index=True` |
| P1.3 P2-6 Mixin onupdate + version | ✅ 完成 | [mixins.py L28-30](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/mixins.py#L28-L30) 已含 `onupdate=utc_now_iso`；[base.py L75-76](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py#L75-L76) 已含 `hasattr + version += 1` |
| C1 sync_safety.py | ✅ 完成 | [sync_safety.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_safety.py) 5 函数 + 12 测试 |
| C2 SyncService.push + schemas | ✅ 完成 | [sync.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py) + [schemas/sync.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/sync.py) + 5 测试 |
| C3 SyncService.pull | ✅ 完成 | [sync.py L218-275](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L218-L275) + 5 测试 |
| C4 SyncService.full + status | ✅ 完成 | [sync.py L281-331](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L281-L331) + 4 测试 |
| C5 SAVEPOINT 兼容性 | ✅ 完成 | [test_note_service.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_note_service.py) 3 savepoint 测试 |
| C8 ENTITY_REGISTRY 验证 | ✅ 完成 | [test_sync_service.py L417-446](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_service.py#L417-L446) 3 entity_registry 测试 |
| **C6 NoteService sync_mode** | ❌ 待实施 | [note.py L61](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L61) `__init__` 无 sync_mode；[sync.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py) 无 `_push_note_event` |
| **C7 sync 路由** | ❌ 待实施 | `routes/v1/sync.py` 不存在；[routes/v1/__init__.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/__init__.py) 无 sync_router 注册 |
| **C9 sync 审计** | ❌ 待实施 | SyncService 无 `_write_audit`；push/pull 未调用审计 |
| **C10 集成测试** | ❌ 待实施 | `tests/test_sync_integration.py` 不存在 |
| **P3.1-P3.6** | ❌ 待实施 | task.py/serializers.py/deps.py/note.py 均未修改 |

### 1.2 关键架构约束（铁律）

1. **三层铁律**: Routers commit / Services flush / Models 纯数据 — Service 不导入 fastapi，不调 commit
2. **双 Base 隔离**: `app.db.base.Base` (业务) vs `app.file_system.schema.Base` (FS 索引)
3. **双 JWT 认证**: Master Token (7d) + Space Token (8h, 含 space_id)
4. **Note 模型无 content 字段**: .md 文件是唯一 Source of Truth，DB 仅存 `content_hash` + `word_count`
5. **Saga Try-Compensate**: NoteService create/update_content/delete 三方法均含补偿
6. **Tombstone TOCTOU 防护**: `TombstoneService.create` 用 `try/except IntegrityError` 处理竞态
7. **NoteService `__init__` 当前签名**: `def __init__(self, db: AsyncSession, fs: FileSystem) -> None` — C6 添加 `sync_mode: bool = False` 参数
8. **sync_safety.serialize_entity 已自带 tags json.loads 保护** — P3.3 仅需修复 [serializers.py L21](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/serializers.py#L21) 原版（仍裸调 `json.loads`）

### 1.3 关键文件位置

| 文件 | 用途 | 本计划涉及 |
|------|------|----------|
| [app/services/note.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py) | NoteService（Saga） | C6 修改 |
| [app/services/sync.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py) | SyncService push/pull/full/status | C6/C9 修改 |
| [app/services/sync_safety.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_safety.py) | 纯工具函数 | C6 复用 |
| [app/services/base.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py) | BaseService.update | C6 复用 |
| [app/services/tombstone.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/tombstone.py) | TombstoneService | C6/P3.2 复用 |
| [app/services/task.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/task.py) | TaskService | P3.1 修改 |
| [app/services/serializers.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/serializers.py) | serialize_entity | P3.3 修改 |
| [app/routes/v1/__init__.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/__init__.py) | 15 路由挂载 | C7 追加 sync_router |
| [app/routes/v1/sync.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/sync.py) | 不存在 | C7 新建 |
| [app/routes/v1/trash.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/trash.py) | purge_item N+1 | P3.2 修改 |
| [app/models/note.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/note.py) | Note ORM | P3.4 修改 |
| [app/models/task.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/task.py) | Task ORM | P3.5 修改 |
| [app/models/sync_audit_log.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/sync_audit_log.py) | SyncAuditLog ORM | C9 复用 |
| [app/deps.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/deps.py) | get_space_context | P3.6 修改 |
| [app/schemas/sync.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/sync.py) | sync schemas | C7 复用 |
| [tests/test_sync_service.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_service.py) | 17 测试已存在 | C6/C9 追加 |
| [tests/test_note_service.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_note_service.py) | NoteService 测试 | C6 追加 sync_mode 测试 |
| [tests/test_sync_routes.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_routes.py) | 不存在 | C7 新建 |
| [tests/test_sync_integration.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_integration.py) | 不存在 | C10 新建 |
| [tests/conftest.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/conftest.py) | space_session + client fixture | 全部复用 |
| [alembic/versions/002_sync_indexes.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/alembic/versions/002_sync_indexes.py) | 索引 migration 模板 | P3.4/P3.5 参考 |

### 1.4 关键代码事实（来自本次探索）

#### NoteService 当前结构（[note.py L47-189](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L47-L189)）

- `__init__(self, db, fs)` — 仅 db + fs 两参数
- `create()`: 调 `fs.create_note` → `super().create(data)`，DB 失败时补偿删除 .md
- `update_content()`: 保存旧 .md → `fs.edit_note` → 更新 DB row，DB 失败时恢复旧 .md
- `update_metadata()`: 仅更新 DB 字段（剥离 content/content_hash/word_count）
- `update()`: 派发（content → update_content，其余 → update_metadata）
- `delete()`: DB 删除 + 写 tombstone → FS best-effort 删除

#### SyncService.push 当前实现（[sync.py L83-145](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L83-L145)）

- 逐事件 `async with self.db.begin_nested()` SAVEPOINT 隔离
- 调用 `_apply_event(model, etype, eid, action, payload, client_ts)`
- 当前对所有实体走相同 ORM 逻辑（C6 需让 note 走 NoteService）

#### SyncService._apply_event 当前实现（[sync.py L147-212](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L147-L212)）

- create: 插入新行，`sanitize_zero_time` 处理 updated_at
- update: `check_lww_conflict` 决策，remote 胜则应用，version 自增
- delete: 删除行

#### 现有测试基线（共 17 测试）

- C2 push 测试 5 个（create/update/delete/batch/lww）
- C3 pull 测试 5 个（empty since/since filter/has_more/tombstones/next_since）
- C4 full/status 测试 4 个（full tombstones/is_full/entity_counts/tombstone_count）
- C8 entity_registry 测试 3 个（14 entities/model+pull_key/unique pull_keys）

#### Trash.py purge_item N+1 模式（[trash.py L179-189](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/trash.py#L179-L189)）

```python
if entity_type == "folder":
    cascade = CascadeService(db)
    desc_ids = await cascade.get_descendant_ids(entity_id)
    for did in desc_ids:                          # N+1 查询
        desc = await db.get(Folder, did)
        if desc is not None:
            await db.delete(desc)
            await tomb_svc.create("folder", did)
```

#### Note model status 字段（[note.py L35-37](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/note.py#L35-L37)）

```python
status: Mapped[str] = mapped_column(
    String(20), default="active", index=True
)  # active | archived
```

仅注释说明取值，无 DB 层 CheckConstraint。

#### Task model 字段（[task.py L17-22](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/task.py#L17-L22)）

```python
status: Mapped[str] = mapped_column(String(20), default="todo")           # 无 index
priority: Mapped[str] = mapped_column(String(20), default="medium")         # 无 index
due_date: Mapped[str | None] = mapped_column(String(32), nullable=True)     # 无 index
```

#### deps.py get_space_context（[deps.py L57-69](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/deps.py#L57-L69)）

仅校验 token 含 `space_id`，不校验 space 是否真实存在。

---

## 二、C6: NoteService sync_mode + _push_note_event（4 测试）

### 2.1 修改 1: NoteService.__init__ 添加 sync_mode 参数

**文件**: `backend/app/services/note.py`

**当前 L61**:
```python
def __init__(self, db: AsyncSession, fs: FileSystem) -> None:
    super().__init__(db)
    self.fs = fs
    self.model = Note
```

**修改为**:
```python
def __init__(
    self,
    db: AsyncSession,
    fs: FileSystem,
    sync_mode: bool = False,
) -> None:
    super().__init__(db)
    self.fs = fs
    self.model = Note
    self.sync_mode = sync_mode
```

### 2.2 修改 2: NoteService.create 在 sync_mode 下保留客户端字段

**修改 `create()` 方法**（[note.py L66-102](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L66-L102)）：

在 `data` 处理阶段，sync_mode=True 时：
- 保留客户端 `created_at`（不依赖 `default=utc_now_iso`）
- 保留客户端 `updated_at`（不依赖 `default=utc_now_iso`）
- 保留客户端 `version`

实现：在 `super().create(data)` 调用前，确保 data 中的 `created_at`/`updated_at`/`version` 字段被原样传递（默认 BaseService.create 会将 data 字段赋给 ORM 实例）。

> **关键约束**: sync_mode=True 时，不调用 `super().create` 的 `default=utc_now_iso`，因为 SyncMixin 的 default 仅在字段未提供时生效，data 中显式传入即可覆盖。

### 2.3 修改 3: NoteService.delete 在 sync_mode 下跳过 tombstone

**修改 `delete()` 方法**（[note.py L166-189](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L166-L189)）：

```python
async def delete(self, id: str) -> None:
    obj = await self.db.get(self.model, id)
    if obj is not None:
        await self.db.delete(obj)
        await self.db.flush()
    # sync_mode 下跳过 tombstone 写入（远端 tombstone 已决策）
    if not self.sync_mode:
        tomb_svc = TombstoneService(self.db)
        await tomb_svc.create("note", id)
    try:
        await self.fs.delete_note(id)
    except (KeyError, FileNotFoundError):
        pass
```

### 2.4 修改 4: SyncService 添加 _push_note_event 方法

**文件**: `backend/app/services/sync.py`

在 `SyncService` 类中新增辅助方法：

```python
async def _push_note_event(
    self,
    etype: str,
    eid: str,
    action: str,
    payload: dict[str, Any],
    client_ts: str,
) -> str:
    """Apply a note event via NoteService(sync_mode=True).

    Returns resolution: "ok" / "conflict_local" / "conflict_remote".
    """
    from app.services.note import NoteService
    from app.services.sync_safety import (
        check_lww_conflict,
        normalize_timestamp,
        sanitize_zero_time,
    )

    client_ts_n = sanitize_zero_time(
        normalize_timestamp(client_ts), now=utc_now_iso()
    )

    if action == "create":
        data = dict(payload)
        data["id"] = eid
        # sync_mode=True 让 NoteService 保留 client 字段
        note_svc = NoteService(self.db, self.fs, sync_mode=True)
        await note_svc.create(data)
        return "ok"

    if action == "update":
        # 先 get 本地 row 做冲突检测
        existing = await self.db.get(Note, eid)
        if existing is None:
            # 视为 create
            data = dict(payload)
            data["id"] = eid
            note_svc = NoteService(self.db, self.fs, sync_mode=True)
            await note_svc.create(data)
            return "ok"
        decision = check_lww_conflict(existing, client_ts_n)
        if decision == "local":
            return "conflict_local"
        # 应用 remote 更新（走 NoteService.update_metadata + update_content）
        note_svc = NoteService(self.db, self.fs, sync_mode=True)
        update_data = dict(payload)
        update_data["updated_at"] = client_ts_n
        await note_svc.update(eid, update_data)
        return "conflict_remote"

    if action == "delete":
        note_svc = NoteService(self.db, self.fs, sync_mode=True)
        await note_svc.delete(eid)
        return "ok"

    raise ValueError(f"Unknown action: {action}")
```

### 2.5 修改 5: SyncService.push 中 etype=="note" 委托给 _push_note_event

**修改 push() 方法**（[sync.py L101-138](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L101-L138)）：

在 `if etype not in ENTITY_REGISTRY` 检查后，在 `model = ENTITY_REGISTRY[etype]["model"]` 之前，添加 note 委托：

```python
if etype == "note":
    try:
        async with self.db.begin_nested():
            resolution = await self._push_note_event(
                etype, eid, action, payload, client_ts,
            )
            if resolution == "conflict_local":
                conflicts.append({
                    "entity_type": etype,
                    "entity_id": eid,
                    "resolution": "local",
                })
            elif resolution == "conflict_remote":
                conflicts.append({
                    "entity_type": etype,
                    "entity_id": eid,
                    "resolution": "remote",
                })
            applied.append({
                "entity_type": etype,
                "entity_id": eid,
                "action": action,
            })
    except Exception as exc:
        logger.warning("sync push note event failed: %s", exc)
        errors.append({
            "entity_type": etype,
            "entity_id": eid,
            "error": str(exc),
        })
    continue
```

### 2.6 TDD 流程

**Red（4 测试，追加到 `tests/test_sync_service.py`）**:

1. `test_sync_mode_preserves_client_updated_at` — sync_mode=True 时 NoteService.create 保留 payload 中的 `updated_at`
2. `test_sync_mode_preserves_client_version` — sync_mode=True 时 NoteService.create 保留 payload 中的 `version`
3. `test_sync_mode_skips_tombstone_on_delete` — sync_mode=True 时 NoteService.delete 不创建新 tombstone
4. `test_sync_service_push_note_event_uses_note_service` — SyncService.push 中 etype=="note" 委托给 NoteService（验证 .md 文件被写入 + DB row 存在）

**Green**: 按上述 5 个修改实施

**验证**:
```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -k "sync_mode or note_event" -v
```

---

## 三、C7: sync 路由（7 测试）

### 3.1 新建文件: `backend/app/routes/v1/sync.py`

**4 端点**:

```python
"""REST routes for sync (Phase C).

Routes commit; the service only flushes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context, get_file_system
from app.file_system.interfaces import FileSystem
from app.schemas.sync import (
    SyncPushRequest,
    SyncPushResponse,
    SyncPullResponse,
    SyncFullResponse,
    SyncStatusResponse,
)
from app.services.sync import SyncService

router = APIRouter()


@router.post("/push", response_model=SyncPushResponse)
async def push(
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
async def pull(
    since: str = Query("", description="ISO timestamp; only return rows updated after this"),
    limit: int = Query(1000, ge=1, le=10000),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Pull incremental changes since *since*."""
    result = await SyncService(db, fs).pull(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/full", response_model=SyncFullResponse)
async def full(
    since: str = Query(""),
    limit: int = Query(1000, ge=1, le=10000),
    db: AsyncSession = Depends(get_space_db),
    fs: FileSystem = Depends(get_file_system),
    ctx: dict = Depends(get_space_context),
):
    """Full sync — return ALL tombstones ignoring *since*."""
    result = await SyncService(db, fs).full(since=since, limit=limit)
    await db.commit()
    return result


@router.get("/status", response_model=SyncStatusResponse)
async def status(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return per-entity counts + tombstone count."""
    result = await SyncService(db).status()
    await db.commit()
    return result
```

### 3.2 修改文件: `backend/app/routes/v1/__init__.py`

**当前 L33-34** (末尾):
```python
from app.routes.v1.settings import router as settings_router
```

**追加**:
```python
from app.routes.v1.sync import router as sync_router
```

**当前 L58-59** (末尾):
```python
router.include_router(settings_router, prefix="/settings", tags=["settings"])
```

**追加**:
```python
router.include_router(sync_router, prefix="/sync", tags=["sync"])
```

### 3.3 TDD 流程

**Red（7 测试，新建 `tests/test_sync_routes.py`）**:

1. `test_push_endpoint_returns_applied` — POST `/api/v1/sync/push` 单事件 create 返回 applied 列表
2. `test_push_endpoint_empty_events` — POST `/api/v1/sync/push` 空 events 数组返回空 applied
3. `test_pull_endpoint_returns_tasks` — GET `/api/v1/sync/pull` 返回 tasks 列表
4. `test_pull_endpoint_pagination` — GET `/api/v1/sync/pull?limit=2` 配 5 条数据返回 has_more=True
5. `test_full_endpoint_returns_all_tombstones` — GET `/api/v1/sync/full?since=2099...` 仍返回所有 tombstones
6. `test_status_endpoint_returns_counts` — GET `/api/v1/sync/status` 返回 entity_counts + tombstone_count
7. `test_sync_endpoints_require_space_token` — 无 Authorization 头返回 401

**测试基础设施**:
- 复用 `client` fixture（httpx ASGITransport）
- 需要先创建 master token + space + 切换 space token（参考 [test_routes_auth_spaces.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_routes_auth_spaces.py) 的模式）

**Green**: 按上述实施

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_routes.py -v
```

---

## 四、C9: sync 审计（3 测试）

### 4.1 修改文件: `backend/app/services/sync.py`

**新增 `_write_audit` 方法**:

```python
async def _write_audit(
    self,
    event_type: str,
    entity_type: str,
    entity_id: str,
    details: str = "",
) -> None:
    """Write an audit log row.

    Failures are logged but do NOT propagate — audit is best-effort and
    must never break the main sync flow.
    """
    from app.models.sync_audit_log import SyncAuditLog

    try:
        log = SyncAuditLog(
            event_type=event_type,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
        )
        self.db.add(log)
        await self.db.flush()
    except Exception as exc:
        logger.warning(
            "sync audit write failed (event=%s etype=%s eid=%s): %s",
            event_type, entity_type, entity_id, exc,
        )
        # Best-effort: rollback only the audit flush, not the outer tx.
        # In SAVEPOINT context this rollback is local; outside it may
        # affect pending changes — but audit failure is rare and we
        # accept the trade-off to keep main flow intact.
        try:
            await self.db.rollback()
        except Exception:
            pass
```

**调用点**:

1. `push()` 中每事件 SAVEPOINT 内、`_apply_event` 后追加：
   ```python
   await self._write_audit(
       "push", etype, eid,
       details=f"action={action} resolution={resolution}",
   )
   ```
2. `pull()` 末尾追加：
   ```python
   await self._write_audit(
       "pull", "batch", "",
       details=f"since={since} limit={limit} has_more={result['has_more']}",
   )
   ```
3. `status()` 不写审计（高频只读）。

### 4.2 TDD 流程

**Red（3 测试，追加到 `tests/test_sync_service.py`）**:

1. `test_push_writes_audit_log` — push 单事件后查询 SyncAuditLog 应有 1 行 event_type="push"
2. `test_pull_writes_audit_log` — pull 后查询 SyncAuditLog 应有 1 行 event_type="pull"
3. `test_audit_failure_does_not_break_main_flow` — mock SyncAuditLog insert 抛异常，push 仍返回 applied（不抛）

**Green**: 实施 `_write_audit` + 在 push/pull 调用

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -k audit -v
```

---

## 五、C10: 集成测试（8 测试）

### 5.1 新建文件: `backend/tests/test_sync_integration.py`

**8 个测试场景**:

1. `test_end_to_end_push_then_pull` — push 单 task → pull 返回该 task
2. `test_lww_conflict_resolution_client_wins` — 本地 task updated_at=10:00，远端 push update at 12:00 → 远端胜
3. `test_tombstone_prevents_resurrection` — push delete → pull 返回 tombstone → 后续 push create 同 id 应被阻止（或视为 upsert）
4. `test_note_push_writes_db_and_fs` — push note create → DB row + .md 文件均存在
5. `test_savepoint_isolation_batch_push` — 批量 push 中 1 事件失败，其他事件仍 applied
6. `test_pull_pagination_has_more` — 5 条数据 + limit=2 → has_more=True
7. `test_status_counts_after_create` — 创建 3 task + 2 note → status 返回正确计数
8. `test_routes_end_to_end_via_http_client` — 使用 `client` fixture 模拟 HTTP 调用 /api/v1/sync/push + /pull

### 5.2 TDD 流程

**Red**: 写 8 测试

**Green**: 无需新代码（C1-C9 已实现）；测试本身即验证集成

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_sync_integration.py -v
```

### 5.3 Skill 使用

- `test-driven-development`: 引导 Red-Green-Refactor 流程
- `agent-browser`: **不使用**（前端未存在，全部测试通过 `client` fixture 完成 HTTP 端到端）

---

## 六、P3.1 — TaskService.update 处理 tags list→JSON（1 测试）

### 6.1 修改文件: `backend/app/services/task.py`

**当前 TaskService 无 update 方法**（继承 BaseService.update）

**追加方法**:

```python
async def update(self, id: str, data: dict[str, Any]) -> Any:
    """Update a task, converting tags list to JSON string if needed."""
    data = dict(data)
    if "tags" in data and isinstance(data["tags"], list):
        data["tags"] = json.dumps(data["tags"])
    return await super().update(id, data)
```

### 6.2 TDD 流程

**Red（1 测试，追加到 `tests/test_task_service.py`）**:

```python
@pytest.mark.asyncio
async def test_update_task_converts_tags_list_to_json(space_session):
    """TaskService.update should convert tags list to JSON string."""
    from app.services.task import TaskService
    from app.models.task import Task

    svc = TaskService(space_session)
    obj = await svc.create({
        "id": uuid.uuid4().hex,
        "title": "T",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
    })
    updated = await svc.update(obj.id, {"tags": ["work", "urgent"]})
    assert updated.tags == '["work", "urgent"]'
    # Verify it parses back as JSON.
    import json
    assert json.loads(updated.tags) == ["work", "urgent"]
```

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_task_service.py -k update_tags -v
```

---

## 七、P3.2 — trash.py purge_item N+1 修复（1 测试）

### 7.1 修改文件: `backend/app/routes/v1/trash.py`

**当前 L179-189**（N+1 模式）:

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

**修改为批量操作**:

```python
if entity_type == "folder":
    cascade = CascadeService(db)
    desc_ids = await cascade.get_descendant_ids(entity_id)
    if desc_ids:
        # 批量查询所有 descendants
        res = await db.execute(
            select(Folder).where(Folder.id.in_(desc_ids))
        )
        descendants = res.scalars().all()
        for desc in descendants:
            await db.delete(desc)
            await tomb_svc.create("folder", desc.id)
```

> **说明**: 完全消除 N+1 需要 `delete(Folder).where(Folder.id.in_(desc_ids))`，但 `db.delete(obj)` 触发 ORM cascade 更安全（保留现有行为）。改为单次 `select(...).where(in_(desc_ids))` 已将 N 次查询降为 1 次。

### 7.2 TDD 流程

**Red（1 测试，追加到 `tests/test_routes_v1.py` 或新建 `tests/test_trash_purge.py`）**:

```python
@pytest.mark.asyncio
async def test_purge_folder_uses_single_query_for_descendants(
    space_session, tmp_path, monkeypatch
):
    """purge_item on a folder with N descendants should issue 1 SELECT,
    not N. We count queries via SQLAlchemy event listener."""
    # Setup: 创建 parent folder + 3 child folders
    # Monkeypatch db.execute 计数
    # 调用 purge_item("folder", parent_id)
    # 断言 execute 调用次数 ≤ 阈值（如 5 次，含 tombstone 等）
```

> **简化方案**: 测试只需验证 purge 后所有 descendants 都被删除 + 都有 tombstone，不强制断言 query 次数（避免脆弱测试）。

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_routes_v1.py -k purge -v
```

---

## 八、P3.3 — serializers.py json.loads 保护（1 测试）

### 8.1 修改文件: `backend/app/services/serializers.py`

**当前 L19-22**:

```python
d = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
if "tags" in d and isinstance(d["tags"], str):
    d["tags"] = json.loads(d["tags"]) if d["tags"] else []
return d
```

**修改为**:

```python
d = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
if "tags" in d and isinstance(d["tags"], str):
    if not d["tags"]:
        d["tags"] = []
    else:
        try:
            d["tags"] = json.loads(d["tags"])
        except (json.JSONDecodeError, ValueError):
            d["tags"] = []
return d
```

> **参考**: [sync_safety.py L68-75](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_safety.py#L68-L75) 已有相同保护，本修复让原版 serializers.py 也一致。

### 8.2 TDD 流程

**Red（1 测试，追加到 `tests/test_serializers.py`）**:

```python
def test_serialize_handles_malformed_tags_json():
    """serialize_entity should return [] for malformed tags JSON, not raise."""
    from app.services.serializers import serialize_entity

    class FakeObj:
        class _Table:
            class _Col:
                def __init__(self, name): self.name = name
            columns = [_Col("id"), _Col("tags")]
        __table__ = _Table()

    obj = FakeObj()
    obj.id = "x"
    obj.tags = "{malformed json"
    result = serialize_entity(obj)
    assert result["tags"] == []
```

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_serializers.py -v
```

---

## 九、P3.4 — Note status CheckConstraint + Alembic 003（1 测试）

### 9.1 修改文件: `backend/app/models/note.py`

**追加 `__table_args__`**:

```python
from sqlalchemy import String, Integer, CheckConstraint

class Note(Base, SyncMixin):
    __tablename__ = "notes"
    # ... 现有字段 ...

    __table_args__ = (
        CheckConstraint(
            "status IN ('active','archived')",
            name="check_note_status",
        ),
    )
```

### 9.2 新建文件: `backend/alembic/versions/003_note_status_check.py`

```python
"""note_status_check: add CheckConstraint on notes.status.

Revision ID: 003
Revises: 002
Create Date: 2026-07-04 00:00:01
"""
from typing import Sequence, Union

from alembic import op


revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_check_constraint(
        "check_note_status", "notes",
        "status IN ('active','archived')"
    )


def downgrade() -> None:
    op.drop_constraint("check_note_status", "notes", type_="check")
```

### 9.3 TDD 流程

**Red（1 测试，追加到 `tests/test_models.py`）**:

```python
@pytest.mark.asyncio
async def test_note_invalid_status_raises_integrity_error(space_session):
    """Note with invalid status should raise IntegrityError."""
    from app.models.note import Note
    from sqlalchemy.exc import IntegrityError

    note = Note(
        id="test-invalid-status",
        title="T",
        status="invalid_status",  # not in ('active','archived')
    )
    space_session.add(note)
    with pytest.raises(IntegrityError):
        await space_session.flush()
```

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_models.py -k note_status -v
```

---

## 十、P3.5 — Task 字段索引 + Alembic 004（1 测试）

### 10.1 修改文件: `backend/app/models/task.py`

**当前 L17-22**:

```python
status: Mapped[str] = mapped_column(String(20), default="todo")
priority: Mapped[str] = mapped_column(String(20), default="medium")
due_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
```

**修改为**:

```python
status: Mapped[str] = mapped_column(String(20), default="todo", index=True)
priority: Mapped[str] = mapped_column(String(20), default="medium", index=True)
due_date: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
```

### 10.2 新建文件: `backend/alembic/versions/004_task_indexes.py`

```python
"""task_indexes: add indexes on tasks.status, tasks.priority, tasks.due_date.

Revision ID: 004
Revises: 003
Create Date: 2026-07-04 00:00:02
"""
from typing import Sequence, Union

from alembic import op


revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_tasks_status", "tasks", ["status"])
    op.create_index("ix_tasks_priority", "tasks", ["priority"])
    op.create_index("ix_tasks_due_date", "tasks", ["due_date"])


def downgrade() -> None:
    op.drop_index("ix_tasks_due_date", table_name="tasks")
    op.drop_index("ix_tasks_priority", table_name="tasks")
    op.drop_index("ix_tasks_status", table_name="tasks")
```

### 10.3 TDD 流程

**Red（1 测试，追加到 `tests/test_models.py`）**:

```python
def test_task_has_indexes_on_query_fields():
    """Task model should have indexes on status, priority, due_date."""
    from app.models.task import Task

    indexed_cols = {
        col.name for col in Task.__table__.columns if col.index
    }
    assert "status" in indexed_cols
    assert "priority" in indexed_cols
    assert "due_date" in indexed_cols
```

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_models.py -k task_index -v
```

---

## 十一、P3.6 — deps.py space_id 校验（1 测试）

### 11.1 修改文件: `backend/app/deps.py`

**当前 [deps.py L57-69](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/deps.py#L57-L69)**:

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

**修改为**:

```python
async def get_space_context(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if user.get("type") != "space":
        raise AuthorizationError("Space token required")
    space_id = user.get("space_id")
    if not space_id:
        raise AuthenticationError("Space token missing space_id")
    # 校验 space 真实存在（防止伪造 token 访问不存在的 space）
    from app.db.models.meta import Space
    from app.db.meta_session import get_meta_session
    from sqlalchemy import select
    from app.errors import NotFoundError

    async for meta_db in get_meta_session():
        result = await meta_db.execute(
            select(Space).where(Space.id == str(space_id))
        )
        if result.scalar_one_or_none() is None:
            raise NotFoundError(f"Space '{space_id}' not found")
        break

    return {"space_id": str(space_id), "user_id": str(user.get("sub"))}
```

### 11.2 TDD 流程

**Red（1 测试，追加到 `tests/test_deps.py`）**:

```python
@pytest.mark.asyncio
async def test_get_space_context_raises_on_unknown_space_id(_isolate_env):
    """get_space_context should raise NotFoundError for non-existent space_id."""
    from app.deps import get_space_context
    from app.errors import NotFoundError

    fake_user = {
        "type": "space",
        "space_id": "spc_nonexistent",
        "sub": "user-1",
    }
    with pytest.raises(NotFoundError, match="Space 'spc_nonexistent' not found"):
        await get_space_context(fake_user)
```

**验证**:
```powershell
.venv\Scripts\python.exe -m pytest tests/test_deps.py -k unknown_space -v
```

---

## 十二、执行计划表

| 阶段 | 任务 | 工具 | 优先级 | 测试数 |
|------|------|------|--------|--------|
| C6 | NoteService sync_mode + _push_note_event | Edit note.py + sync.py + TDD | P2 | 4 测试 |
| C7 | sync 路由 4 端点 + 注册 | Write routes/v1/sync.py + Edit __init__.py + TDD | P2 | 7 测试 |
| C9 | SyncService._write_audit + 调用点 | Edit sync.py + TDD | P2 | 3 测试 |
| C10 | 集成测试 | Write test_sync_integration.py + TDD | P2 | 8 测试 |
| P3.1 | TaskService.update tags 转换 | Edit task.py + TDD | P3 | 1 测试 |
| P3.2 | trash.py purge N+1 修复 | Edit trash.py + TDD | P3 | 1 测试 |
| P3.3 | serializers json.loads 保护 | Edit serializers.py + TDD | P3 | 1 测试 |
| P3.4 | Note status CheckConstraint | Edit note.py + Write 003 migration + TDD | P3 | 1 测试 |
| P3.5 | Task 字段索引 | Edit task.py + Write 004 migration + TDD | P3 | 1 测试 |
| P3.6 | deps.py space_id 校验 | Edit deps.py + TDD | P3 | 1 测试 |
| 收尾 | 更新 project_memory.md | Edit memory 文件 | - | - |
| **合计** | 11 任务 | | | **~29 新测试** |

---

## 十三、假设与决策

### 13.1 假设

1. v3 计划已完成 P1.3 + C1 + C2 + C3 + C4 + C5 + C8，基线 326 测试全绿
2. `space_session` / `client` fixture 已就绪（[conftest.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/conftest.py) 确认）
3. Phase C 详细代码模板已在 v3 计划提供
4. test-driven-development Skill 提供 TDD Red-Green-Refactor 流程引导
5. 全程遵守三层铁律（Service 不导入 fastapi，不调 commit）
6. `app.db.models.meta.Space` 模型存在（用于 P3.6 space_id 校验）
7. `app.db.meta_session.get_meta_session` 存在（[deps.py L75-80](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/deps.py#L75-L80) 已使用）

### 13.2 决策

- **D1**: C6 在 NoteService.create 中通过 `super().create(data)` 传递 client 字段；SyncMixin 的 `default=` 仅在字段未提供时生效，data 中显式传入即覆盖
- **D2**: C6 _push_note_event 中 update 操作先 `db.get(Note, eid)` 做 LWW 检测，再委托 NoteService.update（避免 NoteService 内部 get 两次）
- **D3**: C7 sync 路由复用 `get_space_db` / `get_file_system` / `get_space_context` 三个依赖
- **D4**: C9 _write_audit 用 try/except 包裹，失败仅 logger.warning；rollback 仅在 audit flush 失败时触发（接受 trade-off）
- **D5**: C10 集成测试不强制使用 agent-browser（前端未存在，使用 client fixture 完成 HTTP 端到端）
- **D6**: P3.2 保留 `db.delete(obj)` ORM cascade 行为，仅将 N 次 `db.get` 改为 1 次 `select(...).where(in_(desc_ids))`
- **D7**: P3.3 与 sync_safety.py 的保护逻辑保持一致（dry）
- **D8**: P3.4/P3.5 各新建 1 个 Alembic migration（003/004），沿用 002 的模式
- **D9**: P3.6 通过查询 meta DB 的 Space 表校验 space_id 存在性（增加 1 次 DB 查询，接受 trade-off）
- **D10**: 全部任务完成后更新 `project_memory.md` 标注 Phase C 完成 + 测试总数

### 13.3 不做的事

- ❌ 不修改 session_memory_*.jsonl 或 topics.md
- ❌ 不修改 user_profile.md
- ❌ 不创建除计划要求和必要代码文件之外的新文档
- ❌ 不主动启动 Phase D-H
- ❌ 不修改 cognee 索引
- ❌ 不重写 P0/P1.1/P1.2/C1-C5/C8 已完成的工作
- ❌ 不修改 alembic/env.py（include_object 过滤器已正确实现）

---

## 十四、验证步骤

### 14.1 单元测试验证（按任务）

```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'

# C6
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -k "sync_mode or note_event" -v

# C7
.venv\Scripts\python.exe -m pytest tests/test_sync_routes.py -v

# C9
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -k audit -v

# C10
.venv\Scripts\python.exe -m pytest tests/test_sync_integration.py -v

# P3.1
.venv\Scripts\python.exe -m pytest tests/test_task_service.py -k update_tags -v

# P3.2
.venv\Scripts\python.exe -m pytest tests/test_routes_v1.py -k purge -v

# P3.3
.venv\Scripts\python.exe -m pytest tests/test_serializers.py -v

# P3.4
.venv\Scripts\python.exe -m pytest tests/test_models.py -k note_status -v

# P3.5
.venv\Scripts\python.exe -m pytest tests/test_models.py -k task_index -v

# P3.6
.venv\Scripts\python.exe -m pytest tests/test_deps.py -k unknown_space -v
```

### 14.2 全量回归

```powershell
.venv\Scripts\python.exe -m pytest -q
# 预期 326 + ~29 = ~355 全绿
```

### 14.3 三层铁律检查

```powershell
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if 'fastapi' in f.read_text(encoding='utf-8')]"
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if '.commit()' in f.read_text(encoding='utf-8')]"
# 两个命令都应返回空
```

### 14.4 收尾

1. 更新 `c:\Users\20564\.trae-cn\memory\projects\-e-Development-MyAwesomeApp-PomodoroXII\project_memory.md`:
   - Phase C 状态: ❌ 0% → ✅ 完成
   - 测试总数: 326 → 355
   - 已修复问题列表追加: C6/C7/C9/C10/P3.1-P3.6
2. 不修改 topics.md（系统自动生成）

---

## 十五、关键约束（铁律）

1. **三层铁律**: Routers commit / Services flush / Models 纯数据 — 严格遵守
2. **TDD 流程**: 每个任务先写测试（Red），再实现（Green），最后重构（Refactor）
3. **代码引用规范**: 所有代码引用使用 `file:///` 链接格式
4. **不创建非必要文件**: 仅创建计划要求的代码文件 + 测试文件 + 必要 Alembic migration
5. **路径规范**: 当前仓库为 `e:\Development\MyAwesomeApp\PomodoroXII\backend`
6. **Skill 使用**: test-driven-development 用于 TDD 流程，agent-browser 不使用（前端未存在）
7. **不动用户代码之外的范围**: 不修改 cognee 索引，不修改 session_memory，不修改 user_profile

---

## 十六、风险与缓解

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| C6 sync_mode 影响 NoteService 现有 14 测试 | 高 | sync_mode 默认 False，现有测试全量回归验证 |
| C6 _push_note_event 在 SAVEPOINT 内调用 NoteService.update_content（含 Saga 补偿） | 高 | C5 已验证 SAVEPOINT 兼容性；C6 复用相同模式 |
| C7 路由测试需要 master token + space token 流程 | 中 | 参考 [test_routes_auth_spaces.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_routes_auth_spaces.py) 模式 |
| C9 audit rollback 可能影响 outer tx | 中 | _write_audit 失败仅 logger.warning + rollback，接受 trade-off |
| P3.6 增加 meta DB 查询影响性能 | 低 | 每请求 1 次查询，可接受；后续可加 LRU 缓存优化 |
| Alembic 003/004 可能与现有冲突 | 低 | 002 已成功；003/004 沿用相同模式 |
| 测试总数增长后 conftest 隔离可能失效 | 中 | 每阶段全量回归验证（326 → 355） |
| C10 集成测试复杂度高 | 中 | 使用 `client` fixture 完整 HTTP 流程，不依赖 agent-browser |

---

## 十七、执行顺序（推荐）

```
1. C6 (NoteService sync_mode + _push_note_event) — 4 测试
   ↓
2. C9 (_write_audit) — 3 测试
   ↓
3. C7 (sync 路由) — 7 测试  [依赖 C6/C9]
   ↓
4. C10 (集成测试) — 8 测试  [依赖 C7]
   ↓
5. P3.1-P3.6 (并行/串行均可) — 6 测试
   ↓
6. 全量回归 + 三层铁律检查
   ↓
7. 收尾: 更新 project_memory.md
```

> **关键路径**: C6 → C9 → C7 → C10 → P3.x。C6 是 C7/C10 的前置（note 事件需走 NoteService）；C7 是 C10 的前置（集成测试需 HTTP 端点）。
