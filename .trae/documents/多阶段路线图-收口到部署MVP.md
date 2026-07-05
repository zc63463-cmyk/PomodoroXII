# 多阶段路线图：MCP 收口 → 部署 → MVP

## 1. Summary

后端骨架已硬（550 tests + CI 绿）。下一步不是继续补洞，而是把每条能力变成可发布闭环。本计划覆盖 5 个阶段，严格一阶段一分支一 PR，不混主题。

**铁律**：
- 不在 `codex/mcp-wip` 继续叠加 HTTP lifespan / lint / deploy
- 不把 MCP、部署、前端放一个 PR
- 不改已 CI 绿的 sync/routes/stats/registry，除非有明确失败驱动
- 不为了"更优雅"重写 `build_v1_router()` 动态装配

---

## 2. Current State Analysis

### 2.1 基线

| 项 | 状态 |
|---|---|
| `main` 分支 | 后端 PhaseC / 扩展性 4.5 星 / CI #1 绿（a8b367a） |
| `codex/mcp-wip` 分支 | MCP 兼容性 + 测试增强，commit 67d78c9，本地 550 passed |
| 工作树 | 仅 `.trae/documents/MCP-WIP-探测与修复计划.md` untracked |
| 远端 | `origin = https://github.com/zc63463-cmyk/PomodoroXII.git`，main 已推送 |
| MCP HTTP 模式 | **未初始化 meta DB**（server.py:428 注释说用 lifespan 但实际没有） |
| MCP ruff | `exclude = ["app/mcp/**", "tests/test_mcp_server.py"]` |
| FastAPI | lifespan 已注册（main.py:20-47），MCP 未挂载 |
| Docker/CI | build job 有 smoke test，未推 GHCR |
| 前端 | 不存在 |

### 2.2 MCP HTTP lifespan 问题（探索报告关键发现）

`server.py:415-444` 的 `main()` 函数：
- stdio 模式：`asyncio.run(init_meta_db())` → `mcp.run()` → finally `dispose + close`
- http 模式：**仅** `mcp.run(transport="http", ...)`，无 init、无 cleanup

`FastMCP` 构造（server.py:82-91）**未传入 `lifespan` 参数**，注释「HTTP mode uses lifespan」是虚假文档。

后果：http 模式启动后，`list_spaces()` 等依赖 `get_meta_session()` 的工具会因 `_meta_engine is None` 抛 `RuntimeError("Meta database not initialised")`。

### 2.3 修复方案选择

基于探索报告的 3 个方案：

| 方案 | 改动量 | 风险 | 适合阶段 |
|---|---|---|---|
| 1. FastMCP lifespan 参数 | 中 | 需实证 3.4.2 签名 | 阶段 2（推荐） |
| 2. main() 手动 init/cleanup | 小 | 低，补丁式 | 阶段 2（备选） |
| 3. 挂载进 FastAPI | 大 | 中高，架构调整 | 后置，不在本轮 |

**决策**：阶段 2 采用**方案 2**（main() 手动 init/cleanup），原因：
- 改动最小（~5 行），与 stdio 分支对称
- 不依赖 FastMCP lifespan API 的不确定性
- 不改变部署模型（独立 http server 保持不变）
- 方案 1/3 留作后续重构，不在本轮范围

---

## 3. Proposed Changes（5 阶段）

### 阶段 1：收口 MCP WIP 分支

**分支**：`codex/mcp-wip`（已存在）
**目标**：67d78c9 获得远端 CI 背书并合入 main

#### 1.1 处理未跟踪计划文档

```bash
git add ".trae/documents/MCP-WIP-探测与修复计划.md"
git commit -m "docs: archive MCP WIP execution plan"
```

（有复盘价值，归档提交）

#### 1.2 推送分支

```bash
git push -u origin codex/mcp-wip
```

#### 1.3 GitHub 创建 PR

- base: `main`
- compare: `codex/mcp-wip`
- PR 描述：
  ```
  ## Summary
  - Align FastMCP dependency declaration with tested 3.x API
  - Remove stale Context import from MCP server
  - Add FastMCP tool registration coverage
  - Add missing MCP stats tool behavior tests

  ## Verification
  - pytest tests/test_mcp_server.py → 20 passed
  - pytest tests/test_parity_stats_mcp.py tests/test_parity_routes.py tests/test_stat_spec.py → 11 passed
  - pytest tests/ → 550 passed
  ```

#### 1.4 CI 绿后合并

```bash
git checkout main
git pull --ff-only origin main
```

**约束**：不在本分支叠加任何 HTTP lifespan / lint / deploy 改动。

---

### 阶段 2：MCP HTTP lifespan 专项

**新分支**：`codex/mcp-http-lifespan`（从 main 切出）
**目标**：http 模式启动时初始化 meta DB + space engine，退出时清理
**Skill**：test-driven-development

#### 2.1 探测（不改代码）

```bash
.venv\Scripts\python.exe -m pytest tests/test_mcp_server.py -q --tb=short -p no:cacheprovider
.venv\Scripts\python.exe -m app.mcp.server --help
```

#### 2.2 TDD Red：写 HTTP 模式生命周期测试

测试目标：验证 `main()` 函数在 http 模式下会调用 `init_meta_db()` 和清理函数。

```python
# test_mcp_http_lifespan.py（新文件）
@pytest.mark.asyncio
async def test_http_mode_initializes_meta_db(monkeypatch):
    """HTTP mode main() should call init_meta_db before mcp.run."""
    # monkeypatch mcp.run 使其立即返回（不真正启动服务器）
    # monkeypatch init_meta_db / dispose_space_engine_manager / close_meta_db 记录调用
    # 调用 main(["--transport", "http", "--port", "9999"])
    # 断言 init_meta_db 被调用
    # 断言 cleanup 被调用
```

#### 2.3 TDD Green：修复 main() http 分支

文件：`backend/app/mcp/server.py`（main 函数，约 line 415-444）

改动：http 分支补齐与 stdio 对称的 init/cleanup：

```python
if args.transport == "http":
    asyncio.run(init_meta_db())
    try:
        mcp.run(transport="http", host=args.host, port=args.port)
    finally:
        asyncio.run(dispose_space_engine_manager())
        asyncio.run(close_meta_db())
```

- 修正注释：删除「HTTP mode uses lifespan」虚假文档
- 不改 FastMCP 构造（不引入 lifespan 参数，避免不确定性）

#### 2.4 验证

```bash
.venv\Scripts\python.exe -m pytest tests/test_mcp_server.py tests/test_mcp_http_lifespan.py -q --tb=short -p no:cacheprovider
.venv\Scripts\python.exe -m pytest tests/ --no-header -q --tb=short --maxfail=10 -p no:cacheprovider
```

#### 2.5 提交

```
fix(mcp): initialize resources for HTTP transport
```

**约束**：不动 sync/routes/stats/registry，不动 stdio 模式逻辑。

---

### 阶段 3：MCP lint cleanup

**新分支**：`codex/mcp-lint-cleanup`（从 main 切出）
**目标**：让 MCP 进入主工程质量门禁

#### 3.1 移除 ruff exclude

文件：`backend/pyproject.toml`（line 43-47）

改动：删除 `exclude = ["app/mcp/**", "tests/test_mcp_server.py"]` 行和注释。

#### 3.2 跑 lint，只修 MCP 相关问题

```bash
uv run ruff check app tests
```

预期问题类型（基于探索报告）：
- import order（I001）
- unused imports（F401）
- 可能的 line length（已忽略 E501）

**只修 MCP 文件**：`app/mcp/server.py`、`tests/test_mcp_server.py`，不改其他文件。

#### 3.3 验证

```bash
uv run ruff check app tests
.venv\Scripts\python.exe -m pytest tests/ --no-header -q --tb=short --maxfail=10 -p no:cacheprovider
```

#### 3.4 提交

```
chore(mcp): include MCP files in ruff lint gate
```

**约束**：不改功能逻辑，只修 lint。

---

### 阶段 4：MCP 去重复 / Spec 化

**新分支**：`codex/mcp-spec-centralize`（从 main 切出）
**目标**：减少工具、资源、测试之间的手工同步

#### 4.1 提取 MCP 工具清单常量

文件：`backend/tests/parity_helpers.py`（或新建 `backend/tests/mcp_spec.py`）

改动：把 `test_mcp_server.py` 和 `test_parity_stats_mcp.py` 中硬编码的 expected tools 集合提取为共享常量：

```python
EXPECTED_MCP_TOOLS = {
    "list_all_spaces",
    "get_stats_overview",
    "get_focus_trend",
    "get_task_distribution",
    "get_daily_detail",
    "get_habit_summary",
    "get_schedule_summary",
    "get_note_summary",
    "get_registry_health",
    "list_entities",
    "get_entity_schema",
    "get_sync_status",
    "sync_pull",
}
```

- Stats tools 继续由 `STAT_SPECS` 约束（已有）
- Registry/meta tools 由 `EXPECTED_MCP_TOOLS` 约束
- Sync tools 暂时手写（只有 2 个）

#### 4.2 测试改用共享常量

文件：`backend/tests/test_mcp_server.py`

`test_all_tools_registered_via_fastmcp` 改为引用 `EXPECTED_MCP_TOOLS`，不再内联硬编码。

#### 4.3 验证

```bash
.venv\Scripts\python.exe -m pytest tests/test_mcp_server.py tests/test_parity_stats_mcp.py -q --tb=short -p no:cacheprovider
```

#### 4.4 提交

```
refactor(mcp): centralize MCP registration expectations
```

**约束**：不做"大型动态注册"，只提取常量。不改 Service 方法签名。

---

### 阶段 5：部署基线

**新分支**：`codex/deploy-baseline`（从 main 切出）
**目标**：从"CI 能 build"进入"可部署"

#### 5.1 GHCR 推送

文件：`.github/workflows/ci.yml`

改动：build job 加 `permissions: packages: write` + `push: true`，tag 到 `ghcr.io/zc63463-cmyk/pomodoroxii-backend:latest`。

需确认：GitHub PAT 是否有 `write:packages` scope。

#### 5.2 docker compose

文件：`backend/docker-compose.yml`（新建）

```yaml
services:
  backend:
    image: ghcr.io/zc63463-cmyk/pomodoroxii-backend:latest
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
    environment:
      POMODOROXII_SECRET_KEY: ${POMODOROXII_SECRET_KEY}
      POMODOROXII_ENVIRONMENT: production
      POMODOROXII_SPACES_DATA_DIR: /app/data/spaces
```

#### 5.3 部署文档

文件：`backend/DEPLOY.md`（新建）

内容：
- 环境变量说明（SECRET_KEY / ENVIRONMENT / DATABASE_URL / SPACES_DATA_DIR）
- 初始化方式
- 数据目录备份说明
- docker compose 启动命令

#### 5.4 验证

- CI build job 推送 GHCR 成功
- 本地 `docker compose up` 能启动 + `/api/health` 返回 200

#### 5.5 提交（2 个）

```
ci: publish backend image to GHCR
docs: add backend deployment guide
```

**约束**：Cloudflare Tunnel 后置，先本机 Docker 跑通。不动安全加固（阶段 6）。

---

## 4. Assumptions & Decisions

### Assumptions

1. GitHub PAT 有 `write:packages` scope（阶段 5 需验证）
2. FastMCP 3.4.2 的 `mcp.run(transport="http")` 会阻塞当前事件循环（阶段 2 基于此假设）
3. Dockerfile 已存在且 CI build job 已验证可用（阶段 5 基于现有 CI）

### Decisions

1. **阶段 2 采用方案 2**（main() 手动 init/cleanup），不引入 FastMCP lifespan 参数
2. **阶段 3 只修 lint**，不改功能逻辑
3. **阶段 4 只提取常量**，不做动态注册
4. **阶段 5 不做 Cloudflare Tunnel**，先本机 Docker 跑通
5. **每阶段独立分支 + 独立 PR**，不混主题
6. **不使用 agent-browser skill**（本轮全后端，无前端 UI 需浏览器测试）
7. **brainstorming skill**：本计划已是 brainstorming 产物，执行阶段不再重复

### 约束边界

| 阶段 | 可改文件 | 不可改 |
|---|---|---|
| 1 | 无（仅 git 操作） | 所有代码 |
| 2 | `app/mcp/server.py`, `tests/test_mcp_*.py` | services/routes/stats/registry |
| 3 | `app/mcp/server.py`, `tests/test_mcp_server.py`, `pyproject.toml` | 功能逻辑 |
| 4 | `tests/parity_helpers.py`, `tests/test_mcp_server.py` | `app/mcp/**` |
| 5 | `.github/workflows/ci.yml`, `docker-compose.yml`, `DEPLOY.md` | 后端代码 |

---

## 5. Verification Steps

### 阶段 1 验证
- [ ] PR CI 绿
- [ ] main 合并后 `git pull --ff-only` 成功
- [ ] main 全量 pytest 550 passed

### 阶段 2 验证
- [ ] `test_mcp_http_lifespan.py` 新测试通过
- [ ] `test_mcp_server.py` 20 passed 无回归
- [ ] 全量 pytest 无回归

### 阶段 3 验证
- [ ] `uv run ruff check app tests` 全绿（含 MCP 文件）
- [ ] 全量 pytest 无回归

### 阶段 4 验证
- [ ] `EXPECTED_MCP_TOOLS` 常量被测试引用
- [ ] parity gate 无回归

### 阶段 5 验证
- [ ] CI build job 推送 GHCR 成功
- [ ] `docker compose up` + `/api/health` 200
- [ ] `DEPLOY.md` 含环境变量说明

---

## 6. 后续阶段（不在本轮范围）

| 阶段 | 内容 | 触发条件 |
|---|---|---|
| 6 | 生产安全加固（限流/CSP/secret 校验） | 阶段 5 完成 |
| 7 | 前端 MVP（React + Vite + shadcn/ui） | 阶段 6 完成 |
| 8 | 长期扩展（Goal 落库/MCP CRUD tool/Sync UI） | MVP 稳定 |
