# Sync 引擎深度审查与重建计划

> **TDD 铁律**: 每个生产代码必须有先失败的测试。RED → 验证失败 → GREEN → 验证通过。
> **三层铁律**: (1) Service 不导入 fastapi/不调 commit; (2) Note 模型无 content 字段; (3) 双 JWT 认证。

## 审查结论

**CRITICAL: 整个 Phase C Sync 引擎代码不存在。** 前一会话的 Python 脚本写入了不存在的路径 `pomodoroxi\PomodoroXII-rebuild`，实际路径是 `e:\Development\MyAwesomeApp\PomodoroXII\backend`。所有 sync 相关代码完全丢失。

**额外发现 5 个问题:**
1. `.env` 文件损坏（reparse point），导致 6 个测试收集错误
2. `pytest-cov` 包损坏（缺少 plugin 子模块），阻止 pytest 启动
3. NoteService 无 Saga 补偿（create 失败留孤立 .md；update_content 失败丢旧内容；delete 顺序错误 FS→DB→tombstone）
4. NoteService 无 sync_mode（无法保留客户端 updated_at，导致 LWW 误判）
5. 缺少 3 个 schema 文件（schedule_quick_note, session_quick_note, task_quick_note）

**实际项目路径**: `e:\Development\MyAwesomeApp\PomodoroXII\backend`
**venv Python**: `e:\Development\MyAwesomeApp\PomodoroXII\backend\.venv\Scripts\python.exe`
**依赖安装**: `uv pip install <pkg> --python '.venv\Scripts\python.exe'`

## 执行依赖顺序

```
任务0(环境修复) → 任务1(3个schema) → 任务2(NoteService升级) → 任务3(SyncSafety) → 任务4(sync schemas) → 任务5(SyncService) → 任务6(sync路由) → 任务7(集成测试) → 任务8(全量验证)
```

---

## 任务 0: 环境修复

### 问题
- `.env` 是损坏的 reparse point（`os.path.exists` 返回 True 但 `open` 失败）
- `pytest-cov` 已卸载但 setuptools entrypoint 残留

### 修复

**步骤 1**: 删除损坏的 `.env` 并重建:
```
POMODOROXII_SECRET_KEY=dev-secret-key-not-for-production-use-0123456789abcdef
POMODOROXII_ENVIRONMENT=development
POMODOROXII_DATABASE_URL=sqlite+aiosqlite:///./data/meta.db
POMODOROXII_SPACES_DATA_DIR=./data/spaces
```

**步骤 2**: 在 `tests/conftest.py` 最顶部（所有 import 之前）插入环境变量兜底:
```python
import os
os.environ.setdefault("POMODOROXII_SECRET_KEY", "test-secret-key-not-for-production-use")
os.environ.setdefault("POMODOROXII_ENVIRONMENT", "development")
os.environ.setdefault("POMODOROXII_DATABASE_URL", "sqlite+aiosqlite:///./data/meta.db")
os.environ.setdefault("POMODOROXII_SPACES_DATA_DIR", "./data/spaces")
```

### 验证
```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'
& '.venv\Scripts\python.exe' -m pytest --collect-only -q 2>&1 | Select-Object -Last 5
```
预期: `208 tests collected, 0 errors`（从 `202 collected, 6 errors` 改善）

---

## 任务 1: 创建 3 个缺失 schema

### 参照模式
`app/schemas/habit_check_in.py`: Base/Create/Update/Response 四件套，`model_config = {"from_attributes": True}`。

### 新建文件

**`app/schemas/session_quick_note.py`**:
```python
"""Pydantic schemas for session-quick-note junction."""
from typing import Optional
from pydantic import BaseModel, Field

class SessionQuickNoteBase(BaseModel):
    session_id: str = Field(..., max_length=36)
    quick_note_id: str = Field(..., max_length=36)

class SessionQuickNoteCreate(SessionQuickNoteBase):
    id: Optional[str] = None

class SessionQuickNoteUpdate(BaseModel):
    session_id: Optional[str] = Field(default=None, max_length=36)
    quick_note_id: Optional[str] = Field(default=None, max_length=36)

class SessionQuickNoteResponse(SessionQuickNoteBase):
    id: str
    created_at: str
    updated_at: str
    version: int = 1
    model_config = {"from_attributes": True}
```

**`app/schemas/schedule_quick_note.py`**: 同上，`session_id` → `schedule_id`，类名 `ScheduleQuickNote*`。

**`app/schemas/task_quick_note.py`**: 同上，`session_id` → `task_id`，类名 `TaskQuickNote*`。

### TDD 验证
先在 `tests/test_schemas.py` 追加 3 个测试（ImportError 失败），创建文件后通过。

---

## 任务 2: 升级 NoteService（Saga + sync_mode）

### 现有问题
- `create()`: 无补偿 — `super().create()` 失败后 .md 文件孤立
- `update_content()`: 无补偿 — `db.flush()` 失败后旧内容丢失
- `delete()`: 顺序错误（FS→DB→tombstone），应改为 DB→tombstone→FS
- 无 `sync_mode` — `BaseService.update()` 始终覆盖 `updated_at`，sync 场景下 LWW 误判

### 修改文件
`app/services/note.py`

### 设计
- `sync_mode: bool = False` 作为方法参数（非构造函数），默认 False 保持向后兼容
- Saga: try 块内执行正向操作，except 块执行补偿
- `sync_mode=True` 时: 保留客户端 `updated_at`/`version`/`created_at`，不使用 `utc_now_iso()` 覆盖

### 关键改动

**`create` 添加补偿**:
```python
async def create(self, data: dict[str, Any], sync_mode: bool = False) -> Any:
    data = dict(data)
    content = data.pop("content", "")
    # ... 解析 title/folder_id/tags/external_id（同现状）
    meta = await self.fs.create_note(...)
    data["id"] = meta.id
    data["content_hash"] = meta.content_hash
    data["word_count"] = meta.word_count
    if "tags" in data and isinstance(data["tags"], list):
        data["tags"] = json.dumps(data["tags"])
    if not sync_mode:
        data.pop("created_at", None)
        data.pop("updated_at", None)
        data.pop("version", None)
    try:
        return await super().create(data)
    except Exception:
        try:
            await self.fs.delete_note(meta.id)
        except (KeyError, FileNotFoundError):
            pass
        raise
```

**`update_content` 添加补偿**:
```python
async def update_content(self, id: str, content: str, sync_mode: bool = False) -> Any:
    old_content: str | None = None
    try:
        old_content = await self.fs.read_note(id)
    except (KeyError, FileNotFoundError):
        pass
    meta = await self.fs.edit_note(id, content)
    try:
        obj = await self.get(id)
        obj.content_hash = meta.content_hash
        obj.word_count = meta.word_count
        if not sync_mode:
            obj.updated_at = utc_now_iso()
        await self.db.flush()
        await self.db.refresh(obj)
        return obj
    except Exception:
        if old_content is not None:
            try:
                await self.fs.edit_note(id, old_content)
            except (KeyError, FileNotFoundError):
                pass
        raise
```

**`update_metadata` 添加 sync_mode 旁路**:
```python
async def update_metadata(self, id: str, data: dict[str, Any], sync_mode: bool = False) -> Any:
    data = dict(data)
    data.pop("content", None)
    data.pop("content_hash", None)
    data.pop("word_count", None)
    if "tags" in data and isinstance(data["tags"], list):
        data["tags"] = json.dumps(data["tags"])
    if sync_mode:
        obj = await self.get(id)
        for k, v in data.items():
            if hasattr(obj, k) and k != "id":
                setattr(obj, k, v)
        if "updated_at" not in data:
            obj.updated_at = utc_now_iso()
        await self.db.flush()
        await self.db.refresh(obj)
        return obj
    return await super().update(id, data)
```

**`delete` 改为 DB→tombstone→FS 顺序**:
```python
async def delete(self, id: str, sync_mode: bool = False) -> None:
    obj = await self.db.get(self.model, id)
    if obj is not None:
        await self.db.delete(obj)
        await self.db.flush()
    await TombstoneService(self.db).create("note", id)
    try:
        await self.fs.delete_note(id)
    except (KeyError, FileNotFoundError):
        pass
```

**`update` 传递 sync_mode**:
```python
async def update(self, id: str, data: dict[str, Any], sync_mode: bool = False) -> Any:
    data = dict(data)
    content = data.pop("content", None)
    obj = None
    if content is not None:
        obj = await self.update_content(id, content, sync_mode=sync_mode)
    if data:
        obj = await self.update_metadata(id, data, sync_mode=sync_mode)
    if obj is None:
        obj = await self.get(id)
    return obj
```

### TDD 验证
在 `tests/test_note_service.py` 追加 4 个测试:
- `test_create_saga_compensates_on_db_failure` — monkeypatch `BaseService.create` 抛错，验证 .md 被删除
- `test_update_content_saga_restores_on_failure` — monkeypatch `db.flush` 抛错，验证 content 恢复
- `test_sync_mode_preserves_client_timestamps` — sync_mode=True 保留 updated_at/version
- `test_update_metadata_sync_mode_bypasses_updated_at` — sync_mode=True 保留客户端 updated_at

**失败验证**: `TypeError: create() got an unexpected keyword argument 'sync_mode'`
**通过验证**: 4 个新测试 + 原 8 个测试全绿

---

## 任务 3: 创建 SyncSafety（纯函数安全层）

### 新建文件
`app/services/sync_safety.py`

### 函数清单
- `normalize_timestamp(ts)` — 规范化为 Z 后缀 ISO 字符串
- `is_zero_time(ts)` — 判断零时间
- `sanitize_zero_time(ts)` — 零时间替换为当前 UTC
- `serialize_entity_data(obj)` — ORM → dict（处理 tags JSON）
- `check_lww_conflict(local_updated_at, local_version, remote_updated_at, remote_version)` — LWW 冲突检测
- `async check_tombstone(tomb_svc, entity_type, entity_id)` — 墓碑检查
- `async check_folder_cycle(db, folder_id, new_parent_id)` — 文件夹环检测
- `check_ttl_guard(deleted_at, ttl_days)` — TTL 守卫

### TDD 验证
先写 `tests/test_sync_safety.py`（10 个测试），验证 ImportError 失败，创建文件后通过。

---

## 任务 4: 创建 sync schemas

### 新建文件
`app/schemas/sync.py`

```python
"""Pydantic schemas for the sync protocol."""
from typing import Any, Optional
from pydantic import BaseModel, Field

class SyncEvent(BaseModel):
    entity_type: str
    entity_id: str
    action: str
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: str = ""
    version: int = 1

class SyncPushRequest(BaseModel):
    events: list[SyncEvent]
    client_id: Optional[str] = None

class SyncPushResponse(BaseModel):
    applied: int = 0
    skipped: int = 0
    errors: list[dict[str, Any]] = Field(default_factory=list)

class SyncPullResponse(BaseModel):
    events: list[dict[str, Any]] = Field(default_factory=list)
    tombstones: list[dict[str, Any]] = Field(default_factory=list)
    has_more: bool = False
    next_offset: Optional[int] = None
    model_config = {"extra": "allow"}

class SyncFullResponse(BaseModel):
    entities: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    tombstones: list[dict[str, Any]] = Field(default_factory=dict)
    note_contents: dict[str, str] = Field(default_factory=dict)

class SyncStatusResponse(BaseModel):
    entity_counts: dict[str, int] = Field(default_factory=dict)
    tombstone_count: int = 0
    last_sync: Optional[str] = None
```

---

## 任务 5: 创建 SyncService（核心引擎）

### 新建文件
`app/services/sync.py`

### 设计要点
- `ENTITY_REGISTRY`: `dict[str, type]`，14 个实体类型 → 模型类
- `push()`: 每事件 `begin_nested()` SAVEPOINT 隔离；`_write_audit` 在 savepoint 外（独立 try/except）
- `pull()`: 增量拉取 `updated_at > since`，分页 `limit+1` 检测 has_more
- `full()`: 全量拉取所有实体 + tombstones + note contents（用 `read_notes_batch` 批量桥接）
- `status()`: 各实体计数 + tombstone 计数
- `_push_note_event()`: Note 特殊处理，走 NoteService(sync_mode=True)
- `_write_audit()`: 独立 savepoint + try/except，审计失败不影响主操作

### 关键设计决策

**`_write_audit` 放在 savepoint 外**:
```python
async def push(self, events: list[dict]) -> dict:
    applied = 0; skipped = 0; errors = []
    for ev in events:
        try:
            async with self.db.begin_nested():
                ok = await self._apply_event(ev)
            if ok:
                applied += 1
            else:
                skipped += 1
        except Exception as exc:
            skipped += 1
            errors.append({...})
            continue
        # 审计在 savepoint 外，失败不影响已应用的事件
        await self._write_audit(ev.get("action", ""), ...)
    return {"applied": applied, "skipped": skipped, "errors": errors}
```

**LWW 在 `_apply_upsert` 中**:
- `check_lww_conflict(obj.updated_at, obj.version, remote_ts, remote_ver)` 返回 False → 跳过
- sync_mode 旁路: 直接 `setattr` 不走 `super().update()`（避免覆盖 updated_at）

**Note 桥接在 `pull()` 和 `full()` 中**:
- `pull()`: note content 不在 events 中附加（客户端通过 `GET /notes/{id}/content` 单独获取）
- `full()`: 用 `read_notes_batch` 批量读取 note contents

### TDD 验证
先写 `tests/test_sync_service.py`（10 个测试）:
- push create/update/delete/tombstone_guard/savepoint_isolation/note_bridge/audit
- pull returns changes
- full returns entities + note contents
- status returns counts

---

## 任务 6: 创建 sync 路由 + 注册

### 新建文件
`app/routes/v1/sync.py`（4 端点: POST /push, GET /pull, GET /full, GET /status）

### 修改文件
`app/routes/v1/__init__.py` — 注册 `sync_router`

### 设计
- push/pull/full/status 都依赖 `get_space_db` + `get_space_context`
- push/pull/full 也依赖 `get_file_system`（note content 桥接）
- 路由层 `await db.commit()`，Service 只 flush
- `response_model` 用 sync schemas

### TDD 验证
先写 `tests/test_sync_routes.py`（5 个测试），验证 404 失败，创建路由后通过。
Gate 测试 `test_gate_all_v1_routes_registered` 断言 `>= 40`，新增 4 条后达 44+。

---

## 任务 7: 集成测试

### 新建文件
`tests/test_sync_integration.py`（3 个端到端测试）

- `test_sync_roundtrip_push_then_pull` — push task → pull 取回
- `test_sync_note_full_flow` — push note(含content) → full 取回 note_contents
- `test_sync_delete_then_pull_tombstone` — push delete → pull 返回 tombstone

---

## 任务 8: 全量验证

```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'
& '.venv\Scripts\python.exe' -m pytest -q
```

预期: 0 failed, 0 errors。测试总数约 230+（208 基线 + ~25 新测试）。

Gate 测试专项:
- `test_gate_services_do_not_import_fastapi` — sync.py/sync_safety.py 无 fastapi import
- `test_gate_all_v1_routes_registered` — 44+ >= 40

---

## 文件清单

### 新建（7 生产 + 4 测试）
- `app/schemas/session_quick_note.py`
- `app/schemas/schedule_quick_note.py`
- `app/schemas/task_quick_note.py`
- `app/schemas/sync.py`
- `app/services/sync_safety.py`
- `app/services/sync.py`
- `app/routes/v1/sync.py`
- `tests/test_sync_safety.py`
- `tests/test_sync_service.py`
- `tests/test_sync_routes.py`
- `tests/test_sync_integration.py`

### 修改（4）
- `.env`（删除重建）
- `tests/conftest.py`（顶部加 os.environ.setdefault）
- `app/services/note.py`（Saga + sync_mode）
- `app/routes/v1/__init__.py`（注册 sync_router）

### 追加测试（2）
- `tests/test_schemas.py`（3 个 schema 测试）
- `tests/test_note_service.py`（4 个 Saga 测试）

---

## 假设与决策

1. **sync_mode 作为方法参数**（非构造函数）: 向后兼容，默认 False
2. **_write_audit 在 savepoint 外**: 审计失败不影响已应用事件
3. **ENTITY_REGISTRY 简化为 type→model**: Service 层接受 dict，不需要 schema 验证
4. **SyncSafety 纯函数**: 大部分函数无状态，需要 DB 的函数接受 service/db 参数
5. **pull 不附加 note content**: 客户端单独请求 note content，减少 pull 负载
6. **full 用 read_notes_batch**: 首次同步批量读取，效率更高
7. **delete 顺序 DB→tombstone→FS**: DB 失败时 FS 保持完整
