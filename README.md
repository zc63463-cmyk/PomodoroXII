# PomodoroXII

单用户、多空间、多设备同步的番茄钟与笔记后端。每个 **Space** 拥有独立的 SQLite 元数据库与笔记文件系统；REST API 与 FastMCP 工具供 Web / Agent 客户端接入。

> **当前状态：** 后端 Phase A–E 主体已完成（~95%）；**Phase D 笔记/搜索/回收站打满 100%**；**前端 Phase F 脚手架 S0 已完成**（`frontend/`，Next.js 15 + Dexie v16 + 17 Zustand store + 86 tests）。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 语言 | Python 3.13 |
| Web | FastAPI |
| ORM | SQLAlchemy 2.0（async） |
| 数据库 | SQLite（meta DB + 每 space 独立 DB） |
| 笔记存储 | 文件系统 + FTS5 |
| 迁移 | Alembic |
| Agent | FastMCP 3.x |
| 测试 | pytest · httpx · ruff |

---

## 仓库结构

```
PomodoroXII/
├── backend/                 # FastAPI 应用、测试、Docker、部署文档
│   ├── app/                 # 路由 / 服务 / 模型 / MCP
│   ├── tests/
│   ├── DEPLOY.md            # 生产部署（Docker / GHCR）
│   └── docker-compose.yml
├── documents/               # 项目规划与交接文档
├── 审计报告/cursor审查/     # Cursor 深度审查与验收报告
├── .trae/documents/         # 设计与阶段计划（参考用）
└── 核心文档/                # 架构与元数据设计
```

---

## 快速开始（本地开发）

### 前置

- [uv](https://docs.astral.sh/uv/)（推荐）或 pip
- Python **3.13**

### 安装与运行

```bash
cd backend
uv sync
uv run pytest -q          # 全量测试（当前 621）
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

健康检查：

```bash
curl http://localhost:8000/api/health
# {"status":"ok","version":"0.1.0"}
```

API 交互文档：`http://localhost:8000/docs`

### 前端

```bash
cd frontend
npm install
cp .env.local.example .env.local    # NEXT_PUBLIC_API_BASE=http://localhost:8000
npm run dev                          # http://localhost:3000
npm run generate:api                 # 需后端 @ :8000，生成 src/types/api-generated.ts
```

Gate：`npm run lint && npm run typecheck && npm run test && npm run build`（86 tests, 19 routes）

详见 [frontend/README.md](frontend/README.md)。

---

## 环境变量

所有配置使用前缀 `POMODOROXII_`。常用项：

| 变量 | 说明 |
|------|------|
| `POMODOROXII_SECRET_KEY` | JWT 签名密钥，**至少 32 字节** |
| `POMODOROXII_ENVIRONMENT` | `development` / `production`（生产环境启用 HSTS 等安全头） |
| `POMODOROXII_SPACES_DATA_DIR` | 各 space 的 SQLite 数据目录 |
| `POMODOROXII_DATABASE_URL` | Meta 库连接串（可选，默认 `./data/meta.db`） |
| `POMODOROXII_DEBUG` | `true` 时关闭生产级 HSTS |
| `POMODOROXII_BACKUP_ENABLED` | `true` 时启动时为各 space 创建 DB 备份 |

生成密钥：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

完整列表见 [backend/DEPLOY.md](backend/DEPLOY.md#environment-variables)。

---

## 部署

生产环境推荐使用 Docker：

```bash
cd backend
# 配置 .env（至少 POMODOROXII_SECRET_KEY）
docker compose up -d
curl -fsS http://localhost:8000/api/health
```

详细步骤、GHCR 镜像、卷挂载与排错见 **[backend/DEPLOY.md](backend/DEPLOY.md)**。

已合并 **SecurityHeadersMiddleware**：全环境附加 `X-Content-Type-Options`、`X-Frame-Options` 等；仅在 `production` 且非 debug 时附加 HSTS。

---

## API 概览

| 路径 | 说明 |
|------|------|
| `GET /api/health` | 健康检查 |
| `POST /api/v1/auth/login` | 主账号登录 → JWT |
| `GET/POST /api/v1/spaces` | Space 管理 |
| `GET/POST/PUT/DELETE /api/v1/{entities}` | 14 类实体 CRUD（含 sessions/habits 等 PUT） |
| `PATCH /api/v1/notes/{id}` | 笔记元数据更新（仅 title/tags/summary 等，不写 .md） |
| `PUT /api/v1/notes/{id}/content` | 笔记正文重写（更新 .md + content_hash + word_count） |
| `GET /api/v1/notes/{id}/versions` | 笔记版本历史列表 |
| `GET /api/v1/notes/{id}/versions/{version_id}` | 笔记历史版本正文（PlainText） |
| `GET /api/v1/notes/search` | 笔记全文搜索（FTS5，支持 `folder_id`） |
| `POST /api/v1/quick-notes/{id}/convert` | 速记转 Note（事务性：建 Note + 标记 archived + 复制 memo_comments） |
| `POST /api/v1/sync/push` | 客户端推送同步事件 |
| `GET /api/v1/sync/pull` | 增量拉取 |
| `GET /api/v1/sync/full` | 全量拉取（含全部 tombstones） |
| `GET /api/v1/sync/status` | 各实体计数 |

### Sync 增量拉取（三游标）

客户端循环 `pull`（或 `full`）直到 `has_more == false`，每轮保存并回传：

```
请求：since, since_id, tombstone_since_id
响应：next_since, next_since_id, next_tombstone_since_id
```

Push 时：LWW 远端胜出记录在 `applied[].resolution == "remote"`，**不在** `conflicts` 中。

---

## 开发进度（8 阶段）

与 [documents/PomodoroXII重构项目深度开发规划v4.md](documents/PomodoroXII重构项目深度开发规划v4.md) 及 [审计报告/cursor审查/](审计报告/cursor审查/) 对齐：

| 阶段 | 含义 | 进度 |
|------|------|------|
| **A** | 基础设施（DB、多 space、认证、中间件） | 100% |
| **B** | 业务层（14 实体、REST、registry） | 100% |
| **C** | Sync 引擎（push/pull、游标分页、tombstone） | 100% |
| **D** | 笔记 / 搜索 / 回收站 | **100%** |
| **E** | MCP / 备份 / 导出 | **~85%** |
| **F** | React 19 + Next.js 15 前端 | **~15%**（S0 脚手架完成） |
| **G** | 数据迁移 / E2E | ~15% |
| **H** | 部署 / CI/CD（Docker、GHCR、安全头、README） | **~80%** |

**后端综合 ~95%** · **含前端完整产品 ~58%**（截至 `main` @ `2db8cdd`，PR #14–#19；Phase D 已合入，C-4 已修复）。

---

## 测试与代码质量

```bash
cd backend
uv run pytest -q
uv run ruff check app tests
```

CI：GitHub Actions `Test & Lint`（push / pull_request）。

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [backend/DEPLOY.md](backend/DEPLOY.md) | Docker 部署、环境变量 |
| [审计报告/cursor审查/00-索引与摘要.md](审计报告/cursor审查/00-索引与摘要.md) | 最新审查索引与 Sprint 规划 |
| [documents/](documents/) | 深度开发规划 v4 |

---

## License

TBD
