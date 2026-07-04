# PomodoroXII P0 修复 + Phase C Sync 引擎实施计划

## 摘要

本计划覆盖 PomodoroXII 重构项目的 P0 修复(3 项,阻塞 Phase C)和 Phase C(Sync 引擎 + 双存储桥接,含 06 缺陷修正)。Phase B 已约 90% 完成(244 测试全绿),本计划是后续开发的关键路径。

**目标项目**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**源项目(参考)**: `e:\Development\MyAwesomeApp\pomodoroxi\backend`
**源 sync.py**: `e:\Development\MyAwesomeApp\pomodoroxi\backend\app\routes\sync.py`(1047 行)

---

## 当前状态分析

### 项目概况

PomodoroXII 是番茄钟应用,从 Vue 3 + FastAPI 重写为 React 19 + Next.js 15 + FastAPI,采用多空间架构(共享 FastAPI + 每空间独立 SQLite)。

### 已完成阶段

| 阶段 | 状态 | 产出 |
|------|------|------|
| Phase A | 完成 | file_system 移植(15 文件)、Alembic 初始化、Docker 骨架、main.py 修正 |
| Phase B | ~90% | 双 JWT 认证、18 ORM 模型、14 REST 路由、Service 层、244 测试全绿 |

### 当前后端结构

```
PomodoroXII-rebuild/backend/
├── app/
│   ├── models/          # 18 个 ORM 模型(16 业务 + 2 同步审计)
│   ├── schemas/         # 14 个 Pydantic schema(缺 3 个 junction table schema + sync schema)
│   ├── services/        # base, cascade, note, relation, serializers, stats, task, time, tombstone
│   ├── routes/v1/       # 14 个路由(auth, spaces, tasks, sessions, notes, folders, ...)
│   ├── file_system/     # 已移植的文件系统(双 Base 隔离)
│   ├── db/              # base, session, meta_session, models/meta(Space + MetaSetting)
│   ├── auth/security.py # bcrypt + PyJWT 双 Token
│   ├── deps.py          # get_space_db, get_meta_db, get_file_system 等
│   ├── space_manager.py # SpaceEngineManager(LRU pool max=5)
│   ├── main.py          # create_app() + lifespan
│   └── settings.py      # Settings 配置
├── alembic/
│   ├── env.py           # 异步 + Programmatic API(同时导入 meta + 全部业务模型)
│   └── versions/        # 001_initial.py + cab2ff7bcf37_phase_b_all_models.py
└── tests/               # 26 个测试文件 + test_file_system/
```

### 三层铁律(必须全程遵守)

1. **Routers commit / Services flush / Models 纯数据**: 路由调 `await db.commit()`,Service 只 `await db.flush()`,Service 不导入 `fastapi`
2. **Note 模型无 content 字段**: .md 文件是唯一 Source of Truth,Note ORM 保留 `content_hash` + `word_count`
3. **双 JWT 认证**: Master Token(7天,空间管理) + Space Token(8小时,含 space_id,业务数据)

### 已识别的关键问题

1. **alembic/env.py 同时导入 meta + 全部业务模型** → `alembic upgrade` 在 meta.db 创建 20 表(应仅 2 表)
2. **NoteService.create() 无补偿逻辑** → FS 写成功但 DB flush 失败时,.md 文件成为孤儿
3. **NoteService.update_content() 无 old_hash 保存** → DB flush 失败时 FS/DB 不一致
4. **NoteService.delete() 先删 FS 再删 DB** → FS 删除后 DB 失败则数据丢失
5. **缺少 3 个 junction table schema** → SessionQuickNote/ScheduleQuickNote/TaskQuickNote 无 Create/Update schema
6. **缺少 sync schema** → 无 SyncEvent/SyncPushRequest
7. **`深度交接Prompt.md` 未创建** → PhaseC 交接文档引用但文件不存在

---

## 执行依赖顺序

```
P0-3 (Git/.env) ──────────────────────────────────┐
                                                   │
P0-1 (Alembic 分裂) ──┐                           │
                       ├──> Phase C               │
P0-2 (NoteService Saga) ─┘                        │
                                                   │
C1 (sync_safety.py) ──> C5 (NoteService 集成) ─────┤
                          │                        │
C2 (SyncService.push) <───┤                        │
C3 (SyncService.pull) <───┤                        │
C4 (SyncService.full/status) <── C2,C3            │
                          │                        │
C6 (sync_mode 集成) <── C1,C5                     │
C7 (sync 路由) <── C2,C3,C4                       │
C8 (ENTITY_REGISTRY) <── C2                       │
C9 (sync 审计) <── C2                             │
C10 (集成测试) <── 全部                             │
```

**严格前置**: P0-1/P0-2 必须在 Phase C 之前完成;C1 必须在 C2 之前;junction table schema 创建是 C2/C8 的前置。

---

## 提议变更

### P0-1: Alembic meta/space DB 策略分裂

**问题**: `alembic/env.py` 同时导入 `from app.db.models import meta` 和 `from app.models import *`,导致 `Base.metadata` 含全部 20 表;`alembic upgrade` 在任何 DB 上都创建 20 表。运行时 `init_meta_db()` 和 `_init_schema()` 也用 `Base.metadata.create_all` 创建全部 20 表。

**方案**: 通过表名注册表区分 meta 表(2 表)和 space 表(18 表),在 Alembic 和运行时初始化中分别只创建对应表。

**涉及文件**:

| 文件 | 操作 | 说明 |
|------|------|------|
| `app/db/registry.py` | 新建 | 定义 META_TABLE_NAMES + 过滤辅助函数 |
| `alembic/env.py` | 重写 | 双 target 策略 + include_object 过滤 |
| `alembic/versions/001_initial.py` | 修改 | 添加 `branch_labels = ("meta",)` |
| `alembic/versions/cab2ff7bcf37_phase_b_all_models.py` | 修改 | `down_revision = None` + `branch_labels = ("space",)` |
| `app/db/meta_session.py` | 修改 | `init_meta_db()` 只创建 2 表 |
| `app/space_manager.py` | 修改 | `_init_schema()` 只创建 18 表 |
| `tests/test_alembic.py` | 修改 | 拆分 meta/space 两套测试 |

**核心实现**:

`app/db/registry.py`:
```python
META_TABLE_NAMES: frozenset[str] = frozenset({"spaces", "meta_settings"})

def get_meta_table_objects(metadata) -> list:
    return [metadata.tables[name] for name in META_TABLE_NAMES if name in metadata.tables]

def get_space_table_objects(metadata) -> list:
    return [metadata.tables[name] for name in metadata.tables if name not in META_TABLE_NAMES]
```

`alembic/env.py` 核心: 通过 `config.attributes.get("target")` 区分 "meta"/"space",用 `include_object` 过滤表。

`init_meta_db()` / `_init_schema()`: 调用 `Base.metadata.create_all(conn, tables=get_meta/space_table_objects(Base.metadata))` 只创建对应表。

**验收标准**:
- [ ] `alembic upgrade 001` 在 meta.db 只创建 spaces + meta_settings(2 表)
- [ ] `alembic upgrade cab2ff7bcf37` 在 space.db 创建 18 业务表
- [ ] 运行时 `init_meta_db()` 只创建 2 表
- [ ] 运行时 space engine 初始化只创建 18 表
- [ ] 全部现有 244 测试 + 新测试全绿

---

### P0-2: NoteService Saga 重构

**问题**: 当前 `app/services/note.py` 三个方法无补偿逻辑,FS/DB 不一致风险。

**方案**: Saga Try-Compensate 模式重构 create/update_content/delete。

**涉及文件**:

| 文件 | 操作 | 说明 |
|------|------|------|
| `app/services/note.py` | 重写 | Saga Try-Compensate |
| `tests/test_note_service.py` | 扩展 | 新增 6 个补偿测试 |

**Saga 策略**:

| 方法 | 新顺序 | 补偿逻辑 |
|------|--------|---------|
| `create()` | FS write → DB flush | DB 失败 → `fs.delete_note(id)` 补偿删除 |
| `update_content()` | 保存 old_hash/old_content → FS write → DB flush | DB 失败 → `fs.edit_note(id, old_content)` 恢复 + 恢复 old_hash |
| `delete()` | DB delete + tombstone(flush) → FS best-effort | FS 失败不回滚 DB(孤儿 .md 由一致性检查清理) |

**关键设计**:
- `create()` FS 先行:Note 无 content 字段(铁律 #2),content_hash 必须来自 FS
- `delete()` DB 先行:tombstone 是删除的 Source of Truth,防止 resurrection
- 全部方法只 `flush` 不 `commit`(铁律 #1),与 Phase C SAVEPOINT 兼容

**TDD 测试**:
- `test_create_compensates_fs_on_db_failure` — DB 失败时 .md 不残留
- `test_update_content_restores_old_hash_on_db_failure` — DB 失败时 hash 恢复
- `test_update_content_restores_fs_on_db_failure` — DB 失败时 FS 内容恢复
- `test_delete_db_first_then_fs` — DB delete + tombstone 先于 FS
- `test_delete_fs_failure_does_not_rollback_db` — FS 失败不回滚 DB
- 保留全部现有 8 个 note_service 测试(回归)

**验收标准**:
- [ ] create: DB 失败时 fs.delete_note 被调用,.md 不残留
- [ ] update_content: DB 失败时 content_hash 恢复 + FS 内容恢复
- [ ] delete: DB delete + tombstone 先于 FS;FS 失败不回滚 DB
- [ ] 全部方法只 flush 不 commit
- [ ] 与 Phase C `begin_nested()` SAVEPOINT 兼容

---

### P0-3: Git + .env.example + 清理临时文件

**涉及文件**:

| 文件 | 操作 |
|------|------|
| `.gitignore` | 新建/完善 — 排除 .venv, __pycache__, data/, *.db, .env |
| `.env.example` | 新建 — 全部 POMODOROXII_ 环境变量模板 |
| `README.md` | 更新 — 环境变量说明 + 迁移命令 |

**.env.example 关键内容**:
```env
POMODOROXII_SECRET_KEY=change-me-to-a-strong-key
POMODOROXII_MASTER_TOKEN_EXPIRE_DAYS=7
POMODOROXII_SPACE_TOKEN_EXPIRE_HOURS=8
POMODOROXII_DATABASE_URL=sqlite+aiosqlite:///./data/meta.db
POMODOROXII_SPACES_DATA_DIR=./data/spaces
POMODOROXII_ENGINE_POOL_MAX_SIZE=5
POMODOROXII_ENVIRONMENT=development
POMODOROXII_DEBUG=false
POMODOROXII_CORS_ORIGINS=http://localhost:5173,http://localhost:4173
```

**验收标准**:
- [ ] `git init` + 首次 commit
- [ ] `.env.example` 含全部环境变量
- [ ] `.gitignore` 排除 .venv/data/.env/__pycache__
- [ ] `git status` 干净

---

### C1: sync_safety.py(5 道安全检查)

**涉及文件**:

| 文件 | 操作 |
|------|------|
| `app/services/sync_safety.py` | 新建 — 5 个公共函数 + 辅助函数 |
| `tests/test_sync_safety.py` | 新建 — 12 个测试用例 |

**5 道安全检查**(从源 sync.py 提取为独立函数,不导入 FastAPI):

| 函数 | 源 sync.py 行号 | 作用 |
|------|----------------|------|
| `check_tombstone_first(db, etype, entity_id, action, data, now)` | 493-528 | 实体已删除则阻止;删除后重建(created_at > deleted_at)则清除 tombstone |
| `strip_client_fields(etype, data)` | 459-476 | 剔除 synced/_dirty/_etag/actual_pomodoros 等客户端专属字段 |
| `detect_zero_time(data, now)` | 445-457 | 检测零时间戳(00:00:00.000)并替换为 now |
| `check_folder_circular_ref(db, entity_id, parent_id)` | 561-585 | 复用 CascadeService.get_descendant_ids 检测循环引用 |
| `check_ttl_resurrection(data, ttl_cutoff)` | 634-646 | created_at < 90 天前 → 阻止(防 TTL 过期后复活) |

**辅助函数**: `normalize_timestamp`, `is_zero_time`, `serialize_entity_data`(从源 sync.py 第 111-223 行提取)

**验收标准**:
- [ ] 5 个函数 + 3 个辅助函数全部实现
- [ ] 不导入 FastAPI(铁律 #1)
- [ ] 12 个测试用例全绿

---

### C2: SyncService.push(06 缺陷 #1 修复)

**前置依赖**: 创建 3 个 junction table schema

**涉及文件**:

| 文件 | 操作 |
|------|------|
| `app/schemas/session_quick_note.py` | 新建 — SessionQuickNoteCreate/Update |
| `app/schemas/schedule_quick_note.py` | 新建 — ScheduleQuickNoteCreate/Update |
| `app/schemas/task_quick_note.py` | 新建 — TaskQuickNoteCreate/Update |
| `app/schemas/sync.py` | 新建 — SyncEvent + SyncPushRequest |
| `app/services/sync.py` | 新建 — SyncService + ENTITY_REGISTRY |
| `tests/test_sync_service.py` | 新建 |

**push 设计**:
- 逐事件 `async with db.begin_nested()`(SAVEPOINT 隔离)
- 事件内调用 sync_safety 5 道检查
- Note 实体走 `_apply_note_event` → NoteService(FS + DB 协调)
- 其他实体走 `_apply_event` → 直接 ORM 操作
- **不 commit**(由路由 commit,铁律 #1)
- 返回 `{applied, conflicts, errors, server_time}`

**ENTITY_REGISTRY**: 14 个可同步实体(不含 dimension/mental 系列、Tombstone、Setting、SyncOutbox、SyncAuditLog)

**验收标准**:
- [ ] SAVEPOINT 隔离:第 N 事件失败不影响前 N-1 事件
- [ ] Note 实体走 NoteService(FS + DB)
- [ ] push 返回后 db 未 commit(由路由 commit)
- [ ] 5 道安全检查在 push 中调用

---

### C3: SyncService.pull(06 缺陷 #3 修复:N+1 查询)

**涉及文件**: `app/services/sync.py`(扩展 pull 方法)

**pull 设计**:
- 遍历 ENTITY_REGISTRY,每实体 `select(model).where(updated_at > since).limit(limit+1)`
- Note 特殊: `fs.read_notes_batch(note_ids)` 批量读 .md 内容(1 次 ORM + 1 次批量读,消除 N+1)
- Task 特殊: 批量计算 `actual_pomodoros` 派生字段
- 返回 `{changes: {pull_key: [...]}, tombstones, server_time, has_more, next_since}`
- Tombstone 按 since 过滤 + TTL 清理

**验收标准**:
- [ ] pull 50 条 note → 1 次 ORM 查询 + 1 次 `read_notes_batch`(非 N 次)
- [ ] note 变更含 content 字段(来自 FS)
- [ ] task 变更含 actual_pomodoros
- [ ] 分页 has_more + next_since 正确

---

### C4: SyncService.full + status

**涉及文件**: `app/services/sync.py`(扩展)

- `full(since, limit)`: 全量快照(不按 since 过滤初始查询,tombstones 全量返回)
- `status()`: 遍历 ENTITY_REGISTRY 统计各实体 count + tombstone count

**验收标准**:
- [ ] full 返回全部数据 + 全量 tombstones
- [ ] status 返回各实体计数

---

### C5: NoteService Saga 与 SAVEPOINT 兼容性验证

**涉及文件**: `app/services/note.py`(P0-2 已重构) + `tests/test_sync_service.py`

验证 P0-2 的 Saga 方法在 SyncService.push 的 `begin_nested()` 内正确工作:
- create 失败 → SAVEPOINT 回滚 + FS 补偿删除
- update_content 失败 → SAVEPOINT 回滚 + FS 内容恢复
- delete 成功 → 随外层事务提交;后续事件失败 → 随外层回滚

**验收标准**:
- [ ] `test_note_create_in_savepoint_rollback`
- [ ] `test_note_update_in_savepoint_rollback`
- [ ] `test_note_delete_in_savepoint_rollback`

---

### C6: NoteService sync_mode 集成

**涉及文件**: `app/services/note.py`(扩展)

在 NoteService 添加 `sync_mode: bool = False` 参数:
- `sync_mode=True`(SyncService 调用): 执行 sync_safety 检查
- `sync_mode=False`(REST 路由调用,默认): 跳过检查

**验收标准**:
- [ ] sync_mode=True 时 create 被 tombstone 阻止
- [ ] sync_mode=False 时跳过检查

---

### C7: sync 路由(4 端点)

**涉及文件**:

| 文件 | 操作 |
|------|------|
| `app/routes/v1/sync.py` | 新建 — push/pull/full/status |
| `app/routes/v1/__init__.py` | 修改 — 注册 sync_router |
| `tests/test_routes_sync.py` | 新建 |

**4 个端点**(全部用 space token):
- `POST /api/v1/sync/push` — 接收 events,push 后 `await db.commit()`
- `GET /api/v1/sync/pull` — 增量拉取(since/include_deleted/limit)
- `GET /api/v1/sync/full` — 全量快照
- `GET /api/v1/sync/status` — 统计计数

**验收标准**:
- [ ] 4 端点全部用 space token(Master Token → 403)
- [ ] push 后数据持久化(commit 在路由)
- [ ] pull 返回 note 含 content

---

### C8: ENTITY_REGISTRY 完善

**涉及文件**: `app/services/sync.py`(验证)

确认 14 个实体注册正确,每个含 model + schema_create + schema_update + pull_key。

**验收标准**:
- [ ] `test_entity_registry_has_14_entries`
- [ ] `test_entity_registry_all_schemas_exist`

---

### C9: sync 审计(SyncAuditLog)

**涉及文件**: `app/services/sync.py`(扩展)

每个 applied 事件后写入 SyncAuditLog(event_type/entity_type/entity_id/details),只 flush 不 commit。

**验收标准**:
- [ ] `test_push_writes_audit_log` — applied 事件生成审计记录
- [ ] `test_push_failed_event_no_audit` — 失败事件不写审计

---

### C10: 集成测试

**涉及文件**: `tests/test_sync_service.py`(扩展) + `tests/test_routes_sync.py`(新建)

**集成测试矩阵**:

| 场景 | 测试用例 |
|------|---------|
| 双向同步 | `test_push_then_pull_roundtrip` |
| LWW 冲突 | `test_lww_server_wins` / `test_lww_client_wins` |
| Tombstone | `test_delete_then_pull_tombstone` / `test_tombstone_blocks_resurrection` |
| Note 双存储 | `test_push_note_then_pull_content` / `test_push_note_create_fs_db_consistent` |
| SAVEPOINT | `test_push_batch_partial_failure`(5 事件第 3 失败 → 1,2,4,5 applied) |
| 分页 | `test_pull_pagination` |
| 审计 | `test_push_audit_logged` |
| 路由认证 | `test_sync_requires_space_token` |
| 全量同步 | `test_full_sync_initial` |

---

## 06 缺陷修复对照

| 缺陷 | 修复位置 | 验证测试 |
|------|---------|---------|
| #1 Saga commit 击穿 SAVEPOINT | NoteService 只 flush;SyncService.push 用 begin_nested | `test_push_savepoint_isolates_events` |
| #2 sync adapter 丢失安全防线 | C1 sync_safety.py 5 道检查 + C6 NoteService sync_mode | `test_sync_safety_*` 系列 |
| #3 pull N+1 查询 | C3 fs.read_notes_batch() 批量读 | `test_pull_note_batch_read_not_n1` |
| #4 update_note old_hash 未回滚 | P0-2 update_content Saga 保存 old_hash + 恢复 | `test_update_content_restores_old_hash_on_db_failure` |
| #6 delete_note 不创建 Tombstone | P0-2 delete 先 DB delete + tombstone | `test_delete_creates_tombstone` |
| #7 content_hash 未加入 NoteUpdate | Phase B 已完成 | (已有测试) |
| #8 folder delete 缺少 BFS 级联 | Phase B CascadeService 已完成 | (已有测试) |

---

## 文件变更总览

### 新建文件(11 个)

| 文件路径 | 用途 |
|---------|------|
| `app/db/registry.py` | meta/space 表名注册表 |
| `app/services/sync_safety.py` | 5 道安全检查 |
| `app/services/sync.py` | SyncService(push/pull/full/status) |
| `app/schemas/sync.py` | SyncEvent + SyncPushRequest |
| `app/schemas/session_quick_note.py` | junction table schema |
| `app/schemas/schedule_quick_note.py` | junction table schema |
| `app/schemas/task_quick_note.py` | junction table schema |
| `app/routes/v1/sync.py` | sync 路由(4 端点) |
| `.env.example` | 环境变量模板 |
| `.gitignore` | Git 忽略规则 |
| `tests/test_sync_safety.py` | sync_safety 单元测试 |

### 修改文件(10 个)

| 文件路径 | 修改内容 |
|---------|---------|
| `alembic/env.py` | 双 target 策略 + include_object 过滤 |
| `alembic/versions/001_initial.py` | branch_labels=("meta",) |
| `alembic/versions/cab2ff7bcf37_phase_b_all_models.py` | down_revision=None + branch_labels=("space",) |
| `app/db/meta_session.py` | init_meta_db 只创建 2 表 |
| `app/space_manager.py` | _init_schema 只创建 18 表 |
| `app/services/note.py` | Saga Try-Compensate + sync_mode |
| `app/routes/v1/__init__.py` | 注册 sync_router |
| `tests/conftest.py` | 更新 space_session 注释 |
| `tests/test_alembic.py` | 拆分 meta/space 测试 |
| `tests/test_note_service.py` | 新增 Saga 补偿测试 |

### 扩展测试文件(3 个)

| 文件路径 | 新增内容 |
|---------|---------|
| `tests/test_sync_service.py` | SyncService push/pull/full/status 单元 + 集成测试 |
| `tests/test_routes_sync.py` | sync 路由集成测试 |
| `tests/test_note_service.py` | 6 个 Saga 补偿测试 |

---

## 假设与决策

1. **Alembic 双根迁移策略**: meta 分支(001)和 space 分支(cab2ff7bcf37)独立,运行时用 `create_all(tables=...)` 不依赖 alembic
2. **NoteService.create FS 先行**: content_hash 必须来自 FS,因此 FS 必须先于 DB;DB 失败时补偿删除 FS
3. **NoteService.delete DB 先行**: tombstone 是删除的 Source of Truth;FS 失败时 .md 孤儿由一致性检查(Phase E)清理
4. **sync_safety 在 SyncService.push 中调用**: 而非 NoteService 内部;NoteService 的 sync_mode 参数控制是否检查
5. **ENTITY_REGISTRY 14 实体**: 不含 dimension/mental 系列(目标项目无)、Tombstone/Setting/SyncOutbox/SyncAuditLog(不可同步)
6. **fs.read_notes_batch() 已存在**: note_ops.py 第 116-143 行,C3 直接复用
7. **fs.edit_note() 自带版本备份**: note_ops.py 第 233-241 行,Saga 补偿可利用
8. **CascadeService.get_descendant_ids() 已存在**: cascade.py 第 21-45 行,C1 的 check_folder_circular_ref 复用
9. **TDD 方法论**: 每个任务遵循 Red(失败测试) → Green(实现) → Refactor
10. **`深度交接Prompt.md` 未创建**: 本计划基于 v4 规划 + PhaseB/PhaseC 交接文档 + 源码分析制定

---

## 验证步骤

### P0 验证

```bash
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend

# P0-1: Alembic 分裂
uv run python -c "from app.db.registry import META_TABLE_NAMES; assert META_TABLE_NAMES == {'spaces', 'meta_settings'}"
uv run pytest tests/test_alembic.py -v

# P0-2: NoteService Saga
uv run pytest tests/test_note_service.py -v -k "compensate or restore or delete"

# P0-3: Git
git status  # 干净
ls .env.example  # 存在
```

### Phase C 验证

```bash
# C1: sync_safety
uv run pytest tests/test_sync_safety.py -v

# C2-C4: SyncService
uv run pytest tests/test_sync_service.py -v

# C7: sync 路由
uv run pytest tests/test_routes_sync.py -v

# 三层铁律
grep -r "\.commit()" app/services/  # 返回空
grep -r "from fastapi" app/services/  # 返回空
grep -r "\.commit()" app/routes/  # 有匹配
```

### 全量验证

```bash
# 全部测试(预期 244 + 新增 ~50 = ~294)
uv run pytest -v

# Lint
uv run ruff check app/ --fix
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
