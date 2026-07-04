# PomodoroXII 深度交接 Prompt

> **用途**: 将「--- PROMPT 开始 ---」到「--- PROMPT 结束 ---」整段复制到新对话，让新 Agent 接手 P0 修复 + Phase C 实施。
>
> **前置文档**: `PhaseC转接文档.md`（已修剪，指向本文件）

---

## --- PROMPT 开始 ---

你正在接手 PomodoroXII 重构项目。以下是完整上下文。

### 使命顺序

```
P0 修复（3 项，阻塞 Phase C）→ Phase C（sync_safety → SyncService → sync 路由）→ Phase B 收尾
```

### 当前状态

- **244 测试全绿**，Phase B 约 90% 完成
- 工作目录: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
- 源项目参考: `e:\Development\MyAwesomeApp\pomodoroxi\backend`

### 三条路径

| 路径 | 用途 |
|------|------|
| `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild` | **目标项目**（你在此工作） |
| `e:\Development\MyAwesomeApp\pomodoroxi` | **源项目**（参考代码 + 核心文档） |
| `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\核心文档` | 13 篇深度设计文档 |

### 铁律（违反即拒绝）

1. **Routers commit / Services flush / Models 纯数据**
   - `app/routes/*.py` 调用 `await db.commit()`
   - `app/services/*.py` 只调用 `await db.flush()`，绝不 `commit()`
   - `app/services/*.py` 不导入 `fastapi`（MCP 预留）
   - `app/models/*.py` 只有字段定义和约束

2. **Note 模型无 content 字段**
   - .md 文件是唯一 Source of Truth
   - Note ORM: `content_hash` + `word_count`，不含 `content`
   - NoteResponse 排除 `content`；NoteUpdate 含 `content`（用于 FS 分发）

3. **双 JWT 认证**
   - Master Token (7天): 空间管理路由，`Depends(require_master_token)` + `Depends(get_meta_db)`
   - Space Token (8小时): 业务路由，`Depends(get_space_db)` + `Depends(get_space_context)`

4. **双 DB 架构**
   - Meta DB (`data/meta.db`): 仅 `spaces` + `meta_settings` 两表
   - Space DB (`data/spaces/{space_id}/space.db`): 18 业务表
   - 两者共享同一个 `Base.metadata` 但表集不同

5. **写文件限制**
   - 目标项目路径含小写 `pomodoroxi`，在 TRAE 工作区外
   - 修改文件: 先写入 `c:\Users\20564\.trae-cn\work\6a456ee7fd1417296e067a49\` 临时目录，再用 Python `shutil.copy2` 复制到目标
   - 新建测试文件: 同上

---

## P0 修复（开 Phase C 前必做）

### P0-1: Alembic meta/space DB 策略分裂

#### 问题根因

`Base.metadata` 注册了全部 20 张表（2 meta + 18 business），因为 `alembic/env.py` 同时导入:
```python
from app.db.models import meta  # 注册 Space, MetaSetting
from app.models import *        # 注册 18 个业务模型
```

导致三个运行时矛盾:

| 调用点 | 代码 | 问题 |
|--------|------|------|
| `meta_session.init_meta_db()` | `Base.metadata.create_all(conn)` | 在 meta.db 上创建全部 20 表（应为 2） |
| `space_manager._init_schema()` | `Base.metadata.create_all(conn)` | 在 space.db 上创建全部 20 表（应为 18） |
| `alembic upgrade head` | env.py 不区分目标 DB | 对 meta.db 执行 18 业务表的 migration |

#### 方案 A（推荐）: `tables=` 参数过滤

**核心思路**: 保持单一 `Base`，用 `tables=` 参数精确控制 `create_all` 创建哪些表。

**改动 1**: `app/db/meta_session.py` — `init_meta_db()` 只创建 meta 表

```python
async def init_meta_db() -> AsyncEngine:
    global _meta_engine, _meta_session_factory
    if _meta_engine is not None:
        return _meta_engine
    from app.db.models import meta  # noqa: F401
    from app.db.models.meta import Space, MetaSetting
    _meta_engine = create_engine(settings.database_url, echo=settings.debug)
    _meta_session_factory = create_session_factory(_meta_engine)
    async with _meta_engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[Space.__table__, MetaSetting.__table__],
        )
    logger.info("Meta database initialised at %s", settings.database_url)
    return _meta_engine
```

**改动 2**: `app/space_manager.py` — `_init_schema()` 只创建业务表

```python
@staticmethod
async def _init_schema(engine: AsyncEngine) -> None:
    from app.db.models.meta import Space, MetaSetting
    # 排除 meta 表，只创建业务表
    space_tables = [
        t for name, t in Base.metadata.tables.items()
        if name not in ("spaces", "meta_settings")
    ]
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=space_tables)
```

**改动 3**: `alembic/env.py` — 添加 `include_object` 过滤器

```python
def include_object(object, name, type_, reflected, compare_to):
    """Meta DB migration 只创建 spaces + meta_settings;
    Space DB migration 只创建业务表。"""
    # 通过 config.attributes["target"] 判断目标
    target = config.attributes.get("target", "space")  # "meta" or "space"
    if target == "meta":
        return name in ("spaces", "meta_settings")
    else:
        return name not in ("spaces", "meta_settings")

def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()
```

**改动 4**: 测试 — 新增 `tests/test_db_isolation.py`（3 测试）

```python
@pytest.mark.asyncio
async def test_meta_db_has_only_2_tables(_isolate_env):
    """Meta DB should only contain spaces + meta_settings."""
    from app.db.meta_session import init_meta_db
    from sqlalchemy import inspect
    engine = await init_meta_db()
    async with engine.connect() as conn:
        tables = await conn.run_sync(lambda sync_conn: inspect(sync_conn).get_table_names())
    assert set(tables) == {"spaces", "meta_settings"}

@pytest.mark.asyncio
async def test_space_db_excludes_meta_tables(_isolate_env):
    """Space DB should not contain spaces or meta_settings tables."""
    from app.space_manager import get_space_engine_manager
    from app.db.meta_session import init_meta_db
    from sqlalchemy import inspect
    await init_meta_db()
    manager = get_space_engine_manager()
    engine = await manager.get_engine("spc_test")
    async with engine.connect() as conn:
        tables = await conn.run_sync(lambda sync_conn: inspect(sync_conn).get_table_names())
    assert "spaces" not in tables
    assert "meta_settings" not in tables
    assert len(tables) == 18  # 业务表数量

@pytest.mark.asyncio
async def test_space_db_has_all_business_tables(_isolate_env):
    """Space DB should contain all 18 business tables."""
    # 类似上面，验证 18 个业务表名都存在
```

**验收**: `uv run pytest tests/test_db_isolation.py -v` 3/3 通过 + 全量回归 247/247

---

### P0-2: NoteService Saga 重构

#### 问题根因

当前 `NoteService.create()` 写序:
```
1. fs.create_note()     → 写 .md 文件（不可回滚）
2. super().create(data) → DB flush（可回滚但 .md 已写）
```
如果步骤 2 失败 → **孤儿 .md 文件**。

`NoteService.update_content()` 同理:
```
1. fs.edit_note()       → 改写 .md 文件
2. obj.content_hash = … → DB flush
```
如果步骤 2 失败 → **.md 内容已变但 DB hash 不变**。

Phase C 的 `sync_push` 会用 `db.begin_nested()` (SAVEPOINT)，一个事件失败只回滚 DB 不回滚 FS，放大此问题。

#### 修复方案: DB flush 先行 → FS 写入 → 补偿回滚

**`app/services/note.py` — `create()` 重构**:

```python
async def create(self, data: dict[str, Any]) -> Any:
    """Create: flush DB row first, then write .md, compensate on failure."""
    data = dict(data)
    content = data.pop("content", "")
    title = data.get("title", "")
    folder_id = data.get("folder_id")
    tags = data.get("tags", [])
    if isinstance(tags, str):
        tags = json.loads(tags) if tags else []
    external_id = data.get("id")

    # 先写 DB（可回滚）
    data["content_hash"] = ""  # 占位，FS 写入后更新
    data["word_count"] = 0
    if "tags" in data and isinstance(data["tags"], list):
        data["tags"] = json.dumps(data["tags"])
    obj = await super().create(data)  # flush + refresh

    # 再写 FS
    try:
        meta = await self.fs.create_note(
            title=title, content=content, folder_id=folder_id,
            tags=tags, external_id=external_id,
        )
    except Exception:
        # FS 失败 → 回滚 DB 行
        await self.db.delete(obj)
        await self.db.flush()
        raise

    # FS 成功 → 更新 DB hash/count
    obj.content_hash = meta.content_hash
    obj.word_count = meta.word_count
    await self.db.flush()
    await self.db.refresh(obj)
    return obj
```

**`app/services/note.py` — `update_content()` 重构**:

```python
async def update_content(self, id: str, content: str) -> Any:
    """Rewrite .md file and sync hash/count. Compensate on failure."""
    obj = await self.get(id)
    old_hash = obj.content_hash
    old_count = obj.word_count

    # 先写 FS
    try:
        meta = await self.fs.edit_note(id, content)
    except Exception:
        # FS 失败 → DB 不变，直接抛出
        raise

    # FS 成功 → 更新 DB
    obj.content_hash = meta.content_hash
    obj.word_count = meta.word_count
    obj.updated_at = utc_now_iso()
    await self.db.flush()
    await self.db.refresh(obj)
    return obj
```

**`app/services/note.py` — `delete()` 重构**:

```python
async def delete(self, id: str) -> None:
    """Delete: DB first, FS best-effort, tombstone always."""
    obj = await self.db.get(self.model, id)
    if obj is not None:
        await self.db.delete(obj)
        await self.db.flush()
    # FS 删除是 best-effort（DB 已删，孤儿 .md 无害）
    try:
        await self.fs.delete_note(id)
    except (KeyError, FileNotFoundError):
        pass
    # 墓碑始终创建
    tomb_svc = TombstoneService(self.db)
    await tomb_svc.create("note", id)
```

**测试**: 更新 `tests/test_note_service.py` 新增 3 个补偿测试

```python
@pytest.mark.asyncio
async def test_note_create_compensates_on_fs_failure(space_session, ...):
    """If FS create_note fails, DB row should be rolled back."""
    # Mock fs.create_note to raise
    # Assert no Note row in DB

@pytest.mark.asyncio
async def test_note_update_content_keeps_old_hash_on_fs_failure(space_session, ...):
    """If FS edit_note fails, DB hash/count should remain unchanged."""
    # Mock fs.edit_note to raise
    # Assert obj.content_hash == old_hash

@pytest.mark.asyncio
async def test_note_delete_db_first_then_fs(space_session, ...):
    """Delete should remove DB row even if FS deletion fails."""
    # Mock fs.delete_note to raise
    # Assert DB row is gone, tombstone exists
```

**验收**: `uv run pytest tests/test_note_service.py -v` 全通过 + 全量回归

---

### P0-3: Git + 清理 temp + .env.example

#### 3a: Git 初始化

```powershell
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild
git init
```

**`.gitignore`** (新建，放在 `PomodoroXII-rebuild/` 根目录):
```gitignore
# Python
__pycache__/
*.py[cod]
*.egg-info/
.eggs/

# Virtual env
.venv/
venv/

# IDE
.vscode/
.idea/

# Test / lint cache
.pytest_cache/
.ruff_cache/
.coverage
htmlcov/

# Data (runtime, not committed)
backend/data/
backend/data/spaces/
backend/data/meta.db
backend/data/meta.db-shm
backend/data/meta.db-wal

# OS
Thumbs.db
.DS_Store

# Env
.env
*.env.local
```

#### 3b: .env.example

**新建 `backend/.env.example`**:
```env
# Auth
SECRET_KEY=change-me-in-production
MASTER_TOKEN_EXPIRE_DAYS=7
SPACE_TOKEN_EXPIRE_HOURS=8

# Database
DATABASE_URL=sqlite+aiosqlite:///./data/meta.db
SPACES_DATA_DIR=./data/spaces

# Engine Pool
ENGINE_POOL_MAX_SIZE=5

# CORS
CORS_ORIGINS=["http://localhost:3000"]

# Misc
DEBUG=true
ENVIRONMENT=development
```

#### 3c: 清理临时文件

清理 `c:\Users\20564\.trae-cn\work\6a456ee7fd1417296e067a49\` 下的中间产物:
- `task_schema_fixed.py`, `trash_route_fixed.py`, `test_integration.py` 等临时脚本
- `copy_fixes.py`, `copy_integration_test.py`, `copy_schemas_test.py` 等复制脚本

**验收**: `git status` 显示干净的初始提交；`.env.example` 存在且内容正确

---

## Phase C: 同步引擎

**前置条件**: P0-1 + P0-2 + P0-3 全部完成且测试通过。

### 源项目参考

源项目 sync.py: `e:\Development\MyAwesomeApp\pomodoroxi\backend\app\routes\sync.py`（~1060 行）
- 4 个端点: `GET /pull`, `POST /push`, `GET /status`, `GET /full`
- `ENTITY_REGISTRY` 驱动所有实体
- LWW 冲突检测 + 墓碑 TTL（90 天）
- `begin_nested()` SAVEPOINT 隔离每个 push 事件
- `_normalize_timestamp()` 毫秒级时间戳归一化
- `_is_zero_time()` 零时间防御
- 级联删除: task→sessions, folder→descendants, habit→check_ins

### 目标项目差异

| 维度 | 源项目 | 目标项目 |
|------|--------|---------|
| DB | 单一 DB | 双 DB (meta + per-space) |
| 认证 | `get_current_user` | `get_space_context` + Space Token |
| Note | 有 content 字段 | 无 content，FS 分离 |
| BaseEntity | 18 实体 | 14 实体（无 dimension/mental_*） |
| 路由前缀 | `/api/sync` | `/api/v1/sync` |

### C1: sync_safety 模块

**新建 `app/services/sync_safety.py`** — 纯工具函数，不导入 FastAPI

```python
"""Sync safety utilities — timestamp normalization, LWW comparison, tombstone guards."""

def normalize_timestamp(ts: str | None) -> str | None:
    """归一化到毫秒精度（去掉 Z，截断到 3 位小数）。"""
    # 移植自源项目 _normalize_timestamp

def is_zero_time(ts: str | None) -> bool:
    """检测零时间戳（外部脚本产物）。"""
    # 移植自源项目 _is_zero_time

def check_lww(server_ts: str, client_ts: str) -> str:
    """LWW 比较，返回 'server' / 'client' / 'equal'。"""
    s = normalize_timestamp(server_ts) or ""
    c = normalize_timestamp(client_ts) or ""
    if is_zero_time(s):
        return "client"  # 零时间是陈旧产物
    if s > c:
        return "server"
    return "client"

def serialize_entity_data(data: dict) -> dict:
    """JSON array/object/bool 字段序列化为 DB String 列。"""
    # 移植自源项目 _serialize_entity_data

def model_to_dict(obj) -> dict:
    """ORM → dict，解析 JSON 字符串列为 list。"""
    # 移植自源项目 _model_to_dict
```

**测试**: `tests/test_sync_safety.py`（~10 测试）
- `normalize_timestamp`: Z 后缀、微秒、无小数、None
- `is_zero_time`: 零时间、正常时间、None
- `check_lww`: server 新、client 新、相等、零时间
- `serialize_entity_data`: tags list→JSON、bool→string
- `model_to_dict`: ORM → dict + JSON 解析

### C2: SyncService

**新建 `app/services/sync_service.py`** — 不导入 FastAPI，只 flush

```python
"""SyncService — push/pull orchestration for per-space data sync.

Uses SAVEPOINT (begin_nested) per push event for isolation.
Routes commit; this service only flushes.
"""

class SyncService:
    def __init__(self, db: AsyncSession, fs: FileSystem | None = None):
        self.db = db
        self.fs = fs  # Note 内容需要 FS 操作

    async def pull(self, since: str | None, limit: int = 500) -> dict:
        """Server → client: 增量拉取变更 + 墓碑。"""
        # 遍历 ENTITY_REGISTRY，查 updated_at > since
        # 返回 {changes: {entity_type: [dict]}, tombstones: [...], server_time, has_more}

    async def push(self, events: list[dict]) -> dict:
        """Client → server: 批量推送变更，SAVEPOINT 隔离。"""
        # 逐事件处理: create/update/delete
        # LWW 冲突检测 → conflicts 列表
        # 墓碑 TTL 守卫 → 防止复活
        # 返回 {applied: [idx], conflicts: [...], errors: [...], server_time}

    async def full(self, since: str | None, limit: int = 500) -> dict:
        """全量同步: 初始或恢复。"""
        # 类似 pull 但不过滤 since（分页除外）

    async def status(self) -> dict:
        """返回各实体计数 + 墓碑计数。"""
```

**ENTITY_REGISTRY** — 目标项目 14 实体:

```python
ENTITY_REGISTRY = {
    "task":        {"model": Task, "pull_key": "tasks"},
    "session":     {"model": Session, "pull_key": "sessions"},
    "note":        {"model": Note, "pull_key": "notes"},
    "folder":      {"model": Folder, "pull_key": "folders"},
    "quickNote":   {"model": QuickNote, "pull_key": "quickNotes"},
    "reflection":  {"model": Reflection, "pull_key": "reflections"},
    "habit":       {"model": Habit, "pull_key": "habits"},
    "habitCheckIn":{"model": HabitCheckIn, "pull_key": "habitCheckIns"},
    "schedule":    {"model": Schedule, "pull_key": "schedules"},
    "timeBlock":   {"model": TimeBlock, "pull_key": "timeBlocks"},
    "memoComment": {"model": MemoComment, "pull_key": "memoComments"},
    "sessionQuickNote":  {"model": SessionQuickNote, "pull_key": "sessionQuickNotes"},
    "scheduleQuickNote": {"model": ScheduleQuickNote, "pull_key": "scheduleQuickNotes"},
    "taskQuickNote":     {"model": TaskQuickNote, "pull_key": "taskQuickNotes"},
}
```

**Note 特殊处理**:
- `push` create/update note 时: 如果 `entity_data` 含 `content`，调用 `NoteService` 写 FS
- `pull` note 时: 不返回 `content`（客户端通过 REST `/notes/{id}/content` 单独获取）
- `delete` note 时: 调用 `NoteService.delete()` 同时清理 FS + DB

**测试**: `tests/test_sync_service.py`（~20 测试）
- pull: 空 DB、有数据、分页、墓碑清理
- push: create/update/delete、LWW 冲突、墓碑阻止复活、SAVEPOINT 隔离
- full: 全量 + 分页
- Note 特殊: content 写 FS、delete 清 FS

### C3: Sync 路由

**新建 `app/routes/v1/sync.py`** — 4 端点

```python
router = APIRouter()

@router.get("/sync/pull")
async def sync_pull(since: str | None = Query(None), limit: int = Query(500, ge=1, le=2000),
                    db=Depends(get_space_db), ctx=Depends(get_space_context)):
    result = await SyncService(db).pull(since=since, limit=limit)
    await db.commit()
    return result

@router.post("/sync/push")
async def sync_push(data: SyncPushRequest, db=Depends(get_space_db), ctx=Depends(get_space_context)):
    result = await SyncService(db).push(data.events)
    await db.commit()
    return result

@router.get("/sync/full")
async def sync_full(since: str | None = Query(None), limit: int = Query(500, ge=1, le=2000),
                    db=Depends(get_space_db), ctx=Depends(get_space_context)):
    result = await SyncService(db).full(since=since, limit=limit)
    await db.commit()
    return result

@router.get("/sync/status")
async def sync_status(db=Depends(get_space_db), ctx=Depends(get_space_context)):
    result = await SyncService(db).status()
    return result
```

**注册到 `v1/__init__.py`**: 添加 `from .sync import router as sync_router`

**新建 Schema**: `app/schemas/sync.py`
```python
class SyncPushRequest(BaseModel):
    events: list[dict]

class SyncPullResponse(BaseModel):
    changes: dict[str, list[dict]]
    tombstones: list[dict]
    server_time: str
    has_more: bool
    next_since: str | None
```

**测试**: `tests/test_routes_sync.py`（~15 测试）
- pull 200 + 数据结构
- push 200 + applied/conflicts
- full 200 + 分页
- status 200 + counts
- push 含 Note content → FS 写入
- push 删除 → 墓碑 + 级联

---

## 当前文件地图

```
PomodoroXII-rebuild/backend/
├── pyproject.toml
├── alembic.ini
├── alembic/
│   ├── env.py                        # ⚠️ P0-1: 需添加 include_object
│   └── versions/
│       ├── 001_initial.py            # meta: spaces + meta_settings
│       └── cab2ff7bcf37_phase_b.py   # 18 业务表
├── app/
│   ├── main.py                       # create_app() + 异常处理 + v1 router
│   ├── settings.py                   # Settings (secret_key, db paths, pool)
│   ├── deps.py                       # get_space_db, get_space_context, require_master_token, get_file_system
│   ├── errors.py                     # AppError + 5 子类 + register_exception_handlers
│   ├── middleware.py                 # RequestIdMiddleware
│   ├── space_manager.py              # ⚠️ P0-1: _init_schema 需过滤 meta 表
│   ├── auth/security.py              # hash/verify password, create/decode JWT
│   ├── db/
│   │   ├── base.py                   # Base(DeclarativeBase) + NAMING_CONVENTION
│   │   ├── session.py                # create_engine, create_session_factory
│   │   ├── meta_session.py           # ⚠️ P0-1: init_meta_db 需过滤 meta 表
│   │   └── models/meta.py            # Space + MetaSetting
│   ├── file_system/                  # 15 文件已移植（Phase A 完成）
│   │   ├── api.py                    # get_file_system factory
│   │   ├── interfaces.py             # FileSystem ABC
│   │   └── engine/                   # note_ops, folder_ops, search_ops 等
│   ├── models/                       # 18 模型 (16 业务 + 2 同步审计未建)
│   │   ├── mixins.py                 # SyncMixin (id, created_at, updated_at, version)
│   │   ├── task.py, note.py, folder.py, session.py, ...
│   │   └── tombstone.py              # Tombstone (entity_type, entity_id, deleted_at)
│   ├── schemas/                      # Create/Update/Response per entity
│   │   ├── task.py, note.py, folder.py, ...
│   │   └── common.py                 # PaginatedResponse[T]
│   ├── services/                     # flush-only, 不导入 FastAPI
│   │   ├── base.py                   # BaseService (create/get/list/update/delete)
│   │   ├── task.py                   # TaskService (tags JSON, search, idempotent delete)
│   │   ├── note.py                   # ⚠️ P0-2: create/update_content/delete 需重构
│   │   ├── cascade.py                # CascadeService (BFS folder, soft_delete)
│   │   ├── tombstone.py              # TombstoneService (idempotent, cleanup_expired)
│   │   ├── stats.py                  # StatsService (overview, trend, distribution)
│   │   ├── relation.py               # RelationService (junction tables)
│   │   ├── serializers.py            # serialize_entity/list (ORM → dict)
│   │   └── time.py                   # utc_now_iso()
│   └── routes/v1/
│       ├── __init__.py               # build_v1_router() — 14 sub-routers
│       ├── auth.py                   # POST /setup, /login, GET /verify
│       ├── spaces.py                 # POST/GET/GET-id/POST-token
│       ├── tasks.py, sessions.py, notes.py, folders.py
│       ├── quick_notes.py, reflections.py, habits.py
│       ├── schedules.py, time_blocks.py
│       ├── trash.py                  # list(含墓碑), restore, purge, cleanup
│       ├── stats.py, settings.py
│       └── sync.py                   # ⬜ Phase C 新建
└── tests/                            # 244 测试
    ├── conftest.py                   # _isolate_env autouse + client/space_session fixtures
    ├── test_deps.py, test_meta_db.py, test_space_manager.py  # Phase A
    ├── test_schemas.py, test_models.py, test_alembic.py      # Phase B
    ├── test_base_service.py ... test_relation_service.py     # Phase B services
    ├── test_routes_auth_spaces.py, test_routes_v1.py         # Phase B routes
    ├── test_integration.py           # 5 集成/门禁测试
    ├── test_db_isolation.py          # ⬜ P0-1 新建
    ├── test_sync_safety.py           # ⬜ C1 新建
    ├── test_sync_service.py          # ⬜ C2 新建
    └── test_routes_sync.py           # ⬜ C3 新建
```

---

## 06 缺陷映射

| # | 缺陷 | 当前状态 | 位置 |
|---|------|---------|------|
| 1 | 三层铁律未执行 | ✅ 已修复 | services 不 commit/不导入 fastapi |
| 2 | 缺少 CascadeService | ✅ 已修复 | cascade.py BFS 级联 |
| 3 | Note 软删除不一致 | ✅ 已修复 | Note 硬删除 + 墓碑 |
| 4 | Note content 存 DB | ✅ 已修复 | content_hash + word_count |
| 5 | 缺少 TombstoneService | ✅ 已修复 | tombstone.py |
| 6 | Setting 缺 protected keys | ✅ 已修复 | settings route PROTECTED_KEYS |
| 7 | NoteUpdate 缺 content_hash | ✅ 已修复 | NoteUpdate 含 content_hash + content |
| 8 | 缺少级联删除 | ✅ 已修复 | cascade.py |

---

## conftest.py 关键机制

```python
@pytest.fixture(autouse=True)
async def _isolate_env(tmp_path):
    """每个测试独立环境: 临时目录 + 模块重载 + Base.metadata.clear()"""
    # 1. 设置环境变量指向 tmp_path
    # 2. purge sys.modules: app.models.*, app.services.*, app.routes.*, app.main
    # 3. Base.metadata.clear() + 重新导入
    # 4. yield（测试执行）
    # 5. 清理

@pytest.fixture
async def client(_isolate_env):
    """ASGI test client with init_meta_db"""
    # ASGITransport 不触发 lifespan → 手动 init_meta_db()

@pytest.fixture
async def space_session(_isolate_env):
    """直接空间 DB session（绕过 HTTP）"""
```

**关键**: 所有测试函数内导入 app 模块（不在模块级），避免 conftest reload 后引用过期。

---

## 验收清单

### P0 验收
```powershell
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend

# P0-1: DB 隔离
uv run pytest tests/test_db_isolation.py -v   # 3/3

# P0-2: NoteService Saga
uv run pytest tests/test_note_service.py -v   # 全通过（含新补偿测试）

# P0-3: 工程化
cd .. && git status                            # 干净的初始提交
ls backend/.env.example                        # 存在

# 全量回归
cd backend && uv run pytest -q                 # 247+ 全通过
uv run ruff check app/ --fix                   # 无错误
```

### Phase C 验收
```powershell
# C1: sync_safety
uv run pytest tests/test_sync_safety.py -v     # ~10/10

# C2: SyncService
uv run pytest tests/test_sync_service.py -v    # ~20/20

# C3: Sync 路由
uv run pytest tests/test_routes_sync.py -v     # ~15/15

# 全量回归
uv run pytest -q                               # ~292+ 全通过
```

---

## 常用命令

```powershell
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend

# 测试
uv run pytest -q                               # 全量
uv run pytest tests/test_xxx.py -v             # 单文件
uv run pytest tests/test_xxx.py::test_name -v  # 单测试

# Lint
uv run ruff check app/ --fix

# 迁移
uv run alembic upgrade head
uv run alembic downgrade -1

# 开发服务器
uv run uvicorn app.main:app --reload
```

---

## 禁止事项

1. **禁止** 未完成 P0-1/P0-2 前写 SyncService
2. **禁止** 在 services 中导入 fastapi 或调用 commit()
3. **禁止** 在 Note 模型中添加 content 字段
4. **禁止** 用 Master Token 访问业务路由（必须用 Space Token）
5. **禁止** 在测试模块级导入 app 类（必须在函数内导入）

## 第一步

```
1. cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend
2. uv run pytest -q                    # 确认 244 绿
3. 读 app/db/meta_session.py           # 理解 P0-1
4. 读 app/services/note.py             # 理解 P0-2
5. 做 P0-1: 改 meta_session + space_manager + env.py + 写测试
6. 做 P0-2: 重构 NoteService + 写补偿测试
7. 做 P0-3: git init + .gitignore + .env.example
8. 全量回归确认后，开始 Phase C
```

## --- PROMPT 结束 ---
