# MCP 服务跟踪与战略指导 — 续作计划 v2

> **执行模式**: Plan Mode → 待用户批准
> **生成时间**: 2026-07-05
> **当前分支**: `codex/mcp-wip` (commit 67d78c9)
> **基线**: 544+ tests passed / main CI 绿
> **替代**: [MCP服务启动与项目全景跟踪计划.md](./MCP服务启动与项目全景跟踪计划.md) (Cognee 失败后的简化版)

---

## 1. Summary

基于 v1 计划执行受阻于 Cognee 云端 API 不稳定（cognify 全部失败、数据库未初始化、list_data 307 重定向），用户已批准**跳过 Cognee**，仅用 CBM 代码知识图谱 + 已读的 13 份核心文档 + 4 份审计报告 + 项目深度审查指导，直接生成两份交付物：

1. **项目状态全景报告** — `MCP服务跟踪-项目状态全景报告.md`
2. **8 阶段战略指导 v1** — `全局8阶段战略指导-v1.md`（后端收口为主，前端为辅）

**关键修正**：v1 计划基于的"3 项 CRITICAL 未实现 + MCP lifespan 未修复"假设已被代码探索证伪。当前实际进度更靠前，阶段 1-3 实质完成，阶段 4-6 为剩余重点。

---

## 2. Current State Analysis

### 2.1 MCP 服务实际状态

| MCP | 状态 | 证据 |
|---|---|---|
| **CBM** | ✅ 正常 | `index_status` 返回 1810 nodes / 9160 edges / ready |
| **Cognee** | ❌ 失败 | 日志 `2026-07-05_09-38-42.log` 显示 3 个 dataset cognify 全部 `Server disconnected without sending a response`；`cognify_status` 返回 `DatabaseNotCreatedError`；`list_data` 返回 307 重定向 |
| **Cognee 数据库文件** | ⚠️ 存在但未初始化 | `C:\Users\20564\.cognee\system\databases\cognee_db` 文件存在，但 `cognify_status` API 报数据库未创建 |

**Cognee 失败根因**: Cognee 1.2.2 以 API 模式连接 `https://tenant-efc4aecb-801a-4bbd-af88-1ed907b5f3b6.aws.cognee.ai`，云端 API 在 cognify 大量数据时主动断开连接（10:51:38 集中失败）。

### 2.2 项目实际进度（vs v1 计划假设）

| 阶段 | v1 计划假设 | 实际状态（代码验证） | 证据 |
|---|---|---|---|
| 阶段 1: MCP 收口 | FastMCP 兼容性问题待修 | ✅ **已完成** | [server.py:82-91](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/mcp/server.py#L82-L91) `FastMCP("PomodoroXII", instructions=...)` 构造正常；46 个 MCP 工具齐全 |
| 阶段 2: HTTP lifespan TDD 修复 | P0 风险 R1：`RuntimeError("Meta database not initialised")` | ✅ **已完成** | [server.py:428-439](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/mcp/server.py#L428-L439) `main()` 显式 `asyncio.run(init_meta_db())` + finally `dispose_space_engine_manager()` + `close_meta_db()` |
| 阶段 3: lint cleanup | ruff 配置待加 | ✅ **已完成** | [pyproject.toml:43-61](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L43-L61) `[tool.ruff]` + `[tool.ruff.lint]` + `exclude = ["app/mcp/**", "tests/test_mcp_server.py"]` |
| 阶段 4: Spec 化 EXPECTED_MCP_TOOLS | 待实现 | ⚠️ **部分实现** | `EXPECTED_MCP_TOOLS` 未找到；但 `STAT_SPECS + StatSpec` 已实现替代 stats parity（审计报告确认） |
| 阶段 5: 部署基线 GHCR | 未推送 | ⚠️ **CI 已配置，推送状态未验证** | [ci.yml:108-143](file:///e:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L108-L143) `packages: write` + `docker push ghcr.io/${{ github.repository_owner }}/pomodoroxii-backend:latest` |
| 阶段 6: 生产安全加固 | 未实现 | ❌ **未实现** | grep `slowapi\|RateLimit\|SecurityHeadersMiddleware` 无结果 |
| 阶段 7: 前端 MVP | 不存在 | ❌ **未开始** | `frontend/` 目录不存在 |
| 阶段 8: 长期扩展 | 未开始 | ❌ **未开始** | — |

### 2.3 已修复的 P0/P1 项（v1 计划误判为未修复）

| 项 | v1 假设 | 实际状态 | 证据 |
|---|---|---|---|
| 墓碑防复活检查 | CRITICAL 未实现 | ✅ 已实现 | [sync.py:231-234](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L231-L234) `if action in ("create", "update"): tomb = await TombstoneService(self.db).exists(etype, eid); if tomb is not None: return "conflict_tombstone"` |
| 客户端字段剥离 | CRITICAL 未实现 | ✅ 已实现 | [sync.py:229](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L229) `payload = strip_client_fields(payload, etype)` + [sync_safety.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync_safety.py) 实现 |
| 文件夹循环引用检测 | CRITICAL 未实现 | ✅ 已实现 | [sync.py:265, 301](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L265) `if await check_folder_circular_ref(self.db, eid, payload["parent_id"]): return "conflict_circular_ref"` |
| MCP HTTP lifespan | P0 R1 风险 | ✅ 已修复 | [server.py:430](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/mcp/server.py#L430) `asyncio.run(init_meta_db())` |

### 2.4 仍未实现的项（v1 计划未覆盖或未细化）

| 项 | 严重度 | 验证 |
|---|---|---|
| 8 个 Service 仍在 routes/v1/* 内联定义（违反三层架构） | P1 | pomodoroxii-deep-review-report.md §1.3 列出 8 个内联 Service |
| frontmatter.py 缺失（.md 文件无 YAML frontmatter） | P1 | pomodoroxii-deep-review-report.md §5.2 |
| 6 个实体删除时不创建墓碑（Session/Reflection/Habit/Schedule/TimeBlock/QuickNote） | P1 | pomodoroxii-deep-review-report.md §3.1 — 需重新验证是否已修复 |
| 认证限流（slowapi） | P1 | grep 无结果 |
| 安全响应头（X-Content-Type-Options/X-Frame-Options/HSTS） | P1 | grep 无结果 |
| sync payload Pydantic schema 校验（M3 批量赋值） | P1 | 需重新验证 |
| 弱密钥黑名单扩展 | P2 | 需重新验证 |
| APScheduler 定时任务（备份 + snapshot） | P2 | pomodoroxii-deep-review-report.md §1.2 |
| backup_service / snapshot_service / consistency_service | P2 | pomodoroxii-deep-review-report.md §1.2 |
| export/admin/search 路由 | P2 | pomodoroxii-deep-review-report.md §1.2 |

### 2.5 已读但未 cognify 的数据资产

由于跳过 Cognee，以下数据将直接用于生成报告（已在前序对话中读取）：

| 数据类型 | 数量 | 来源 |
|---|---|---|
| 核心文档 | 13 份 | `核心文档/01-深度架构规划.md` 至 `15-扩展性parity例外表.md` |
| PhaseC 交接+路线图 | 4 份 | `documents/PhaseC转接文档.md`、`documents/深度交接Prompt.md`、`documents/项目深度审查与后续行动开发指导.md`、`documents/MCP服务启动与项目全景跟踪计划.md` |
| 审计报告 | 3 份 | `审计报告/PhaseC-sync-repair-tasks4-7-completion-report.md`、`审计报告/扩展性4.5星提升-修复优化工作报告.md`、`pomodoroxii-deep-review-report.md` |
| CBM 知识图谱 | 1810 nodes / 9160 edges | `index_status` + 12 Leiden clusters（v1 计划已查询） |

---

## 3. Proposed Changes

### 阶段 C': 项目状态全景报告生成（替换原 C 阶段的双 MCP 协同）

**目的**: 用 CBM + 已读文档，直接生成项目当前状态的全景报告。

#### C'.1 CBM 补充查询（验证内联 Service + 路由注册）

| 查询 | 工具 | 目的 |
|---|---|---|
| 内联 Service 位置 | `search_graph(label="Class", file_pattern="*routes/v1/*")` | 验证 8 个 Service 是否仍在 routes 内联 |
| 路由注册清单 | `search_graph(label="Route", limit=200)` | 与 REGISTRY.route_prefix 对比 |
| MCP 工具清单 | `search_graph(label="Function", file_pattern="*mcp*")` | 与 STAT_SPECS 对比 |
| sync 调用链 | `trace_path(start="SyncService.push", end="NoteService.create")` | 验证 sync push 链路完整性 |
| 死代码检测 | `search_graph(min_degree=0, label="Function", limit=50)` | 识别未引用的 helper |

#### C'.2 生成 `MCP服务跟踪-项目状态全景报告.md`

报告结构：

```markdown
# MCP 服务跟踪 — 项目状态全景报告

## 1. 执行摘要
- 项目处于后端收口阶段，544+ 测试全绿
- 阶段 1-3 实质完成（MCP / lifespan / lint）
- 阶段 4-6 为剩余重点（Spec 化 / GHCR 推送 / 安全加固）
- 前端 MVP（阶段 7）未启动

## 2. MCP 服务运行状态
- CBM: 正常（1810/9160）
- Cognee: 失败（云端 API 不稳定，建议本地部署或换工具）

## 3. 项目实际进度矩阵（vs v1 计划）
（用 §2.2 表格）

## 4. 已闭环的 P0/P1 项
（用 §2.3 表格 + 代码引用）

## 5. 仍未闭环的 P1/P2 项
（用 §2.4 表格 + 验证建议）

## 6. CBM 知识图谱分析
- 节点/边统计
- Leiden clusters 分布（12 个 cluster）
- MCP 模块耦合度（cluster 220, 71 成员, cohesion 0.79）

## 7. 风险矩阵更新
（覆盖阶段 4-8 的 R1-R6）

## 8. 与原 5 阶段路线图的差异
（指出阶段 1-3 已完成，建议直接进入阶段 4-6）
```

#### C'.3 关键修正点

报告必须明确指出以下 v1 计划的误判：

1. ~~阶段 2 方案 2 需 TDD 修复 lifespan~~ → 已修复（直接 `asyncio.run(init_meta_db())`）
2. ~~3 项 CRITICAL 安全检查缺失~~ → 已实现（[sync.py:229-301](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L229-L301)）
3. ~~阶段 4 EXPECTED_MCP_TOOLS 需提取~~ → STAT_SPECS 已替代 stats parity
4. Cognee 不可用 → 转向 CBM + 文档直读

---

### 阶段 D': 8 阶段战略指导（后端收口为主，前端为辅）

**目的**: 基于实际进度，给出阶段 4-6 的 P0 行动项 + 阶段 7-8 的简略建议。

#### D'.1 阶段 1-3 复核结论（已完成，仅记录）

| 阶段 | 完成证据 | 后续行动 |
|---|---|---|
| 1: MCP 收口 | [server.py:82-91](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/mcp/server.py#L82-L91) FastMCP 构造正常，46 工具齐全 | 无 |
| 2: HTTP lifespan | [server.py:428-439](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/mcp/server.py#L428-L439) `asyncio.run(init_meta_db())` + finally cleanup | 无（可选：补 TDD 测试覆盖 lifespan） |
| 3: lint cleanup | [pyproject.toml:43-61](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L43-L61) ruff 配置完整 + `exclude = ["app/mcp/**", "tests/test_mcp_server.py"]` | 无 |

#### D'.2 阶段 4: Spec 化 EXPECTED_MCP_TOOLS — **重新评估**

**原计划**: 提取 `EXPECTED_MCP_TOOLS` 常量做 parity gate。

**实际状态**:
- `EXPECTED_MCP_TOOLS` 未实现
- 但 `STAT_SPECS + StatSpec`（[stats_spec.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/stats_spec.py)）已实现 7 维度 stats parity
- `parity_helpers.py` 的 `get_registered_mcp_tool_names()` 已用 `mcp.list_tools()` 自省（审计报告 §3.4）

**建议行动**:
1. **P2**: 评估是否仍需 `EXPECTED_MCP_TOOLS` — 若 `STAT_SPECS` + `mcp.list_tools()` 自省已覆盖 parity，则可关闭此阶段
2. **P1**: 若需补强，提取非 stats 工具（如 `list_all_spaces`）到 `EXPECTED_MCP_TOOLS` 常量，添加 parity test

#### D'.3 阶段 5: 部署基线 GHCR — **CI 已配置，需验证首次推送**

**CI 配置已就绪** ([ci.yml:108-143](file:///e:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L108-L143)):
- `permissions: packages: write`
- `docker buildx build --push ghcr.io/${{ github.repository_owner }}/pomodoroxii-backend:latest`

**待验证**:
1. GitHub PAT 是否有 `write:packages` scope
2. 首次 push main 后 GHCR 镜像是否生成
3. 镜像 size 是否合理（预估 200-400 MB）
4. `docker pull ghcr.io/zc63463-cmyk/pomodoroxii-backend:latest` 是否可拉取

**P1 行动项**:
- 推送 main 触发 CI → 检查 GHCR 镜像生成 → 拉取验证

#### D'.4 阶段 6: 生产安全加固 — **未实现，P0**

**未实现的 P0/P1 项**（基于 [pomodoroxii-deep-review-report.md](file:///e:/Development/MyAwesomeApp/PomodoroXII/pomodoroxii-deep-review-report.md) §四）:

| 项 | 严重度 | 建议实现 |
|---|---|---|
| 认证限流（M1） | P0 | 引入 `slowapi`，对 `/auth/login` 限流 5次/分钟/IP |
| 安全响应头（M2） | P0 | 实现 `SecurityHeadersMiddleware`：`X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` + `Strict-Transport-Security: max-age=31536000` |
| sync payload schema 校验（M3） | P1 | 用 Pydantic schema 替代 `dict[str, Any]`，字段白名单 |
| 弱密钥黑名单（M5） | P1 | 扩展黑名单或要求 `len(secret_key) >= 32` |
| setup 竞态（M4） | P2 | 捕获 `IntegrityError` 返回 409 |

**P0 行动项**:
1. 添加 `slowapi` 依赖 + 配置 `/auth/login` 限流
2. 实现 `SecurityHeadersMiddleware` 并在 `main.py` 注册
3. 为限流和安全头添加测试

#### D'.5 阶段 7: 前端 MVP — **未开始，仅给技术栈选型**

用户偏好: React > Vue3，memos-style 布局，subtle shadows + unified borders。

| 子阶段 | 技术栈 | 备注 |
|---|---|---|
| 7.1 脚手架 | Next.js 15 (App Router) + Tailwind CSS 4 + shadcn/ui | 用户偏好 React |
| 7.2 认证 | NextAuth.js v5 + 双 JWT（master + space） | 复用后端 `/auth/*` |
| 7.3 番茄钟核心 | React Server Components + Server Actions | 调用 `/api/v1/sessions/*` |
| 7.4 小记 feature | memos-style 布局 + subtle shadows | 用户明确偏好 |
| 7.5 部署 | Vercel (前端) + Cloudflare Tunnel (后端) | 与阶段 5 GHCR 协同 |

**说明**: 阶段 7 为建议性，不在本次执行范围内。详细实施计划待阶段 6 完成后单独规划。

#### D'.6 阶段 8: 长期扩展 — **未开始，简略**

| 项 | 触发条件 | 优先级 |
|---|---|---|
| Goal 落库 + GoalService | 阶段 7 稳定 | P2 |
| MCP CRUD tool（从 read-only 扩展为 read-write） | 阶段 7 稳定 | P2 |
| APScheduler（备份 + snapshot） | 阶段 5 完成 | P1 |
| backup_service / snapshot_service / consistency_service | 阶段 6 完成 | P1 |
| 8 个内联 Service 移入 services/ 目录 | 阶段 6 完成 | P1 |
| frontmatter.py 实现（.md YAML frontmatter） | 阶段 7.4 完成 | P1 |
| export/admin/search 路由 | 阶段 7 完成 | P2 |
| Multi-tenant（单用户 → 多租户） | 商业化需求 | P3 |

#### D'.7 阶段依赖图（基于 CBM 验证）

```
[已完成] 阶段1(MCP收口) ──→ [已完成] 阶段2(HTTP lifespan) ──→ [已完成] 阶段3(lint)
                                                                          │
                                                                          ↓
[待评估] 阶段4(Spec化) ←─────────────────────────────────────────────────┘
                │
                ↓
[待验证] 阶段5(GHCR推送) ──→ [未实现,P0] 阶段6(安全加固) ──→ [未开始] 阶段7(前端MVP,建议性)
                                                              │
                                                              ↓
                                                      [未开始] 阶段8(长期扩展)
```

#### D'.8 生成 `全局8阶段战略指导-v1.md`

报告结构：

```markdown
# 全局 8 阶段战略指导 v1

## 1. 执行摘要
- 阶段 1-3 已完成
- 阶段 4 需重新评估（STAT_SPECS 已替代部分需求）
- 阶段 5 CI 已配置，需验证首次推送
- 阶段 6 为 P0（限流 + 安全头）
- 阶段 7-8 为建议性

## 2. 阶段 1-3 完成证据
（用 D'.1 表格）

## 3. 阶段 4 重新评估
（用 D'.2 内容）

## 4. 阶段 5 GHCR 推送验证清单
（用 D'.3 内容）

## 5. 阶段 6 P0 行动项
（用 D'.4 内容 + 代码示例）

## 6. 阶段 7 前端 MVP 技术栈选型（建议性）
（用 D'.5 内容）

## 7. 阶段 8 长期扩展清单
（用 D'.6 内容）

## 8. 阶段依赖图
（用 D'.7 图示）

## 9. 风险矩阵（覆盖阶段 4-8）
| ID | 风险 | 阶段 | 级别 | 缓解 |
|---|---|---|---|---|
| R1 | GitHub PAT 缺 `write:packages` scope | 5 | P0 | 验证 PAT scope |
| R2 | slowapi 与 async FastAPI 兼容性 | 6 | P1 | 验证 slowapi 0.1.9+ 支持 async |
| R3 | 前端 NextAuth.js 与后端双 JWT 集成复杂度 | 7 | P2 | 单独规划 |
| R4 | APScheduler 与 FastAPI lifespan 集成 | 8 | P1 | 参考 fabioferreira/apscheduler-fastapi |
| R5 | 8 个内联 Service 迁移可能破坏现有测试 | 8 | P1 | TDD 先行 |

## 10. 优先级建议
- **P0（立即执行）**: 阶段 5 GHCR 验证 + 阶段 6 限流/安全头
- **P1（1-2 周内）**: 阶段 4 评估 + 阶段 8 内联 Service 迁移 + APScheduler
- **P2（后续迭代）**: 阶段 7 前端 MVP + 阶段 8 长期扩展
```

---

## 4. Assumptions & Decisions

### Assumptions

1. **Cognee 完全跳过**: 用户已批准，本次执行不再调用任何 Cognee 工具
2. **CBM 索引新鲜度**: 1810/9160 反映 codex/mcp-wip 分支当前状态（v1 计划已确认 `changed_count = 0`）
3. **已读文档可用**: 13 份核心文档 + 4 份交接路线图 + 3 份审计报告内容已在对话上下文中
4. **代码探索已充分**: §2.2-2.4 的进度矩阵基于实际 grep/read 验证，非假设
5. **GHCR 推送状态**: CI 配置已就绪，但首次推送是否成功需在执行阶段验证
6. **8 个内联 Service 仍存在**: 基于 [pomodoroxii-deep-review-report.md](file:///e:/Development/MyAwesomeApp/PomodoroXII/pomodoroxii-deep-review-report.md) §1.3，需在执行阶段用 CBM `search_graph` 复核

### Decisions

1. **跳过 Cognee**: 用户决策 — 云端 API 不稳定，无法依赖
2. **后端收口为主**: 用户决策 — 阶段 4-6 详细，阶段 7-8 简略
3. **不修改业务代码**: 本计划仅生成 `.trae/documents/` 下的两份报告文档
4. **不再生成 Cognee dataset**: `pomodoroxii_core_docs` / `_handover` / `_audit` / `_code` 全部放弃
5. **阶段 4 重新评估**: 不强制实现 `EXPECTED_MCP_TOOLS`，若 `STAT_SPECS` 已覆盖则关闭
6. **阶段 7 为建议性**: 不展开实施细节，仅给技术栈选型

### 约束边界

| 阶段 | 可改文件 | 不可改 |
|---|---|---|
| C' | `.trae/documents/MCP服务跟踪-项目状态全景报告.md`（新建） | 所有代码 |
| D' | `.trae/documents/全局8阶段战略指导-v1.md`（新建） | 所有代码 |

---

## 5. Verification Steps

### 阶段 C' 验证（项目状态全景报告）

- [ ] CBM 补充查询全部完成（5 个查询）
- [ ] 报告包含 §2.2 进度矩阵（基于代码验证，非假设）
- [ ] 报告明确指出 v1 计划的 4 处误判（§C'.3）
- [ ] 报告包含 CBM 知识图谱统计（节点/边/cluster）
- [ ] 报告包含风险矩阵（覆盖阶段 4-8）

### 阶段 D' 验证（8 阶段战略指导）

- [ ] 阶段 1-3 完成证据完整（含代码引用）
- [ ] 阶段 4 重新评估结论明确（是否仍需 EXPECTED_MCP_TOOLS）
- [ ] 阶段 5 GHCR 验证清单可执行（4 个验证项）
- [ ] 阶段 6 P0 行动项含代码示例（slowapi + SecurityHeadersMiddleware）
- [ ] 阶段 7-8 为建议性，不展开实施细节
- [ ] 阶段依赖图基于 CBM 验证
- [ ] 风险矩阵覆盖全部 8 阶段

### 退出条件

1. ✅ `MCP服务跟踪-项目状态全景报告.md` 已生成且包含 §C'.2 全部章节
2. ✅ `全局8阶段战略指导-v1.md` 已生成且包含 §D'.8 全部章节
3. ✅ 阶段 1-2 的 P0 行动项明确可执行（GHCR 验证 + 安全加固）
4. ✅ 报告中所有代码引用使用 `file:///` 协议可点击

---

## 6. 执行顺序

| 顺序 | 阶段 | 操作 | 工具 | 阻塞性 |
|---|---|---|---|---|
| 1 | C'.1 | CBM 补充查询（5 个查询） | `run_mcp` × 5 | 是（C'.2 依赖） |
| 2 | C'.2 | 生成 `MCP服务跟踪-项目状态全景报告.md` | `Write` | 是 |
| 3 | D'.1-D'.7 | 整理战略指导内容（基于 C'.1 结果） | — | 否 |
| 4 | D'.8 | 生成 `全局8阶段战略指导-v1.md` | `Write` | 否 |

**总操作**: ~5 次 CBM 查询 + 2 次 Write
**预估时间**: 5-10 分钟

---

## 7. 退出条件（最终）

1. ✅ 用户批准本计划
2. ✅ 执行阶段 C'.1-C'.2 生成项目状态全景报告
3. ✅ 执行阶段 D'.1-D'.8 生成 8 阶段战略指导
4. ✅ 两份报告均包含可执行的 P0 行动项（GHCR 验证 + 安全加固）
5. ✅ 不修改任何业务代码（仅 `.trae/documents/` 下两份新文档）
