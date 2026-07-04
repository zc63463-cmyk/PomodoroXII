# PomodoroXII 项目深度审查报告

> ⚠️ **本文档部分内容已过时（2026-07-04 下午更新）**
>
> §TL;DR 和 §二中提到的 **3 项 CRITICAL**（墓碑防复活、客户端字段剥离、循环引用检测）
> 以及「8 个实体删除时不创建墓碑」**均已在当前工作树修复**。请参阅：
> - `PhaseC审计报告.md` — 逐项 PASS/FAIL 审计（全部 PASS）
> - `深度审查报告-独立复核版.md` — 纠正版完整审查报告
>
> 以下内容保留原文以供历史参考，但 **TL;DR 和 §二的 CRITICAL/MAJOR 结论已失效**。
>
> ---
>
> 审查时间：2026-07-04 | 审查范围：全项目（backend + 核心文档 + 项目结构）
> 审查方法：代码静态分析 + 架构合规性检查 + 安全审计 + 测试覆盖评估 + 文档交叉验证

---

## TL;DR

PomodoroXII 后端架构基础扎实，三条铁律（Routers commit / Services flush / Services 不导入 FastAPI）**全部通过验证**，361 个测试全部通过。但同步引擎存在 **3 项 CRITICAL 级安全检查缺失**（墓碑防复活、客户端字段剥离、循环引用检测），架构规划中规划的多个模块（MCP Server、frontmatter、export/admin/search 路由、backup/snapshot/consistency 服务）尚未实现，且 8 个实体删除时不创建墓碑——这些是上线前必须解决的问题。

---

## 一、架构合规性审查

### 1.1 三条铁律验证 ✅ 全部通过

| 铁律 | 验证方法 | 结果 | 证据 |
|------|---------|------|------|
| Routers commit, Services flush | grep `await.*commit` in services/ | ✅ 零匹配 | Services 目录无任何 commit 调用 |
| Services 不导入 FastAPI | grep `from fastapi\|import fastapi` in services/ | ✅ 零匹配 | 13 个 service 文件均无 FastAPI 依赖 |
| Models 纯数据 | 人工审查 18 个模型文件 | ✅ 通过 | 所有模型仅有字段和约束，无业务方法 |

### 1.2 架构规划 vs 实际实现对照

| 规划项 | 规划路径 | 实际状态 | 严重度 |
|--------|---------|---------|--------|
| MCP Server | `app/mcp/` | ❌ **完全缺失** | MAJOR |
| frontmatter.py | `app/file_system/frontmatter.py` | ❌ **完全缺失**，无 YAML frontmatter | MAJOR |
| search 路由 | `routes/v1/search.py` | ❌ **缺失**（FTS5 搜索仅通过 file_system 内部 API） | MINOR |
| export 路由 | `routes/export.py` | ❌ **缺失** | MINOR |
| admin 路由 | `routes/admin.py` | ❌ **缺失**（部分功能在 trash.py /cleanup） | MINOR |
| backup_service | `services/backup_service.py` | ❌ **缺失**（仅 file_system/backup.py 索引备份） | MAJOR |
| snapshot_service | `services/snapshot_service.py` | ❌ **完全缺失** | MAJOR |
| consistency_service | `services/consistency_service.py` | ❌ **缺失**（仅 file_system 一致性检查） | MINOR |
| export_service | `services/export_service.py` | ❌ **缺失** | MINOR |
| 定时任务 (APScheduler) | `main.py lifespan` | ❌ **完全缺失** | MAJOR |
| Alembic 迁移 | `alembic/versions/` | ✅ 6 个迁移文件 | OK |
| AGENTS.md | `data/notes/AGENTS.md` | ❌ **缺失** | MINOR |
| 前端 (React 19) | `frontend/` | ❌ **完全未开始** | INFO |

### 1.3 服务层架构偏差

**问题**：架构规划要求所有 Service 放在 `app/services/` 目录，但实际有 8 个 Service 类**定义在路由文件内部**：

| Service 类 | 所在文件 | 应在位置 |
|-----------|---------|---------|
| HabitService | `routes/v1/habits.py:32` | `services/habit_service.py` |
| HabitCheckInService | `routes/v1/habits.py:64` | `services/habit_check_in_service.py` |
| ScheduleService | `routes/v1/schedules.py:24` | `services/schedule_service.py` |
| SessionService | `routes/v1/sessions.py:23` | `services/session_service.py` |
| QuickNoteService | `routes/v1/quick_notes.py:26` | `services/quick_note_service.py` |
| FolderService | `routes/v1/folders.py:26` | `services/folder_service.py` |
| ReflectionService | `routes/v1/reflections.py:36` | `services/reflection_service.py` |
| TimeBlockService | `routes/v1/time_blocks.py:23` | `services/time_block_service.py` |

**影响**：违反三层架构分离原则，Service 逻辑与路由耦合，无法被 MCP Server 复用。

---

## 二、同步引擎安全审查 🔴 3 项 CRITICAL

### 2.1 五道安全检查实现状态

架构文档（01-深度架构规划.md）明确规定了 sync push 的 **5 道安全检查**，实际实现状态：

| # | 安全检查 | 规划位置 | 实际状态 | 严重度 |
|---|---------|---------|---------|--------|
| 1 | **墓碑优先检查**（防删除实体被 push 复活） | `sync_safety.py: check_tombstone_first` | ❌ **未实现** | 🔴 CRITICAL |
| 2 | **客户端字段剥离**（strip _dirty/_etag/synced 等） | `sync_safety.py: strip_client_fields` | ❌ **未实现** | 🔴 CRITICAL |
| 3 | **零点时间戳检测** | `sync_safety.py: detect_zero_time` | ✅ 已实现（`is_zero_time` + `sanitize_zero_time`） | OK |
| 4 | **文件夹循环引用检测** | `sync_safety.py: check_folder_circular_ref` | ❌ **未实现** | 🔴 CRITICAL |
| 5 | **SAVEPOINT per event** | `sync_service.py: db.begin_nested()` | ✅ 已实现 | OK |

### 2.2 CRITICAL-1：墓碑防复活检查缺失

**位置**：`backend/app/services/sync.py:215-258`（`_apply_event` 方法）

**问题**：`_apply_event` 在处理 `create` 和 `update` 事件时，**不检查该 entity 是否已有 tombstone**。这意味着：
- 客户端 A 删除了 task `abc`（服务器写入 tombstone + 删除 DB 行）
- 客户端 B 离线时缓存了 task `abc` 的 create 事件
- 客户端 B 联网 push → 服务器重新创建 task `abc` → **已删除实体被复活**

**影响**：数据不一致，用户删除的数据可能通过同步复活。

**建议**：在 `_apply_event` 的 create/update 分支前加入墓碑检查：
```python
# 在 create/update 前检查墓碑
tomb_svc = TombstoneService(self.db)
tomb = await tomb_svc.exists(etype, eid)
if tomb is not None and action in ("create", "update"):
    return "conflict_local"  # 拒绝复活
```

### 2.3 CRITICAL-2：客户端字段未剥离

**位置**：`backend/app/services/sync.py:215-228, 245-246`

**问题**：sync push 的 payload 直接通过 `model(**data)` 和 `setattr(obj, k, v)` 写入 ORM 对象，**不过滤客户端独有字段**。架构规划要求剥离的字段：

| 字段 | 来源 | 危险性 |
|------|------|--------|
| `synced` | 客户端同步标记 | 覆盖服务器同步状态 |
| `_dirty` | 客户端脏标记 | 覆盖服务器脏标记 |
| `_etag` | 客户端 ETag | 覆盖服务器 ETag |
| `actual_pomodoros` | Task 客户端字段 | 可能覆盖服务器端统计 |
| `archive_file_path` | QuickNote 客户端字段 | 路径注入风险 |
| `migrated_to_note_id` | QuickNote 客户端字段 | 覆盖迁移状态 |

此外，客户端可以覆盖 `id`、`created_at`、`version` 等不应由客户端控制的字段（安全审计 M3）。

**建议**：实现 `strip_client_fields()` 函数并应用到 payload：

```python
CLIENT_FIELDS_TO_STRIP = {"synced", "_dirty", "_etag", "actual_pomodoros", 
                          "archive_file_path", "migrated_to_note_id"}
PROTECTED_FIELDS = {"id", "created_at", "version"}

def strip_client_fields(data: dict, entity_type: str) -> dict:
    data = {k: v for k, v in data.items() 
            if k not in CLIENT_FIELDS_TO_STRIP and k not in PROTECTED_FIELDS}
    return data
```

### 2.4 CRITICAL-3：文件夹循环引用检测缺失

**位置**：`backend/app/services/sync.py:245-246`（update 分支）

**问题**：当 sync push 更新 folder 的 `parent_id` 时，**不检查是否会形成循环引用**（A→B→A）。这可能导致：
- `CascadeService.get_descendant_ids` 的 BFS 遍历陷入死循环（虽然有 visited set 保护，但会产生错误的级联删除）
- 文件夹树结构损坏

**建议**：在 folder update 事件处理中加入循环引用检测：
```python
if etype == "folder" and "parent_id" in payload:
    if await self._check_folder_circular_ref(eid, payload["parent_id"]):
        return "conflict_local"
```

### 2.5 sync_safety.py 实际内容 vs 规划

| 规划函数 | 实际函数 | 状态 |
|---------|---------|------|
| `check_tombstone_first()` | ❌ 不存在 | 缺失 |
| `strip_client_fields()` | ❌ 不存在 | 缺失 |
| `detect_zero_time()` | `is_zero_time()` + `sanitize_zero_time()` | ✅ 已实现 |
| `check_folder_circular_ref()` | ❌ 不存在 | 缺失 |
| (无对应) | `normalize_timestamp()` | 额外实现 |
| (无对应) | `serialize_entity()` | 额外实现 |
| (无对应) | `check_lww_conflict()` | 额外实现 |

---

## 三、删除一致性审查 🔴 MAJOR

### 3.1 墓碑创建不一致

**问题**：14 种同步实体中，**仅 Task 和 Note 在删除时创建墓碑**，其余 6 个实体的删除路由不调用 TombstoneService：

| 实体 | 删除路由 | 创建墓碑 | 严重度 |
|------|---------|---------|--------|
| Task | `routes/v1/tasks.py:99` | ✅ TaskService.delete() 内部创建 | OK |
| Note | `routes/v1/notes.py:112` | ✅ NoteService.delete() 内部创建 | OK |
| Session | `routes/v1/sessions.py:107` | ❌ **不创建** | 🔴 MAJOR |
| Reflection | `routes/v1/reflections.py:127` | ❌ **不创建** | 🔴 MAJOR |
| Habit | `routes/v1/habits.py:144` | ❌ **不创建** | 🔴 MAJOR |
| Schedule | `routes/v1/schedules.py:104` | ❌ **不创建** | 🔴 MAJOR |
| TimeBlock | `routes/v1/time_blocks.py:101` | ❌ **不创建** | 🔴 MAJOR |
| QuickNote | `routes/v1/quick_notes.py:132` | ❌ **不创建** | 🔴 MAJOR |
| Folder | `routes/v1/folders.py:131` | ❌ 软删除（trashed_at），不创建墓碑 | MINOR |

**影响**：这 6 个实体删除后，其他设备通过 sync pull 无法得知删除事件，会在本地保留已删除的数据——**同步删除不一致**。

**建议**：在 `BaseService.delete()` 中默认创建墓碑，或在各 Service 的 delete 方法中显式调用 `TombstoneService.create()`。

### 3.2 BaseEntityRegistry 与实际模型数量

| 维度 | 架构规划 | 实际实现 |
|------|---------|---------|
| 同步实体数 | 14 种 | 14 种 ✅ |
| ORM 模型数 | 16 表 | 18 表（+sync_outbox + sync_audit_log） |
| SyncMixin 继承 | 所有同步实体 | ✅ 14 个实体均继承 |
| Tombstone（非 SyncMixin） | 1 表 | ✅ 正确 |
| Setting（非 SyncMixin） | 1 表 | ✅ 正确 |

---

## 四、安全审计发现

### 4.1 严重度汇总

| 级别 | 数量 | 关键项 |
|------|------|--------|
| CRITICAL | 0 | — |
| MAJOR | 5 | M1 限流缺失、M2 安全头缺失、M3 sync 批量赋值、M4 setup 竞态、M5 弱密钥校验 |
| MINOR | 8 | CORS 宽松、路径泄露、getattr 过滤、settings 原始 dict 等 |
| INFO | 4 | HS256 单服务合适、无密码复杂度、debug SQL echo、惰性导入 |

### 4.2 优先修复项

1. **M1 — 认证端点无限流**：`/auth/login` 可被暴力破解。建议引入 `slowapi` 限流中间件。
2. **M2 — 安全响应头缺失**：无 `X-Content-Type-Options`、`X-Frame-Options`、`Strict-Transport-Security`。建议添加 `SecurityHeadersMiddleware`。
3. **M3 — sync payload 批量赋值**：payload 为 `dict[str, Any]`，直接 `model(**data)` 可覆盖任意字段。建议字段白名单。
4. **M5 — 弱密钥校验缺口**：`.env` 中 `dev-test-secret-key-for-testing-only` 不在黑名单，生产环境可绕过。
5. **M4 — setup 竞态**：并发 setup 可触发 IntegrityError → 500。建议捕获返回 409。

### 4.3 安全亮点 ✅

- PyJWT（非 python-jose）+ bcrypt 12 rounds
- 算法固定 `algorithms=[settings.algorithm]`，防算法混淆
- 多空间隔离通过独立 SQLite DB 实现，无跨空间泄露
- FTS5 查询双引号转义防注入（`search_ops.py:40`）
- 参数化查询贯穿全栈，无 SQL 注入风险
- 500 错误不泄露堆栈，仅返回通用消息
- `.env` 正确被 `.gitignore` 排除

---

## 五、file_system 子系统审查

### 5.1 架构合规性

| 规划项 | 实际状态 | 严重度 |
|--------|---------|--------|
| 8 Mixin 组合 | ✅ 已实现（StorageBase + 7 Mixin） | OK |
| FTS5 trigram 搜索 | ✅ 已实现 + LIKE 回退 | OK |
| `frontmatter.py` 模块 | ❌ **完全缺失** | MAJOR |
| .md YAML frontmatter | ❌ **未实现**（.md 为纯文本） | MAJOR |
| 三层锁（RLock → FileLock → SQLite） | ✅ 已实现 | OK |
| 原子写入（temp + os.replace） | ✅ 已实现 | OK |
| 路径遍历防护 | ✅ folder_id 存在性验证 | OK |
| content_hash 一致性检查 | ✅ check_consistency + repair | OK |

### 5.2 关键问题

**MAJOR：无 YAML frontmatter**
架构规划明确要求 .md 文件包含 YAML frontmatter（id, title, tags, folder_id, content_hash, created_at, updated_at），使 .md 文件自描述、可离线解析、Agent 友好。实际 .md 文件为**纯文本内容**，元数据仅存在于 index.db。

**影响**：
- .md 文件无法脱离 index.db 独立解析
- AGENTS.md 导航文件无法工作
- 可移植性降低（架构文档 07/08 的核心目标未达成）

**file_system 技术质量评价**：
- 锁机制正确（RLock 进程内 + FileLock 跨进程）
- 原子写入正确（temp file + os.replace）
- FTS5 搜索正确（trigram + 双引号转义 + LIKE 回退）
- 一致性检查完善（missing_files + orphan_files + hash_mismatches）
- 使用 `asyncio.to_thread` 包装同步 sqlite3 操作，不阻塞事件循环

---

## 六、测试覆盖审查

### 6.1 测试概览

| 维度 | 数据 |
|------|------|
| 测试文件 | 51 个 |
| 测试用例 | 361 个 |
| 通过率 | **100%（361/361）** |
| 耗时 | ~4 分钟 |
| 测试隔离 | autouse fixture + importlib.reload（优秀） |

### 6.2 测试覆盖矩阵

| 领域 | 测试数 | 覆盖评价 |
|------|--------|---------|
| Auth | 27 | ✅ 充分（密码哈希、token 边界、权限隔离） |
| Models | 11 | ✅ 充分（表注册、约束、字段） |
| Schemas | 9 | ✅ 充分（Create/Update/Response 三件套） |
| Services | 60 | ✅ 充分（BaseService、NoteService Saga、Sync LWW） |
| Routes | 84 | ✅ 充分（12 路由组 CRUD + 分页 + 集成） |
| file_system | 37 | ✅ 充分（7 引擎模块 + 全流程） |
| 基础设施 | 68 | ✅ 充分（DB 隔离、索引守卫、异常处理） |
| 架构门禁 | 5 | ✅ 优秀（AST 扫描服务层不导入 FastAPI） |

### 6.3 关键测试缺口

| 缺口 | 严重度 | 说明 |
|------|--------|------|
| 并发 sync push | 🔴 P0 | 零并发测试，多设备同步是核心场景 |
| 跨 space 数据隔离 | 🔴 P0 | 仅测表结构隔离，未测数据层隔离 |
| Tombstone 复活 | 🔴 P0 | 未测 create→delete→create(same id)→pull |
| FS 故障 Saga | 🟡 P1 | Saga 仅测 DB 失败方向，未测 FS 写入失败 |
| LWW 相同时间戳 | 🟡 P1 | 未测 tie-breaking 策略 |
| 6 实体无独立 Service 测试 | 🟡 P2 | Session/Reflection/Habit 等依赖 HTTP 间接覆盖 |

### 6.4 测试亮点 ✅

- **架构门禁测试**：用 AST 扫描确保服务层不导入 FastAPI、≥40 路由注册
- **索引回归守卫**：用 `EXPLAIN QUERY PLAN` 验证查询使用索引
- **Saga 补偿完整**：NoteService create/update/delete 三个方向均有 DB 失败补偿测试
- **性能优化守卫**：D-2/D-3/D-4/D-5 优化均有专门回归测试
- **测试文档化**：许多 docstring 解释了"为何这样测"和已知限制

---

## 七、项目健康度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构合规性 | ★★★☆☆ | 三条铁律通过，但 8 个 Service 位置不对、多个规划模块缺失 |
| 代码质量 | ★★★★☆ | 代码清晰、注释充分、错误处理完善 |
| 同步引擎安全 | ★★☆☆☆ | 5 道安全检查仅实现 2 道，3 道 CRITICAL 缺失 |
| 删除一致性 | ★★☆☆☆ | 6/8 实体删除不创建墓碑，同步删除不一致 |
| 安全防护 | ★★★☆☆ | 认证/隔离良好，但无限流、无安全头、payload 未校验 |
| 测试覆盖 | ★★★★☆ | 361 测试全通过，隔离优秀，但并发/隔离/复活未测 |
| file_system | ★★★★☆ | 8 Mixin 架构清晰，但无 frontmatter |
| 文档完整性 | ★★★★★ | 13 份核心文档完善，交叉审查通过 |
| **综合** | **★★★☆☆** | **基础扎实，但同步安全有 CRITICAL 缺口需优先修复** |

---

## 八、优先修复建议

### P0 — 上线前必须修复（CRITICAL）

1. **实现墓碑防复活检查**：在 `sync.py:_apply_event` 的 create/update 分支前检查 tombstone
2. **实现客户端字段剥离**：在 `sync_safety.py` 添加 `strip_client_fields()` 并应用到 payload
3. **实现文件夹循环引用检测**：在 folder update 事件中检测 parent_id 循环
4. **统一删除墓碑创建**：为 Session/Reflection/Habit/Schedule/TimeBlock/QuickNote 的删除操作添加墓碑

### P1 — 上线前建议修复（MAJOR）

5. **添加认证限流**：为 `/auth/login` 添加 IP 级限流
6. **添加安全响应头**：实现 `SecurityHeadersMiddleware`
7. **sync payload 字段白名单**：限制可写入字段，保护 id/created_at/version
8. **强化弱密钥检测**：扩展黑名单或要求密钥长度 ≥32
9. **实现 frontmatter.py**：.md 文件添加 YAML frontmatter
10. **将 8 个内联 Service 移入 services/ 目录**：符合三层架构

### P2 — 后续迭代

11. **补充并发 sync push 测试**
12. **补充跨 space 数据隔离测试**
13. **补充 tombstone 复活测试**
14. **实现 MCP Server 模块**
15. **实现 backup/snapshot/consistency 服务**
16. **添加 APScheduler 定时任务**
17. **实现 export/admin/search 路由**

---

## 九、架构演进建议

### 9.1 短期（1-2 周）
- 修复 3 道 CRITICAL 安全检查缺失
- 统一 8 个实体的墓碑创建
- 添加限流和安全头
- 将内联 Service 移入 services/

### 9.2 中期（1 个月）
- 实现 frontmatter.py + AGENTS.md
- 补充并发/隔离/复活测试
- 实现 backup/snapshot 服务 + APScheduler
- sync payload Pydantic schema 校验

### 9.3 长期（2-3 个月）
- 实现 MCP Server（Agent 接入）
- 实现 export/admin/search 路由
- 启动 React 19 前端重建
- Docker Compose + Cloudflare Tunnel 部署

---

> 本报告基于 2026-07-04 的代码状态生成。项目处于 Phase A-C 后端开发阶段，361 个测试全部通过，架构基础扎实，但同步引擎安全检查和删除一致性存在 CRITICAL 级缺口，需在上线前优先修复。
