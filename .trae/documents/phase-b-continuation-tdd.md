# Phase B TDD 续接实施计划（Steps 3-10）

## 摘要

Phase A 已完成（105 测试），Phase B Steps 0-2 已完成（24 测试，共 129 测试通过）。Step 3 部分完成（env.py 已改、迁移已生成、测试未写）。本计划覆盖 Steps 3-10 的 TDD 实施，预估新增 ~108 测试，总计 ~237 测试。

**工作目录**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**源项目参考**: `e:\Development\MyAwesomeApp\pomodoroxi\backend\app\`
**TDD 方法论**: Red（写失败测试→看它失败）→ Green（最小代码通过）→ Refactor（保持绿色清理）

## 当前状态分析

### 已就位（Steps 0-2，129 测试通过）
- `app/services/time.py` — utc_now_iso / utc_now_iso_ms / utc_now
- `tests/conftest.py` — _isolate_env（含 sys.modules 清除 app.models.* + 重载链）
- `app/models/` — 18 个 ORM 模型（14 SyncMixin + 4 特殊），Note 无 content 列
- `app/schemas/` — 14 个 Pydantic schema 文件
- `alembic/env.py` — 已添加 `from app.models import *`
- `alembic/versions/cab2ff7bcf37_phase_b_all_models.py` — 18 张业务表迁移（已验证 Note 无 content）

### 待完成（Steps 3-10）
- `tests/test_alembic.py` — 迁移验证测试
- `app/services/base.py` — BaseService（flush 不 commit）
- `app/services/tombstone.py` — TombstoneService
- `app/services/cascade.py` — CascadeService（BFS 级联删除）
- `app/services/` 实体服务 + serializers
- `app/routes/v1/auth.py` + `spaces.py` — 双 JWT 认证 + 空间管理
- `app/routes/v1/` 12 个 REST 路由
- 集成测试 + 门控检查

### 关键前置发现

**发现 1 — conftest 服务模块重载缺失**
当前 conftest 只清除 `app.models.*` 的 sys.modules，未清除 `app.services.*` 子模块。Step 4+ 新增服务模块若在顶层导入模型类，conftest reload 后服务仍引用旧类。**Step 4 必须先扩展 conftest**。

**发现 2 — task status 不一致**
`app/models/task.py` CHECK 约束允许 `status IN ('todo','in_progress','done','archived')`，但 `app/schemas/task.py` 的 Literal 是 `['todo','in_progress','done','cancelled']`。Step 9 前必须统一为 `archived`（与模型/迁移一致）。

**发现 3 — space_session fixture 缺失**
服务测试需要已建表的 per-space AsyncSession。当前无共享 fixture，Step 4 需提炼。

**发现 4 — v1 路由聚合层为空**
`app/routes/v1/__init__.py` 为空，`main.py` 未 include 任何 router。Step 8 需建立聚合 router。

**发现 5 — 全量测试耗时 ~5 分钟**
conftest 每例重载导致 129 测试约 292 秒。迭代时只跑新文件。

## 实施步骤

### Step 3: Alembic 迁移验证（3 测试）

**文件**: `tests/test_alembic.py`

**技术要点**: `alembic/env.py` 已支持 connection-sharing 路径（`config.attributes.get("connection")` 非空时走同步 `do_run_migrations`）。测试用同步 `sqlite:///` 引擎传连接，绕开 async engine 与 fileConfig 副作用。

**TDD Red — 3 测试**:
1. `test_upgrade_to_head_creates_20_tables` — upgrade head 后 `inspect(engine).get_table_names()` 恰好 20 张
2. `test_downgrade_to_001_leaves_only_2_meta_tables` — upgrade head 后 downgrade 001，剩余仅 spaces + meta_settings
3. `test_notes_table_has_no_content_column` — notes 表无 content 列，有 content_hash + word_count

**实现骨架**:
```python
from alembic.config import Config
from alembic import command
from sqlalchemy import create_engine, inspect

def _run_migration(tmp_path, action, revision):
    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None  # 跳过 fileConfig 日志副作用
    engine = create_engine(f"sqlite:///{(tmp_path / 'alembic.db').as_posix()}")
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        if action == "upgrade":
            command.upgrade(cfg, revision)
        else:
            command.downgrade(cfg, revision)
    return engine
```

**验证**: `uv run pytest tests/test_alembic.py -v`

---

### Step 4: BaseService + conftest 扩展（~8 测试）

#### 4a. 扩展 conftest.py（RED 前必须完成）

在重载 `app.models` 之后、重载 `app.auth.security` 之前插入：
```python
# Phase B 服务模块：清除后由各测试按需重新导入
import sys as _sys
for _key in list(_sys.modules.keys()):
    if _key.startswith("app.services.") and _key != "app.services.time":
        del _sys.modules[_key]
```

新增 `space_session` fixture：
```python
@pytest.fixture
async def space_session(_isolate_env):
    from app.db.meta_session import init_meta_db, close_meta_db
    from app.space_manager import get_space_engine_manager, dispose_space_engine_manager
    await init_meta_db()
    manager = get_space_engine_manager()
    session = await manager.get_session("spc_test")
    try:
        yield session
    finally:
        await session.close()
        await dispose_space_engine_manager()
        await close_meta_db()
```

#### 4b. BaseService — `app/services/base.py`

**铁律**: 不 import FastAPI；只 flush 不 commit；返回 ORM 实例；接受 dict 参数（MCP 预留）。

```python
class BaseService:
    model: type  # 子类设置

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(self, data: dict) -> Any:
        obj = self.model(**data)
        self.db.add(obj)
        await self.db.flush()
        await self.db.refresh(obj)
        return obj

    async def get(self, id: str) -> Any:
        obj = await self.db.get(self.model, id)
        if obj is None:
            raise NotFoundError(f"{self.model.__name__} '{id}' not found")
        return obj

    async def list(self, *, offset=0, limit=50, filters=None):
        q = select(self.model)
        if filters:
            for k, v in filters.items():
                q = q.where(getattr(self.model, k) == v)
        total = (await self.db.execute(select(func.count()).select_from(q.subquery()))).scalar() or 0
        rows = (await self.db.execute(q.offset(offset).limit(limit))).scalars().all()
        return rows, total

    async def update(self, id: str, data: dict) -> Any:
        obj = await self.get(id)
        for k, v in data.items():
            setattr(obj, k, v)
        obj.updated_at = utc_now_iso()
        await self.db.flush()
        await self.db.refresh(obj)
        return obj

    async def delete(self, id: str) -> None:
        obj = await self.get(id)
        await self.db.delete(obj)
        await self.db.flush()
```

**TDD Red — `tests/test_base_service.py`（8 测试，用 Task 作具体 model）**:
1. `test_create_flushes_row_visible_in_same_session`
2. `test_create_does_not_commit_rollback_undoes_it` — create 后 rollback，再 get → NotFoundError
3. `test_get_returns_instance_by_id`
4. `test_get_raises_not_found_for_missing_id`
5. `test_list_returns_items_with_total_and_pagination` — 建 3 条，limit=2，断言 len==2 total==3
6. `test_list_applies_equality_filters` — filters={"status":"done"} 只返回 1
7. `test_update_modifies_fields_and_bumps_updated_at`
8. `test_delete_removes_instance_and_raises_when_missing`

**验证**: `uv run pytest tests/test_base_service.py -v`

---

### Step 5: TombstoneService（~6 测试）

**文件**: `app/services/tombstone.py`

```python
TOMBSTONE_TTL_DAYS = 90

class TombstoneService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(self, entity_type: str, entity_id: str) -> Tombstone:
        # 幂等：已存在则返回现有
        existing = await self.exists(entity_type, entity_id)
        if existing:
            return existing
        t = Tombstone(entity_type=entity_type, entity_id=entity_id, deleted_at=utc_now_iso())
        self.db.add(t)
        await self.db.flush()
        await self.db.refresh(t)
        return t

    async def exists(self, entity_type: str, entity_id: str) -> Tombstone | None:
        res = await self.db.execute(select(Tombstone).where(
            Tombstone.entity_type == entity_type,
            Tombstone.entity_id == entity_id))
        return res.scalar_one_or_none()

    async def cleanup_expired(self, ttl_days: int = TOMBSTONE_TTL_DAYS) -> int:
        cutoff = (utc_now() - timedelta(days=ttl_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        res = await self.db.execute(select(Tombstone).where(Tombstone.deleted_at < cutoff))
        old = res.scalars().all()
        for t in old:
            await self.db.delete(t)
        await self.db.flush()
        return len(old)
```

**TDD Red — `tests/test_tombstone_service.py`（6 测试）**:
1. `test_create_writes_tombstone_with_entity_type_and_id`
2. `test_create_is_idempotent_duplicate_does_not_raise`
3. `test_exists_returns_true_for_recorded_entity`
4. `test_exists_returns_false_for_unknown_entity`
5. `test_cleanup_expired_removes_old_tombstones_returns_count` — 插入 100 天前时间戳
6. `test_cleanup_expired_keeps_recent_tombstones`

**验证**: `uv run pytest tests/test_tombstone_service.py -v`

---

### Step 6: CascadeService（~7 测试）

**文件**: `app/services/cascade.py`

提取源 `routes/folders.py` 的 `_get_descendant_ids` BFS + 级联软删逻辑。

```python
class CascadeService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_descendant_ids(self, folder_id: str) -> list[str]:
        # BFS，仅遍历未 trashed 子节点（防复活已删子树）
        ...

    async def soft_delete_folder(self, folder_id: str) -> dict:
        # 级联 trashed_at + 解除 notes/quick_notes 的 folder_id 引用
        ...

    async def delete_task_cascade(self, task_id: str) -> None:
        # 删除 task + 关联 task_quick_notes
        ...

    async def delete_note_cascade(self, note_id: str, fs=None) -> None:
        # 删除 note + memo_comments + FS 软删
        ...
```

**TDD Red — `tests/test_cascade_service.py`（7 测试）**:
1. `test_get_descendant_ids_collects_multi_level_bfs` — 三层树返回 2 个后代
2. `test_get_descendant_ids_skips_trashed_subtrees` — child trashed 后 grandchild 不被收集
3. `test_soft_delete_folder_cascades_to_descendants` — 删 root，所有后代 trashed_at 非空
4. `test_soft_delete_folder_clears_notes_folder_id` — 子树内 Note 的 folder_id 变 None
5. `test_soft_delete_folder_clears_quick_notes_folder_id`
6. `test_soft_delete_folder_raises_not_found` — 不存在 id → NotFoundError
7. `test_cascade_delete_task_removes_junction_links` — 删 task 后 task_quick_notes 行消失

**验证**: `uv run pytest tests/test_cascade_service.py -v`

---

### Step 7: 实体服务 + serializers（~28 测试）

**新建文件**: `app/services/serializers.py`, `task.py`, `note.py`, `stats.py`, `relation.py`

#### 7a. serializers.py（4 测试）
```python
def serialize_entity(obj: Any) -> dict:
    d = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
    if "tags" in d and isinstance(d["tags"], str):
        d["tags"] = json.loads(d["tags"]) if d["tags"] else []
    return d
```
测试: `tests/test_serializers.py`
1. `test_serialize_entity_converts_orm_to_dict`
2. `test_serialize_entity_parses_tags_json_to_list`
3. `test_serialize_list_handles_multiple`
4. `test_serialize_entity_excludes_sa_internal_attrs`

#### 7b. TaskService（6 测试）— `app/services/task.py`
继承 BaseService，重写 create（tags list→JSON）和 delete（幂等+墓碑）。
测试: `tests/test_task_service.py`
1. `test_create_task_with_client_id_respected`
2. `test_create_task_serializes_tags_to_json_string`
3. `test_list_tasks_search_by_title` — ilike
4. `test_list_tasks_filter_by_status_and_priority`
5. `test_delete_task_idempotent_writes_tombstone`
6. `test_delete_task_when_already_gone_still_writes_tombstone`

#### 7c. NoteService Saga（8 测试）— `app/services/note.py`
**核心**: 协调 DB（Note ORM，仅 metadata+hash+word_count）与 FileSystem（.md 内容）。
```python
class NoteService(BaseService):
    def __init__(self, db: AsyncSession, fs: FileSystem):
        super().__init__(db)
        from app.models.note import Note
        self.model = Note
        self.fs = fs

    async def create(self, data: dict) -> Note:
        # 1) 写 .md (fs.create_note with external_id)
        # 2) 写 ORM 行 (content_hash + word_count from fs meta)
        ...

    async def get_content(self, note_id: str) -> str:
        return await self.fs.read_note(note_id)

    async def update_content(self, note_id: str, content: str) -> Note:
        meta = await self.fs.edit_note(note_id, content)
        return await self.update(note_id, {"content_hash": meta.content_hash, "word_count": meta.word_count})
```
测试: `tests/test_note_service.py`（用真实 FileSystemStorage）
1. `test_create_note_writes_md_and_db_row_with_hash_and_word_count`
2. `test_create_note_respects_client_id`
3. `test_get_note_returns_metadata_without_content`
4. `test_get_note_content_reads_md_file`
5. `test_update_note_content_rewrites_md_and_updates_hash`
6. `test_update_note_metadata_updates_db_fields_only`
7. `test_delete_note_removes_md_and_db_and_writes_tombstone`
8. `test_delete_note_idempotent`

#### 7d. StatsService（5 测试）— `app/services/stats.py`
从源 `routes/stats.py` 提取查询逻辑，返回 dict。
测试: `tests/test_stats_service.py`
1. `test_overview_counts_completed_work_sessions_by_period`
2. `test_overview_sums_durations`
3. `test_focus_trend_fills_missing_dates_with_zeros`
4. `test_task_distribution_by_status_and_priority`
5. `test_daily_detail_for_specific_date`

#### 7e. RelationService（5 测试）— `app/services/relation.py`
管理三张关联表（task/session/schedule ↔ quick_note）的 link/unlink/list。
测试: `tests/test_relation_service.py`
1. `test_link_quick_note_to_task_creates_junction_row`
2. `test_link_is_idempotent_no_duplicate`
3. `test_unlink_removes_junction_row`
4. `test_list_quick_notes_for_task`
5. `test_link_quick_note_to_session`

**验证**: `uv run pytest tests/test_serializers.py tests/test_task_service.py tests/test_note_service.py tests/test_stats_service.py tests/test_relation_service.py -v`

---

### Step 8: auth + spaces 路由（~13 测试）

#### 8a. 基础设施

**修改 `app/routes/v1/__init__.py`**: 建立 v1 聚合 router
**修改 `app/main.py`**: `app.include_router(build_v1_router())`

**新增 client fixture**（conftest.py）:
```python
@pytest.fixture
async def client(_isolate_env):
    from app.main import create_app
    from app.db.meta_session import init_meta_db, close_meta_db
    from app.space_manager import dispose_space_engine_manager
    from httpx import AsyncClient, ASGITransport
    await init_meta_db()
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    await dispose_space_engine_manager()
    await close_meta_db()
```

#### 8b. 路由实现

**`app/routes/v1/auth.py`**（用 `get_meta_db`）:
- `POST /api/v1/auth/setup` — 首次设密码（存 MetaSetting key=admin_password），已存在则 409
- `POST /api/v1/auth/login` — 校验密码 → 返回 master_token
- `GET /api/v1/auth/verify` — Depends(get_current_user) 返回 {valid, user_id, type}

**`app/routes/v1/spaces.py`**（用 `require_master_token` + `get_meta_db`）:
- `POST /api/v1/spaces` — 创建 Space + 建目录
- `GET /api/v1/spaces` — 列出全部
- `GET /api/v1/spaces/{id}` — 单个
- `POST /api/v1/spaces/{id}/token` — master token → space_token

#### 8c. TDD Red — `tests/test_routes_auth_spaces.py`（13 测试）

auth（6）:
1. `test_setup_sets_admin_password` — 201
2. `test_setup_rejects_duplicate_password_409`
3. `test_login_returns_master_token` — 解码 type=master
4. `test_login_wrong_password_401`
5. `test_verify_master_token_returns_valid`
6. `test_verify_missing_token_401`

spaces（7）:
7. `test_create_space_returns_id_and_persists`
8. `test_create_space_requires_master_token_403` — space token 调用
9. `test_list_spaces_returns_all`
10. `test_get_space_by_id`
11. `test_issue_space_token_requires_master_token`
12. `test_issue_space_token_returns_space_scoped_token` — 解码 type=space
13. `test_space_token_decoded_by_get_space_context`

**验证**: `uv run pytest tests/test_routes_auth_spaces.py -v`

---

### Step 9: 12 REST 路由（~45 测试）

**前置**: 修正 task schema status 为 `archived`（统一模型与迁移）。

**统一模式**:
```python
@router.post("", response_model=XxxResponse, status_code=201)
async def create(data: XxxCreate, db: AsyncSession = Depends(get_space_db),
                 ctx: dict = Depends(get_space_context)):
    obj = await XxxService(db).create(data.model_dump())
    await db.commit()
    await db.refresh(obj)
    return obj
```

**新建文件**（`app/routes/v1/` 下）: tasks.py, sessions.py, notes.py, folders.py, quick_notes.py, reflections.py, habits.py, schedules.py, time_blocks.py, trash.py, stats.py, settings.py

**测试文件**: `tests/test_routes_v1.py`

| 路由 | 测试数 | 关键测试 |
|---|---|---|
| tasks | 5 | create_201 / list_filter_status / get_404 / update_partial / delete_idempotent_tombstone |
| sessions | 4 | create_work / list_by_type / get / delete |
| notes | 5 | create_writes_md_and_db / get_meta_no_content / get_content_reads_md / update_content_changes_hash / delete_removes_both |
| folders | 5 | create / list_root / move_circular_reject / delete_cascade / system_folder_reject |
| quick_notes | 4 | create / list_pinned_first / update / delete |
| reflections | 3 | create / list_by_date / get |
| habits | 4 | create / list / check_in_create / delete |
| schedules | 3 | create / list_upcoming / delete |
| time_blocks | 3 | create / list_by_date / delete |
| trash | 4 | list_trashed / restore / purge_writes_tombstone / cleanup_expired |
| stats | 3 | overview / focus_trend / task_distribution |
| settings | 2 | get_settings / update_rejects_protected_keys |

**关键实现提示**:
- notes 路由需同时注入 `get_space_db` 与 `get_file_system`
- trash 路由调用 TombstoneService + CascadeService
- settings 路由 PROTECTED_KEYS 沿用源设计，update 对受保护 key 返回 rejected 列表

**验证**: `uv run pytest tests/test_routes_v1.py -v`

---

### Step 10: 集成验证 + 门控检查（~5 测试）

**文件**: `tests/test_integration.py`

1. `test_full_lifecycle_space_token_task_session_stats` — 端到端：setup→login→create_space→issue_token→create_task→create_session→stats→delete_task→tombstone
2. `test_note_saga_end_to_end_consistency` — create note→get_content→update_content→hash 变化→delete→.md 与 DB 均消失
3. `test_cascade_folder_delete_integration` — 建 root/child/grandchild + Note → DELETE folder → 三层 trashed + Note unfiled
4. `test_gate_services_do_not_import_fastapi` — 静态扫描 app/services/*.py 无 `from fastapi`
5. `test_gate_all_v1_routes_registered` — 枚举 /api/v1 下端点数 ≥ 预期

**11 项门控清单**:
| # | 检查项 | 覆盖方式 |
|---|--------|---------|
| 1 | 路由 commit / 服务 flush / 模型纯数据 | 静态扫描 + 抽查 |
| 2 | 服务不 import FastAPI | test_gate_services_do_not_import_fastapi |
| 3 | 双 JWT 分离 | Step 8 测试 8/11/12 |
| 4 | Note 无 content 列 | test_models + test_alembic |
| 5 | conftest 每例重载 | 现状已满足 |
| 6 | 测试内导入 model | 现状已满足 |
| 7 | 时间 Z 后缀秒精度 | time.py 测试 |
| 8 | tags JSON↔list | test_schemas + serializers |
| 9 | MCP 预留（返回 ORM/dict、接受 dict） | BaseService 设计 |
| 10 | FileSystem 返回实例 | test_deps 已覆盖 |
| 11 | 全部 12 路由注册 | test_gate_all_v1_routes_registered |

**验证**: `uv run pytest tests/test_integration.py -v` + 全量回归 `uv run pytest -q`

## 假设与决策

1. **conftest 服务重载**: Step 4 必须先扩展 conftest 清除 `app.services.*`（time 除外），否则服务模块引用陈旧模型类
2. **task status 统一**: Step 9 前修正 schema 为 `archived`（与模型 CHECK 约束一致）
3. **alembic 测试同步**: 用 `sqlite:///`（同步）+ `config.attributes["connection"]` 走 env.py 同步分支
4. **ASGITransport 不触发 lifespan**: client fixture 必须手动 `init_meta_db()`
5. **NoteService Saga**: Service 只 flush，route 层 commit。若 commit 失败 .md 可能成为孤儿——当前阶段接受 best-effort
6. **space_session fixture**: `space_manager.get_session` 内部 `_init_schema` 调用 `Base.metadata.create_all`，会建出全部 20 张表
7. **MCP 预留**: 所有 Service 方法接受 dict/基本类型参数，返回 ORM 对象或 dict，不导入 FastAPI
8. **文件写入**: pomodoroxi（小写）在 TRAE 工作目录范围内，可直接用 Write/SearchReplace 工具
9. **测试导入**: 所有测试在函数内导入模型类（避免 conftest reload 后陈旧引用）
10. **NoteService 与 FileSystem**: fs 自带 index.db，与 ORM notes 表存在元数据冗余。以 ORM 为查询入口、fs 为内容存储

## 验证步骤

1. **Step 3**: `uv run pytest tests/test_alembic.py -v`
2. **Step 4**: `uv run pytest tests/test_base_service.py -v`
3. **Step 5**: `uv run pytest tests/test_tombstone_service.py -v`
4. **Step 6**: `uv run pytest tests/test_cascade_service.py -v`
5. **Step 7**: `uv run pytest tests/test_serializers.py tests/test_task_service.py tests/test_note_service.py tests/test_stats_service.py tests/test_relation_service.py -v`
6. **Step 8**: `uv run pytest tests/test_routes_auth_spaces.py -v`
7. **Step 9**: `uv run pytest tests/test_routes_v1.py -v`
8. **Step 10**: `uv run pytest tests/test_integration.py -v` + 全量回归 `uv run pytest -q`
9. **最终**: `uv run ruff check app/ --fix` + 11 项门控检查

## 测试规模预估

| Step | 测试文件 | 预估测试数 |
|------|---------|-----------|
| 3 | test_alembic.py | 3 |
| 4 | test_base_service.py | 8 |
| 5 | test_tombstone_service.py | 6 |
| 6 | test_cascade_service.py | 7 |
| 7 | test_serializers + task + note + stats + relation | 28 |
| 8 | test_routes_auth_spaces.py | 13 |
| 9 | test_routes_v1.py | 45 |
| 10 | test_integration.py | 5 |
| **合计** | | **~115 新增** |

现有 129 + 新增 ~115 = **总计 ~244 测试**。

## TDD 执行纪律

每步严格遵循 Red-Green-Refactor:
1. **Red**: 写失败测试 → 运行 → 确认失败（且失败原因正确：功能缺失而非语法错误）
2. **Green**: 写最小代码让测试通过 → 运行 → 确认通过
3. **Refactor**: 清理代码（提取重复、对齐命名）→ 运行 → 确认仍通过
4. **不跳过 Red**: 如果测试立即通过，说明测试的是已有行为，需修正测试
5. **不保留未测试代码**: 先写代码再补测试 ≠ TDD
