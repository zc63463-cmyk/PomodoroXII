# PomodoroXII 优先级修复与 Phase C 实施计划

> **目标**: 按优先级 P0→P1→P2→P3 逐个规划实现，覆盖记忆修正、Phase C 前置三项、Phase C 10 任务、剩余 P2/P3 项。
>
> **方法论**: TDD（Red → Green → Refactor），每阶段产出测试先行，再写实现。
>
> **工具协同**: 自身（Trae IDE Agent）+ test-driven-development Skill（TDD 流程）+ agent-browser Skill（Phase C 路由端到端测试）
>
> **生成时间**: 2026-07-04（Plan Mode Phase 3 输出）

---

## 一、当前状态分析（Phase 1 探索成果）

### 1.1 关键探索发现

| 探索项 | 状态 | 证据 |
|--------|------|------|
| `project_memory.md` 是否存在 | ❌ **不存在** | `c:\Users\20564\.trae-cn\memory\projects\-e-Development-MyAwesomeApp-PomodoroXII\` 下仅有 `20260702/20260703/20260704` 三个日期目录 + topics.md，无 `project_memory.md` |
| 其他项目是否有 `project_memory.md` | ✅ 有 | KBv4MinerUI / markvault-js / pomodoroxi 等项目均有 |
| `BaseService.list()` 返回类型 | ✅ 已返回 `(items, total)` 元组 | [base.py:55-67](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py#L55-L67) |
| `PaginatedResponse` schema 是否存在 | ✅ **已存在** | [common.py:10-23](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/common.py#L10-L23) — 但路由层未使用 |
| P2-1 影响范围 | 11 处 `return items` | reflections.py:100, notes.py:57, quick_notes.py:91, habits.py:117+182, folders.py:85, schedules.py:77, sessions.py:80, time_blocks.py:78, tasks.py:58, trash.py:111 |
| P2-5 sync infra 模型索引 | ❌ 无 `index=True` | sync_outbox.py L25-31 + sync_audit_log.py L24-29 全部无索引 |
| P2-6 Mixin onupdate/version | ❌ 未实现 | mixins.py L27-28 `updated_at` 无 `onupdate`, `version` 无自增 |
| Phase C 旧计划代码完整性 | ✅ 完整可用 | phase-c-sync-completion-plan.md L99-524 含 Task 7/10/5+6/8 完整代码，但路径针对 `pomodoroxi-rebuild`（已归档） |
| NoteService Saga 现状 | ✅ 完整 Try-Compensate | note.py L94-102 (create) + L121-137 (update_content) + L177-188 (delete) — **但没有 `sync_mode` 参数**（旧计划声称"已有但未使用"是错误的） |
| `space_session` / `client` fixture | ✅ 已存在 | conftest.py L87-109 + L112-137 |
| TombstoneService 现状 | ✅ 含 TOCTOU 修复 | tombstone.py L42-52 `try/except IntegrityError` + 重新查询 |
| routes/v1/__init__.py 现状 | ✅ 15 路由挂载 | __init__.py L37-59 — 但无 sync_router |

### 1.2 关键架构约束（铁律）

1. **Routers commit / Services flush / Models 纯数据** — Service 不导入 fastapi，不调 commit
2. **Note 模型无 content 字段** — .md 文件是唯一 Source of Truth，DB 仅存 `content_hash` + `word_count`
3. **双 JWT 认证** — Master Token(7d) + Space Token(8h, 含 space_id)
4. **双 Base 隔离** — `app.db.base.Base` (业务) vs `app.file_system.schema.Base` (FS 索引)
5. **Saga Try-Compensate** — NoteService create/update_content/delete 三方法均含补偿

### 1.3 测试基线

- **当前测试数**: 214 个测试 / 36 文件（Grep 实际计数）
- **测试框架**: pytest + pytest-asyncio (asyncio_mode=auto)
- **隔离机制**: `conftest.py` 的 `_isolate_env` autouse fixture（重载 settings/models/services）
- **关键 fixture**: `space_session` (per-test 空间 DB), `client` (httpx AsyncClient + ASGITransport)

---

## 二、P0 阶段 — 立即修正记忆

### 2.1 任务说明

创建 `project_memory.md`，明确标注当前仓库真实状态，避免后续 Agent 被误导。

### 2.2 文件操作

**文件路径**: `c:\Users\20564\.trae-cn\memory\projects\-e-Development-MyAwesomeApp-PomodoroXII\project_memory.md`

**操作**: Write 新建文件

**内容结构**（约 80-100 行）:

```markdown
# PomodoroXII 项目记忆

> **最后更新**: 2026-07-04
> **项目根**: e:\Development\MyAwesomeApp\PomodoroXII
> **状态基线**: 2026-07-04 深度调研（详见 .trae/documents/项目深度调研分析报告.md）

## 关键事实（避免被误导）

### 1. Phase C 实际进度 = 0%
- ❌ `app/services/sync.py` **不存在**
- ❌ `app/routes/v1/sync.py` **不存在**
- ❌ `app/services/sync_safety.py` **不存在**
- ✅ 仅有的 sync 相关代码：3 个空壳模型 `SyncOutbox`/`SyncAuditLog`/`Tombstone`

### 2. 测试总数 = 214（非 244）
- Grep `^(async )?def test_|^class Test` 实际计数 214
- "244 全绿"是 v4 规划文档的声称值，不反映当前代码

### 3. 前端不存在
- Phase F 未开始，无 frontend/ 目录
- cognee 索引声称"React 19 已完成"是 LLM 幻觉，错误

### 4. 无 CI/CD 且 Git 未初始化
- cognee 声称"GitHub Actions 完整流水线"是虚假信息

### 5. 旧文档针对已归档项目
- `.trae/documents/phase-c-sync-completion-plan.md` 目标项目为 `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`（已归档）
- 该文档的"已完成 Task 1-4"对当前仓库无效

## 真实架构

- 后端: FastAPI + SQLAlchemy 2.0 async + 多空间独立 SQLite + 共享 meta.db
- 认证: 自实现双 JWT (master 7d / space 8h) + bcrypt 12 rounds
- **不使用** Auth0 / AWS / PostgreSQL / GitHub Actions / React

## Phase 进度

| Phase | 实际状态 |
|-------|---------|
| A (file_system) | ✅ 完成 |
| B (业务层) | ✅ 完成（90%） |
| P0 修复 | ✅ 完成（2/2） |
| P1 修复 | ✅ 完成（5/5） |
| C (Sync 引擎) | ❌ **0% 未实现** |
| D-H | ❌ 未开始 |

## 已修复问题（P0/P1）

- P0-1 DB 表隔离 ✅
- P0-2 NoteService Saga ✅
- P1-1 trash Task AttributeError ✅
- P1-2 Cascade 循环防护 ✅
- P1-3 Tombstone TOCTOU ✅
- P1-4 Relation ValidationError ✅
- P1-5 NoteService json.loads ✅

## 未修复问题（P2/P3）

- P2-1 list 端点丢弃 total（11 处）
- P2-2 TaskService update 不处理 tags
- P2-3 Cascade N+1（部分修）
- P2-4 serializers json.loads（部分修）
- P2-5 SyncOutbox/SyncAuditLog 无索引
- P2-6 Mixin updated_at 无 onupdate / version 无自增
- P3-10 Note status 无 CheckConstraint
- P3-13 deps.py space_id 未校验存在性

## 后续行动优先级

1. **P0**: 修正记忆（本文件）
2. **P1**: Phase C 前置三项（P2-1/P2-5/P2-6）
3. **P2**: Phase C 实施（10 任务 ~54 测试）
4. **P3**: 修复剩余 P2/P3 项
```

### 2.3 验证步骤

1. 文件存在性: `Read c:\Users\20564\.trae-cn\memory\projects\-e-Development-MyAwesomeApp-PomodoroXII\project_memory.md`
2. 内容包含 "Phase C 实际进度 = 0%"
3. 内容包含 "测试总数 = 214"

### 2.4 不做的事

- ❌ 不修改 session_memory_*.jsonl（历史记录保留）
- ❌ 不修改 topics.md（自动生成）
- ❌ 不修改 user_profile.md（跨项目共享）

---

## 三、P1 阶段 — Phase C 前置三项

### 3.1 P2-1: 11 个 list 端点丢弃 total

#### 3.1.1 修复策略

**关键发现**: `PaginatedResponse[T]` schema 已存在于 [common.py:10-23](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/common.py#L10-L23)，含 `items`/`total`/`limit`/`offset`/`has_more` 字段。路由层只需：
1. 从 `app.schemas.common` 导入 `PaginatedResponse`
2. 将 `response_model=list[XxxResponse]` 改为 `response_model=PaginatedResponse[XxxResponse]`
3. 将 `return items` 改为 `return {"items": items, "total": total, "limit": per_page, "offset": (page-1)*per_page, "has_more": ((page-1)*per_page + len(items)) < total}`

#### 3.1.2 涉及文件（11 处）

| 文件 | 行号 | 端点 |
|------|------|------|
| [tasks.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/tasks.py#L32-L58) | L32-58 | list_tasks |
| [notes.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/notes.py#L43-L57) | L43-57 | list_notes |
| [folders.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/folders.py#L66-L85) | L66-85 | list_folders |
| [sessions.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/sessions.py#L62-L80) | L62-80 | list_sessions |
| [schedules.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/schedules.py#L66-L77) | L66-77 | list_schedules |
| [time_blocks.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/time_blocks.py#L62-L78) | L62-78 | list_time_blocks |
| [reflections.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/reflections.py#L84-L100) | L84-100 | list_reflections |
| [quick_notes.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/quick_notes.py#L80-L91) | L80-91 | list_quick_notes |
| [habits.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/habits.py#L106-L117) | L106-117 | list_habits |
| [habits.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/habits.py#L169-L182) | L169-182 | list_check_ins |
| [trash.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/routes/v1/trash.py#L52-L111) | L52-111 | list_trash |

**特殊情况**:
- `trash.py` 的 list_trash 端点可能不返回分页结构（需读取确认）
- `habits.py` 含 2 个 list 端点（list_habits + list_check_ins）

#### 3.1.3 TDD 流程

**测试先行**（追加到 `tests/test_routes_v1.py`）:

```python
@pytest.mark.asyncio
async def test_list_tasks_returns_paginated_envelope(client):
    """list_tasks 应返回 PaginatedResponse 结构（含 items + total）。"""
    # 预先创建 3 个 task
    for i in range(3):
        await client.post("/api/v1/tasks", json={"title": f"T{i}", "status": "todo"})
    resp = await client.get("/api/v1/tasks")
    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data
    assert "total" in data
    assert data["total"] == 3
    assert len(data["items"]) == 3
    assert "limit" in data
    assert "offset" in data
    assert "has_more" in data

# 对 11 个端点各写一个同类测试（test_list_notes_returns_paginated_envelope 等）
```

**实现**: 修改 11 个路由文件，统一改为 `PaginatedResponse[T]` 返回结构。

**验证**: `pytest tests/test_routes_v1.py -k paginated -v`（应有 11 个新测试通过）

#### 3.1.4 影响范围

- **路由层**: 11 个文件需修改
- **schema 层**: 0 个修改（PaginatedResponse 已存在）
- **service 层**: 0 个修改（已返回 tuple）
- **测试层**: 11 个新测试
- **OpenAPI schema**: 自动更新（FastAPI 根据 response_model 生成）

### 3.2 P2-5: SyncOutbox/SyncAuditLog 添加索引

#### 3.2.1 修复策略

为以下字段添加 `index=True`:
- `SyncOutbox.entity_type`, `entity_id`, `synced_at`, `created_at`
- `SyncAuditLog.event_type`, `entity_type`, `entity_id`, `created_at`

#### 3.2.2 文件操作

**修改文件**:
- [sync_outbox.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/sync_outbox.py#L25-L31)
- [sync_audit_log.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/sync_audit_log.py#L24-L29)

**修改方式**: Edit 各字段的 `mapped_column` 添加 `index=True`

**新增 Alembic migration**:
- `alembic/versions/002_sync_indexes.py` — 创建索引
- upgrade: `op.create_index("ix_sync_outbox_entity_type", "sync_outbox", ["entity_type"])` 等
- downgrade: `op.drop_index(...)` 反向

#### 3.2.3 TDD 流程

**测试先行**（追加到 `tests/test_models.py` 或新建 `tests/test_sync_indexes.py`）:

```python
@pytest.mark.asyncio
async def test_sync_outbox_has_index_on_entity_id(space_session):
    """SyncOutbox.entity_id 应有索引。"""
    from app.models.sync_outbox import SyncOutbox
    cols = {c.name: c for c in SyncOutbox.__table__.columns}
    assert cols["entity_id"].index is True
    assert cols["synced_at"].index is True
    assert cols["created_at"].index is True

@pytest.mark.asyncio
async def test_sync_audit_log_has_index_on_entity_id(space_session):
    """SyncAuditLog.entity_id 应有索引。"""
    from app.models.sync_audit_log import SyncAuditLog
    cols = {c.name: c for c in SyncAuditLog.__table__.columns}
    assert cols["entity_id"].index is True
    assert cols["event_type"].index is True
    assert cols["created_at"].index is True
```

**验证**: `pytest tests/test_sync_indexes.py -v`

### 3.3 P2-6: Mixin updated_at onupdate + version 自增

#### 3.3.1 修复策略

**关键约束**: `updated_at` 已在 `BaseService.update` L74 手动设置，所以 `onupdate` 是冗余但无害的安全网。

**修改 1**: `mixins.py` L28 添加 `onupdate=utc_now_iso`:

```python
# 当前
updated_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso)

# 修改为
updated_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, onupdate=utc_now_iso)
```

**修改 2**: `base.py` `BaseService.update` L72-77 添加 `version += 1`:

```python
# 当前 L72-77
async def update(self, id: str, data: dict[str, Any]) -> Any:
    obj = await self.get(id)
    for k, v in data.items():
        setattr(obj, k, v)
    obj.updated_at = utc_now_iso()
    await self.db.flush()
    await self.db.refresh(obj)
    return obj

# 修改为
async def update(self, id: str, data: dict[str, Any]) -> Any:
    obj = await self.get(id)
    for k, v in data.items():
        setattr(obj, k, v)
    obj.updated_at = utc_now_iso()
    if hasattr(obj, "version"):
        obj.version = (obj.version or 0) + 1
    await self.db.flush()
    await self.db.refresh(obj)
    return obj
```

#### 3.3.2 TDD 流程

**测试先行**（追加到 `tests/test_base_service.py`）:

```python
@pytest.mark.asyncio
async def test_update_bumps_version(space_session):
    """BaseService.update 应自增 version 字段。"""
    from app.models.task import Task
    from app.services.base import BaseService

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    obj = await svc.create({"id": "ver-1", "title": "V1", "status": "todo"})
    assert obj.version == 1
    updated = await svc.update("ver-1", {"title": "V2"})
    assert updated.version == 2
    assert updated.title == "V2"

@pytest.mark.asyncio
async def test_update_refreshes_updated_at(space_session):
    """BaseService.update 应刷新 updated_at。"""
    from app.models.task import Task
    from app.services.base import BaseService

    class TaskService(BaseService):
        model = Task

    svc = TaskService(space_session)
    obj = await svc.create({"id": "ts-1", "title": "T1", "status": "todo"})
    original_ts = obj.updated_at
    updated = await svc.update("ts-1", {"title": "T2"})
    assert updated.updated_at >= original_ts
```

**验证**: `pytest tests/test_base_service.py -k "version or updated_at" -v`

---

## 四、P2 阶段 — Phase C 实施（10 任务，~54 新测试）

### 4.1 Phase C 实施总体策略

**方法论**: TDD（Red → Green → Refactor）
- 每个任务先写测试（Red），再写实现（Green），最后重构（Refactor）
- 使用 `test-driven-development` Skill 引导流程

**Skill 使用**:
- `test-driven-development`: 用于 Phase C 10 任务的 TDD 流程引导
- `agent-browser`: 用于 Phase C 路由端到端测试（C7 任务完成后，通过浏览器自动化验证 sync 端点）

**旧计划适配**: `phase-c-sync-completion-plan.md` 中的代码完整可用，但路径需从 `pomodoroxi-rebuild` 替换为 `PomodoroXII`。

### 4.2 任务清单与执行顺序

```
C1 sync_safety.py ─────── 纯工具函数,无依赖（12 测试）
    │
    ▼
C2 SyncService.push ──── 依赖 C1（5 测试）
    │
    ▼
C3 SyncService.pull ──── 依赖 C2（5 测试）
    │
    ├──▶ C5 SAVEPOINT 兼容性 ── 纯测试（3 测试）
    ├──▶ C8 ENTITY_REGISTRY 验证 ── 纯测试（3 测试）
    │
    ▼
C4 SyncService.full + status ── 依赖 C3（4 测试）
    │
    ├──▶ C6 NoteService sync_mode ── 依赖 C3（4 测试）
    │        │
    │        ▼
    └──▶ C9 sync 审计 ── 依赖所有方法（3 测试）
             │
             ▼
       C7 sync 路由 ── 依赖全部（7 测试）
             │
             ▼
       C10 集成测试 ── 依赖路由（8 测试,使用 agent-browser）
```

### 4.3 各任务详细规划

#### C1: sync_safety.py — 纯工具函数

**新建文件**: `backend/app/services/sync_safety.py`

**函数清单**（来自旧计划，需适配）:
- `normalize_timestamp(ts)` — 归一化到毫秒精度
- `is_zero_time(ts)` — 检测零时间戳
- `sanitize_zero_time(ts, now=None)` — 零时间替换为当前 UTC
- `serialize_entity(obj)` — ORM → dict（处理 tags JSON）
- `check_lww_conflict(local_obj, remote_ts)` — LWW 冲突检测

**TDD 流程**:
1. 先写 `tests/test_sync_safety.py`（12 测试）
2. 实现 `sync_safety.py`
3. 验证: `pytest tests/test_sync_safety.py -v`

**关键约束**:
- 不导入 fastapi
- 不调 commit
- 依赖: `from app.services.time import utc_now_iso`

#### C2: SyncService.push + ENTITY_REGISTRY + schemas

**新建文件**:
- `backend/app/schemas/sync.py` — SyncEvent / SyncPushRequest / SyncPushResponse
- `backend/app/services/sync.py` — SyncService 类 + ENTITY_REGISTRY 字典

**ENTITY_REGISTRY 内容**（14 实体）:
```python
ENTITY_REGISTRY = {
    "task": {"model": Task, "pull_key": "tasks"},
    "session": {"model": Session, "pull_key": "sessions"},
    "note": {"model": Note, "pull_key": "notes"},
    "folder": {"model": Folder, "pull_key": "folders"},
    "quickNote": {"model": QuickNote, "pull_key": "quickNotes"},
    "reflection": {"model": Reflection, "pull_key": "reflections"},
    "habit": {"model": Habit, "pull_key": "habits"},
    "habitCheckIn": {"model": HabitCheckIn, "pull_key": "habitCheckIns"},
    "schedule": {"model": Schedule, "pull_key": "schedules"},
    "timeBlock": {"model": TimeBlock, "pull_key": "timeBlocks"},
    "memoComment": {"model": MemoComment, "pull_key": "memoComments"},
    "sessionQuickNote": {"model": SessionQuickNote, "pull_key": "sessionQuickNotes"},
    "scheduleQuickNote": {"model": ScheduleQuickNote, "pull_key": "scheduleQuickNotes"},
    "taskQuickNote": {"model": TaskQuickNote, "pull_key": "taskQuickNotes"},
}
```

**push() 签名**: `async def push(self, events: list[dict]) -> dict[str, Any]`

**返回**: `{"applied": [...], "conflicts": [...], "errors": [...], "server_time": "..."}`

**实现要点**:
- 逐事件 `async with self.db.begin_nested()` (SAVEPOINT 隔离)
- 调用 sync_safety 安全检查
- Note 实体走 NoteService（C6 实现）
- 其他实体走直接 ORM 操作
- 不 commit（路由 commit）

**TDD 流程**:
1. 先写 `tests/test_sync_service.py`（5 个 push 测试）
2. 实现 `sync.py` 的 push() 方法
3. 验证: `pytest tests/test_sync_service.py -k push -v`

#### C3: SyncService.pull

**修改文件**: `backend/app/services/sync.py`（追加 pull 方法）

**pull() 签名**: `async def pull(self, since: str = "", limit: int = 1000) -> dict`

**返回结构**: `{server_time, has_more, next_since, tombstones, tasks, sessions, ...}`（14 个 pull_key 分组）

**实现要点**:
- 遍历 ENTITY_REGISTRY，每实体查询 `updated_at > since`
- Note 特殊处理: 收集 note_ids → `fs.read_notes_batch(note_ids)` 批量读 content
- Tombstone 查询 `deleted_at > since`
- 分页: `limit + 1` 条用于检测 has_more

**TDD 流程**:
1. 先写 5 个 pull 测试（见旧计划 L413-470）
2. 实现 pull() 方法
3. 验证: `pytest tests/test_sync_service.py -k pull -v`

#### C4: SyncService.full + status

**修改文件**: `backend/app/services/sync.py`（追加 full + status 方法）

**full()**: 与 pull 的区别是 tombstones 不按 since 过滤（全量返回），附加 `"is_full": True`

**status()**: 返回 `{server_time, entity_counts: {tasks: N, ...}, tombstone_count: N}`

**TDD 流程**:
1. 先写 4 个 full/status 测试（见旧计划 L474-523）
2. 实现 full() + status()
3. 验证: `pytest tests/test_sync_service.py -k "full or status" -v`

#### C5: SAVEPOINT 兼容性验证

**修改文件**: `backend/tests/test_note_service.py`（追加 3 个测试，无新代码）

**测试目的**: 验证 NoteService Saga 在 `db.begin_nested()` 内正确工作

**测试代码**: 见旧计划 L105-184（完整代码已提供）

**验证**: `pytest tests/test_note_service.py -k savepoint -v`

#### C6: NoteService sync_mode 集成

**修改文件**:
- `backend/app/services/note.py`（添加 sync_mode 参数）
- `backend/app/services/sync.py`（push 中 note 事件委托给 NoteService）

**NoteService 改动**:
- `__init__` 添加 `sync_mode: bool = False` 参数
- sync_mode=True 时保留客户端 `updated_at`/`version`/`created_at`

**SyncService 改动**:
- 新增 `_push_note_event()` 辅助方法
- push() 中 `etype == "note"` 委托给 `_push_note_event()`

**TDD 流程**:
1. 先写 4 个 sync_mode 测试
2. 实现 sync_mode 参数 + _push_note_event
3. 验证: `pytest tests/test_sync_service.py -k sync_mode -v`

#### C7: sync 路由

**新建文件**: `backend/app/routes/v1/sync.py`

**修改文件**: `backend/app/routes/v1/__init__.py`（注册 sync_router）

**端点**:
- `POST /api/v1/sync/push` — body: SyncPushRequest, 返回 SyncPushResponse
- `GET /api/v1/sync/pull?since=&limit=` — 返回 SyncPullResponse
- `GET /api/v1/sync/full?since=&limit=` — 返回 SyncFullResponse
- `GET /api/v1/sync/status` — 返回 SyncStatusResponse

**TDD 流程**:
1. 先写 `tests/test_sync_routes.py`（7 个测试）
2. 实现 sync 路由
3. 注册到 `__init__.py`
4. 验证: `pytest tests/test_sync_routes.py -v`

#### C8: ENTITY_REGISTRY 验证

**修改文件**: `backend/tests/test_sync_service.py`（追加 3 个测试，无新代码）

**测试代码**: 见旧计划 L209-233（完整代码已提供）

**验证**: `pytest tests/test_sync_service.py -k entity_registry -v`

#### C9: sync 审计

**修改文件**: `backend/app/services/sync.py`（添加 `_write_audit` 方法）

**_write_audit 实现**:
- 在 savepoint 外执行（审计失败不影响已应用事件）
- 写入 SyncAuditLog: event_type / entity_type / entity_id / details
- try/except 包裹（失败仅记录日志，不抛出）

**TDD 流程**:
1. 先写 3 个审计测试
2. 实现 _write_audit
3. 在 push/pull/status 中调用
4. 验证: `pytest tests/test_sync_service.py -k audit -v`

#### C10: 集成测试（使用 agent-browser Skill）

**新建文件**: `backend/tests/test_sync_integration.py`

**测试场景**（8 个）:
1. 端到端 push + pull 双向同步
2. LWW 冲突解决
3. Tombstone 防复活
4. Note content 双存储一致性
5. SAVEPOINT 隔离下批量 push
6. pull 分页 has_more
7. status 计数正确性
8. 路由端到端（使用 `client` fixture）

**Skill 使用**: `agent-browser` 可选用于场景 8 的浏览器端到端验证（如果需要前端联调）

**TDD 流程**:
1. 先写 8 个集成测试
2. 验证所有测试通过
3. 验证: `pytest tests/test_sync_integration.py -v`

### 4.4 Phase C 完成验收

**全量回归**: `pytest -q`（预期 214 + ~54 = ~268 测试全绿）

**三层铁律检查**:
```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if 'fastapi' in f.read_text(encoding='utf-8')]"
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if '.commit()' in f.read_text(encoding='utf-8')]"
```
两个命令都应返回空（0 个匹配）。

---

## 五、P3 阶段 — 修复剩余 P2/P3 项

### 5.1 P2-2: TaskService update 不处理 tags

**修改文件**: `backend/app/services/task.py`

**修复方式**: 重写 `update()` 方法，处理 tags list→JSON 转换（参考 NoteService.update_metadata）

**TDD 流程**:
1. 先写测试: `test_update_task_converts_tags_list_to_json`
2. 实现: TaskService.update 处理 tags
3. 验证: `pytest tests/test_task_service.py -k update_tags -v`

### 5.2 P2-3: trash.py purge_item N+1

**修改文件**: `backend/app/routes/v1/trash.py`

**修复方式**: purge_item 改为 `select(Folder).where(Folder.id.in_(desc_ids))` 批量查询

**TDD 流程**:
1. 先写测试: `test_purge_item_batch_query_no_n_plus_1`
2. 实现: 批量查询
3. 验证: `pytest tests/test_routes_v1.py -k purge -v`

### 5.3 P2-4: serializers json.loads 未保护

**修改文件**: `backend/app/services/serializers.py`

**修复方式**: 添加 `try/except json.JSONDecodeError` 包裹 json.loads

**TDD 流程**:
1. 先写测试: `test_serialize_handles_malformed_tags_json`
2. 实现: try/except 包裹
3. 验证: `pytest tests/test_serializers.py -v`

### 5.4 P3-10: Note status CheckConstraint

**修改文件**: `backend/app/models/note.py`

**修复方式**: 添加 `CheckConstraint("status IN ('active','archived')", name="check_note_status")`

**TDD 流程**:
1. 先写测试: `test_note_invalid_status_raises`
2. 实现: 添加 CheckConstraint
3. 验证: `pytest tests/test_models.py -k note_status -v`

### 5.5 P3-11: Task status/priority/due_date 添加索引

**修改文件**: `backend/app/models/task.py`

**修复方式**: 为 `status`、`priority`、`due_date` 字段添加 `index=True`

### 5.6 P3-13: deps.py 校验 space_id 存在性

**修改文件**: `backend/app/deps.py`

**修复方式**: `get_space_context` 中校验 space_id 存在，不存在则抛 `NotFoundError`

**TDD 流程**:
1. 先写测试: `test_get_space_context_raises_on_unknown_space_id`
2. 实现: 添加校验
3. 验证: `pytest tests/test_deps.py -v`

---

## 六、执行计划（任务清单）

| 阶段 | 任务 | 工具 | 优先级 | 估算测试 |
|------|------|------|--------|---------|
| P0 | 创建 project_memory.md | Write | P0 | 0 |
| P1.1 | P2-1 修复 11 个 list 端点 | Edit 11 文件 | P1 | 11 测试 |
| P1.2 | P2-5 sync infra 添加索引 | Edit 2 文件 + Alembic migration | P1 | 2 测试 |
| P1.3 | P2-6 Mixin onupdate + version | Edit 2 文件 | P1 | 2 测试 |
| P2.1 (C1) | sync_safety.py | Write + TDD | P2 | 12 测试 |
| P2.2 (C2) | SyncService.push + schemas | Write + TDD | P2 | 5 测试 |
| P2.3 (C3) | SyncService.pull | Edit + TDD | P2 | 5 测试 |
| P2.4 (C4) | SyncService.full + status | Edit + TDD | P2 | 4 测试 |
| P2.5 (C5) | SAVEPOINT 兼容性测试 | TDD only | P2 | 3 测试 |
| P2.6 (C6) | NoteService sync_mode | Edit + TDD | P2 | 4 测试 |
| P2.7 (C7) | sync 路由 | Write + TDD | P2 | 7 测试 |
| P2.8 (C8) | ENTITY_REGISTRY 验证 | TDD only | P2 | 3 测试 |
| P2.9 (C9) | sync 审计 | Edit + TDD | P2 | 3 测试 |
| P2.10 (C10) | 集成测试 | TDD + agent-browser | P2 | 8 测试 |
| P3.1 | P2-2 TaskService update tags | Edit + TDD | P3 | 1 测试 |
| P3.2 | P2-3 trash.py purge N+1 | Edit + TDD | P3 | 1 测试 |
| P3.3 | P2-4 serializers json protection | Edit + TDD | P3 | 1 测试 |
| P3.4 | P3-10 Note status CheckConstraint | Edit + TDD | P3 | 1 测试 |
| P3.5 | P3-11 Task 字段索引 | Edit + TDD | P3 | 1 测试 |
| P3.6 | P3-13 deps space_id 校验 | Edit + TDD | P3 | 1 测试 |
| **合计** | | | | **~75 新测试** |

---

## 七、假设与决策

### 7.1 假设

1. `PaginatedResponse` schema 已存在且可直接使用（已在 [common.py:10-23](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/schemas/common.py) 确认）
2. Phase C 旧计划代码可用，仅需将路径从 `pomodoroxi-rebuild` 替换为 `PomodoroXII`
3. `space_session` 和 `client` fixture 已就绪（已在 conftest.py 确认）
4. test-driven-development Skill 提供 TDD 流程引导
5. agent-browser Skill 用于 Phase C 路由端到端测试（可选）
6. 全程遵守三层铁律（Service 不导入 fastapi，不调 commit）

### 7.2 决策

- **D1**: P2-1 使用已有 `PaginatedResponse` schema，不创建新 schema
- **D2**: P2-5 创建 Alembic migration（002_sync_indexes.py）记录索引变更
- **D3**: P2-6 使用 `hasattr(obj, "version")` 防护，避免影响无 SyncMixin 的模型
- **D4**: Phase C 10 任务严格按依赖顺序执行（C1→C2→C3→C4→C5+C8 并行→C6→C9→C7→C10）
- **D5**: 每个任务先写测试（Red），再实现（Green），最后重构（Refactor）
- **D6**: 不重写主报告，仅修改代码 + 测试
- **D7**: Phase C 完成后更新 project_memory.md 标注进度变化
- **D8**: TDD Skill 在每个 Phase C 任务开始时调用，引导 Red-Green-Refactor 流程
- **D9**: agent-browser Skill 在 C10 集成测试阶段调用，用于端到端验证（可选）
- **D10**: 不修改 alembic/env.py 的 include_object 过滤器（已正确实现 P0-1）

### 7.3 不做的事

- ❌ 不修改 session_memory_*.jsonl 或 topics.md
- ❌ 不修改 user_profile.md
- ❌ 不创建除计划文件和必要代码文件之外的新文档
- ❌ 不主动启动 Phase D-H（依赖 Phase C 完成且需用户明确指令）
- ❌ 不修改 cognee 索引（标记为可选，用户明确要求时执行）
- ❌ 不重写主报告 `项目深度调研分析报告.md`

### 7.4 Skill 使用规划

| Skill | 使用时机 | 用途 |
|-------|---------|------|
| `test-driven-development` | P1/P2/P3 每个任务开始时 | 引导 TDD Red-Green-Refactor 流程 |
| `agent-browser` | C10 集成测试阶段 | 浏览器端到端验证 sync 路由（可选） |

---

## 八、验证步骤

### 8.1 P0 验证

1. `Read c:\Users\20564\.trae-cn\memory\projects\-e-Development-MyAwesomeApp-PomodoroXII\project_memory.md` 应存在
2. 内容包含 "Phase C 实际进度 = 0%" 和 "测试总数 = 214"

### 8.2 P1 验证

```powershell
cd 'e:\Development\MyAwesomeApp\PomodoroXII\backend'

# P2-1: 11 个端点返回 PaginatedResponse
.venv\Scripts\python.exe -m pytest tests/test_routes_v1.py -k paginated -v

# P2-5: sync 索引
.venv\Scripts\python.exe -m pytest tests/test_sync_indexes.py -v

# P2-6: version 自增
.venv\Scripts\python.exe -m pytest tests/test_base_service.py -k "version or updated_at" -v

# 全量回归
.venv\Scripts\python.exe -m pytest -q
```

### 8.3 P2 验证（Phase C）

```powershell
# 各任务测试
.venv\Scripts\python.exe -m pytest tests/test_sync_safety.py -v       # C1
.venv\Scripts\python.exe -m pytest tests/test_sync_service.py -v      # C2-C6, C8-C9
.venv\Scripts\python.exe -m pytest tests/test_note_service.py -k savepoint -v  # C5
.venv\Scripts\python.exe -m pytest tests/test_sync_routes.py -v        # C7
.venv\Scripts\python.exe -m pytest tests/test_sync_integration.py -v   # C10

# 全量回归（预期 214 + ~75 = ~289 测试）
.venv\Scripts\python.exe -m pytest -q

# 三层铁律检查
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if 'fastapi' in f.read_text(encoding='utf-8')]"
.venv\Scripts\python.exe -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if '.commit()' in f.read_text(encoding='utf-8')]"
# 两个命令都应返回空
```

### 8.4 P3 验证

```powershell
.venv\Scripts\python.exe -m pytest tests/test_task_service.py -k update_tags -v
.venv\Scripts\python.exe -m pytest tests/test_routes_v1.py -k purge -v
.venv\Scripts\python.exe -m pytest tests/test_serializers.py -v
.venv\Scripts\python.exe -m pytest tests/test_models.py -k "note_status or task_index" -v
.venv\Scripts\python.exe -m pytest tests/test_deps.py -v
```

---

## 九、关键约束（铁律）

1. **三层铁律**: Routers commit / Services flush / Models 纯数据 — 严格遵守
2. **TDD 流程**: 每个任务先写测试（Red），再实现（Green），最后重构（Refactor）
3. **MCP 工具规范**: 调用 run_mcp 时严格使用 `{"server_name": ..., "tool_name": ..., "args": {...}}` 格式
4. **代码引用规范**: 报告中所有代码引用使用 `file:///` 链接格式
5. **不创建非必要文件**: 仅创建计划要求的代码文件 + 测试文件 + 1 个 Alembic migration
6. **路径规范**: 当前仓库为 `e:\Development\MyAwesomeApp\PomodoroXII\backend`（大写 P 和 X）
7. **Skill 使用**: test-driven-development 用于 TDD 流程，agent-browser 用于端到端测试（可选）
8. **不动用户代码之外的范围**: 不修改 cognee 索引，不修改 session_memory，不修改 user_profile

---

## 十、风险与缓解

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| Phase C 旧计划代码与当前仓库不兼容 | 中 | 逐任务适配路径，先验证 import 路径 |
| TDD 流程耗时较长 | 中 | 严格遵守计划顺序，每任务完成后立即验证 |
| sync_mode 集成可能破坏现有 NoteService | 高 | 添加 sync_mode=False 默认值，向后兼容 |
| Alembic migration 可能与 P2-5 冲突 | 低 | 在 P1 阶段先创建 migration |
| agent-browser Skill 不可用 | 低 | C10 集成测试使用 client fixture 替代 |
| 测试总数增长后 conftest 隔离可能失效 | 中 | 每阶段全量回归验证 |
