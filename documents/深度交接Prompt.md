# PomodoroXII 深度交接 Prompt

> **用法**: 在新对话中将下方「--- PROMPT 开始 ---」到「--- PROMPT 结束 ---」整段复制给 Agent。  
> **生成时间**: 2026-07-02（Phase B 合并后深度审查版）  
> **当前阶段**: Phase B ~90% → 优先修复 → Phase C Sync 引擎

---

## --- PROMPT 开始 ---

你好，你正在接手 **PomodoroXII** 重构项目。

### 你的使命（按顺序，不可跳步）

1. **P0 优先修复**（开 Phase C 前的阻塞项）— 见下文「优先修复任务」
2. **Phase C 实施** — Sync 引擎 + 双存储桥接（含 06 文档缺陷修正）
3. **Phase B 收尾**（非阻塞，可并行）— search / memo_comment / relation 路由

**禁止**: 在 `pomodoroxi\PomodoroXII-rebuild` 或 `temp/` 目录开发（已归档/过期）。

---

### 项目概述

PomodoroXII 是番茄钟应用，正从 **Vue 3 + FastAPI** 重写为 **React 19 + Next.js 15 + FastAPI**。

- **多空间架构**: 共享 FastAPI + 每空间独立 SQLite + 独立 notes 目录
- **双 JWT**: Master Token（7 天，meta 层）/ Space Token（8 小时，含 `space_id`）
- **双 Base**: `app.db.base.Base`（业务 ORM）与 `app.file_system.schema.Base`（FS 索引）完全隔离
- **Note content**: `.md` 文件为 SoT；DB 只存 `content_hash` + `word_count`

---

### 路径表（canonical）

| 路径 | 用途 |
|------|------|
| `E:\Development\MyAwesomeApp\PomodoroXII` | **唯一工作目录（你在此开发）** |
| `E:\Development\MyAwesomeApp\PomodoroXII\backend` | FastAPI 后端 |
| `E:\Development\MyAwesomeApp\PomodoroXII\documents\` | 规划与交接文档 |
| `e:\Development\MyAwesomeApp\pomodoroxi` | **源项目**（参考代码 + 13 核心文档） |
| `e:\Development\MyAwesomeApp\pomodoroxi\backend\app\routes\sync.py` | **Phase C 移植来源**（~1047 行） |
| `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild` | **已归档**（2026-07-02 已合并，勿再改） |
| `E:\Development\MyAwesomeApp\PomodoroXII\temp\` | **过期草稿，勿用** |

### 必读文档（按优先级）

1. `documents/PomodoroXII重构项目深度开发规划v4.md` — 8 阶段总规划
2. `documents/深度交接Prompt.md` — 本文件（含优先修复清单）
3. `e:\Development\MyAwesomeApp\pomodoroxi\核心文档(New)\06-实施计划评审与缺陷修正.md` — 8 个已确认缺陷
4. `e:\Development\MyAwesomeApp\pomodoroxi\核心文档(New)\13-单用户多空间架构设计.md` — 双 JWT、引擎池
5. `e:\Development\MyAwesomeApp\pomodoroxi\核心文档(New)\01-深度架构规划.md` — 三层铁律

---

### 当前状态快照（2026-07-02 验证）

| 指标 | 值 |
|------|-----|
| pytest | **244/244 通过** |
| ORM 业务模型 | 18 + 2 meta |
| v1 HTTP 操作 | 60（OpenAPI 统计） |
| 专用 Service 模块 | 9（另有 8 个内联在 route 文件） |
| Alembic revisions | 2（`001_initial` + `cab2ff7bcf37_phase_b_all_models`） |
| file_system | 15 文件，38 测试 |
| 前端 | **不存在** |
| Git | **未初始化** |

**已完成**: Phase A 全部 + Phase B 主体（models/schemas/services/routes/集成测试）

**未开始**: Phase C Sync、Phase F 前端、Phase G/H 部署

---

### 架构铁律（违反即拒绝合并）

1. **Routers commit / Services flush / Models 纯数据**
   - `app/routes/*.py` → `await db.commit()`
   - `app/services/*.py` → 只 `flush()`，**绝不 commit**
   - `app/models/*.py` → 仅字段与约束
   - `app/services/*.py` → **不 import fastapi**（MCP 预留）

2. **Note 无 content 字段** — Create 可收 content 写 .md；Update/Response 用 content_hash

3. **双 JWT** — 业务路由 `Depends(get_space_db)` + space token；空间管理 `require_master_token` + meta db

4. **时间戳** — 统一 `utc_now_iso()`，Z 后缀秒精度（`app/services/time.py`）

5. **TDD** — 先写失败测试，再实现；每步保持全绿

---

## ★ 优先修复任务（开 Phase C 前必须完成）

按 **P0 → P1 → P2** 顺序执行。每项含：问题、文件、验收标准。

---

### P0-1: Alembic Meta DB / Space DB schema 策略分裂 【阻塞 Phase C】

**问题**:
- 设计: `meta.db` 仅 `spaces` + `meta_settings`（2 表）；18 业务表在各 `space.db`
- 实际: `alembic/env.py` 导入全部 `app.models.*`，`alembic upgrade head` 会在 **meta.db 建 20 表**
- 运行时: `init_meta_db()` 只 import meta 模型 → meta.db 仅 2 表；`SpaceEngineManager._init_schema()` 用 `Base.metadata.create_all` → space.db 全表
- **风险**: 生产 `alembic upgrade` 污染 meta.db；dev/prod schema 来源不一致

**涉及文件**:
- `backend/alembic/env.py`
- `backend/alembic/versions/001_initial.py`
- `backend/alembic/versions/cab2ff7bcf37_phase_b_all_models.py`
- `backend/tests/test_alembic.py`
- `backend/app/db/meta_session.py`
- `backend/app/space_manager.py`

**修复方向（二选一，推荐 A）**:

**方案 A — 拆分 Alembic target（推荐）**:
- `env.py` 默认仅 meta 模型 → meta 迁移只管 2 表
- 新增 space 迁移链（或 space 继续 `create_all` + 版本戳表），业务表不进 meta.db
- 更新 `test_alembic.py`：meta 测 2 表，space 测 18 表

**方案 B — 文档化 + 约束**:
- 明确 `alembic upgrade` 仅用于空库 bootstrap，生产靠 `create_all`
- 加启动检查防止 meta.db 出现业务表

**验收**:
- [ ] `init_meta_db()` 后 meta.db 只有 2 表
- [ ] 新建 space 后 space.db 有 18 业务表（+ 无 meta 表渗入）
- [ ] `alembic upgrade head` 行为与上述一致且有测试覆盖
- [ ] 244 既有测试仍全绿（或更新后全绿）

---

### P0-2: NoteService 写序改为 Saga Try-Compensate 【阻塞 Phase C】

**问题**:
- v4 Phase C5 要求: **DB flush → FS write → 失败 rollback + FS 补偿**
- 当前 `NoteService.create`: **先 `fs.create_note`，再 `super().create`（DB）**
- 后果: DB 失败产生孤儿 .md；Sync push SAVEPOINT 无法对齐（06 缺陷 #1）

**涉及文件**:
- `backend/app/services/note.py`（核心）
- `backend/tests/test_note_service.py`
- `backend/tests/test_integration.py`（`test_note_saga_end_to_end_consistency`）
- 新增 `backend/tests/test_note_saga_compensation.py`

**目标写序**:

| 操作 | 正确顺序 | 失败补偿 |
|------|----------|----------|
| create | DB flush（占位行/元数据）→ FS write | FS 失败 → rollback DB；DB 已 flush 后 FS 失败 → 删 .md |
| update_content | 保存 old_hash → FS write → DB flush | FS 失败恢复 old_hash（06 #4） |
| delete | 软删/Tombstone + FS 删 | 幂等 |

**验收**:
- [ ] `NoteService` 仍只 flush 不 commit
- [ ] mock `fs.create_note` 抛异常 → DB 无残留行
- [ ] mock DB flush 后 FS 失败 → 无孤儿 .md（或补偿删除）
- [ ] 既有 note 集成测试全绿
- [ ] 新增 compensation 专项测试 ≥ 3 个

---

### P0-3: 初始化 Git + 清理过期资产 【工程阻塞】

**问题**: 无版本控制；`temp/` 59 文件易误用；`PhaseC转接文档.md` 下半部仍是过时 Phase B 清单

**任务**:
1. `git init`（若用户同意 commit，再做 baseline）
2. 删除或移走 `temp/`（或写 `temp/README.md` 标明「已废弃，2026-07-02」）
3. 修剪 `documents/PhaseC转接文档.md`：删除第 123 行起过时 Phase B 任务清单，改为指向本文件
4. 新增 `backend/.env.example`（`POMODOROXII_SECRET_KEY`、`DATABASE_URL`、`SPACES_DATA_DIR`、`CORS_ORIGINS`）

**验收**:
- [ ] `.env.example` 存在且字段与 `settings.py` 一致
- [ ] 无 agent 再引用 `temp/` 或 `PomodoroXII-rebuild` 作为工作目录

---

## Phase C 实施任务（P0 完成后）

参考 v4 §C1–C10 与源项目 `pomodoroxi/backend/app/routes/sync.py`。

### C1: `app/services/sync_safety.py`（06 #2）

5 个公共函数（从源 sync.py 提取）:
- `check_tombstone_first`
- `strip_client_fields`
- `detect_zero_time`
- `check_folder_circular_ref`
- `check_ttl_resurrection`

**测试**: `tests/test_sync_safety.py`（每函数 ≥ 1 用例）

### C2: `app/services/sync.py` — SyncService（06 #1）

- `push`: 每事件 `async with db.begin_nested()`（SAVEPOINT），循环外 `db.commit()`
- `ENTITY_REGISTRY`: 14 实体注册表
- **关键**: 调用 NoteService 时只 flush 不 commit

**测试**: 10 事件第 3 个失败 → 前 2 个回滚

### C3: SyncService.pull（06 #3）

- `select(Note)` 含 content_hash
- `fs.read_notes_batch()` 批量读
- pull 50 条 → **1 次 ORM + 1 次 FS batch**

### C4: SyncService.full + status

全量快照 + 待同步计数

### C5–C6: sync 路由 + 审计

- `app/routes/v1/sync.py` — push/pull/full/status
- 注册到 `app/routes/v1/__init__.py`
- 测试走 **API client + auth_headers**，不直接操作 DB（06 #5）

### C 阶段门控

- [ ] 10 事件第 3 失败 → 前 2 回滚
- [ ] pull 50 notes = 1 ORM + 1 batch FS
- [ ] mock FS 异常 → DB 回滚 / hash 恢复
- [ ] 墓碑防 sync 复活
- [ ] services 无 fastapi import（已有 gate 测试）
- [ ] 全量 pytest 通过

---

## Phase B 收尾（非阻塞，可并行）

| ID | 任务 | 文件 | 优先级 |
|----|------|------|--------|
| B-1 | 搜索 API | `routes/v1/search.py` | P2（或 defer Phase D） |
| B-2 | MemoComment CRUD | `routes/v1/memo_comments.py` | P2 |
| B-3 | Relation link/unlink API | `routes/v1/relations.py` 或嵌套路由 | P2 |
| B-4 | CORS 加 `localhost:3000` | `app/settings.py` | P2 |
| B-5 | 8 个内联 Service 抽到 `app/services/` | 各 route 文件 | P3 |

**已有但未暴露 HTTP**:
- `app/services/relation.py` — 已实现
- `app/schemas/memo_comment.py` — 已有 schema

---

## 关键文件地图

```
backend/
├── app/
│   ├── main.py              # create_app + build_v1_router
│   ├── deps.py              # JWT + get_space_db + get_file_system ✅
│   ├── space_manager.py     # LRU 引擎池 + create_all
│   ├── db/meta_session.py   # meta.db 仅 2 表初始化
│   ├── models/              # 18 业务模型 + SyncMixin.version
│   ├── schemas/             # 14 模块
│   ├── services/
│   │   ├── base.py          # CRUD, flush only
│   │   ├── note.py          # ⚠️ P0-2 Saga 重构目标
│   │   ├── cascade.py       # BFS 级联
│   │   ├── tombstone.py
│   │   ├── relation.py      # 无路由
│   │   └── time.py          # utc_now_iso
│   ├── routes/v1/           # 14 路由模块, 60 ops
│   └── file_system/         # 15 文件, 独立 Base
├── alembic/                 # ⚠️ P0-1 修复目标
├── tests/                   # 244 tests
│   ├── conftest.py          # _isolate_env + reload 链
│   └── test_integration.py  # 架构 gate
└── pyproject.toml           # Python >=3.13
```

---

## 开发与测试命令

```bash
cd E:\Development\MyAwesomeApp\PomodoroXII\backend

# 安装依赖（注意：不是 --dev，是 --extra dev）
uv sync --extra dev

# 全量测试
uv run pytest -q

# 单文件
uv run pytest tests/test_note_service.py -v

# 启动 API
uv run uvicorn app.main:app --reload
```

**conftest 陷阱（Phase B 已踩过）**:
- 测试函数内 import 模型/服务，**禁止模块顶层** `from app.models.x import X`（reload 后类引用陈旧）
- `_isolate_env` 会 reload settings 链；扩展时保持依赖顺序

---

## 已知设计与文档偏差（接受或显式决策）

| 项 | 文档说法 | 实际实现 | 建议 |
|----|----------|----------|------|
| 密码存储 | `Space.password_hash` | `MetaSetting(key="admin_password")` | 保持现状，更新文档 |
| auth setup | 创建空间 + 双 token | 仅设密码 | 可选增强，非 P0 |
| auth switch | `POST /auth/switch` | `POST /spaces/{id}/token` | 保持现状 |
| login 响应字段 | `master_token` | `access_token` | 保持现状或加别名 |
| FS index 路径 | `.meta/index.db` | `{space_id}/index.db` | Phase D 统一 |

---

## 06 文档缺陷 ↔ Phase C 映射

| # | 缺陷 | Phase C 任务 | 验证方式 |
|---|------|-------------|----------|
| 1 | Saga commit 击穿 SAVEPOINT | C2/C5 + P0-2 | 10 事件第 3 失败回滚 |
| 2 | sync adapter 丢安全防线 | C1 sync_safety | grep adapter 调 5 函数 |
| 3 | pull N+1 | C3 batch read | 50 条 = 1 ORM + 1 FS |
| 4 | update old_hash 未回滚 | P0-2 NoteService | mock FS 异常 |
| 5 | 测试 fixture 不存在 | C 测试用 client | 无直接 DB 操作 |
| 6 | delete 不建 Tombstone | 已实现 | 删除后 tombstone 存在 |
| 8 | folder BFS 级联 | 已实现 CascadeService | 集成测试已有 |

---

## 你的第一步行动清单

接到本 prompt 后，请按此顺序执行并汇报：

1. `cd backend && uv sync --extra dev && pytest -q` — 确认 244 绿
2. 阅读 `alembic/env.py`、`meta_session.py`、`space_manager.py` — 理解 P0-1
3. 阅读 `services/note.py` — 理解 P0-2
4. **实施 P0-1**（TDD：先改/加 alembic 测试，再改 env.py）
5. **实施 P0-2**（TDD：先加 compensation 测试，再改 NoteService）
6. **实施 P0-3**（.env.example + 文档修剪；git init 需询问用户）
7. 汇报 P0 完成后，开始 C1 `sync_safety.py`

**不要**在未完成 P0-1、P0-2 前开始 SyncService 实现。

--- PROMPT 结束 ---
