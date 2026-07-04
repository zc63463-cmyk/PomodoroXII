# 调研 — MCP 查询日志摘要

> 本文件为「[项目深度调研分析报告](file:///e:/Development/MyAwesomeApp/PomodoroXII/.trae/documents/项目深度调研分析报告.md)」附录 E 的原始数据来源。
>
> 调研日期: 2026-07-04
> 调研工具: Trae IDE Agent + codebase-memory-mcp + cognee-mcp

---

## A. codebase-memory-mcp 查询记录

### A.1 元数据查询

| 工具 | 输入 | 返回摘要 |
|------|------|---------|
| `list_projects` | `{}` | 1 个项目: `E-Development-MyAwesomeApp-PomodoroXII-backend` |
| `index_status` | `{project_name: "..."}` | 状态 `ready`, 1261 节点, 5457 边, 47 文件已索引 |
| `get_graph_schema` | `{project_name: "..."}` | 节点标签 9 种 (Function/Method/Class/File/Module/Variable/Route/Folder/Decorator), 边类型 17 种 (USAGE/CALLS/DEFINES/TESTS/...) |
| `get_architecture` | `{aspects: ["all"], project_name: "..."}` | packages: `app.auth, app.db, app.file_system, app.models, app.registry, app.routes.v1, app.schemas, app.services, alembic`; layers: core/api/entry; hotspots: BaseService.get (fan_in 115) |

### A.2 Cypher 查询清单（5 条）

执行方式: `run_mcp` → `query_graph`，所有查询包装在 `args.cypher` 字段中。

| # | 查询目的 | Cypher 表达式 | 返回结果 |
|---|---------|--------------|---------|
| Q1 | 高复杂度函数（>5） | `MATCH (f:Function) WHERE f.complexity > 5 RETURN f.qualified_name, f.complexity, f.cognitive, f.loop_depth ORDER BY f.complexity DESC LIMIT 20` | **3 条** — 全部在 alembic 迁移脚本 (upgrade/downgrade, complexity=11) + tests gate (test_gate_services_do_not_import_fastapi, complexity=8)。**应用代码 0 个高复杂度函数**。 |
| Q2 | 高扇入节点（>10） | `MATCH (n) WHERE n.fan_in > 10 RETURN n.qualified_name, n.fan_in ORDER BY n.fan_in DESC LIMIT 15` | **8 条** — Top: `BaseService.get` (fan_in=115), `BaseService.delete` (35), `BaseService.create` (33), `FileSystem.create_note` (18), `BaseService.list` (14), `ReflectionService.create` (14), `utc_now_iso` (13), `FileSystem.read_note` (10) |
| Q3 | 跨边界调用嫌疑（路由层→模型层） | `MATCH (r:Function)-[:CALLS]->(s:Function) WHERE r.file_path STARTS WITH "app/routes" AND s.file_path STARTS WITH "app/models" RETURN r.qualified_name, s.qualified_name` | **0 条** ✅ 三层铁律严格遵守 |
| Q4 | 服务层 fastapi import 嫌疑 | `MATCH (m:Module)-[:IMPORTS]->(target) WHERE m.qualified_name STARTS WITH "app.services" AND target CONTAINS "fastapi" RETURN m.qualified_name, target` | **0 条** ✅ 三层铁律严格遵守 |
| Q5 | 测试覆盖缺口（按 service 函数） | `MATCH (f:Function)-[:TESTS]->(target:Function) WHERE f.file_path STARTS WITH "tests/" AND target.file_path STARTS WITH "app/services" RETURN target.qualified_name, count(f) AS test_count ORDER BY test_count ASC` | 多条 — `BaseService.list/create/get/delete` 测试覆盖良好；`CascadeService.purge_item` / `TombstoneService.cleanup_expired` 测试覆盖较薄 |

### A.3 search_graph 调用清单

| # | 查询语句 | 返回摘要 |
|---|---------|---------|
| 1 | `"BaseService create update delete"` | CRUD 通用模式 9 个核心方法 (BaseService + NoteService + TaskService) |
| 2 | `"JWT token auth space"` | 双 JWT 实现路径: `auth.security.create_master_token` / `create_space_token` / `decode_access_token`; `deps.require_master_token` / `get_space_context` |
| 3 | `"EntitySpec register"` | EntityRegistry 注册链: `registry.builtin.register_all` → 20 个 `_register(EntitySpec(...))` 调用 |

### A.4 已知查询问题

1. **Cypher 语法陷阱**: `MATCH (t:Function {is_test: true})` 在 Cypher 引擎中报 "expected token type 86, got 49 at pos 28" 错误
   - **修复**: 改为 `MATCH (t:Function) WHERE t.is_test = true RETURN ...`
   - **次生问题**: 修复后返回 0 条 — `is_test` 属性可能未在 Function 节点建立索引
   - **替代方案**: 已用 Grep `^(async )?def test_|^class Test` 实际计数 214 测试函数（与图谱统计一致）

2. **Route 节点 path 字段未填充**: 71 个 Route 节点的 `path` 字段大多为空字符串，导致 `MATCH (r:Route) RETURN r.method, r.path` 查询无效
   - **替代方案**: 通过 Read 路由文件 + `routes/v1/__init__.py` 整理端点矩阵（见主报告附录 C）

---

## B. cognee-mcp 查询记录

### B.1 search 调用

| 查询语句 | 返回摘要 | 处理 |
|---------|---------|------|
| `"PomodoroXII architecture"` | 含 Auth0 / AWS CloudFront / PostgreSQL / GitHub Actions 等**虚构信息**，混杂真实信息（FastAPI / 多空间 SQLite / Saga Try-Compensate） | 在主报告 1.2 节差异校正表 + 第八章 cognee 校验报告中明确标注实际架构 |
| `"project status"` | 声称"Phase A+B 完成, Phase C 进行中" | 实际为 Phase C 0%；已用 Glob `**/sync*.py` 验证 |

### B.2 list_data / recall 调用

- `list_data` 返回若干项目相关片段（部分正确：FastAPI / SQLAlchemy / 多空间架构；部分误导：Auth0 / PostgreSQL / GitHub Actions）
- `recall` 查询返回项目历史交互片段

### B.3 误导信息清单

| cognee 声称 | 实际代码 | 误导程度 |
|------------|----------|---------|
| Auth0 (OAuth2 / OIDC) | 自实现双 JWT (PyJWT 2.10+ + bcrypt 4.2+, master 7d / space 8h) | ❌ 严重 |
| AWS CloudFront CDN | 无 CDN（本地 FastAPI） | ❌ 严重 |
| PostgreSQL multi-tenant | 每空间独立 SQLite + 共享 meta.db | ❌ 严重 |
| AWS ECS/Fargate | 无（Docker 多阶段构建但未部署） | ❌ 严重 |
| GitHub Actions 完整流水线 | 未初始化 Git，无 CI/CD | ❌ 严重 |
| CloudWatch + X-Ray | 无（仅 JsonFormatter 日志） | ❌ 中度 |
| React 19 + Next.js 15 已完成 | 前端完全不存在（Phase F 未开始） | ❌ 严重 |
| "Phase C merged to main" | Phase C 0% 未实现 | ❌ 严重 |

**根因分析**: cognee 索引在 `cognify` 过程中可能基于"PomodoroXII 是云原生应用"的假设生成虚假记忆，需要以实际代码为权威依据。

### B.4 修正建议（未执行）

可通过以下方式修正 cognee 索引:

```python
# 方式 1: save_interaction 写入正确描述
run_mcp(server_name="mcp_cognee-mcp", tool_name="save_interaction", args={
    "interaction": "PomodoroXII 实际架构: FastAPI + SQLAlchemy 2.0 async + 多空间独立 SQLite + 自实现双 JWT (master 7d / space 8h) + bcrypt 12 rounds + Cloudflare Tunnel 部署待定 + 未初始化 Git + 无 CI/CD + 前端不存在。Phase A/B 完成, Phase C 实际进度 0%。"
})

# 方式 2: remember 显式声明
run_mcp(server_name="mcp_cognee-mcp", tool_name="remember", args={
    "content": "PomodoroXII 实际架构纠正: 不使用 Auth0/AWS/PostgreSQL/GitHub Actions/React, 实际为自实现双 JWT + SQLite 多空间 + 未部署 + 前端未开始"
})

# 方式 3: prune 清理后重新 cognify
run_mcp(server_name="mcp_cognee-mcp", tool_name="prune", args={})
# 然后重新 save_interaction + cognify
```

**决策**: 本计划默认不执行修正（标记为可选任务 3），仅在用户明确要求时执行。

---

## C. 工具调用统计

### C.1 调用次数汇总

| MCP 服务器 | 工具类型 | 调用次数 | 备注 |
|-----------|---------|---------|------|
| codebase-memory-mcp | 元数据查询 (list_projects / index_status / get_graph_schema / get_architecture) | 4 | 项目元信息收集 |
| codebase-memory-mcp | Cypher 查询 (query_graph) | 5 | Q1-Q5 见 A.2 节 |
| codebase-memory-mcp | 语义搜索 (search_graph) | 3 | 见 A.3 节 |
| **codebase-memory-mcp 小计** | | **12** | |
| cognee-mcp | search | 2 | 见 B.1 节 |
| cognee-mcp | list_data / recall | 1 | 见 B.2 节 |
| **cognee-mcp 小计** | | **3** | |
| **MCP 总调用** | | **15** | |

### C.2 文件读取统计

| 类别 | 文件数 | 备注 |
|------|--------|------|
| 后端核心代码 (app/) | ~22 | main.py / settings / deps / errors / logging / middleware / space_manager / auth/security / db 4 文件 / file_system 关键文件 / services 8 文件 / models 关键 6 文件 / registry 3 文件 / routes/v1 关键 4 文件 / alembic/env.py |
| 测试文件 (tests/) | ~5 | conftest / test_db_isolation / test_note_service / test_integration / test_models |
| 文档 (documents/ + .trae/documents/) | ~6 | v4 规划 / PhaseC 转接 / 深度交接Prompt / 项目深度审查 / phase-c-sync-completion-plan / phase-c-sync-remaining-tasks |
| **总读取** | **~33** | |

### C.3 调用工具对比

| 工具 | 优势 | 局限 |
|------|------|------|
| codebase-memory-mcp | 精确的代码知识图谱；Cypher 查询能力强；可验证架构铁律 | 索引时间可能滞后于最新代码变更；部分属性（如 `is_test`、`path`）未填充 |
| cognee-mcp | 语义搜索能力强；可处理自然语言查询 | 索引含虚构信息（LLM 幻觉产物）；不可作为权威依据 |
| Trae IDE Agent (自身) | 可直接读取最新代码；可执行 Grep/Glob 精确验证；可作为仲裁者 | 单次会话上下文有限；需要 MCP 提供宏观视图 |

### C.4 三方协同模式总结

| 阶段 | 主导方 | 任务 |
|------|--------|------|
| 宏观架构扫描 | codebase-memory-mcp | get_architecture + 节点/边统计 + clusters 检测 |
| 铁律遵守验证 | codebase-memory-mcp (Cypher) | Q3 跨边界调用 + Q4 fastapi import |
| 复杂度热点 | codebase-memory-mcp (Cypher) | Q1 高复杂度函数 |
| 测试覆盖评估 | codebase-memory-mcp + Grep | Q5 TESTS 边 + Grep 实际计数 |
| 知识校验 | cognee-mcp | search 返回 vs 实际代码差异 |
| 实际状态仲裁 | Trae IDE Agent | Read 文件 + Grep 验证 MCP 返回 |

---

## D. 附录：原始数据存放位置

| 数据类型 | 存放位置 |
|---------|---------|
| codebase-memory 图谱快照 | `backend/.codebase-memory/graph.db.zst`（127 KB 压缩） |
| codebase-memory artifact 元数据 | `backend/.codebase-memory/artifact.json` |
| cognee 索引数据 | cognee-venv 内部存储 |
| 调研主报告 | [.trae/documents/项目深度调研分析报告.md](file:///e:/Development/MyAwesomeApp/PomodoroXII/.trae/documents/项目深度调研分析报告.md) |
| 调研原计划 | [.trae/documents/项目深度调研分析计划.md](file:///e:/Development/MyAwesomeApp/PomodoroXII/.trae/documents/项目深度调研分析计划.md) |
| 收尾计划 | [.trae/documents/项目深度调研-收尾计划.md](file:///e:/Development/MyAwesomeApp/PomodoroXII/.trae/documents/项目深度调研-收尾计划.md) |
| 原审查文档 | [.trae/documents/项目深度审查与后续行动开发指导.md](file:///e:/Development/MyAwesomeApp/PomodoroXII/.trae/documents/项目深度审查与后续行动开发指导.md) |

---

**附录 E 完毕。**
