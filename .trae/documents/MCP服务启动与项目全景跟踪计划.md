# MCP 服务启动与项目全景跟踪计划

> **执行模式**: Plan Mode → 用户已批准
> **生成时间**: 2026-07-05
> **当前分支**: `codex/mcp-wip` (commit 67d78c9)
> **基线**: 550 tests passed / main CI 绿

---

## 1. Summary

启动 agent 自带的两个 MCP 服务(CBM 与 Cognee)用于跟踪 PomodoroXII 项目进度,通过 CBM 代码知识图谱 + Cognee 语义知识图谱双视角,生成项目当前状态全景报告,并基于现有 5 阶段路线图扩展为覆盖阶段 1-8 的全局战略指导(含前端 MVP 与长期扩展)。

**核心动作**:
1. 重新索引 CBM 到 `codex/mcp-wip` 分支当前状态(full mode,2-5 分钟)
2. 初始化 Cognee 数据库并分批 cognify 4 类数据(核心文档/交接路线图/审计报告/代码模块)
3. 用 CBM 查询 + Cognee recall 交叉验证项目状态,生成全景报告
4. 输出阶段 1-8 全局战略指导,含依赖图、风险矩阵、优先级建议

---

## 2. Current State Analysis

### 2.1 CBM (Codebase Memory MCP) 现状

| 维度 | 状态 |
|---|---|
| 索引项目 | `E-Development-MyAwesomeApp-PomodoroXII-backend` |
| 节点/边 | 1810 nodes / 9160 edges / ~10MB |
| 索引基线 | `main` 分支 (a8b367a) |
| 当前分支 | `codex/mcp-wip` (67d78c9) |
| 变更检测 | 3 文件 (server.py, pyproject.toml, test_mcp_server.py),impacted_symbols 为空 |
| 问题 | 索引滞后,无法反映 MCP 修复后的真实代码结构 |

**可用只读工具**: `search_graph`, `get_architecture`, `query_graph`, `trace_path`, `get_code_snippet`, `search_code`

### 2.2 Cognee 现状

| 维度 | 状态 |
|---|---|
| 数据库 | **未创建** (`DatabaseNotCreatedError: please call await setup() first`) |
| 已 cognify 数据 | 无 |
| 可用工具 | 仅 `cognify_status` 返回错误 |
| 待 cognify 数据 | 核心文档(13份) + 交接/路线图(4份) + 审计报告(2份) + 代码关键模块 |

**关键阻塞**: 必须先 `cognify()` 写入数据,才能 `search()` / `recall()` 查询。

### 2.3 项目进度基线

| 项 | 状态 |
|---|---|
| main 分支 | PhaseC tasks4-7 + 扩展性 4.5 星 + CI #1 绿 (a8b367a) |
| codex/mcp-wip 分支 | FastMCP 兼容性修复 + 测试增强 (67d78c9),本地 550 passed |
| 未跟踪文件 | `.trae/documents/MCP-WIP-探测与修复计划.md` (旧探测计划,已执行) + 本计划文件 |
| 远端 | `origin = https://github.com/zc63463-cmyk/PomodoroXII.git`,main 已推送 |
| MCP HTTP 模式 | **未初始化 meta DB** (server.py:428 注释虚假,实际无 lifespan) |
| MCP ruff | `exclude = ["app/mcp/**", "tests/test_mcp_server.py"]` |
| Docker/CI | build job 有 smoke test,未推 GHCR |
| 前端 | 不存在 |

### 2.4 已识别风险

| ID | 风险 | 来源 | 级别 |
|---|---|---|---|
| R1 | MCP HTTP 模式启动后 `RuntimeError("Meta database not initialised")` | server.py:428-444 + 探索报告 | P0 |
| R2 | Cognee cognify 大量数据时 LLM API 成本失控 | 用户选择 cognify 全部4类 | P1 |
| R3 | CBM full re-index 阻塞主线程 2-5 分钟 | 工具特性 | P1 |
| R4 | 路线图阶段2基于"FastMCP 3.4.2 mcp.run() 阻塞"假设,未实证 | 多阶段路线图 §4 Assumptions | P1 |
| R5 | 5 阶段路线图未覆盖前端 MVP 实施细节 | 用户选"全局含前端" | P2 |

---

## 3. Proposed Changes

### 阶段 A: CBM 重索引(同步代码知识图谱)

**目的**: 让 CBM 知识图谱反映 `codex/mcp-wip` 分支当前真实代码结构。

#### A.1 执行重索引

```python
# 通过 run_mcp 调用 CBM
run_mcp(
  server_name="mcp_codebase-memory-mcp",
  tool_name="index_repository",
  args={
    "repo_path": "E:/Development/MyAwesomeApp/PomodoroXII/backend",
    "mode": "full",
    "persistence": True  # 写入 .codebase-memory/graph.db.zst 供团队共享
  }
)
```

**预期产出**:
- 节点数从 1810 增长(预估 1900-2100,因 MCP server.py 测试增加)
- 边数从 9160 增长(预估 9500-10000)
- `impacted_symbols` 不再为空
- 团队 artifact 更新到 `backend/.codebase-memory/graph.db.zst`

#### A.2 验证索引新鲜度

```python
# 通过 run_mcp 调用 CBM detect_changes
run_mcp(
  server_name="mcp_codebase-memory-mcp",
  tool_name="detect_changes",
  args={"project": "E-Development-MyAwesomeApp-PomodoroXII-backend", "base_branch": "main", "depth": 2}
)
```

**预期**: `changed_count = 0`,impacted_symbols 反映真实影响范围。

#### A.3 用 CBM 探索 MCP 模块架构

```python
# 通过 run_mcp 调用 CBM get_architecture
run_mcp(
  server_name="mcp_codebase-memory-mcp",
  tool_name="get_architecture",
  args={"project": "E-Development-MyAwesomeApp-PomodoroXII-backend", "aspects": ["clusters"]}
)
```

**目的**: 识别 MCP 模块在 Leiden 社区检测中的归属,验证"已收口区域 vs MCP WIP"边界。

---

### 阶段 B: Cognee 初始化与分批 cognify

**目的**: 建立项目语义知识图谱,支撑跨文档关联查询。

#### B.1 第一批: 核心文档 13 份(优先级最高,~15-25K tokens)

按依赖顺序 cognify,每批 2-3 份避免单次 LLM 调用过载:

| 批次 | 文档 | 路径 | 主题 |
|---|---|---|---|
| B1.1 | 01-深度架构规划 + 02-技术栈升级推荐 | `核心文档/01-*.md`, `核心文档/02-*.md` | 三层铁律 + 技术选型 |
| B1.2 | 03-子功能定位 + 04-数据管理 | `核心文档/03-*.md`, `核心文档/04-*.md` | 模块边界 + 数据流 |
| B1.3 | 05-file_system 移植 + 06-缺陷修正 | `核心文档/05-*.md`, `核心文档/06-*.md` | 文件系统 + 8 缺陷 |
| B1.4 | 07-元数据方案 + 08-元数据现状 | `核心文档/07-*.md`, `核心文档/08-*.md` | 元数据可移植性 |
| B1.5 | 09-核心审查 + 10-用户扩展 | `核心文档/09-*.md`, `核心文档/10-*.md` | 审查报告 + 扩展 |
| B1.6 | 11-平台愿景 + 12-AI编码规范 | `核心文档/11-*.md`, `核心文档/12-*.md` | 愿景 + AI 规范 |
| B1.7 | 13-多空间架构 + 14-扩展性规划 + 15-parity例外表 | `核心文档/13-*.md`, `核心文档/14-*.md`, `核心文档/15-*.md` | 多空间 + 扩展性 |

```python
# 每批调用模式
run_mcp(
  server_name="mcp_cognee-mcp",
  tool_name="cognify",
  args={
    "data": "<文档1内容>\n\n---\n\n<文档2内容>",
    "dataset_name": "pomodoroxii_core_docs"
  }
)
# 调用 cognify_status 轮询直到完成
run_mcp(
  server_name="mcp_cognee-mcp",
  tool_name="cognify_status",
  args={"dataset_name": "pomodoroxii_core_docs"}
)
```

#### B.2 第二批: PhaseC 交接 + 路线图(~10-20K tokens)

| 批次 | 文档 | 路径 |
|---|---|---|
| B2.1 | PhaseC 转接文档 | `documents/PhaseC转接文档.md` |
| B2.2 | 深度交接 Prompt | `documents/深度交接Prompt.md`, `.trae/documents/深度交接Prompt.md` |
| B2.3 | 多阶段路线图 | `.trae/documents/多阶段路线图-收口到部署MVP.md` |
| B2.4 | MCP-WIP 探测计划(已执行) | `.trae/documents/MCP-WIP-探测与修复计划.md` |

```python
run_mcp(
  server_name="mcp_cognee-mcp",
  tool_name="cognify",
  args={"data": "<内容>", "dataset_name": "pomodoroxii_handover"}
)
```

#### B.3 第三批: 审计报告 + 完成报告(~8-12K tokens)

| 批次 | 文档 | 路径 |
|---|---|---|
| B3.1 | PhaseC sync 修复 tasks4-7 完成报告 | `审计报告/PhaseC-sync-repair-tasks4-7-completion-report.md` |
| B3.2 | 扩展性 4.5 星提升报告 | `审计报告/扩展性4.5星提升-修复优化工作报告.md` |
| B3.3 | 项目深度审查报告 | `pomodoroxii-deep-review-report.md` |
| B3.4 | 独立复核版 + v2 | `深度审查报告-独立复核版.md`, `深度审查报告v2.md` |

```python
run_mcp(
  server_name="mcp_cognee-mcp",
  tool_name="cognify",
  args={"data": "<内容>", "dataset_name": "pomodoroxii_audit"}
)
```

#### B.4 第四批: 代码关键模块摘要(~30-50K tokens,最大批次)

不直接 cognify 全部源码,而是 cognify 关键模块的**职责摘要**(避免 token 爆炸):

| 批次 | 模块 | 摘要来源 |
|---|---|---|
| B4.1 | MCP server.py | `server.py` 顶部 docstring + 工具清单 + 探索报告 §2 |
| B4.2 | main.py + deps.py + middleware.py | 模块级 docstring + 路由注册 |
| B4.3 | services/* | 各 service 类 docstring + 方法签名清单 |
| B4.4 | routes/v1/* | 路由前缀 + endpoint 清单(用 CBM `search_graph` 提取) |
| B4.5 | registry/builtin.py | 实体元数据 + route_enabled + route_prefix |
| B4.6 | sync 相关 (services/sync.py + routes/sync.py + sync_registry.py) | 现有 sync 引擎设计摘要 |

```python
# 用 CBM 提取代码摘要后再 cognify
# 1. 用 search_graph 找出所有 Routes
run_mcp(
  server_name="mcp_codebase-memory-mcp",
  tool_name="search_graph",
  args={"project": "E-Development-MyAwesomeApp-PomodoroXII-backend", "label": "Route", "limit": 200}
)
# 2. 把摘要送入 Cognee
run_mcp(
  server_name="mcp_cognee-mcp",
  tool_name="cognify",
  args={"data": "<摘要>", "dataset_name": "pomodoroxii_code"}
)
```

#### B.5 cognify 全部完成后验证

```python
# 用 recall 测试知识图谱可用性
run_mcp(
  server_name="mcp_cognee-mcp",
  tool_name="recall",
  args={"query": "MCP HTTP 模式为何会触发 RuntimeError? 涉及哪些文件?", "top_k": 5}
)
```

**预期**: 返回 server.py:428-444、init_meta_db、lifespan、main() 等关键节点关联。

---

### 阶段 C: 双 MCP 协同查询生成项目状态报告

**目的**: 用 CBM + Cognee 交叉验证,生成可交付的项目状态报告。

#### C.1 CBM 视角: 代码结构 + 依赖耦合

| 查询 | 工具 | 目的 |
|---|---|---|
| MCP 模块外部依赖 | `search_graph(relationship="IMPORTS", file_pattern="*mcp*")` | 验证 MCP 是否耦合已收口区域 |
| StatsService 调用方 | `search_graph(query="StatsService", include_connected=True)` | 验证 stats parity gate 完整性 |
| 已收口区域 cluster | `get_architecture(aspects=["clusters"])` | 识别 Leiden 社区,验证模块边界 |
| sync 路径追踪 | `trace_path(start="SyncService.pull", end="NoteService.create")` | 验证 sync push 链路无 P0 风险 |
| 未引用代码 | `search_graph(min_degree=0, label="Function")` | 识别死代码 |

#### C.2 Cognee 视角: 跨文档关联 + 历史决策追溯

| 查询 | 工具 | 目的 |
|---|---|---|
| MCP 设计原意 | `recall(query="MCP server 设计目标与传输模式")` | 验证当前实现是否符合设计 |
| PhaseC 历史决策 | `recall(query="PhaseC tasks4-7 解决了什么问题,如何解决")` | 避免重复踩坑 |
| 8 缺陷修复状态 | `recall(query="06 文档 8 个缺陷的修复进度")` | 验证是否全部闭环 |
| 多空间架构约束 | `recall(query="SpaceEngineManager 的 LRU 和 double-check 设计原因")` | 阶段 2 HTTP lifespan 修复需遵守 |
| 扩展性 4.5 星未完成项 | `recall(query="扩展性 4.5 星提升还有哪些未完成项")` | 识别阶段 4 范围 |

#### C.3 生成状态报告

输出到 `.trae/documents/MCP服务跟踪-项目状态全景报告.md`,包含:
1. CBM 代码知识图谱统计(节点/边/cluster)
2. Cognee 知识图谱统计(cognify 数据量/数据集)
3. CBM + Cognee 交叉验证结果
4. 与现有 5 阶段路线图的差异分析
5. 风险矩阵更新

---

### 阶段 D: 全局 8 阶段战略指导(覆盖前端 MVP)

**目的**: 把现有 5 阶段路线图扩展为 8 阶段全局战略,补充前端 MVP 与长期扩展细节。

#### D.1 阶段 1-5 复核(基于 Cognee 历史决策)

用 Cognee `recall` 验证现有 5 阶段路线图的每个决策:
- 阶段 2 方案 2(main 手动 init/cleanup)是否最优?是否漏掉 FastMCP lifespan 实证?
- 阶段 4 提取 `EXPECTED_MCP_TOOLS` 是否会与 `STAT_SPECS` parity gate 冲突?
- 阶段 5 GHCR 推送是否需要先验证 PAT scope?

#### D.2 阶段 6: 生产安全加固(扩展)

基于 Cognee `recall` 检索安全相关历史决策:
- `recall(query="认证限流 安全响应头 CSP secret 校验 设计")`
- 补充: rate limit 中间件、CSP 头、secret_key production 校验、HTTPS 强制
- 关联: `app/auth/security.py`, `app/middleware.py`

#### D.3 阶段 7: 前端 MVP(扩展,基于用户偏好)

用户偏好: React > Vue3,memos-style 布局,subtle shadows + unified borders。

| 子阶段 | 内容 | 技术栈 |
|---|---|---|
| 7.1 | 脚手架 + 设计系统 | Next.js 15 + Tailwind + shadcn/ui |
| 7.2 | 认证 + 多空间切换 | NextAuth.js + 双 JWT |
| 7.3 | 番茄钟核心(session + task + time_block) | React Server Components + Server Actions |
| 7.4 | 小记 feature (memos-style) | 详见 user_profile 偏好 |
| 7.5 | 反思 / 习惯 / 快捷笔记 | 复用后端 routes/v1/* |
| 7.6 | 同步 UI(可选) | 调用 /api/v1/sync/* |
| 7.7 | 部署(Vercel + Cloudflare Tunnel) | 与阶段 5 GHCR 协同 |

#### D.4 阶段 8: 长期扩展(扩展)

| 项 | 内容 | 触发条件 |
|---|---|---|
| Goal 落库 | GoalService + Goal CRUD | 阶段 7 稳定 |
| MCP CRUD tool | 从 read-only 扩展为 read-write | 阶段 7 稳定 |
| Sync UI | 可视化冲突解决 | 阶段 7.6 完成 |
| APScheduler | 定时备份 + snapshot | 阶段 5 完成后 |
| Multi-tenant | 单用户 → 多租户 | 商业化需求 |

#### D.5 战略依赖图(用 CBM 验证)

```python
# 用 CBM trace_path 验证阶段间依赖
run_mcp(
  server_name="mcp_codebase-memory-mcp",
  tool_name="trace_path",
  args={"project": "E-Development-MyAwesomeApp-PomodoroXII-backend", "start": "<阶段N入口>", "end": "<阶段N+1入口>"}
)
```

输出阶段依赖图:
```
阶段1(MCP收口) ──→ 阶段2(HTTP lifespan) ──→ 阶段3(lint) ──→ 阶段4(Spec化)
                                                                      │
                                                                      ↓
阶段6(安全) ←── 阶段5(部署基线) ←─────────────────────────────────────┘
                │
                ↓
        阶段7(前端 MVP) ──→ 阶段8(长期扩展)
```

#### D.6 输出全局战略指导文档

输出到 `.trae/documents/全局8阶段战略指导-v1.md`,包含:
1. 现有 5 阶段复核结论(基于 Cognee 历史决策)
2. 阶段 6/7/8 详细扩展
3. 阶段依赖图(基于 CBM 验证)
4. 风险矩阵(覆盖全部 8 阶段)
5. 优先级建议(P0/P1/P2)

---

## 4. Assumptions & Decisions

### Assumptions

1. **CBM full mode 重索引**: 2-5 分钟内完成,不阻塞主线程
2. **Cognee cognify**: LLM_API_KEY 已配置(否则 cognify 会失败)
3. **文档读取**: 13 份核心文档每份平均 5-15K tokens,总计 ~80-150K tokens
4. **代码摘要**: 用 CBM 提取摘要后再 cognify,避免直接 cognify 全部源码(~500K+ tokens)
5. **Cognee 数据集**: 用 4 个独立 dataset 隔离不同类型数据,便于后续删除/更新
6. **GitHub PAT**: 阶段 5 GHCR 推送需 `write:packages` scope(阶段 5 时验证)

### Decisions

1. **CBM 使用 full mode**: 用户明确选择,接受 2-5 分钟代价
2. **Cognee 分 4 批 cognify**: 避免单次 LLM 调用过载,每批可独立验证
3. **代码用摘要 cognify**: 不直接 cognify 源码,用 CBM 提取摘要后送入 Cognee
4. **不修改业务代码**: 本计划仅写 `.trae/documents/` 下的报告文档,不动 `backend/`
5. **8 阶段全局指导**: 覆盖前端 MVP,但前端阶段(7)为建议性,不强制立即执行
6. **优先级**: 阶段 1-2 为 P0(阻塞 MCP WIP 收口),阶段 3-5 为 P1,阶段 6-8 为 P2
7. **brainstorming skill**: 本计划已是 brainstorming 产物,执行阶段不再重复

### 约束边界

| 阶段 | 可改文件 | 不可改 |
|---|---|---|
| A | 无(只读 CBM) | 所有代码 |
| B | 无(只 cognify 数据) | 所有代码 |
| C | `.trae/documents/MCP服务跟踪-项目状态全景报告.md` (新建) | 所有代码 |
| D | `.trae/documents/全局8阶段战略指导-v1.md` (新建) | 所有代码 |

---

## 5. Verification Steps

### 阶段 A 验证(CBM 重索引)
- [ ] `index_repository` 返回 success,无错误
- [ ] `detect_changes` 返回 `changed_count = 0`
- [ ] `get_architecture` 返回的 cluster 列表包含 MCP 模块
- [ ] `search_graph(label="Route", file_pattern="*mcp*")` 返回非空结果

### 阶段 B 验证(Cognee 初始化)
- [ ] `cognify_status` 不再返回 `DatabaseNotCreatedError`
- [ ] 4 个 dataset(`pomodoroxii_core_docs`, `_handover`, `_audit`, `_code`)均完成
- [ ] `recall(query="MCP HTTP 模式 RuntimeError")` 返回相关结果

### 阶段 C 验证(状态报告)
- [ ] `.trae/documents/MCP服务跟踪-项目状态全景报告.md` 已生成
- [ ] 报告包含 CBM + Cognee 双视角数据
- [ ] 报告与现有 5 阶段路线图差异分析完整

### 阶段 D 验证(全局战略指导)
- [ ] `.trae/documents/全局8阶段战略指导-v1.md` 已生成
- [ ] 阶段 6/7/8 详细扩展内容完整
- [ ] 阶段依赖图基于 CBM 验证
- [ ] 风险矩阵覆盖全部 8 阶段

---

## 6. 执行顺序与预估代价

| 顺序 | 阶段 | 估时 | LLM 调用代价 | 阻塞性 |
|---|---|---|---|---|
| 1 | A.1 CBM 重索引 | 2-5 min | 0 | 是(后续 CBM 查询依赖) |
| 2 | A.2-A.3 CBM 验证+架构查询 | 30s | 0 | 否 |
| 3 | B.1 核心文档 cognify (7批) | 5-10 min | 高(7次 LLM 调用) | 否(可异步) |
| 4 | B.2 交接+路线图 cognify (4批) | 3-5 min | 中(4次) | 否 |
| 5 | B.3 审计报告 cognify (4批) | 3-5 min | 中(4次) | 否 |
| 6 | B.4 代码摘要 cognify (6批) | 5-10 min | 高(6次+CBM查询) | 否 |
| 7 | B.5 Cognee 验证 | 30s | 低 | 是(阶段C依赖) |
| 8 | C 双 MCP 协同查询 | 2-3 min | 低 | 是 |
| 9 | D 全局8阶段战略指导 | 5-10 min | 低 | 否 |

**总估时**: 25-50 分钟
**总 LLM 调用**: ~25-30 次 cognify + 10-15 次 recall/search

---

## 7. 退出条件

1. ✅ CBM 索引反映 codex/mcp-wip 分支当前状态
2. ✅ Cognee 4 个 dataset 完成 cognify
3. ✅ 生成 `MCP服务跟踪-项目状态全景报告.md`
4. ✅ 生成 `全局8阶段战略指导-v1.md`
5. ✅ 阶段 1-2(用户当前关注)的 P0 行动项明确可执行
