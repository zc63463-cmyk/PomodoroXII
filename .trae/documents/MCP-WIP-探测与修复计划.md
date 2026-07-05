# MCP WIP 探测与修复计划

## 1. Summary

在 PhaseC tasks4-7 与扩展性收尾基线 CI 绿后，进入 MCP WIP 阶段。本计划分两步：先探测 `test_mcp_server.py` 的失败面，再按失败分类用 TDD 修复。严格限定范围：只碰 `backend/app/mcp/**` 和 `backend/tests/test_mcp_server.py`，不卷入已收口的 sync/routes/stats/registry 区域。

---

## 2. Current State Analysis

### 2.1 FastMCP 版本漂移（最高风险）

| 位置 | 声明 | 实际锁定 |
|---|---|---|
| `pyproject.toml:20` | `fastmcp>=2.0` | — |
| `uv.lock:396-404` | — | `fastmcp==3.4.2` |

跨大版本（2.x → 3.x），API 可能有变化：
- `FastMCP(name, instructions=...)` 构造签名
- `@mcp.tool` 裸装饰器 vs `@mcp.tool()` 是否等价
- `mcp.name` 属性路径
- `mcp.list_tools()` 返回结构
- `Context` 导入路径

### 2.2 死导入 Context

`server.py:30` 导入 `from fastmcp import FastMCP, Context`，但 `Context` 在全文件零引用。FastMCP 3.x 中 `Context` 的导入路径可能已变，会导致 `ImportError` 直接让整个 MCP 模块不可用。

### 2.3 工具注册方式

13 个工具使用裸装饰器 `@mcp.tool`（无括号），4 个资源用 `@mcp.resource("uri")`，2 个 prompt 用裸 `@mcp.prompt`。3.x 可能要求带括号形式。

### 2.4 Session Bridge 机制

- `get_space_session(space_id)` 上下文管理器：直接调 `space_manager.get_space_engine_manager()` 获取 session
- `list_spaces()`：用 `async for session in get_meta_session(): ... break` 模式（不直观）
- 绕过 FastAPI 依赖注入，独立实例化 Service

### 2.5 测试结构

14 个测试，**全部绕过 FastMCP 调度层**，直接 `await` 底层函数。不验证装饰器注册、协议层、Context 注入。唯一调用 FastMCP API 的是 `parity_helpers.py:86` 的 `server.list_tools()`。

### 2.6 已知问题清单

| 优先级 | 问题 | 位置 |
|---|---|---|
| P0 | FastMCP 3.4.2 vs `>=2.0` 声明漂移 | `pyproject.toml:20` |
| P0 | `Context` 死导入可能触发 ImportError | `server.py:30` |
| P0 | 裸 `@mcp.tool` 装饰器 3.x 兼容性 | `server.py` 13 处 |
| P0 | `mcp.name` 属性 3.x 路径 | `server.py:82`, `test_mcp_server.py` #1 |
| P1 | `test_mcp_server_has_instructions` 空断言 | `test_mcp_server.py` #2 |
| P1 | http 模式未初始化 meta DB | `server.py:428-440` |
| P1 | `get_focus_trend`/`get_daily_detail`/`get_schedule_summary` 无测试 | `test_mcp_server.py` |
| P2 | 资源与工具代码重复 | `server.py` |
| P2 | MCP 未挂载到 FastAPI | `app/main.py` |

### 2.7 与已收口区域的耦合

- **stats**：7 个工具直接调 `StatsService`，受 `STAT_SPECS` parity gate 约束
- **registry/meta**：3 个工具调 `MetaService`，无 parity 测试
- **sync**：2 个工具调 `SyncService.status/pull`，无 parity 测试
- **routes**：无代码级耦合，通过 `STAT_SPECS` 间接对齐

修复时**不得修改** Service 方法签名，否则破坏 parity gate。

---

## 3. Proposed Changes

### Phase A: 探测阶段（不修改代码）

**目的**：获取 `test_mcp_server.py` 的实际失败面，验证探索报告的假设。

#### A.1 切分支

```bash
git checkout -b codex/mcp-wip
```

#### A.2 跑现状测试

```bash
cd backend
uv run pytest tests/test_mcp_server.py -q --tb=short -p no:cacheprovider
```

#### A.3 汇报失败面

按以下格式分类每个失败：
- 失败测试名
- 错误类型（ImportError / AttributeError / AssertionError / 其他）
- 关键 traceback（1-2 行）
- 初步归类

#### A.4 预期失败场景与对应修复策略

**场景 1: ImportError（Context 导入失败）**

如果 FastMCP 3.x 改了 `Context` 的导入路径：
- 失败表现：`ImportError: cannot import name 'Context' from 'fastmcp'`
- 影响面：所有测试（模块级导入失败）
- 修复策略（TDD）：
  1. RED: 写测试 `test_mcp_module_imports_cleanly`，`import app.mcp.server` 不报错
  2. GREEN: 移除 `Context` 导入（零引用死代码）
  3. 验证：全量 14 测试可收集

**场景 2: AttributeError（mcp.name 不存在）**

如果 3.x 改了 name 属性路径：
- 失败表现：`AttributeError: 'FastMCP' object has no attribute 'name'`
- 影响面：`test_mcp_server_has_correct_name`
- 修复策略（TDD）：
  1. RED: 修改测试，断言 3.x 真实属性路径（如 `mcp.instructions` 或通过 `mcp.config` 访问）
  2. GREEN: 如需要，在 server.py 暴露兼容属性
  3. 验证：测试通过

**场景 3: 装饰器行为变化（list_tools 返回空或结构变化）**

如果裸 `@mcp.tool` 在 3.x 不再注册工具：
- 失败表现：`parity_helpers.get_actual_stats_mcp_tools()` 返回空集或缺失工具，`test_parity_stats_mcp.py` 失败
- 影响面：parity gate 测试（但不在 test_mcp_server.py 范围内）
- 修复策略（TDD）：
  1. RED: 写测试 `test_all_tools_registered`，用 `await mcp.list_tools()` 断言 13 个工具名
  2. GREEN: 把 `@mcp.tool` 改为 `@mcp.tool()`（带括号）
  3. 验证：`list_tools()` 返回 13 个工具

**场景 4: session bridge 初始化失败**

如果测试 fixture 隔离环境与 MCP 的 `get_space_session` 冲突：
- 失败表现：`RuntimeError` / DB 未找到 / space 不存在
- 影响面：需要 DB 的工具测试（#4-#12）
- 修复策略：调整测试 fixture 或 MCP session bridge 的初始化逻辑

**场景 5: 测试全绿（无失败）**

如果 3.4.2 与 2.x API 兼容：
- 结论：MCP WIP 无阻塞，直接进入测试补齐阶段（Phase C）
- 仍需修复 P0/P1 已知问题（死导入、空断言、http lifespan）

### Phase B: 核心修复（TDD，基于探测结果）

按探测阶段的实际失败面，逐个用 TDD Red-Green-Refactor 修复。

**铁律**：
- 每个修复先写失败测试（RED）
- 最小代码通过测试（GREEN）
- 不改 Service 方法签名
- 不碰 `app/mcp/` 以外的业务代码
- 不做 ruff 批量修复

#### B.1 修复 ImportError（如适用）

- 文件: `backend/app/mcp/server.py`
- 改动: 移除 `Context` 从导入行
- TDD: `test_mcp_module_imports_cleanly`

#### B.2 修复 mcp.name 属性（如适用）

- 文件: `backend/tests/test_mcp_server.py`
- 改动: 探测 3.x 真实属性路径，更新断言
- TDD: 修改 `test_mcp_server_has_correct_name` 使其失败，再修到通过

#### B.3 修复装饰器注册（如适用）

- 文件: `backend/app/mcp/server.py`
- 改动: `@mcp.tool` → `@mcp.tool()`，`@mcp.prompt` → `@mcp.prompt()`
- TDD: `test_all_tools_registered` + `test_all_prompts_registered`

#### B.4 修复 pyproject.toml 版本下限

- 文件: `backend/pyproject.toml`
- 改动: `fastmcp>=2.0` → `fastmcp>=3.0`（锁定大版本）
- 理由: 实际使用 3.x API，声明应匹配

### Phase C: 测试补齐（TDD）

补齐探索报告识别的测试盲区：

#### C.1 补齐 3 个无测试的工具

- `get_focus_trend` — 测试返回 trend 数据
- `get_daily_detail` — 测试返回某日详情
- `get_schedule_summary` — 测试返回 schedule 汇总

#### C.2 修复空断言

- `test_mcp_server_has_instructions` — 改为断言真实 instructions 属性

#### C.3 补齐 4 个资源的测试（如可行）

- `registry_health_resource`
- `all_entities_resource`
- `entity_schema_resource`
- `spaces_resource`

### Phase D: 验证

#### D.1 MCP 测试全量

```bash
cd backend
uv run pytest tests/test_mcp_server.py -q --tb=short -p no:cacheprovider
```

#### D.2 Parity gate 回归

```bash
cd backend
uv run pytest tests/test_parity_stats_mcp.py tests/test_parity_routes.py tests/test_stat_spec.py -q --tb=short -p no:cacheprovider
```

#### D.3 全量回归（确保不破坏已收口区域）

```bash
cd backend
uv run pytest tests/ --no-header -q --tb=short --maxfail=10 -p no:cacheprovider
```

#### D.4 Lint 检查（仅已收口区域）

```bash
cd backend
uv run ruff check app tests --exclude "app/mcp" --exclude "tests/test_mcp_server.py"
```

---

## 4. Assumptions & Decisions

### Assumptions

1. FastMCP 3.4.2 是当前锁定版本，修复目标为兼容 3.x
2. 测试直接 await 底层函数的模式保持不变（不改为通过 MCP 协议层调用）
3. `parity_helpers.py` 可修改（它是测试基础设施，不在"已收口区域"范围）
4. MCP 不挂载到 FastAPI（保持独立进程，Phase D 之后再决策）

### Decisions

1. **不修改 Service 方法签名**：StatsService/SyncService/MetaService 的方法签名是已收口契约，MCP 必须适配
2. **不做 ruff 批量修复**：`pyproject.toml` 的 `exclude = ["app/mcp/**", ...]` 保持不变，等 MCP 成熟后再纳入 lint
3. **不提交**：探测和修复阶段完成后，等用户确认再提交
4. **TDD 严格执行**：每个修复先 RED 再 GREEN，不写"参考代码"

### 约束边界

| 区域 | 可改 | 说明 |
|---|---|---|
| `backend/app/mcp/server.py` | ✅ | MCP 主体 |
| `backend/app/mcp/__init__.py` | ✅ | 模块导出 |
| `backend/tests/test_mcp_server.py` | ✅ | MCP 测试 |
| `backend/tests/parity_helpers.py` | ✅ | 测试基础设施（如需适配 3.x） |
| `backend/pyproject.toml` | ⚠️ 仅 fastmcp 版本下限 | 不动 ruff exclude |
| `backend/app/services/**` | ❌ | 已收口 |
| `backend/app/routes/**` | ❌ | 已收口 |
| `backend/app/registry/**` | ❌ | 已收口 |

---

## 5. Verification Steps

1. `test_mcp_server.py` 全量通过（14 + 新增测试）
2. `test_parity_stats_mcp.py` / `test_parity_routes.py` / `test_stat_spec.py` 无回归
3. 全量 pytest 无回归（544+ passed）
4. ruff check 已收口区域 clean
5. 不修改 `app/mcp/` 和 `test_mcp_server.py` 以外的业务代码
