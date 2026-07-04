# PomodoroXII Phase C 转接文档

> **状态（2026-07-04 更新）**: Phase C sync 安全项（C1/C2/C3/M1）已全部闭环实现并通过审计。
> 全量测试 **386 passed**（含 12 个 Phase C 补全测试）。代码层面无 P0 阻塞项。
>
> **已完成项**:
> - C1 墓碑防复活（create/update 均查 TombstoneService.exists）✅
> - C2 strip_client_fields（剥离 synced/_dirty/_etag/id/created_at/version + 实体专属字段）✅
> - C3 folder 环检测（create/update 均检测，含 self-parent）✅
> - M1 REST 删除墓碑（8 实体 entity_type 已设，BaseService._ensure_tombstone 统一）✅
> - sync push delete 墓碑（非 note 无条件写；note 由 sync 层补写）✅
> - Note sync_mode delete（NoteService 跳过墓碑，sync push delete 补写）✅
> - TombstoneService 并发（expunge 替代 rollback，SAVEPOINT 安全）✅
>
> **未完成项（后续迭代）**:
> - 4 个关联表实体（sessionQuickNote/scheduleQuickNote/taskQuickNote/memoComment）unlink 删除不写墓碑
> - YAML frontmatter 未实现（.md 文件非自描述）
> - 认证限流 / 安全响应头中间件
> - MCP Server / backup / snapshot / APScheduler
>
> **测试数**: 386 passed（test_phase_c_completion.py 新增 12 个回归测试）
>
> **注意**: `pomodoroxii-deep-review-report.md` 中 §2/§3.1 关于 CRITICAL 问题的段落已过时
> （所列 3 项 CRITICAL 均已在工作树修复）。请参考 `PhaseC审计报告.md` 和 `深度审查报告-独立复核版.md`。
>
> ---
>
> **用途**: 在新对话中将此文档作为 prompt 发给 agent,让其在目标项目中继续实施 Phase C。
> **前置**: Phase A + Phase B 已全部完成（2026-07-02 从 `PomodoroXII-rebuild` 合并入本仓库）。
> **目标**: 实施 Phase C — Sync 引擎 + 双存储桥接（含 06 文档 8 缺陷修正）。

---

## 你好,新 Agent

你正在接手 PomodoroXII 重构项目的 **Phase C** 实施。Phase B 已在 `E:\Development\MyAwesomeApp\PomodoroXII\backend` 完成并通过 **244** 个测试。

### 项目概述

PomodoroXII 是一个番茄钟应用,正从 Vue 3 + FastAPI 完全重写为 React 19 + Next.js 15 + FastAPI。项目采用多空间架构(共享 FastAPI + 每空间独立 SQLite)。

### 三条路径(请务必先读取)

| 路径 | 用途 |
|------|------|
| `E:\Development\MyAwesomeApp\PomodoroXII` | **目标项目（canonical，你在此工作）** |
| `e:\Development\MyAwesomeApp\pomodoroxi` | **源项目**(参考代码 + 13 核心文档) |
| `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild` | **已归档**（2026-07-02 已合并入目标项目，勿再在此开发） |
| `E:\Notes\测试-demo\video-collector\Video_thrans_workflow\scripts\file_system` | file_system 源码(已移植完成,不再需要) |

### 必读文档(按优先级)

1. **v4 总规划**: `E:\Development\MyAwesomeApp\PomodoroXII\documents\PomodoroXII重构项目深度开发规划v4.md` — 完整 8 阶段规划,你的任务是 Phase C
2. **01 深度架构规划**: `e:\Development\MyAwesomeApp\pomodoroxi\核心文档(New)\01-深度架构规划.md` — 三层铁律、Service 设计
3. **13 多空间架构**: `e:\Development\MyAwesomeApp\pomodoroxi\核心文档(New)\13-单用户多空间架构设计.md` — 双 JWT、SpaceEngineManager
4. **06 缺陷修正**: `e:\Development\MyAwesomeApp\pomodoroxi\核心文档(New)\06-实施计划评审与缺陷修正.md` — 8 个已确认缺陷

### Phase A + B 完成状态(你的起点)

```
PomodoroXII/backend/
├── pyproject.toml                    # 依赖已配置 (Python>=3.12, FastAPI, SQLAlchemy, PyJWT, bcrypt, alembic 等)
├── alembic.ini                       # Alembic 配置
├── Dockerfile                        # 多阶段构建 (uv + 非 root)
├── .dockerignore
├── alembic/
│   ├── env.py                        # 异步 + Programmatic API
│   ├── script.py.mako
│   └── versions/
│       └── 001_initial.py            # baseline: spaces + meta_settings
├── app/
│   ├── __init__.py
│   ├── main.py                       # ✅ create_app() + 异常处理器 + RequestIdMiddleware + setup_logging
│   ├── settings.py                   # ✅ Settings (secret_key production 校验已修正)
│   ├── deps.py                       # ✅ get_current_user + require_master_token + get_space_context + get_space_db + get_file_system
│   ├── errors.py                     # ✅ AppError + 5 子类 + register_exception_handlers
│   ├── logging.py                    # ✅ JsonFormatter + request_id_var + setup_logging
│   ├── middleware.py                 # ✅ RequestIdMiddleware (uuid import 已修正)
│   ├── space_manager.py              # ✅ SpaceEngineManager (LRU + asyncio.Lock + double-check)
│   ├── auth/
│   │   ├── __init__.py
│   │   └── security.py              # ✅ hash_password + verify_password + create_master_token + create_space_token + decode_access_token
│   ├── db/
│   │   ├── __init__.py
│   │   ├── base.py                  # ✅ Base(DeclarativeBase) + NAMING_CONVENTION
│   │   ├── session.py               # ✅ create_engine + create_session_factory + get_db (deprecated)
│   │   ├── meta_session.py          # ✅ init_meta_db + close_meta_db
│   │   └── models/
│   │       ├── __init__.py          # (仅导入 meta)
│   │       └── meta.py             # ✅ Space + MetaSetting
│   ├── file_system/                  # ✅ 15 文件已移植 + 5 耦合已修正
│   │   ├── __init__.py
│   │   ├── api.py                   # ✅ get_file_system factory + serialize()
│   │   ├── backup.py                # ✅ BackupService
│   │   ├── interfaces.py            # ✅ ABC + StrEnum
│   │   ├── models.py               # ✅ Pydantic DTO
│   │   ├── schema.py               # ✅ ORM (独立 Base) + init_database + FTS5
│   │   └── engine/
│   │       ├── __init__.py
│   │       ├── base.py             # ✅ StorageBase (RLock + FileLock + sqlite3 + _atomic_write)
│   │       ├── consistency_ops.py
│   │       ├── export_ops.py
│   │       ├── folder_ops.py
│   │       ├── note_ops.py         # ✅ 9 方法 + read_notes_batch (新增)
│   │       ├── search_ops.py       # ✅ FTS5 trigram + LIKE 回退
│   │       ├── trash_ops.py
│   │       └── version_ops.py
│   ├── models/                       # ✅ 18 业务 + 同步审计模型
│   ├── schemas/                      # ✅ Pydantic Create/Update/Response
│   ├── services/                     # ✅ BaseService + 实体 Service + Cascade + Tombstone
│   ├── routes/v1/                    # ✅ auth + spaces + 12 业务路由
│   └── mcp/                          # ⬜ 空 (Phase E)
│       └── __init__.py
└── tests/                            # ✅ 244 tests 全部通过
```

**当前 244 个测试全部通过**（含 Phase A 加固 + Phase B 模型/Service/路由/集成测试）。

> **合并说明（2026-07-02）**: 自 `pomodoroxi\PomodoroXII-rebuild\backend` 整体迁入。`temp/` 为过期草稿，请勿使用。

### 关键架构约束(铁律,违反即拒绝)

1. **Routers commit / Services flush / Models 纯数据**
   - `app/routes/*.py` 中调用 `await db.commit()`
   - `app/services/*.py` 中只调用 `await db.flush()`,绝不 `commit()`
   - `app/models/*.py` 中只有字段定义和约束,无业务方法
   - `app/services/*.py` 中不导入 `fastapi`(不依赖 HTTP 上下文)

2. **Note 模型无 content 字段(D4 决策)**
   - .md 文件是唯一 Source of Truth
   - Note ORM 保留 `content_hash` + `word_count`,不保留 `content`
   - NoteUpdate schema 含 `Optional[content_hash]`(06 缺陷 #7)

3. **双 JWT 认证(D6 决策)**
   - Master Token (7天): 空间管理路由(auth setup/login + spaces CRUD),不含 space_id
   - Space Token (8小时): 业务路由,含 space_id
   - 业务路由用 `Depends(get_space_db)`,空间管理路由用 `Depends(require_master_token)` + `Depends(get_meta_db)`

4. **双 Base 隔离(D14 决策)**
   - `app.db.base.Base` — 应用 ORM 模型(Phase B 创建的 16+2 表)
   - `app.file_system.schema.Base` — file_system 独立 ORM(已就位)
   - 两者 MetaData 完全独立,不交叉

5. **写文件范围**: 目标项目在 `E:\Development\MyAwesomeApp\PomodoroXII` 内,可以直接用 Write/SearchReplace 工具写入。

---

## 后续工作（Phase B 已完成）

> **Phase B 任务清单、门控标准、工作流程已过时（2026-07-02 合并完成）。**  
> 请使用 **`documents/深度交接Prompt.md`** — 内含 P0 优先修复任务 + Phase C 实施计划 + 可直接复制给新 Agent 的完整 Prompt。

**快速入口**:
1. 打开 `documents/深度交接Prompt.md`
2. 复制「--- PROMPT 开始 ---」到「--- PROMPT 结束 ---」整段
3. 粘贴给新对话中的 Agent

**当前优先修复（开 Phase C 前）**:
- **P0-1**: Alembic meta/space DB schema 策略分裂
- **P0-2**: NoteService Saga 写序重构
- **P0-3**: Git / 清理 temp / `.env.example`
