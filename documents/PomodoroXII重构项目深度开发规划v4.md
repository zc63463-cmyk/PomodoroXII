# PomodoroXII 重构项目深度开发规划 v4

> 基于 v3 的 8 阶段框架,经逐文件审查验证全部 6 个缺陷(F1-F6),融入 Alembic Programmatic API、双 Base 隔离、Saga Try-Compensate、Dexie Proxy 嵌套转发、Docker 多阶段构建等 2025-2026 最佳实践。采用 doc-coauthoring 工作流编写。

## 摘要

本项目将 PomodoroXII 从 Vue 3 + FastAPI 完全重写为 React 19 + Next.js 15 + FastAPI,包含多空间架构(共享 FastAPI + 每空间独立 SQLite)、file_system 子系统移植(15 文件 + 5 耦合修正)、双 JWT 认证、Saga 跨库事务、Sync 引擎(含 06 文档 8 缺陷修正)。

当前 **Phase A + Phase B 已完成**：244 个测试全部通过（2026-07-02 自 `PomodoroXII-rebuild` 合并）。下一步为 Phase C（Sync 引擎）。本计划定义 8 个阶段(A-H)。

**三条路径**:
- 目标项目（canonical）:`E:\Development\MyAwesomeApp\PomodoroXII`
- 源项目(参考):`e:\Development\MyAwesomeApp\pomodoroxi`(Vue 3 + FastAPI 完整代码库 + 13 核心文档)
- 已归档副本:`e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild`（已合并，勿再开发）
- file_system 源码(移植):`E:\Notes\测试-demo\video-collector\Video_thrans_workflow\scripts\file_system`(15 文件，已移植)

---

## 当前状态分析（2026-07-02 快照）

### 已验证的实现状态

| 模块 | 状态 | 验证结果 |
|------|------|---------|
| Phase A 基础设施 | ✅ 完成 | main/settings/middleware/deps/file_system/Alembic/Docker 全部就位；F1–F6 已修 |
| Phase B 业务层 | ✅ 完成 | 18 models + 14 schemas + 9 services + 14 v1 路由 |
| 认证 | ✅ 完成 | 密码存 `MetaSetting(admin_password)`；双 JWT master/space |
| Alembic | ✅ 完成 | `001_initial` + `cab2ff7bcf37_phase_b_all_models` |
| 测试 | ✅ 244/244 | `cd backend && pytest` |

### 测试现状

| 类别 | 测试数 | 覆盖内容 |
|------|--------|---------|
| Phase A 加固 | ~70 | auth/errors/settings/middleware/logging/main/db |
| Phase B 模型/Schema | ~24 | ORM + Pydantic |
| Phase B Service | ~44 | Base/Cascade/Tombstone/Task/Note/Stats/Relation |
| Phase B 路由 | ~58 | auth/spaces + 12 业务 REST |
| 集成 + 门禁 | 5 | 生命周期、Note Saga、级联删除、架构 gate |
| file_system | ~38 | note/folder/search/trash/schema |
| 基础设施 | 11 | meta_db/space_manager/deps |
| **合计** | **244** | 全部通过 |

### 历史缺陷（已修复）

| 缺陷 | 原问题 | 当前状态 |
|------|--------|---------|
| F1 | secret_key 校验恒真 | ✅ 生产环境强校验 |
| F2–F4 | main.py 未接线 | ✅ 异常处理/中间件/日志已接入 |
| F5 | middleware uuid 导入顺序 | ✅ 已修 |
| F6 | get_file_system 返回 Path | ✅ 使用 `app.file_system.api` 工厂 |

### 已验证的 file_system 源码耦合点（均已修正）

| 耦合点 | 源文件 | 行号 | 当前代码 | 修正方式 |
|--------|--------|------|---------|---------|
| 1. 导入路径 | `__init__.py` | 7 | `from file_system.interfaces import (...)` | → `from app.file_system.interfaces import (...)` |
| 1. 导入路径 | `__init__.py` | 16 | `from file_system.schema import (...)` | → `from app.file_system.schema import (...)` |
| 1. 导入路径 | `api.py` | 9 | `from file_system.engine import FileSystemStorage` | → `from app.file_system.engine import FileSystemStorage` |
| 1. 导入路径 | `api.py` | 10 | `from file_system.interfaces import FileSystem` | → `from app.file_system.interfaces import FileSystem` |
| 1. 导入路径 | `engine/note_ops.py` | 15 | `from file_system.interfaces import NoteMeta, NoteStatus, NoteLevel` | → `from app.file_system.interfaces import ...` |
| 2. 死导入 | `schema.py` | 9 | `import urllib.parse` | 删除(未使用) |
| 3. logger 依赖 | `backup.py` | 13 | `from logger_config import get_logger` | → `import logging; logger = logging.getLogger(__name__)` |
| 4. 路径推导 | `api.py` | 18 | `_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent` | → 从 `settings.data_dir` 获取 |
| 5. 缺失方法 | `engine/note_ops.py` | — | 无 `read_notes_batch` 方法 | 新增批量读取方法 |

### 测试现状（历史快照，已由上方 244 测试替代）

| 测试文件 | 测试数 | 覆盖内容 |
|---------|--------|---------|
| `test_meta_db.py` | 4 | Space 创建/默认值/MetaSetting/init 幂等 |
| `test_space_manager.py` | 4 | 引擎池基本/LRU/dispose/session |
| `test_deps.py` | 3 | health 端点/space_token 创建/master_token 无 space_id |
| **Phase A 小计** | **11** | 已扩展为 244 测试全绿 |

---

## 架构决策表

| # | 决策项 | 选择 | 依据 |
|---|--------|------|------|
| D1 | 多空间隔离模式 | 共享 FastAPI + 每空间独立 SQLite | 13 文档 |
| D2 | 多空间插入时机 | Phase A 地基层织入 | 整合决策 |
| D3 | 三层铁律 | Routers commit / Services flush / Models 纯数据 | 01 文档 |
| D4 | content 所有权 | .md 文件为唯一 SoT,Note 模型无 content 字段,保留 content_hash + word_count | 05 文档 |
| D5 | 跨库事务 | Saga Try-Compensate + 补偿操作 + 定期一致性修复 | 05 文档 + 研究验证 |
| D6 | 认证体系 | 双 JWT:Master Token(7天) + Space Token(8小时,含 space_id) | 13 文档 |
| D7 | 引擎池 | SpaceEngineManager:LRU(max=5) + asyncio.Lock | 13 文档 |
| D8 | 前端 DB 切换 | Dexie Proxy:JavaScript Proxy 动态转发 + 嵌套 Table Proxy | 13 文档 + 研究验证 |
| D9 | 前端框架 | React 19 + Next.js 15(App Router + Turbopack) | 02 文档 |
| D10 | 前端状态 | Zustand 5(客户端) + TanStack Query v6(服务端) | 02 文档 |
| D11 | 组合式模式 | Compound Components + variant + Provider + no forwardRef | composition-patterns Skill |
| D12 | 密码库 | PyJWT 2.10+ + bcrypt 4.2+(无 passlib) | 02 文档 |
| D13 | DB 迁移 | Alembic async + Programmatic API(connection sharing) | 研究验证 |
| D14 | file_system DB | 双 Base 隔离(FSBase 与 app Base 完全独立) | 研究验证 |
| D15 | Docker | 多阶段构建 + uv 官方镜像 + 非 root UID 1000 + gosu | 研究验证 |

---

## 统一编排:8 个阶段

```
Phase A  补全与加固:file_system 移植 + Alembic + main.py 修正 + Docker 骨架
    │     三条轨道:
    │     ├── 轨道1: A3-fix(修正 secret_key) + A8-fix(修正 main.py) + A9(Alembic)
    │     ├── 轨道2: A10-A17(15 文件移植 + 5 耦合修正 + 批量读取)
    │     └── 轨道3: A19-fix(middleware uuid) + A20(Docker) + A21(get_file_system)
    │
    ▼
Phase B  双 JWT 认证完善 + 全业务模型/Service/REST 路由
    │     ├── auth.py + spaces.py 路由
    │     ├── 16+2 表 ORM 模型(Note 无 content)
    │     ├── Pydantic schemas + Alembic 迁移
    │     ├── BaseService + 全实体 Service + CascadeService
    │     └── 12 个 REST 路由
    │
    ├──▶ Phase C  Sync 引擎 + 双存储桥接(含 06 缺陷修正)
    │         ├── sync_safety.py(5 道安全检查)
    │         ├── SyncService(push SAVEPOINT + pull 批量)
    │         ├── NoteService(Saga Try-Compensate)
    │         └── 06 缺陷 8 个全修正
    │              │
    │              ▼
    │        Phase D  Notes/Search/Trash API + file_system 全集成
    │              ├── Notes CRUD + content 分离
    │              ├── FTS5 搜索 + 回收站 + 版本历史
    │              └── file_system 空间化
    │                   │
    │                   ▼
    │             Phase E  可靠性 + Agent + Export
    │                  ├── backup + snapshot + consistency
    │                  └── MCP Server
    │
    └──▶ Phase F  React 19 前端重建(组合式模式 + 多空间 UI)
              ├── 骨架 + 框架无关迁移 + Dexie Proxy
              ├── 逐 View 迁移(composables → hooks)
              └── PWA + React Compiler + Vue 残留清理
                   │
                   ▼
             Phase G  数据迁移 + 端到端集成测试
                   │
                   ▼
              Phase H  部署 + Docker Compose + CI/CD
```

**关键路径**: A → B → C → D → E → G → H
**非关键路径**: B → F → G(前端,B 完成后与 C/D/E 并行)

---

## 风险登记册

| # | 风险 | 严重度 | 概率 | 缓解措施 | 归属阶段 |
|---|------|--------|------|---------|---------|
| R1 | content 双重所有权 | 高 | 确定 | 方案 A:Phase B 模型定义即移除 Note.content | B,C |
| R2 | 跨库事务原子性 | 高 | 确定 | Saga Try-Compensate + flush 不 commit + 补偿操作 | C |
| R3 | Saga commit 击穿 SAVEPOINT | 高 | 06 确认 | NoteService 只 flush() 不 commit(),sync_push 外层统一 commit | C |
| R4 | sync adapter 丢失安全防线 | 高 | 06 确认 | sync_safety.py 5 函数共用,adapter 强制调用 | C |
| R5 | pull N+1 查询 | 中 | 06 确认 | content_hash ORM 一并取出 + read_notes_batch 批量读 | C |
| R6 | 引擎池并发冲突 | 中 | 低 | asyncio.Lock + double-check pattern(已验证) | A |
| R7 | 空间切换数据残留 | 中 | 中 | Dexie Proxy + space-switched 事件 + TanStack Query invalidate | F |
| R8 | Dexie 配额不足 | 中 | 低 | navigator.storage.persist() | F |
| R9 | 迁移失败数据丢失 | 高 | 低 | 备份 + 事务 + 幂等检测(检测 meta.db 存在则跳过) | G |
| R10 | file_system Windows 中文路径 | 中 | 确定 | 原生 `sqlite3.connect(str(db_path))`,不通过 SQLAlchemy URL | A |
| R11 | 前端框架迁移质量 | 中 | 中 | 30% 框架无关复用 + Compound 重写 | F |
| R12 | 双 JWT Token 过期处理 | 中 | 中 | Axios 401 拦截器自动刷新 | B,F |
| R13 | secret_key 未校验即启动 | 高 | 已发生 | A3-fix:production 环境缺失即 raise | A |
| R14 | exception handler 未注册 | 高 | 已发生 | A8-fix:create_app 中调用 register_exception_handlers | A |

---

## 提议变更:Phase A 详细规划

### 轨道 1:修正 + Alembic

#### A3-fix:修正 secret_key 校验(F1/R13)

**文件**: `backend/app/settings.py`(第 57-69 行)

**当前代码(有缺陷)**:
```python
@field_validator("secret_key")
@classmethod
def validate_secret_key(cls, v: str) -> str:
    if not v or v == "change-me":
        if True:  # 恒真,仅 warn
            import warnings
            warnings.warn(...)
    return v
```

**修正后代码**:
```python
@field_validator("secret_key")
@classmethod
def validate_secret_key(cls, v: str) -> str:
    from app.settings import Settings
    # 需通过 model_config 获取 environment,或使用 class-level 检查
    if not v or v == "change-me":
        import warnings
        warnings.warn(
            "SECRET_KEY is not set or using default value.",
            stacklevel=2,
        )
        # production 环境强制校验
        import os
        env = os.getenv("ENVIRONMENT", "development")
        if env == "production":
            raise ValueError("SECRET_KEY must be set in production environment")
    return v
```

**验证**:
```bash
# 生产环境缺失 secret_key 应报错
$env:ENVIRONMENT="production"; $env:SECRET_KEY=""; uv run python -c "from app.settings import get_settings"
# 预期: ValueError

# 开发环境仅 warn
$env:ENVIRONMENT="development"; $env:SECRET_KEY=""; uv run python -c "from app.settings import get_settings"
# 预期: 成功 + warning log
```

#### A8-fix:修正 main.py 注册(F2/F3/F4/R14)

**文件**: `backend/app/main.py`(第 31-57 行 `create_app()` 函数)

**当前缺陷**: `create_app()` 中缺少三项注册

**修正**: 在 `create_app()` 中 CORS 之后、health check 之前添加:
```python
def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(...)

    # CORS (已有)
    app.add_middleware(CORSMiddleware, ...)

    # === 修正 F2: 注册全局异常处理器 ===
    from app.errors import register_exception_handlers
    register_exception_handlers(app)

    # === 修正 F3: 添加请求 ID 中间件 ===
    from app.middleware import RequestIdMiddleware
    app.add_middleware(RequestIdMiddleware)

    # === 修正 F4: 在 lifespan startup 调用 setup_logging ===
    # (在 lifespan 函数的 startup 部分添加)
    from app.logging import setup_logging
    setup_logging(level="DEBUG" if settings.debug else "INFO")

    # Health check (已有)
    @app.get("/api/health")
    ...
```

**中间件顺序**: CORS 最外层 → RequestIdMiddleware → 路由(Starlette 按添加逆序包裹,所以 CORS 先添加在最外层)

**验证**:
```bash
# 异常处理器
curl -s http://localhost:8000/api/nonexistent | python -m json.tool
# 预期: {"detail": "...", "error_type": "NotFoundError"}

# 请求 ID 中间件
curl -sI -H "x-request-id: test-123" http://localhost:8000/api/health | findstr x-request-id
# 预期: x-request-id: test-123
```

#### A9:Alembic 初始化(异步 + Programmatic API)

**文件**: `backend/alembic.ini`, `backend/app/alembic/env.py`, `backend/app/alembic/script.py.mako`, `backend/app/alembic/versions/`

**设计方案**: 基于 Alembic 官方 Cookbook 的 Programmatic API + Connection Sharing 模式。env.py 优先使用外部注入的连接,否则自建异步引擎。

**alembic.ini 关键配置**:
```ini
[alembic]
script_location = app/alembic
sqlalchemy.url = sqlite+aiosqlite:///./data/meta.db
# URL 由 env.py 动态覆盖,此处为 CLI 默认值
```

**env.py 核心逻辑**:
```python
import asyncio
from logging.config import fileConfig
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config
from alembic import context

from app.db.base import Base
# Phase A 仅导入 meta 模型;Phase B 扩展导入全部业务模型
from app.db.models import meta  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,  # SQLite 必须用 batch 模式
    )
    with context.begin_transaction():
        context.run_migrations()

async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()

def run_migrations_online() -> None:
    connectable = config.attributes.get("connection", None)
    if connectable is None:
        asyncio.run(run_async_migrations())
    else:
        do_run_migrations(connectable)

run_migrations_online()
```

**baseline 迁移** `001_initial.py`:仅创建 spaces + meta_settings 表(Phase B 扩展为 20 表)

**验证**:
```bash
cd backend
alembic upgrade head     # 成功,创建 spaces + meta_settings 表
alembic downgrade base  # 成功,表被删除
alembic history         # 显示 1 个 revision
```

### 轨道 2:file_system 移植(5 处耦合修正)

#### A10:移植 15 文件

**源码**: `E:\Notes\测试-demo\video-collector\Video_thrans_workflow\scripts\file_system\`
**目标**: `E:\Development\MyAwesomeApp\PomodoroXII\backend\app\file_system\`

**文件清单**(15 文件,已验证):
```
file_system/
├── __init__.py          # 导出 FileSystem, FolderMeta, NoteMeta, NoteORM 等
├── api.py               # FileSystemStorage 工厂 + serialize() 函数
├── backup.py            # BackupService (依赖 logger_config)
├── interfaces.py        # ABC 定义
├── models.py            # Pydantic DTO
├── schema.py            # SQLAlchemy ORM (独立 Base) + init_database
└── engine/
    ├── __init__.py      # 导出 FileSystemStorage
    ├── base.py          # StorageBase (RLock + FileLock + sqlite3 + _atomic_write)
    ├── consistency_ops.py
    ├── export_ops.py
    ├── folder_ops.py
    ├── note_ops.py      # NoteOpsMixin (9 方法 + 需新增 read_notes_batch)
    ├── search_ops.py    # FTS5 trigram + LIKE 回退
    ├── trash_ops.py
    └── version_ops.py
```

#### A11:修正耦合 1 — 导入路径

全局替换 `from file_system.xxx` → `from app.file_system.xxx`:

| 文件 | 行号 | 原始 | 修正 |
|------|------|------|------|
| `__init__.py` | 7 | `from file_system.interfaces import (...)` | `from app.file_system.interfaces import (...)` |
| `__init__.py` | 16 | `from file_system.schema import (...)` | `from app.file_system.schema import (...)` |
| `api.py` | 9 | `from file_system.engine import FileSystemStorage` | `from app.file_system.engine import FileSystemStorage` |
| `api.py` | 10 | `from file_system.interfaces import FileSystem` | `from app.file_system.interfaces import FileSystem` |
| `engine/note_ops.py` | 15 | `from file_system.interfaces import ...` | `from app.file_system.interfaces import ...` |

**保持不变**: `engine/note_ops.py` 第 16 行 `from .base import _utc_now_iso, ...`(相对导入)

**验证**: `uv run python -c "from app.file_system import FileSystem, FolderMeta, NoteMeta"` 无错误

#### A12:修正耦合 2 — 死导入

**文件**: `schema.py` 第 9 行
**修正**: 删除 `import urllib.parse`(未使用)

#### A13:修正耦合 3 — logger 依赖

**文件**: `backup.py` 第 13-15 行
**原始**: `from logger_config import get_logger` + `logger = get_logger(__name__)`
**修正**: `import logging` + `logger = logging.getLogger(__name__)`

#### A14:修正耦合 4 — 路径推导

**文件**: `api.py` 第 17-18 行
**原始**: `_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent`(三级 parent,指向 scripts/ 的上级)
**修正**: 从 settings 获取路径:
```python
from app.settings import get_settings
_settings = get_settings()
# 工厂函数中:
fs = FileSystemStorage(
    root_dir=_settings.data_dir / "notes",
    index_db=_settings.data_dir / ".meta" / "index.db",
)
```

#### A15:修正耦合 5 — 批量读取

**文件**: `engine/note_ops.py`(NoteOpsMixin 类中新增)

**新增方法**:
```python
async def read_notes_batch(self, note_ids: list[str]) -> list[str | None]:
    """批量读取笔记内容,保持输入顺序。IO 次数 = 2(1 次批量查 DB + 1 次批量读文件)。"""
    if not note_ids:
        return []

    def _do():
        with self._lock:
            with self._connect() as conn:
                conn.row_factory = __import__("sqlite3").Row
                placeholders = ",".join("?" * len(note_ids))
                rows = conn.execute(
                    f"SELECT note_id, current_path FROM notes "
                    f"WHERE note_id IN ({placeholders}) AND is_deleted = 0",
                    note_ids,
                ).fetchall()
                path_map = {row["note_id"]: row["current_path"] for row in rows}

        results = []
        for nid in note_ids:
            rel_path = path_map.get(nid)
            if rel_path is None:
                results.append(None)
                continue
            abs_path = self.root / rel_path
            if abs_path.exists():
                results.append(abs_path.read_text(encoding="utf-8"))
            else:
                results.append(None)
        return results

    return await asyncio.to_thread(_do)
```

**验证**: 3 个 note_id → 3 条 content,顺序一致;不存在的 note_id 返回 None

#### A16:补全 schema 遗漏

**文件**: `schema.py`
**修正**: 确保 `init_database()` 创建全部 8 表(notes, folders, note_paths, note_versions, note_links, notes_fts, schema_meta, sync_audit_log)

#### A17:验证 file_system 独立运行

编写集成测试 `test_fs_full_flow`:create note → read note → search note → delete note → 全流程通过

### 轨道 3:Docker 骨架 + get_file_system 修正

#### A19-fix:修正 middleware uuid 导入位置(F5)

**文件**: `middleware.py`
**修正**: 将第 28 行 `import uuid` 移至文件顶部(第 1-7 行区域)
**验证**: `uv run ruff check backend/app/middleware.py` 无 E402 错误

#### A20:Docker 骨架(多阶段 + uv + 非 root)

**文件**: `backend/Dockerfile`, `backend/.dockerignore`

**设计方案**: 基于 uv 官方 Docker 集成文档,多阶段构建(builder 以 root 安装依赖,runtime 以 app 用户运行)。

**Dockerfile**:
```dockerfile
# Stage 1: Builder
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim AS builder
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
WORKDIR /app

# 先装依赖(利用 Docker 层缓存)
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# 复制源码
COPY app/ ./app/

# Stage 2: Runtime
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim AS runtime
RUN groupadd -g 1000 app && useradd -m -u 1000 -g 1000 -s /bin/bash app
WORKDIR /app

COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --from=builder --chown=app:app /app/app /app/app

RUN mkdir -p /app/data && chown -R app:app /app/data
USER app
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
VOLUME ["/app/data"]
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**.dockerignore**: 排除 `.venv/`, `__pycache__/`, `*.pyc`, `data/`, `*.db`, `.env`, `.pytest_cache/`

**验证**: `docker build -t pomodoroxii-backend backend/` 构建成功

#### A21:修正 get_file_system(F6)

**文件**: `backend/app/deps.py`(第 100-113 行)

**当前代码(有缺陷)**:
```python
async def get_file_system(ctx: dict = Depends(get_space_context)) -> Any:
    # Placeholder - returns Path
    settings = get_settings()
    notes_dir = settings.space_notes_dir(ctx["space_id"])
    notes_dir.mkdir(parents=True, exist_ok=True)
    return notes_dir  # 返回 Path,不是 FileSystem
```

**修正后代码**:
```python
async def get_file_system(
    ctx: dict = Depends(get_space_context),
) -> FileSystem:
    """返回当前空间的 FileSystem 实例。"""
    from app.file_system.api import get_file_system as _get_fs
    settings = get_settings()
    notes_dir = settings.space_notes_dir(ctx["space_id"])
    notes_dir.mkdir(parents=True, exist_ok=True)
    index_db = settings.data_dir / "spaces" / ctx["space_id"] / ".meta" / "index.db"
    index_db.parent.mkdir(parents=True, exist_ok=True)
    return await _get_fs(root_dir=notes_dir, index_db=index_db)
```

**验证**: `isinstance(result, FileSystem)` 为 True;不同 space_id 返回不同 FS 实例

### Phase A 门控标准

1. `curl /api/health` 返回 200
2. `curl -H "x-request-id: test" /api/health` 响应头含 `x-request-id: test`
3. raise NotFoundError 返回 404 JSON 含 `error_type` 字段
4. `ENVIRONMENT=production SECRET_KEY=""` 报错退出
5. `from app.file_system.engine import FileSystemStorage` 无错误
6. file_system 全流程测试通过(create → read → search → delete)
7. `read_notes_batch([id1, id2, id3])` 返回 3 条 content,顺序一致
8. `alembic upgrade head` + `alembic downgrade base` 均通过
9. `docker build -t pomodoroxii-backend .` 成功
10. `get_file_system` 返回 FileSystem 实例(非 Path)
11. `ruff check backend/app/middleware.py` 无 E402
12. 全部已有 11 测试 + 新增修正测试通过

---

## 提议变更:Phase B-H 概要

### Phase B:双 JWT 认证 + 全业务模型/Service/REST 路由

**前置条件**: Phase A 完成

**B4 认证+空间路由**: `POST /auth/setup`(创建默认空间 + 签发双 Token) + `POST /auth/login` + `POST /auth/switch` + spaces CRUD(用 require_master_token + get_meta_db)

**B5 全 16+2 表 ORM 模型**: SyncMixin(id/created_at/updated_at/version/deleted_at) + 16 业务模型 + 2 同步审计模型。**关键**: Note 模型无 content 字段,有 content_hash + word_count(D4)

**B6 Pydantic Schemas**: 各实体 Create/Update/Response。**关键修正**: NoteUpdate 含 Optional[content_hash](06 #7);NoteResponse 不含 content

**B7 Alembic 迁移**: `alembic revision --autogenerate` → 人工校验 Note 无 content 列 → `alembic upgrade head` 创建 20 表

**B8 BaseService**: `get/create/update/delete` 全部使用 `flush()` 不 `commit()`,version 递增 + 软删除

**B9 全实体 Service + CascadeService**: 各实体 Service 继承 BaseService;CascadeService(BFS 级联:delete_task_cascade / delete_folder_cascade / delete_note_cascade),被 REST 和 sync 共用

**B10 12 REST 路由**: tasks/sessions/notes/folders/quick_notes/reflections/habits/schedules/time_blocks/trash/stats/search,全部用 `Depends(get_space_db)` + 调 Service + `await db.commit()`

**B11 TombstoneService + settings 路由**: TombstoneService(create/exists/cleanup_expired TTL 90天) + settings KV CRUD

**门控**: 双 JWT 校验(业务路由拒绝 Master Token);`Base.metadata.tables` 含 20 表;Note 无 content;services 无 commit;routes 有 commit;`/openapi.json` 可导出

### Phase C:Sync 引擎 + 双存储桥接(含 06 缺陷修正)

**前置条件**: Phase B 完成

**C1 sync_safety.py(06 #2)**: 5 个公共函数(check_tombstone_first / strip_client_fields / detect_zero_time / check_folder_circular_ref / check_ttl_resurrection),从源 sync.py 提取

**C2 SyncService.push(06 #1)**: `async with db.begin_nested()` per event(逐事件 SAVEPOINT),循环外 `db.commit()`(统一提交),ENTITY_REGISTRY 14 实体注册表。**关键**: NoteService.create 只 flush 不 commit

**C3 SyncService.pull(06 #3)**: `select(Note)` 含 content_hash + `fs.read_notes_batch()` 批量读 + `_model_to_dict()` 转换

**C4 SyncService.full + status**: 全量快照 + 统计待同步计数

**C5 NoteService(Saga,06 #1/#4/#6)**:
- `create_note`: DB flush → FS write → 失败则 DB rollback + FS 补偿删除
- `update_note`: 保存 old_hash → FS write(有版本备份)→ DB flush → 失败恢复 old_hash(06 #4)
- `delete_note`: 软删除 + 创建 Tombstone(06 #6)
- **全部只 flush 不 commit**

**C6-C10**: sync_safety 在 NoteService 中调用 + sync 路由 + ENTITY_REGISTRY + sync 审计 + 测试(通过 API client + auth_headers,不直接操作 DB)

**门控**: 10 事件第 3 个失败前 2 个回滚;pull 50 条 ORM 查询=1 次;mock FS 异常 → DB 回滚;墓碑防复活

### Phase D:Notes/Search/Trash API + file_system 全集成

**前置条件**: Phase C 完成

**D1-D2**: NoteService 完善 + Notes REST API(GET 列表/GET 单条/POST 创建/PATCH 元数据/PUT content/DELETE)。**关键**: PATCH 元数据不触发 .md 写入;PUT content 更新 .md + content_hash

**D3-D5**: Search API(FTS5 trigram + LIKE 回退) + Trash API(trash_ops ↔ DB trashed_at 对齐) + 版本历史 + Convert API(事务性:DB add → set migrated_to_note_id → trashed_at → copy comments → commit → FS write)

**D6 frontmatter.py**: `build_md_content(note_data)` + `parse_frontmatter(md_content)`,7 字段(id/title/tags/folder_id/content_hash/word_count/created_at/updated_at)

**D7 file_system 空间化**: `get_file_system(space_id)` 按空间返回独立 FS,根目录 `data/spaces/{space_id}/notes/`

**门控**: content 分离(PATCH 不写 .md,PUT content 更新 .md);FTS5 搜索;回收站对齐;.md 含 frontmatter;空间隔离

### Phase E:可靠性 + Agent + Export

**前置条件**: Phase D 完成

**E1-E3**: BackupService(sqlite3.backup() Online Backup + 30 天保留 + 多空间版) + SnapshotService(JSONL + _manifest.json) + ConsistencyService(db_has_file_missing / file_has_db_missing 修复)

**E4-E5**: ExportService(ExportContainer 格式 + 时间戳 Z 后缀 + tags 原生 list + 剥离同步元数据) + Export/Admin 路由(Admin 用 require_master_token)

**E6-E7**: APScheduler(AsyncIOScheduler + lifespan 集成,备份 3:00 + 快照 3:30 + 一致性每小时) + MCP Server(4 tools + 3 resources + 2 prompts)

**门控**: 双库备份;JSONL 快照;一致性检查修复;MCP Server 可连接;APScheduler 正确启停

### Phase F:React 19 前端重建

**前置条件**: Phase B 完成后即可启动(需 OpenAPI schema),与 C/D/E 并行

**F-a 骨架**: Next.js 15 + Tailwind v4 + shadcn/ui + Provider Pattern(React 19 Context 无 .Provider) + 框架无关代码迁移(api.ts/database.ts/export-v2.ts/types/,30% 原样保留) + Dexie v16 schema(+content_hash,-_etag,-content) + openapi-typescript + 17 Zustand store + PWA + Dexie Proxy(SpaceDBManager + 嵌套 Table Proxy) + MetaDB + SpaceStore + Axios 401 拦截器 + navigator.storage.persist()

**Dexie Proxy 核心实现**:
```typescript
class SpaceDBManager {
  private currentDB: PomodoroXIDB | null = null
  private dbCache: Map<string, PomodoroXIDB> = new Map()

  switchTo(spaceId: string): void { /* 切换 + LRU 淘汰 + CustomEvent */ }

  get proxy(): PomodoroXIDB {
    const manager = this
    return new Proxy({} as PomodoroXIDB, {
      get(_target, prop) {
        const db = manager.current
        const value = (db as any)[prop]
        if (typeof value === 'function') return value.bind(db)
        if (value instanceof Dexie.Table) {
          return new Proxy(value, {
            get(tableTarget, tableProp) {
              const tv = (tableTarget as any)[tableProp]
              return typeof tv === 'function' ? tv.bind(tableTarget) : tv
            }
          })
        }
        return value
      }
    })
  }
}
export const db = spaceDBManager.proxy as PomodoroXIDB
```

**F-b 逐 View 迁移**: composables → hooks(40+) + TanStack Query v6 + React Hook Form + Zod + Compound Components(variant 非 boolean,无 forwardRef) + 逐 View 迁移 + 空间 UI(SpaceSwitcher compound)

**F-c 清理**: 删除 Vue 残留 + PWA SW 注册 + React 19 Compiler + Zustand selector 测试 + dark mode 回归 + E2E

**门控**: `grep "vue" frontend/package.json` 返回空;Dexie Proxy 空间切换零改动;17 store 有 selector 测试;React 19 Compiler 启用;Playwright E2E 通过

### Phase G:数据迁移 + 端到端集成测试

**前置条件**: C/D/E/F 全部完成

| 任务 | 验证标准 |
|------|---------|
| G1 后端迁移脚本(备份 + 创建 MetaDB + 迁移 admin_password + 注册默认空间) | 幂等(检测 meta.db 存在 → 跳过) |
| G2 Note.content → .md 迁移 | .md 文件生成;content_hash 正确 |
| G3 前端迁移(检测旧 DB + 逐表 export/import) | 迁移后功能正常;失败不删除旧 DB |
| G4 E2E(setup → login → CRUD → sync → switch space) | Playwright 全流程通过 |
| G5 性能验证 | 空间切换 < 500ms |
| G6 安全验证 | 跨空间数据隔离 |
| G7 06 缺陷回归 | 8 个缺陷无回归 |
| G8 Saga 补偿验证 | mock FS 异常 → DB 回滚 |

### Phase H:部署 + Docker Compose + CI/CD

**前置条件**: Phase G 完成

| 任务 | 验证标准 |
|------|---------|
| H1 docker-compose.yml(backend + frontend + cloudflared) | `docker-compose up` 三服务启动 |
| H2 backend Dockerfile(多阶段 + uv + 非 root) | `docker build` 成功 |
| H3 frontend Dockerfile(next build + standalone) | `docker build` 成功 |
| H4 Cloudflare Tunnel | 域名可访问 |
| H5 pre-commit hooks(ruff + eslint) | `pre-commit run --all-files` 通过 |
| H6 CI/CD(backend-ci + frontend-ci) | CI 在 PR 上自动运行 |
| H7 README + 部署文档 | 新用户按文档可部署 |
| H8 AGENTS.md + CLAUDE.md | AI 工具可读取理解项目约束 |
| H9 data/ volume 挂载 | data/{space_id}/ 持久化 |

---

## 跨阶段关注点

### 三条铁律全程验证

| 铁律 | 验证命令 | 预期 | 执行时机 |
|------|---------|------|---------|
| Routers commit | `grep -r "\.commit()" backend/app/routes/` | 有匹配 | 每阶段结束 |
| Services flush | `grep -r "\.commit()" backend/app/services/` | 返回空 | 每阶段结束 |
| Services 不导入 FastAPI | `grep -r "from fastapi" backend/app/services/` | 返回空 | 每阶段结束 |
| Models 纯数据 | 检查 ORM 模型文件无业务方法 | 只有字段和约束 | Phase B 结束 |

### 06 文档缺陷修正映射

| 缺陷 | 严重度 | 修正任务 | 修正方式 | 验证方法 |
|------|--------|---------|---------|---------|
| #1 Saga commit 击穿 SAVEPOINT | 高 | C2/C5 | NoteService 只 flush 不 commit | 10 事件第 3 个失败 → 前 2 个回滚 |
| #2 sync adapter 丢失安全防线 | 高 | C1/C6 | sync_safety.py 5 函数共用 | grep 验证 adapter 调用 5 函数 |
| #3 pull N+1 查询 | 中 | C3 | content_hash ORM 一并取出 + read_notes_batch | pull 50 条 → 1 次 ORM + 1 次批量读 |
| #4 update_note old_hash 未回滚 | 中 | C5 | FS 失败时恢复 old_hash | mock fs.edit_note 抛异常 → hash 恢复 |
| #5 测试 fixture 引用不存在导出 | 低 | C10 | 用 client fixture + auth_headers | 无直接 DB 操作 |
| #6 delete_note 不创建 Tombstone | 低 | C5 | 统一创建 Tombstone | 删除后 Tombstone 存在 |
| #7 content_hash 未加入 NoteUpdate | 低 | B6 | NoteUpdate 含 Optional[content_hash] | schema 验证 |
| #8 folder delete 缺少 BFS 级联 | 低 | C9 | CascadeService BFS 级联 | 删除 folder 后后代被清理 |

### 多空间架构全程验证

| 验证项 | 验证方法 | 执行阶段 |
|--------|---------|---------|
| Meta DB 独立 | spaces 表 CRUD 不依赖业务 DB | A |
| 引擎池 LRU | 6 个空间第 1 个被 dispose | A |
| DB Router | get_space_db 返回正确空间 DB | A |
| 双 JWT 校验 | Master Token 被业务路由拒绝 | B |
| 同步隔离 | 每空间独立 outbox/tombstone | C |
| file_system 空间化 | data/spaces/{space_id}/ 隔离 | D |
| Dexie Proxy | 空间切换后业务代码零改动 | F |
| 数据迁移 | 单空间 → 默认空间幂等 | G |

### 并行机会

| 并行窗口 | 可并行的任务组 | 前提条件 |
|---------|--------------|---------|
| A 内三轨道 | 轨道1(修正+Alembic) ‖ 轨道2(file_system) ‖ 轨道3(Docker) | 无相互依赖 |
| B 内四组 | 认证+空间路由 ‖ 模型+Schema ‖ Service ‖ 路由 | BaseService 定义后各实体独立 |
| B → F 桥接 | B 完成后 F 骨架启动,与 C/D/E 并行 | 需 OpenAPI schema |
| C 内 | sync_safety ‖ SyncService 骨架 | sync_safety 独立 |
| D 内 | Notes API ‖ Search ‖ Trash ‖ Convert ‖ Versions | 全依赖 NoteService 但互相独立 |
| E 内 | Backup+Snapshot ‖ Consistency ‖ Export ‖ MCP | 4 个独立模块 |
| G 内 | 后端迁移 ‖ 前端迁移 | 前后端独立 |

---

## 假设与前提

1. **Python 3.13 可用**: pyproject.toml 当前 `requires-python>=3.12`,Docker 使用 `python3.13-trixie-slim`
2. **uv 已安装**: 用于包管理和虚拟环境
3. **file_system 源码可读**: `E:\Notes\测试-demo\video-collector\Video_thrans_workflow\scripts\file_system\` 路径可访问
4. **源项目代码可参考**: `e:\Development\MyAwesomeApp\pomodoroxi\` 完整代码库可用作迁移参考
5. **file_system 双 Base 隔离**: file_system 的 `Base`(schema.py)与应用 `Base`(db/base.py)完全独立,各自的 MetaData 不交叉
6. **file_system 保持原生 sqlite3**: 不迁移到 aiosqlite,三层锁(RLock→FileLock→SQLite 事务)语义成熟,使用 `asyncio.to_thread()` 包装
7. **写文件限制**: 目标项目 `E:\Development\MyAwesomeApp\PomodoroXII` 可能存在写入限制,需通过 Python 生成器脚本在临时工作目录执行文件复制和修改
8. **TDD 方法论**: 每个任务遵循 Red(失败测试)→ Green(实现)→ Refactor(重构)三色循环
9. **doc-coauthoring 工作流**: 上下文收集 → 结构化 → 细化 → 读者测试

---

## 验证步骤总览

### Phase A 验证(立即可执行)

```bash
# 1. 缺陷修正验证
$env:ENVIRONMENT="production"; $env:SECRET_KEY=""; uv run python -c "from app.settings import get_settings"
# 预期: ValueError

# 2. 异常处理器
curl -s http://localhost:8000/api/nonexistent
# 预期: {"detail": "...", "error_type": "..."}

# 3. 请求 ID
curl -sI -H "x-request-id: test-123" http://localhost:8000/api/health | findstr x-request-id
# 预期: x-request-id: test-123

# 4. file_system 导入
uv run python -c "from app.file_system import FileSystem, FolderMeta, NoteMeta"
# 预期: 无错误

# 5. 批量读取
uv run pytest tests/test_file_system/ -v -k "batch"
# 预期: 通过

# 6. Alembic
cd backend; alembic upgrade head; alembic downgrade base
# 预期: 均成功

# 7. Docker
docker build -t pomodoroxii-backend backend/
# 预期: 构建成功

# 8. Ruff
uv run ruff check backend/app/middleware.py
# 预期: 无 E402

# 9. 全部测试
uv run pytest -v
# 预期: 11 已有 + 新增修正测试全部通过
```

### 后续阶段验证(每阶段结束时执行)

```bash
# 三层铁律
grep -r "\.commit()" backend/app/services/   # 返回空
grep -r "from fastapi" backend/app/services/  # 返回空
grep -r "\.commit()" backend/app/routes/       # 有匹配
grep "get_db " backend/app/routes/             # 返回空(全用 get_space_db)

# Note 模型
python -c "from app.db.models.note import Note; assert 'content' not in [c.name for c in Note.__table__.columns]"

# 前端
grep "vue" frontend/package.json               # 返回空
```

---

## 文档与源码参照索引

| 参照对象 | 路径 |
|---------|------|
| v3 总规划 | `pomodoroxi/.trae/documents/PomodoroXII重构项目深度开发规划v3.md` |
| 深度架构规划(01) | `pomodoroxi/核心文档(New)/01-深度架构规划.md` |
| 技术栈升级(02) | `pomodoroxi/核心文档(New)/02-技术栈升级推荐.md` |
| file_system 移植(05) | `pomodoroxi/核心文档(New)/05-file_system移植方案分析.md` |
| 缺陷修正(06) | `pomodoroxi/核心文档(New)/06-实施计划评审与缺陷修正.md` |
| 多空间架构(13) | `pomodoroxi/核心文档(New)/13-单用户多空间架构设计.md` |
| file_system 源码 | `E:\Notes\测试-demo\video-collector\Video_thrans_workflow\scripts\file_system` |
| 源项目后端 | `pomodoroxi/backend/app/` |
| 源项目 sync.py | `pomodoroxi/backend/app/routes/sync.py`(1047 行,Phase C 移植来源) |
| 目标项目 | `E:\Development\MyAwesomeApp\PomodoroXII` |
| 当前后端实现 | [PomodoroXII/backend/app/](computer://e:\Development\MyAwesomeApp\PomodoroXII\backend\app) |

---

**规划结束。**

v4 相对 v3 的核心改进:
1. **全部 F1-F6 缺陷经逐行验证**: 带实际行号和当前代码片段
2. **Alembic Programmatic API**: 基于 Alembic 官方 Cookbook,env.py 支持 connection sharing + async engine + render_as_batch
3. **双 Base 隔离明确**: file_system 的 FSBase 与 app Base 完全独立,各自 MetaData 不交叉
4. **Saga Try-Compensate 模式**: 具体的 DB flush → FS write → 失败 rollback + 补偿删除时序
5. **Dexie Proxy 嵌套转发**: SpaceDBManager + Proxy.get trap + Table 对象嵌套 Proxy,确保链式调用正确
6. **Docker 多阶段构建**: uv 官方镜像 + builder/runtime 分离 + UID 1000 + gosu 降权
7. **5 处耦合修正精确到行号**: 每处都带原始代码和修正后代码
