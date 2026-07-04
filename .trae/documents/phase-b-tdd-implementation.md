# Phase B TDD 深度实施计划

## 摘要

Phase A 已完成（105 测试通过），底层基础设施全部就位。Phase B 目标是构建全业务层：18 表 ORM 模型 + Pydantic schemas + Alembic 迁移 + Service 层（含 CascadeService + TombstoneService）+ 双 JWT 认证路由 + 12 REST 路由。采用 TDD Red-Green-Refactor 循环，预估新增 ~140 测试，总计 ~245 测试。

**工作目录**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**源项目参考**: `e:\Development\MyAwesomeApp\pomodoroxi\backend\app\`
**MCP 预留**: Service 方法返回 ORM/dict，接受 dict 参数，不导入 FastAPI

## 当前状态分析

### 已就位（Phase A）
- `app/db/base.py` — Base(DeclarativeBase) + NAMING_CONVENTION
- `app/db/models/meta.py` — Space + MetaSetting（2 张 meta 表）
- `app/deps.py` — get_current_user / require_master_token / get_space_context / get_space_db / get_meta_db / get_file_system
- `app/auth/security.py` — hash/verify_password + create_master/space_token + decode_access_token
- `app/space_manager.py` — SpaceEngineManager（_init_schema 调用 Base.metadata.create_all）
- `app/errors.py` — AppError + 5 子类
- `app/file_system/` — 完整笔记文件系统（15 文件）
- `tests/conftest.py` — _isolate_env autouse fixture（含 Base.metadata.clear() + reload 链）
- 105 个测试全部通过

### 待创建（Phase B）
- `app/models/` — 16 业务模型 + 2 同步审计模型
- `app/schemas/` — Pydantic Create/Update/Response schemas
- `app/services/` — BaseService + 实体 Services + CascadeService + TombstoneService + serializers
- `app/routes/v1/` — auth + spaces + 12 业务路由

### 三大隐患

**隐患 A — conftest 重载链断裂**
现有 conftest 的 `_isolate_env` 执行 `Base.metadata.clear()` 后重载 meta 模型，但不重载 `app.models`。Phase B 创建业务模型后，若 conftest 不扩展重载链，业务模型不会注册到新 Base.metadata，导致所有 Service/Route 测试因 "no such table" 崩溃。

**隐患 B — 模块级导入陈旧引用**
conftest 每个测试都 reload 模块。若测试文件在模块顶层 `from app.models.task import Task`，reload 后该 Task 符号指向旧类（旧 `__table__` 已从 metadata 清除）。所有测试必须在函数内导入。

**隐患 C — 时间戳格式不一致**
源项目用 naive datetime（`isoformat()` 无后缀），目标项目 meta.py 用 Z 后缀秒精度。必须统一为 Z 后缀秒精度。

## 实施步骤

### Step 0: 前置基础设施

**文件**: `app/services/time.py`, `tests/conftest.py`（扩展）, 目录骨架

**0.1 创建 `app/services/time.py`**

TDD Red — `tests/test_time.py`（2 测试）:
- `test_utc_now_iso_has_z_suffix` — 时间戳以 Z 结尾，无 +00:00
- `test_utc_now_iso_seconds_precision` — 秒精度（无微秒）

Green 实现:
```python
from datetime import datetime, timezone
def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def utc_now_iso_ms() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
def utc_now():
    return datetime.now(timezone.utc)
```

**0.2 扩展 conftest.py 重载链**

在 `_isolate_env` fixture 中，reload `app.db.models.meta` 之后、reload `app.deps` 之前，插入:
```python
import app.services.time as time_module
importlib.reload(time_module)
import app.models as business_models
importlib.reload(business_models)  # 18 表注册到新 metadata
```

验证: reload 后 `len(Base.metadata.tables) == 20`。

**0.3 创建目录骨架**
`app/models/__init__.py`, `app/schemas/__init__.py`, `app/services/__init__.py`, `app/routes/__init__.py`, `app/routes/v1/__init__.py`

---

### Step 1: B5 — 18 表 ORM 模型

**文件**: `app/models/mixins.py`, `app/models/*.py`（18 个模型文件）, `app/models/__init__.py`

**1.1 SyncMixin** — `app/models/mixins.py`:
```python
class SyncMixin:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: uuid.uuid4().hex)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso)
    version: Mapped[int] = mapped_column(Integer, default=1)
```
适用: 14 个标准实体（Task/Session/Note/Folder/QuickNote/Reflection/Habit/HabitCheckIn/Schedule/TimeBlock/MemoComment + 3 关联表）
不用: Tombstone（int PK）、Setting（key PK）、SyncOutbox、SyncAuditLog

**1.2 TDD Red** — `tests/test_models.py`（~11 测试）:

| 测试 | 断言 |
|------|------|
| `test_18_models_registered_on_metadata` | len(Base.metadata.tables) == 20 |
| `test_note_has_no_content_column` | Note 无 content 列 |
| `test_note_has_content_hash_and_word_count` | 有 content_hash + word_count |
| `test_task_has_check_constraints` | status/priority CHECK |
| `test_folder_unique_constraint` | uq_folder_parent_name |
| `test_sync_mixin_fields_present` | Task/Session/Note 有 id/created_at/updated_at/version |
| `test_tombstone_uses_int_pk` | Integer 自增 |
| `test_setting_uses_key_pk` | key 主键 |
| `test_sync_outbox_fields` | entity_type/entity_id/action/payload/synced_at |
| `test_sync_audit_log_fields` | event_type/entity_type/entity_id/details |
| `test_all_models_import_from_db_base` | 无 `from app.database import Base` |

**1.3 实现要点** — 从源项目逐文件移植，关键改造:
- 改 `from app.database import Base` → `from app.db.base import Base`
- 改 `from app.services.time import utc_now_iso` → 从新建的 time.py 导入
- Note 模型: **移除 content**，加 `content_hash: str(default="")` + `word_count: int(default=0)`
- 所有标准实体继承 SyncMixin（子类不重复声明 id/created_at/updated_at/version）

**1.4 `app/models/__init__.py`** 导入全部 18 个模型。

---

### Step 2: B6 — Pydantic Schemas

**文件**: `app/schemas/common.py`, `app/schemas/*.py`（16 实体 schemas）

**2.1 TDD Red** — `tests/test_schemas.py`（~13 测试）:

| 测试 | 断言 |
|------|------|
| `test_task_create_validates_status_literal` | 非法 status → ValidationError |
| `test_task_response_from_attributes` | model_validate(orm_task) 成功 |
| `test_task_tags_json_string_to_list` | tags JSON string → list |
| `test_note_create_has_content_field` | NoteCreate 有 content（写入 .md 用） |
| `test_note_update_has_content_hash_not_content` | NoteUpdate 有 content_hash，无 content |
| `test_note_response_no_content` | NoteResponse 无 content，有 content_hash + word_count |
| `test_folder_create_required_name` | name 缺失 → ValidationError |
| `test_all_entities_have_create_update_response` | 16 实体均有三类 schema |
| `test_common_paginated_response` | PaginatedResponse 泛型可用 |

**2.2 关键差异（Note schemas）**:
- NoteCreate: 有 `content: str`（路由层传给 file_system 写 .md）
- NoteUpdate: 有 `content_hash: str | None`，**无 content**（06 缺陷 #7）
- NoteResponse: 无 content，有 content_hash + word_count

**2.3 common.py**: `PaginatedResponse[T]`（items/total/limit/offset/has_more）、`ErrorResponse`

---

### Step 3: B7 — Alembic 迁移 002

**文件**: `alembic/env.py`（修改）, `alembic/versions/002_phase_b_all_models.py`（新建）

**3.1 TDD Red** — `tests/test_alembic.py`（3 测试）:
- `test_alembic_upgrade_creates_all_tables` — upgrade head 后 20 张表
- `test_alembic_downgrade_drops_business_tables` — downgrade -1 后回到 2 张
- `test_migration_note_table_no_content` — Note 表无 content 列

**3.2 实现**:
1. 修改 `alembic/env.py`: 添加 `from app.models import *  # noqa: F401`
2. `uv run alembic revision --autogenerate -m "phase_b_all_models"`
3. 人工检查: Note 无 content 列、有 content_hash + word_count、18 张新表、CHECK/Unique/Index 保留

---

### Step 4: B8 — BaseService

**文件**: `app/services/base.py`

**4.1 TDD Red** — `tests/test_base_service.py`（~8 测试）:
- `test_create_flushes_not_commits` — create 后 db.in_transaction() 为 True
- `test_get_returns_entity` — create → get 同一 id
- `test_get_raises_not_found` — 不存在 id → NotFoundError
- `test_update_sets_fields` — update 后字段变更，version +1
- `test_delete_soft_sets_deleted_at` — soft=True 时设置 deleted_at
- `test_delete_hard_removes_entity` — soft=False 时物理删除
- `test_no_commit_in_base_service` — 源码不含 .commit()

**4.2 实现**: 按转接文档 B8 + 架构文档 3.2。只 flush 不 commit。get 不存在时 raise NotFoundError。

---

### Step 5: B11 — TombstoneService

**文件**: `app/services/tombstone.py`

**5.1 TDD Red** — `tests/test_tombstone_service.py`（~6 测试）:
- `test_create_tombstone` — create 后 DB 有记录
- `test_create_idempotent` — 重复 create 不报错
- `test_exists_returns_true_for_deleted` — create 后 exists → True
- `test_exists_returns_false_for_alive` — 未删除 → False
- `test_cleanup_expired_removes_old` — >90 天的被清理
- `test_cleanup_keeps_recent` — 30 天内保留

---

### Step 6: B9a — CascadeService

**文件**: `app/services/cascade.py`

**6.1 TDD Red** — `tests/test_cascade_service.py`（~7 测试）:
- `test_delete_task_cascade_removes_sessions` — Task 的关联 Session 删除
- `test_delete_task_cascade_clears_quicknote_refs` — TaskQuickNote 关联表记录删除
- `test_delete_task_cascade_creates_tombstones` — task + session tombstone 存在
- `test_delete_folder_cascade_bfs_descendants` — 三层 Folder BFS 全部处理
- `test_delete_folder_cascade_nullifies_notes` — Note.folder_id 置 None
- `test_delete_note_cascade_removes_comments` — MemoComment 删除 + tombstone
- `test_delete_note_cascade_calls_fs` — fs.delete_note 被调用

**6.2 实现要点**:
- BFS 遍历只遍历 `trashed_at.is_(None)` 的子节点（防止无限循环）
- delete_note_cascade: FS 失败时 try/except log，不阻断 DB 删除
- 被 REST 路由和 sync 共用

---

### Step 7: B9b — 实体 Services + serializers

**文件**: `app/services/task_service.py`, `app/services/note_service.py`, `app/services/folder_service.py`, `app/services/session_service.py`, `app/services/quick_note_service.py`, `app/services/reflection_service.py`, `app/services/habit_service.py`, `app/services/schedule_service.py`, `app/services/time_block_service.py`, `app/services/stats_service.py`, `app/services/relation_service.py`, `app/services/serializers.py`

**7.1 实施顺序**: TaskService → FolderService → SessionService/ReflectionService/HabitService/ScheduleService/TimeBlockService → QuickNoteService → NoteService → StatsService → RelationService → serializers.py

**7.2 TDD Red** — `tests/test_services.py`（~28 测试）:

**TaskService**:
- list_tasks 支持 status/priority/date/limit/offset 过滤
- create_task 返回 ORM 对象
- update_task 增量 version
- delete_task 调用 CascadeService

**NoteService（关键）**:
- create_note 同时写 .md + DB，设置 content_hash + word_count
- create_note FS 失败时 DB 回滚（Saga 补偿）
- get_note_content 读取 .md 正文
- search_notes 返回 list[dict] 含 note_id/title/excerpt
- list_notes 支持 folder_id 过滤

**StatsService**:
- focus_stats(period) 返回 dict 含 total_sessions/total_minutes/by_day
- graph_overview() 返回 {"nodes":[],"edges":[]}（骨架）

**serializers**:
- task_to_dict / note_to_dict（不含 content，含 content_hash/word_count，tags 解析为 list）

**7.3 MCP 预留检查**:
- 所有 Service 方法接受 dict/基本类型参数
- 返回 ORM 对象或 dict（非 Pydantic schema）
- 不导入 FastAPI

---

### Step 8: B4 — auth + spaces 路由

**文件**: `app/routes/v1/auth.py`, `app/routes/v1/spaces.py`

**8.1 TDD Red** — `tests/test_auth_routes.py` + `tests/test_spaces_routes.py`（~13 测试）:

**auth.py**:
- `test_setup_creates_default_space_and_double_token` — POST /auth/setup → 200 + master_token + space_token + space
- `test_setup_rejects_if_already_setup` — 二次 → 409
- `test_login_returns_master_token` — POST /auth/login → 200 + master_token
- `test_login_wrong_password` — → 401
- `test_switch_returns_space_token` — POST /auth/switch（master token）→ 200 + space_token
- `test_switch_rejects_without_master_token` — space token → 403
- `test_switch_rejects_invalid_space_id` — → 404

**spaces.py**:
- `test_list_spaces_requires_master_token` — space token → 403
- `test_list_spaces_returns_all` — master token → 200
- `test_create_space` — POST → 201
- `test_update_space_name` — PATCH → 200
- `test_delete_non_default_space` — DELETE → 204
- `test_delete_default_space_rejected` — → 403/409

**8.2 密码存储决策**: 用 MetaSetting KV 存储（key="admin_password", value=hash），不改 Space 模型。

---

### Step 9: B10 — 12 REST 路由

**文件**: `app/routes/v1/tasks.py`, `sessions.py`, `notes.py`, `folders.py`, `quick_notes.py`, `reflections.py`, `habits.py`, `schedules.py`, `time_blocks.py`, `trash.py`, `stats.py`, `settings.py` + `main.py`（注册路由）

**9.1 TDD Red** — `tests/test_routes.py`（~45 测试）:

每条路由验证:
- master token → 403
- space token → 200
- 无 token → 401

**tasks.py**: CRUD 全流程 + client_id + filter + tombstone
**notes.py**: create 写 .md + response 无 content + content_hash 更新 + cascade delete
**folders.py**: unique name + circular ref 检测 + cascade soft delete
**trash.py**: list + restore + purge + tombstone
**stats.py**: overview + focus_trend
**settings.py**: KV CRUD + admin_password 保护

**9.2 路由统一模式**:
```python
@router.post("", response_model=TaskResponse, status_code=201)
async def create_task(payload: TaskCreate, db: AsyncSession = Depends(get_space_db)):
    svc = TaskService(db)
    data = payload.model_dump()
    if "tags" in data: data["tags"] = json.dumps(data["tags"])
    task = await svc.create_task(data)
    await db.commit()  # 路由层 commit
    return TaskResponse.model_validate(task)
```

**9.3 main.py 注册**: `app.include_router(router, prefix="/api/v1")`

---

### Step 10: 集成验证 + 门控检查

**10.1 新增 conftest fixtures**:
- `meta_db_session` — 初始化 meta DB 并 yield session
- `space_db_session` — 初始化测试空间 DB session
- `app_client` — TestClient with lifespan
- `auth_tokens` — setup 后返回 master_token + space_token

**10.2 门控检查**:

| # | 检查项 | 预期 |
|---|--------|------|
| 1 | master token 调 GET /tasks | 403 |
| 2 | space token 调 GET /tasks | 200 |
| 3 | len(Base.metadata.tables) | 20 |
| 4 | Note 无 content 列 | ✓ |
| 5 | grep `\.commit()` app/services/ | 空 |
| 6 | grep `from fastapi` app/services/ | 空 |
| 7 | grep `\.commit()` app/routes/ | 有匹配 |
| 8 | alembic upgrade head | 成功 |
| 9 | alembic downgrade -1 | 成功 |
| 10 | uv run pytest -v | 全绿 |
| 11 | GET /openapi.json | 200 |

## 假设与决策

1. **SyncMixin**: 14 个标准实体继承，4 个特殊实体（Tombstone/Setting/SyncOutbox/SyncAuditLog）不继承
2. **Note 模型**: 无 content 字段，.md 为唯一 Source of Truth，ORM 保留 content_hash + word_count
3. **密码存储**: 用 MetaSetting KV（key="admin_password"），不改 Space 模型
4. **时间戳格式**: 统一 Z 后缀秒精度（对齐 meta.py），time.py 为唯一来源
5. **tags 序列化**: 路由层 model_dump 后转 JSON string，schema field_validator 反向解析
6. **级联删除**: Task/Session 物理删除 + tombstone；Folder BFS 软删除 + nullify 子节点；Note DB 物理删除 + FS 软删除
7. **MCP 预留**: Service 方法返回 ORM/dict，接受 dict 参数，不导入 FastAPI；StatsService.graph_overview() 返回空骨架
8. **文件写入**: 先尝试 Write 工具直接写入目标目录；若失败，写 temp 后用 Python shutil.copy2 复制
9. **测试导入**: 所有测试在函数内导入模型类（避免 conftest reload 后陈旧引用）
10. **Alembic**: 20 张表共享 app.db.base.Base.metadata；002 迁移在 meta.db 建 18 张业务表（可接受的冗余）

## 验证步骤

1. **Step 0 验证**: `uv run pytest tests/test_time.py -v` + 确认 reload 后表数 == 20
2. **Step 1 验证**: `uv run pytest tests/test_models.py -v` + `python -c "from app.db.base import Base; from app.models import *; print(len(Base.metadata.tables))"` == 20
3. **Step 2 验证**: `uv run pytest tests/test_schemas.py -v`
4. **Step 3 验证**: `uv run alembic upgrade head` + `uv run alembic downgrade -1` + `uv run alembic upgrade head`
5. **Step 4-7 验证**: 每步 `uv run pytest tests/test_xxx.py -v` + `grep -r "\.commit()" app/services/` 为空
6. **Step 8-9 验证**: `uv run pytest tests/test_auth_routes.py tests/test_routes.py -v`
7. **Step 10 验证**: 全量 `uv run pytest -v` + 11 项门控检查 + `uv run ruff check app/ --fix`

## 测试规模预估

| Step | 测试文件 | 预估测试数 |
|------|---------|-----------|
| 0 | test_time.py | 2 |
| 1 | test_models.py | 11 |
| 2 | test_schemas.py | 13 |
| 3 | test_alembic.py | 3 |
| 4 | test_base_service.py | 8 |
| 5 | test_tombstone_service.py | 6 |
| 6 | test_cascade_service.py | 7 |
| 7 | test_services.py | 28 |
| 8 | test_auth_routes.py + test_spaces_routes.py | 13 |
| 9 | test_routes.py | 45 |
| 10 | 集成/门控 | 5 |
| **合计** | | **~141 新增** |

Phase A 现有 105 + Phase B 新增 ~141 = **总计 ~246 测试**。
