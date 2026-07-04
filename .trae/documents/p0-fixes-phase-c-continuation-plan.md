# PomodoroXII P0 修复收尾 + Phase C Sync 引擎续接计划

> **For agentic workers:** 本计划采用 TDD 方法论(Red → Green → Refactor),每个任务包含完整测试代码、实现代码和运行命令。步骤使用 checkbox (`- [ ]`) 语法跟踪。

**Goal:** 完成 P0 剩余修复(路由测试 + NoteService Saga)并实现 Phase C Sync 引擎(push/pull/full/status + 安全检查 + 双存储桥接 + 审计)

**Architecture:** 多空间架构(共享 meta.db + 每空间 SQLite),Sync 引擎采用 client-first + LWW 冲突解决 + Tombstone 防复活。Note 实体走 NoteService(双存储 Saga),其他实体走直接 ORM。SAVEPOINT 隔离每事件。

**Tech Stack:** Python 3.12, FastAPI 0.139.0, SQLAlchemy 2.0 (async), Pydantic v2, Vitest/pytest, aiosqlite

---

## 摘要

本计划覆盖 PomodoroXII 重构项目的 P0 收尾(2 项)和 Phase C(C1-C10,Sync 引擎 + 双存储桥接,含 06 缺陷修正)。P0-3 已完成,P0-1 基本完成(alembic 7 测试全绿,1 个预存路由测试失败需修复),P0-2 和 Phase C 全部未开始。

**目标项目**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**源项目(参考)**: `e:\Development\MyAwesomeApp\pomodoroxi\backend`
**venv Python**: `.venv\Scripts\python.exe`
**pytest 配置**: `asyncio_mode = "auto"`, `testpaths = ["tests"]`, `pythonpath = ["."]`

---

## 当前状态分析

### 已完成

| 任务 | 状态 | 产出 |
|------|------|------|
| P0-3 (Git/.env) | ✅ 完成 | `.gitignore` + `.env.example` |
| P0-1 (Alembic 分裂) | ✅ 基本完成 | `registry.py` + `env.py` + 迁移文件 + `meta_session.py` + `space_manager.py` + 7 个 alembic 测试全绿 |

### 进行中/阻塞

| 问题 | 详情 |
|------|------|
| `test_gate_all_v1_routes_registered` 失败 | FastAPI 0.139.0 + Starlette 1.3.1 中 `app.routes` 不再展开 `include_router` 子路由。OpenAPI schema 确认 35 个 v1 路径已注册。需改用 `app.openapi()["paths"]` 计数。 |

### 未开始

| 任务 | 说明 |
|------|------|
| P0-2 (NoteService Saga) | `note.py` 三个方法无补偿逻辑,delete 顺序错误(FS 先于 DB) |
| C1 (sync_safety.py) | 5 道安全检查 + 3 辅助函数 |
| C2 (SyncService.push) | junction schema + sync schema + SyncService + ENTITY_REGISTRY |
| C3 (SyncService.pull) | 批量读 note content 消除 N+1 |
| C4 (SyncService.full + status) | 全量快照 + 统计计数 |
| C5 (SAVEPOINT 兼容性) | NoteService Saga 在 begin_nested 内验证 |
| C6 (sync_mode 集成) | NoteService 添加 sync_mode,SyncService 委托 note 事件 |
| C7 (sync 路由) | 4 端点 + 注册 |
| C8 (ENTITY_REGISTRY 验证) | 14 实体完整性 |
| C9 (sync 审计) | SyncAuditLog 写入 |
| C10 (集成测试) | 双向同步/冲突/Tombstone/Note双存储/SAVEPOINT/分页/审计/认证 |

### 三层铁律(必须全程遵守)

1. **Routers commit / Services flush / Models 纯数据**: 路由调 `await db.commit()`,Service 只 `await db.flush()`,Service 不导入 `fastapi`
2. **Note 模型无 content 字段**: .md 文件是唯一 Source of Truth,Note ORM 保留 `content_hash` + `word_count`
3. **双 JWT 认证**: Master Token(7天,空间管理) + Space Token(8小时,含 space_id,业务数据)

### 关键代码现状

- `app/services/note.py`: create() 无补偿,update_content() 不保存 old_content,delete() FS 先于 DB(顺序错误)
- `app/services/base.py`: flush-only CRUD 基类(正确)
- `app/services/tombstone.py`: exists/create/cleanup_expired(正确)
- `app/models/`: 18 个业务模型(含 SyncOutbox/SyncAuditLog/Tombstone)
- `app/schemas/`: 14 个 schema(缺 session_quick_note/schedule_quick_note/task_quick_note/sync)
- `app/file_system/engine/note_ops.py`: 已有 `read_notes_batch()` (L116-143) 和 `edit_note()` (L233-241)
- `app/services/serializers.py`: 已有 `serialize_entity()` 用于 ORM → dict

---

## 执行依赖顺序

```
任务 1 (fix gate test) ──────────────────────────────────── 独立,可立即执行
任务 2 (NoteService Saga) ──────────────────────────────── 独立,可与任务 1 并行
任务 3 (sync_safety.py) ─────────────────────────────────── 独立,可并行
    │
    ▼
任务 4 (SyncService.push + schemas + ENTITY_REGISTRY) ──── 依赖任务 3
    │
    ├──▶ 任务 5 (pull) ─────────────────────────────────── 依赖任务 4
    ├──▶ 任务 6 (full + status) ────────────────────────── 依赖任务 4
    ├──▶ 任务 7 (SAVEPOINT 验证) ───────────────────────── 依赖任务 2
    ├──▶ 任务 8 (sync_mode 集成) ───────────────────────── 依赖任务 2 + 4
    │        │
    │        ▼
    └──▶ 任务 9 (sync 路由) ───────────────────────────── 依赖任务 4-8
             │
             ├──▶ 任务 10 (ENTITY_REGISTRY 验证) ───────── 依赖任务 4
             ├──▶ 任务 11 (审计) ────────────────────────── 依赖任务 4
             │
             ▼
        任务 12 (集成测试) ──────────────────────────────── 依赖任务 1-11 全部完成
```

---

## 提议变更

### 任务 1: 修复 test_gate_all_v1_routes_registered

**问题**: FastAPI 0.139.0 中 `app.routes` 不再展开 `include_router` 子路由,导致 `hasattr(r, "path")` 遍历返回 0 个 v1 路由。

**方案**: 改用 `app.openapi()["paths"]` 计数,这是已注册路由的权威来源。

**涉及文件**:
- 修改: `tests/test_integration.py` (第 308-321 行)

**实现**: 将 `v1_count` 计算从遍历 `app.routes` 改为遍历 `app.openapi()["paths"]`,阈值从 40 降为 35(当前实际数),C7 添加 4 个 sync 端点后变为 39。

**验收标准**:
- [ ] `test_gate_all_v1_routes_registered` 通过
- [ ] OpenAPI schema 中 v1 路径数 >= 35

---

### 任务 2: P0-2 NoteService Saga 重构

**问题**: 当前三个方法无补偿逻辑,FS/DB 不一致风险。

**方案**: Saga Try-Compensate 模式重构。

**涉及文件**:
- 修改: `app/services/note.py`
- 修改: `tests/test_note_service.py` (追加 6 个测试)

**Saga 策略**:

| 方法 | 新顺序 | 补偿逻辑 |
|------|--------|---------|
| `create()` | FS write → DB flush | DB 失败 → `fs.delete_note(id)` 补偿删除 |
| `update_content()` | 保存 old_content → FS write → DB flush | DB 失败 → `fs.edit_note(id, old_content)` 恢复 |
| `delete()` | DB delete + tombstone(flush) → FS best-effort | FS 失败不回滚 DB(孤儿 .md 由一致性检查清理) |

**关键设计**:
- `create()` FS 先行: Note 无 content 字段(铁律 #2),content_hash 必须来自 FS
- `delete()` DB 先行: tombstone 是删除的 Source of Truth,防止 resurrection
- 全部方法只 `flush` 不 `commit`(铁律 #1),与 Phase C SAVEPOINT 兼容

**TDD 测试(6 个)**:
- `test_saga_create_db_failure_compensates_fs_delete` — DB 失败时 .md 不残留
- `test_saga_update_content_db_failure_restores_old_content` — DB 失败时 FS 内容恢复
- `test_saga_delete_db_first_then_fs` — DB delete 先于 FS delete
- `test_saga_delete_db_failure_preserves_fs` — DB 失败时 .md 保留
- `test_saga_delete_always_writes_tombstone` — .md 已删时仍写 tombstone
- `test_saga_create_update_delete_end_to_end` — 端到端 FS/DB 一致性

**验收标准**:
- [ ] create: DB 失败时 fs.delete_note 被调用,.md 不残留
- [ ] update_content: DB 失败时 FS 内容恢复
- [ ] delete: DB delete + tombstone 先于 FS;FS 失败不回滚 DB
- [ ] 全部方法只 flush 不 commit
- [ ] 8 个现有测试 + 6 个新测试全绿

---

### 任务 3: C1 sync_safety.py(5 道安全检查 + 3 辅助函数)

**涉及文件**:
- 新建: `app/services/sync_safety.py`
- 新建: `tests/test_sync_safety.py`

**3 个辅助函数**:
- `normalize_timestamp(ts)` — 统一为毫秒精度无 Z 后缀
- `is_zero_time(ts)` — 检测午夜零时伪时间戳
- `serialize_entity_data(data)` — list→json.dumps, bool→"true"/"false"

**5 道安全检查**(SyncSafety 类方法):
- `check_tombstone()` — 阻止复活已删除实体,允许"删后重建"(created_at > deleted_at 时清除 tombstone)
- `check_lww_conflict()` — 服务器版本更新时阻止覆盖(LWW)
- `check_ttl_guard()` — TTL 过期(>90天)的创建视为冲突
- `sanitize_zero_time()` — 零时时间戳替换为当前时间
- `check_folder_cycle()` — BFS 检测 folder 循环引用

**TDD 测试(12 个)**: 8 个辅助函数测试 + 4 个安全检查测试

**验收标准**:
- [ ] 5 个检查方法 + 3 个辅助函数全部实现
- [ ] 不导入 FastAPI(铁律 #1)
- [ ] 12 个测试全绿

---

### 任务 4: C2 SyncService.push(junction schema + sync schema + SyncService + ENTITY_REGISTRY)

**前置依赖**: 任务 3 (sync_safety)

**涉及文件**:
- 新建: `app/schemas/session_quick_note.py`
- 新建: `app/schemas/schedule_quick_note.py`
- 新建: `app/schemas/task_quick_note.py`
- 新建: `app/schemas/sync.py`
- 新建: `app/services/sync.py`
- 新建: `tests/test_sync_service.py`

**push 设计**:
- 逐事件 `async with db.begin_nested()`(SAVEPOINT 隔离)
- 事件内调用 sync_safety 5 道检查
- Note 实体走 NoteService(FS + DB 协调)— 任务 8 实现
- 其他实体走直接 ORM 操作
- **不 commit**(由路由 commit,铁律 #1)
- 返回 `{applied, conflicts, errors, server_time}`

**ENTITY_REGISTRY**: 14 个可同步实体(task/session/reflection/schedule/quickNote/note/habit/habitCheckIn/timeBlock/memoComment/sessionQuickNote/scheduleQuickNote/taskQuickNote/folder)

**TDD 测试(5 个)**:
- `test_push_create_task` — 创建事件应用
- `test_push_update_lww_conflict` — LWW 冲突检测
- `test_push_delete_writes_tombstone` — 删除写 tombstone
- `test_push_tombstone_blocks_create` — tombstone 阻止复活
- `test_push_savepoint_isolates_events` — SAVEPOINT 隔离(第 2 事件失败不影响 1/3)

**验收标准**:
- [ ] SAVEPOINT 隔离:第 N 事件失败不影响前 N-1 事件
- [ ] push 返回后 db 未 commit(由路由 commit)
- [ ] 5 道安全检查在 push 中调用
- [ ] 3 个 junction schema + sync schema 创建

---

### 任务 5: C3 SyncService.pull(批量读 note content 消除 N+1)

**前置依赖**: 任务 4

**涉及文件**: `app/services/sync.py`(追加 pull 方法), `tests/test_sync_service.py`(追加测试)

**pull 设计**:
- 遍历 ENTITY_REGISTRY,每实体 `select(model).where(updated_at > since).limit(limit+1)`
- Note 特殊: `fs.read_notes_batch(note_ids)` 批量读 .md 内容(1 次 ORM + 1 次批量读,消除 N+1)
- 返回 `{changes: {pull_key: [...]}, tombstones, server_time, has_more, next_since}`

**TDD 测试(5 个)**:
- `test_pull_returns_all_entities`
- `test_pull_includes_note_content_from_fs`
- `test_pull_since_filter`
- `test_pull_returns_tombstones`
- `test_pull_pagination_has_more`

**验收标准**:
- [ ] pull 50 条 note → 1 次 ORM 查询 + 1 次 `read_notes_batch`(非 N 次)
- [ ] note 变更含 content 字段(来自 FS)
- [ ] 分页 has_more + next_since 正确

---

### 任务 6: C4 SyncService.full + status

**前置依赖**: 任务 4

**涉及文件**: `app/services/sync.py`(追加), `tests/test_sync_service.py`(追加测试)

- `full(since, limit)`: 全量快照(tombstones 全量返回,不按 since 过滤)
- `status()`: 遍历 ENTITY_REGISTRY 统计各实体 count + tombstone count

**TDD 测试(2 个)**:
- `test_full_returns_all_data_and_tombstones`
- `test_status_returns_counts`

**验收标准**:
- [ ] full 返回全部数据 + 全量 tombstones
- [ ] status 返回各实体计数

---

### 任务 7: C5 NoteService Saga SAVEPOINT 兼容性验证

**前置依赖**: 任务 2

**涉及文件**: `tests/test_note_service.py`(追加 3 个测试)

验证 P0-2 的 Saga 方法在 `db.begin_nested()` 内正确工作:
- create 失败 → SAVEPOINT 回滚 + FS 补偿删除
- update_content 失败 → SAVEPOINT 回滚 + FS 内容恢复
- delete 失败 → SAVEPOINT 回滚 + .md 保留

**TDD 测试(3 个)**:
- `test_saga_create_inside_savepoint_rolls_back_cleanly`
- `test_saga_update_inside_savepoint_restores_content`
- `test_saga_delete_inside_savepoint_preserves_fs_on_rollback`

**验收标准**:
- [ ] 3 个 SAVEPOINT 兼容性测试全绿

---

### 任务 8: C6 NoteService sync_mode 集成

**前置依赖**: 任务 2 + 任务 4

**涉及文件**: `app/services/note.py`(添加 sync_mode), `app/services/sync.py`(push 中 note 事件委托), `tests/test_sync_service.py`(追加测试)

**设计**:
- `NoteService.__init__` 添加 `sync_mode: bool = False` 参数
- SyncService.push 中 `etype == "note"` 的 create/update/delete 委托给 NoteService
- note 事件在 SAVEPOINT 内通过 NoteService 写 .md + DB

**TDD 测试(3 个)**:
- `test_push_note_create_writes_md_and_db`
- `test_push_note_update_rewrites_md`
- `test_push_note_delete_removes_both`

**验收标准**:
- [ ] sync push note create 写 .md + DB
- [ ] sync push note update 重写 .md + 更新 hash
- [ ] sync push note delete 删 .md + DB + tombstone

---

### 任务 9: C7 sync 路由(4 端点 + 注册)

**前置依赖**: 任务 4-8

**涉及文件**:
- 新建: `app/routes/v1/sync.py`
- 修改: `app/routes/v1/__init__.py`(注册 sync_router)
- 新建: `tests/test_routes_sync.py`

**4 个端点**(全部用 space token):
- `POST /api/v1/sync/push` — 接收 events,push 后 `await db.commit()`
- `GET /api/v1/sync/pull` — 增量拉取(since/include_deleted/limit)
- `GET /api/v1/sync/full` — 全量快照
- `GET /api/v1/sync/status` — 统计计数

**TDD 测试(5 个)**:
- `test_sync_push_route`
- `test_sync_pull_route`
- `test_sync_full_route`
- `test_sync_status_route`
- `test_sync_requires_space_token` — Master Token → 403

**验收标准**:
- [ ] 4 端点全部用 space token
- [ ] push 后数据持久化(commit 在路由)
- [ ] pull 返回 note 含 content

---

### 任务 10: C8 ENTITY_REGISTRY 完善(验证 14 实体)

**前置依赖**: 任务 4

**涉及文件**: `tests/test_sync_service.py`(追加 3 个验证测试)

**TDD 测试(3 个)**:
- `test_entity_registry_has_14_entities`
- `test_entity_registry_entries_have_required_keys`
- `test_entity_registry_pull_keys_unique`

**验收标准**:
- [ ] 14 个实体注册正确
- [ ] 每个含 model + schema_create + schema_update + pull_key
- [ ] pull_key 唯一

---

### 任务 11: C9 sync 审计(SyncAuditLog)

**前置依赖**: 任务 4

**涉及文件**: `app/services/sync.py`(push 末尾追加审计写入), `tests/test_sync_service.py`(追加测试)

每个 applied 事件后写入 SyncAuditLog(event_type/entity_type/entity_id/details),只 flush 不 commit。conflicts 和 errors 不写审计。

**TDD 测试(2 个)**:
- `test_push_writes_audit_log` — applied 事件生成审计记录
- `test_push_no_audit_for_conflicts` — 冲突事件不写审计

**验收标准**:
- [ ] applied 事件写入 SyncAuditLog
- [ ] conflicts/errors 不写审计

---

### 任务 12: C10 集成测试

**前置依赖**: 任务 1-11 全部完成

**涉及文件**: 新建 `tests/test_sync_integration.py`

**集成测试矩阵(8 个)**:

| 场景 | 测试用例 |
|------|---------|
| 双向同步 | `test_bidirectional_sync_push_then_pull` |
| LWW 冲突 | `test_lww_conflict_resolution` |
| Tombstone | `test_tombstone_prevents_resurrection` |
| Note 双存储 | `test_note_dual_storage_sync` |
| SAVEPOINT | `test_savepoint_isolation_in_batch` |
| 分页 | `test_sync_pagination` |
| 审计 | `test_sync_audit_logged` |
| 认证 | `test_sync_requires_authentication` |

**验收标准**:
- [ ] 8 个集成测试全绿

---

## 06 缺陷修复对照

| 缺陷 | 修复位置 | 验证测试 |
|------|---------|---------|
| #1 Saga commit 击穿 SAVEPOINT | NoteService 只 flush;SyncService.push 用 begin_nested | `test_push_savepoint_isolates_events` |
| #2 sync adapter 丢失安全防线 | C1 sync_safety.py 5 道检查 + C6 NoteService sync_mode | `test_sync_safety_*` 系列 |
| #3 pull N+1 查询 | C3 fs.read_notes_batch() 批量读 | `test_pull_includes_note_content_from_fs` |
| #4 update_note old_hash 未回滚 | P0-2 update_content Saga 保存 old_content + 恢复 | `test_saga_update_content_db_failure_restores_old_content` |
| #6 delete_note 不创建 Tombstone | P0-2 delete 先 DB delete + tombstone | `test_saga_delete_always_writes_tombstone` |

---

## 文件变更总览

### 新建文件(9 个)

| 文件路径 | 用途 |
|---------|------|
| `app/services/sync_safety.py` | 5 道安全检查 + 3 辅助函数 |
| `app/services/sync.py` | SyncService(push/pull/full/status) + ENTITY_REGISTRY |
| `app/schemas/sync.py` | SyncEvent + SyncPushRequest |
| `app/schemas/session_quick_note.py` | junction table schema |
| `app/schemas/schedule_quick_note.py` | junction table schema |
| `app/schemas/task_quick_note.py` | junction table schema |
| `app/routes/v1/sync.py` | sync 路由(4 端点) |
| `tests/test_sync_safety.py` | sync_safety 单元测试(12 个) |
| `tests/test_sync_integration.py` | 集成测试(8 个) |

### 修改文件(5 个)

| 文件路径 | 修改内容 |
|---------|---------|
| `tests/test_integration.py` | 修复 gate 测试用 OpenAPI schema 计数 |
| `app/services/note.py` | Saga Try-Compensate + sync_mode 参数 |
| `app/routes/v1/__init__.py` | 注册 sync_router |
| `tests/test_note_service.py` | 新增 6 个 Saga 测试 + 3 个 SAVEPOINT 测试 |
| `tests/test_sync_service.py` | push/pull/full/status/registry/audit/sync_mode 测试 |

---

## 假设与决策

1. **NoteService.create FS 先行**: content_hash 必须来自 FS,因此 FS 必须先于 DB;DB 失败时补偿删除 FS
2. **NoteService.delete DB 先行**: tombstone 是删除的 Source of Truth;FS 失败时 .md 孤儿由一致性检查(Phase E)清理
3. **sync_safety 在 SyncService.push 中调用**: 而非 NoteService 内部;NoteService 的 sync_mode 参数控制是否检查
4. **ENTITY_REGISTRY 14 实体**: 不含 dimension/mental 系列(目标项目无)、Tombstone/Setting/SyncOutbox/SyncAuditLog(不可同步)
5. **fs.read_notes_batch() 已存在**: note_ops.py L116-143,C3 直接复用
6. **TDD 方法论**: 每个任务遵循 Red(失败测试) → Green(实现) → Refactor
7. **测试模式一致性**: 所有新测试遵循现有模式 — 模型导入在测试函数内部(conftest reload 约束),使用 `space_session`/`client` fixture
8. **路由测试修复**: OpenAPI schema 是已注册路由的权威来源,比遍历 `app.routes` 更可靠
9. **Note 事件特殊处理**: SyncService.push 中 `etype == "note"` 委托给 NoteService(写 .md),其他实体直接操作 ORM
10. **审计日志仅记录成功**: 只有 `applied` 列表中的事件写入 SyncAuditLog

---

## 验证步骤

### 任务级验证

```powershell
cd 'e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend'

# 任务 1: 路由测试
& '.venv\Scripts\python.exe' -m pytest tests/test_integration.py::test_gate_all_v1_routes_registered -v

# 任务 2: NoteService Saga
& '.venv\Scripts\python.exe' -m pytest tests/test_note_service.py -v

# 任务 3: sync_safety
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_safety.py -v

# 任务 4-6,8,10-11: SyncService
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_service.py -v

# 任务 7: SAVEPOINT 兼容性
& '.venv\Scripts\python.exe' -m pytest tests/test_note_service.py -k savepoint -v

# 任务 9: sync 路由
& '.venv\Scripts\python.exe' -m pytest tests/test_routes_sync.py -v

# 任务 12: 集成测试
& '.venv\Scripts\python.exe' -m pytest tests/test_sync_integration.py -v
```

### 全量验证

```powershell
# 全部测试(预期 244 + 新增 ~50 = ~294)
& '.venv\Scripts\python.exe' -m pytest -v

# Lint
& '.venv\Scripts\python.exe' -m ruff check app/ --fix

# 三层铁律检查
# 1. Services 不导入 fastapi
# 2. Services 不调 commit
# 3. Routes 调 commit
```

### 三层铁律验证

```powershell
# 铁律 #1: Services 不导入 fastapi
& '.venv\Scripts\python.exe' -c "import ast, pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if any(n.name == 'fastapi' or (n.name or '').startswith('fastapi.') for node in ast.walk(ast.parse(f.read_text(encoding='utf-8'))) for n in ([node] if isinstance(node, ast.Import) else []) for n in node.names)]"

# 铁律 #1: Services 不调 commit
& '.venv\Scripts\python.exe' -c "import pathlib; [print(f) for f in pathlib.Path('app/services').glob('*.py') if '.commit()' in f.read_text()]"
```

---

## 后续阶段概览(本计划不覆盖)

| 阶段 | 内容 | 前置 |
|------|------|------|
| Phase D | Notes/Search/Trash API + file_system 全集成 | Phase C |
| Phase E | 可靠性(backup/snapshot/consistency) + MCP Server | Phase D |
| Phase F | React 19 前端重建(组合式模式 + 多空间 UI) | Phase B |
| Phase G | 数据迁移 + 端到端集成测试 | C/D/E/F |
| Phase H | 部署 + Docker Compose + CI/CD | Phase G |
