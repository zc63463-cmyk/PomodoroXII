# Phase A TDD 加固 — 续接计划

## 摘要

Phase A TDD 加固已完成阶段 1.1 (test_auth_security.py, 14 测试) 和 1.2 (test_errors.py, 13 测试),阶段 1.3 (test_settings.py, 9 测试) 的 NoDecode 修复已应用但尚未验证。本计划续接剩余阶段 1.3 验证 + 阶段 2-5,目标是将测试总数从 11(原始)提升到 70+,覆盖 Phase A 全部 12 条门控标准。

**工作目录**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**TDD 方法**: 对已有代码编写表征测试;发现 bug 时按 Red-Green-Refactor 修复
**已修复的 3 个 bug**: conftest reload (Base.metadata.clear)、errors.py 异常处理器 (500 vs Exception)、settings.py cors_origins (NoDecode)

## 当前状态

### 已完成的测试 (38 个,预期全通过)

| 测试文件 | 测试数 | 状态 |
|---------|--------|------|
| `tests/test_deps.py` | 3 | 原始,通过 |
| `tests/test_meta_db.py` | 4 | 原始,通过 |
| `tests/test_space_manager.py` | 4 | 原始,通过 |
| `tests/test_auth_security.py` | 14 | Phase 1.1,通过 |
| `tests/test_errors.py` | 13 | Phase 1.2,通过 |
| `tests/test_settings.py` | 9 | Phase 1.3,NoDecode 修复已应用,**待验证** |

### 已修复的 bug

1. **conftest.py**: `Base.metadata.clear()` 防止 importlib.reload 导致 "Table already defined"
2. **errors.py**: `@app.exception_handler(500)` 替代 `@app.exception_handler(Exception)`,修复 ServerErrorMiddleware 不调用问题
3. **settings.py**: `Annotated[list[str], NoDecode]` 防止 pydantic-settings 在 validator 之前 JSON-parse env var

## 待完成工作

### 阶段 1.3 验证: test_settings.py

**操作**: 运行 `uv run pytest tests/test_settings.py -v` 验证 NoDecode 修复后 9 个测试全部通过。

**风险**: 若 NoDecode 在 pydantic-settings 当前版本不支持,需回退到 `field_validator(mode="before")` + 手动 `os.environ.get` 方案(当前代码已有此逻辑)。

---

### 阶段 2: HTTP 层测试

#### 2.1 创建 `tests/test_middleware.py` (3 个测试)

**目标文件**: `app/middleware.py` — RequestIdMiddleware

**源码分析**: 中间件继承 BaseHTTPMiddleware,dispatch 方法:
- 从 `x-request-id` header 获取或生成 UUID4
- 设置到 `request_id_var` ContextVar
- 响应头回传 `x-request-id`

**测试用例**:
1. `test_generates_uuid_when_no_header` — 无入站 header 时,响应头包含 UUID 格式的 x-request-id
2. `test_reuses_incoming_header` — 有入站 header 时,响应头原样返回
3. `test_binds_request_id_to_context_var` — 中间件执行期间 request_id_var 被设置(通过日志输出验证)

**测试方式**: 构建最小 FastAPI app + RequestIdMiddleware,用 `httpx.AsyncClient` + `ASGITransport` 发请求。

#### 2.2 创建 `tests/test_logging.py` (5 个测试)

**目标文件**: `app/logging.py` — JsonFormatter + setup_logging

**源码分析**:
- `JsonFormatter.format()` 输出 JSON 含 ts/level/logger/msg,条件含 request_id 和 exc
- `setup_logging()` 幂等: 移除带 `_pomodoroxii_json` 标记的旧 handler 再添加新的

**测试用例**:
1. `test_json_formatter_produces_valid_json` — format() 返回 json.loads 可解析的字符串
2. `test_json_formatter_includes_core_fields` — 包含 ts/level/logger/msg 四个字段
3. `test_json_formatter_includes_request_id_when_set` — request_id_var 设置后 payload 包含 request_id
4. `test_json_formatter_omits_request_id_when_empty` — request_id_var 为空时 payload 不含 request_id 键
5. `test_setup_logging_is_idempotent` — 多次调用后 root logger 只有 1 个 _pomodoroxii_json handler

#### 2.3 创建 `tests/test_main.py` (5 个测试)

**目标文件**: `app/main.py` — create_app() + health 端点

**源码分析**: create_app() 注册 CORSMiddleware + RequestIdMiddleware + 异常处理器 + /api/health 端点 + lifespan(初始化 meta_db + space_manager)

**测试用例**:
1. `test_create_app_returns_fastapi_instance` — create_app() 返回 FastAPI 对象
2. `test_health_endpoint_returns_200` — GET /api/health → 200 + {"status": "ok"}
3. `test_app_error_handler_registered` — 触发 NotFoundError → 404 JSON + error_type
4. `test_request_id_middleware_registered` — 响应头包含 x-request-id
5. `test_cors_headers_present` — OPTIONS 预检请求返回 CORS 头

**测试方式**: 使用 `httpx.AsyncClient` + `ASGITransport(app=create_app())`, 不触发 lifespan(避免 DB 初始化)。

---

### 阶段 3: DB 层测试

#### 3.1 创建 `tests/test_db_session.py` (4 个测试)

**目标文件**: `app/db/session.py` — create_engine + create_session_factory + get_db

**源码分析**:
- `create_engine(url, echo, pool_size)` — SQLite 时忽略 pool_size
- `create_session_factory(engine)` — 返回 async_sessionmaker,expire_on_commit=False
- `get_db()` — 废弃,委托给 meta_session.get_meta_session

**测试用例**:
1. `test_create_engine_returns_async_engine` — 返回 AsyncEngine 实例
2. `test_create_session_factory_returns_maker` — 返回 async_sessionmaker 实例
3. `test_create_session_factory_binds_engine` — factory 产生的 session 的 engine 与传入一致
4. `test_sqlite_engine_ignores_pool_size` — SQLite URL + pool_size 不报错

#### 3.2 扩展 `tests/test_deps.py` (新增 3 个测试)

**目标**: 补充 DB 依赖 + get_file_system 测试

**源码分析 (deps.py get_file_system)**:
```python
try:
    from file_system import FileSystem  # type: ignore[import-not-found]
except Exception:
    return notes_dir
```
**关键发现**: `from file_system import FileSystem` 会失败(正确路径是 `from app.file_system.interfaces import FileSystem`),导致总是 fallback 返回 Path。这是 Gate #10 的 bug。

**测试用例**:
1. `test_get_meta_db_yields_session` — get_meta_db yield AsyncSession(需 init_meta_db)
2. `test_get_space_db_yields_session` — get_space_db yield 绑定到空间 DB 的 AsyncSession
3. `test_get_file_system_returns_filesystem_instance` — get_file_system 返回 FileSystem 实例(非 Path)

**预期 bug**: test 3 将失败(Red),因为 deps.py 导入路径错误。修复:改为 `from app.file_system.api import get_file_system as get_fs_factory` 并调用工厂函数。

---

### 阶段 4: file_system 子系统测试

#### 4.1-4.2 创建 `tests/test_file_system/` 包 + conftest.py

**fixture**:
```python
@pytest.fixture
async def fs_instance(tmp_path):
    from app.file_system.api import get_file_system
    root_dir = tmp_path / "notes"
    index_db = tmp_path / "index" / "index.db"
    fs = await get_file_system(root_dir=root_dir, index_db=index_db)
    yield fs
    await fs.close()
```

#### 4.3 创建 `tests/test_file_system/test_note_ops.py` (18 个测试)

**目标文件**: `app/file_system/engine/note_ops.py`

**测试用例**:
1. `test_create_note_returns_note_meta` — 返回 NoteMeta,id 以 "n_" 开头
2. `test_create_note_writes_md_file` — .md 文件实际写入磁盘
3. `test_create_note_with_folder` — 指定 folder_id 创建(需先建 folder)
4. `test_create_note_with_external_id` — 透传 external_id 作为 note_id
5. `test_create_note_duplicate_external_id_raises` — 重复 external_id → ValueError
6. `test_create_note_nonexistent_folder_raises` — 不存在的 folder_id → ValueError
7. `test_read_note_returns_content` — 读取笔记内容
8. `test_read_note_not_found_raises` — 不存在的 id → KeyError
9. `test_read_note_meta_returns_metadata` — 读取元数据返回 NoteMeta
10. `test_edit_note_updates_content` — 编辑后 content_hash 变化
11. `test_edit_note_creates_version_backup` — 内容变化时 .meta/version_backups/ 有备份
12. `test_edit_note_meta_updates_title` — 修改标题,文件重命名
13. `test_delete_note_moves_to_trash` — 删除后 .md 移到 .trash/,is_deleted=1
14. `test_delete_note_not_found_raises` — 不存在 → KeyError
15. `test_list_notes_returns_all_active` — 列出所有活跃笔记
16. `test_list_notes_filters_by_folder` — 按 folder_id 过滤
17. `test_read_notes_batch_returns_ordered_contents` — **Gate #7** 批量读取,顺序一致
18. `test_read_notes_batch_empty_input_returns_empty` — 空列表 → 空列表

#### 4.4 创建 `tests/test_file_system/test_folder_ops.py` (8 个测试)

**目标文件**: `app/file_system/engine/folder_ops.py`

**测试用例**:
1. `test_create_folder_returns_folder_meta` — 创建返回 FolderMeta
2. `test_create_folder_with_parent` — 嵌套文件夹
3. `test_get_folder_returns_meta` — 查询文件夹
4. `test_get_folder_not_found_raises` — 不存在 → KeyError
5. `test_list_folders_by_parent` — 列出子文件夹
6. `test_move_folder_changes_parent` — 移动文件夹,含环形引用检测
7. `test_rename_folder_changes_name` — 重命名,含唯一性校验
8. `test_delete_folder_removes_folder` — 删除文件夹,子笔记入回收站

#### 4.5 创建 `tests/test_file_system/test_search_ops.py` (3 个测试)

**目标文件**: `app/file_system/engine/search_ops.py`

**测试用例**:
1. `test_search_returns_matching_notes` — FTS5 搜索匹配结果(≥3 字符)
2. `test_search_in_folder_scopes_results` — 文件夹内搜索
3. `test_search_short_query_uses_like_fallback` — 短查询(<3 字符)走 LIKE 回退

#### 4.6 创建 `tests/test_file_system/test_trash_ops.py` (4 个测试)

**目标文件**: `app/file_system/engine/trash_ops.py`

**测试用例**:
1. `test_list_trash_returns_deleted_notes` — 列出回收站
2. `test_restore_note_undoes_delete` — 恢复笔记,is_deleted=0
3. `test_purge_note_permanently_deletes` — 彻底删除,DB 行消失
4. `test_empty_trash_clears_all` — 清空回收站,返回清除数量

#### 4.7 创建 `tests/test_file_system/test_full_flow.py` (2 个测试, **Gate #6**)

**目标**: 端到端全流程集成测试

**测试用例**:
1. `test_full_flow_create_read_search_delete`:
   - 创建文件夹 → 创建笔记(指定文件夹) → 读取笔记内容 → 搜索笔记 → 编辑笔记 → 删除笔记 → 列出回收站 → 恢复笔记 → 验证全流程
2. `test_full_flow_multiple_notes_batch_read`:
   - 创建 3 个笔记 → read_notes_batch → 验证顺序和内容一致

#### 4.8 创建 `tests/test_file_system/test_schema.py` (3 个测试)

**目标文件**: `app/file_system/schema.py` — init_database + 迁移

**测试用例**:
1. `test_init_database_creates_all_tables` — notes/folders/note_paths/note_versions/note_links/notes_fts/schema_meta/sync_audit_log 全部创建
2. `test_init_database_is_idempotent` — 多次调用不报错
3. `test_schema_version_tracking` — schema_meta 表记录 version=1

---

### 阶段 5: 回归验证 + 修复

#### 5.1 运行全部测试

```bash
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend
uv run pytest -v
```

**预期**: 原 11 + 已完成 36 + 新增约 30 = 77 个测试全部通过。

#### 5.2 修复 TDD 发现的缺陷

**已知潜在 bug**:
- `deps.py` 的 `get_file_system` 导入路径错误 (`from file_system import FileSystem` 应为 `from app.file_system.interfaces import FileSystem`),导致总是 fallback 返回 Path (Gate #10)

**修复原则**: 先写失败测试 → 修复代码 → 验证通过。不修改测试来迁就代码。

#### 5.3 验证 Phase A 门控标准

| # | 门控标准 | 测试覆盖 |
|---|---------|---------|
| 1 | /api/health 返回 200 | test_main |
| 2 | x-request-id 头传播 | test_middleware |
| 3 | NotFoundError 404 JSON + error_type | test_errors |
| 4 | production + 空 secret_key 报错 | test_settings |
| 5 | file_system 导入无错误 | test_file_system conftest |
| 6 | file_system 全流程 | test_full_flow |
| 7 | read_notes_batch 有序 | test_note_ops |
| 8 | alembic upgrade/downgrade | 手动验证 |
| 9 | docker build | 手动验证 |
| 10 | get_file_system 返回 FileSystem | test_deps (修复后) |
| 11 | ruff 无 E402 | 手动验证 |
| 12 | 全部测试通过 | uv run pytest -v |

#### 5.4 代码检查

```bash
uv run ruff check app/ --fix
```

## 假设与决策

1. **测试文件命名**: `tests/test_{模块名}.py`,file_system 测试放 `tests/test_file_system/` 子目录
2. **TDD 策略**: 对已有代码写表征测试;发现 bug 时严格按 Red-Green-Refactor 修复
3. **不修改已有代码**: 除非测试发现明确的 bug
4. **file_system 测试用真实实例**: 不 mock sqlite3/文件系统,使用 tmp_path 隔离
5. **HTTP 集成测试用 ASGITransport**: 避免 mock,直接测试 FastAPI app,不触发 lifespan
6. **文件写入限制**: pomodoroxi 目录(小写)不在 workspace 范围内,需写入 temp 后用 Python shutil.copy2 复制

## 验证步骤

1. **阶段 1.3 验证**: `uv run pytest tests/test_settings.py -v`
2. **逐文件 TDD**: 每个测试文件创建后立即运行 `uv run pytest tests/test_xxx.py -v`
3. **阶段回归**: 每完成一个阶段运行 `uv run pytest -v` 确保无回归
4. **门控验证**: 全部测试完成后,逐项验证 12 条 Phase A 门控标准
5. **代码检查**: `uv run ruff check app/ --fix`
6. **最终统计**: 确认测试总数从 11 增长到 77+,全部通过
