# Phase A TDD 加固计划

## 摘要

Phase A 已完成 14 个任务,11 个测试通过,但大量核心组件缺少自动化测试覆盖。本计划对 Phase A 全部组件执行一轮 TDD 加固,确保 Phase A 门控标准 12 项全部有自动化测试覆盖,然后再进入 Phase B。

**工作目录**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend`
**测试框架**: pytest + pytest-asyncio (asyncio_mode = "auto")
**TDD 方法**: 对已有代码编写表征测试(characterization tests),发现缺陷时按 Red-Green-Refactor 修复

## 当前状态分析

### 已有测试 (11 个,全部通过)

| 测试文件 | 测试数 | 覆盖内容 |
|---------|--------|---------|
| `tests/test_deps.py` | 3 | token 解码 / master token 拒绝 / space context 提取 |
| `tests/test_meta_db.py` | 4 | init 引擎 / 建表 / 幂等 / Space 持久化 |
| `tests/test_space_manager.py` | 4 | 引擎创建 / 缓存 / LRU 驱逐 / session 可用 |

### 未测试组件 (0 个直接测试)

| 组件 | 文件 | 风险 |
|------|------|------|
| 密码哈希 + JWT | `app/auth/security.py` | 高 - 认证基石 |
| 异常体系 + 处理器 | `app/errors.py` | 高 - 全局错误响应 |
| 请求 ID 中间件 | `app/middleware.py` | 中 - 日志追踪 |
| JSON 日志格式 | `app/logging.py` | 中 - 可观测性 |
| 配置校验 | `app/settings.py` | 高 - 生产安全 |
| 应用工厂 | `app/main.py` | 高 - 启动入口 |
| DB 会话工厂 | `app/db/session.py` | 低 - 薄包装 |
| file_system 全子系统 | `app/file_system/` (15 文件) | 高 - 核心业务 |

### Phase A 门控标准覆盖情况

| # | 门控标准 | 当前测试状态 |
|---|---------|-------------|
| 1 | `/api/health` 返回 200 | 间接覆盖(test_deps) |
| 2 | `x-request-id` 头传播 | **未覆盖** |
| 3 | NotFoundError 返回 404 JSON + error_type | **未覆盖** |
| 4 | production + 空 secret_key 报错 | **未覆盖** |
| 5 | file_system 导入无错误 | **未覆盖** |
| 6 | file_system 全流程(create→read→search→delete) | **未覆盖** |
| 7 | read_notes_batch 返回有序内容 | **未覆盖** |
| 8 | alembic upgrade/downgrade | 手动验证 |
| 9 | docker build | 手动验证 |
| 10 | get_file_system 返回 FileSystem 实例 | **未覆盖** |
| 11 | ruff 无 E402 | 手动验证 |
| 12 | 全部已有 + 新增测试通过 | **待补全** |

## 提议变更

### 阶段 1: 核心基础设施测试 (auth + errors + settings)

#### 1.1 创建 `tests/test_auth_security.py`

**目标**: 直接测试 `app/auth/security.py` 的 5 个函数

**测试用例**:
- `test_hash_password_returns_bcrypt_hash` - 返回值以 `$2b$` 开头,长度 60
- `test_hash_password_truncates_at_72_bytes` - 超长密码不报错
- `test_verify_password_succeeds_with_correct_password` - 正确密码返回 True
- `test_verify_password_fails_with_wrong_password` - 错误密码返回 False
- `test_create_master_token_contains_master_type` - payload type == "master",无 space_id
- `test_create_space_token_contains_space_id` - payload type == "space",含 space_id
- `test_create_master_token_has_7d_expiry` - exp 距 now 约 7 天
- `test_create_space_token_has_8h_expiry` - exp 距 now 约 8 小时
- `test_decode_access_token_decodes_valid_token` - 正确解码返回 payload
- `test_decode_access_token_raises_on_invalid_token` - 无效 token 抛 jwt.PyJWTError
- `test_decode_access_token_raises_on_expired_token` - 过期 token 抛 jwt.PyJWTError

**TDD 注意**: 代码已存在,预期大部分测试直接通过。若失败则揭示 bug。

#### 1.2 创建 `tests/test_errors.py`

**目标**: 测试 `app/errors.py` 的异常类层级 + FastAPI 异常处理器

**测试用例**:
- `test_app_error_default_attributes` - detail/status_code/error_type 默认值
- `test_app_error_custom_attributes` - 自定义 detail/status_code/error_type
- `test_not_found_error_has_404` - status_code == 404, error_type == "not_found"
- `test_conflict_error_has_409` - status_code == 409, error_type == "conflict"
- `test_validation_error_has_422` - status_code == 422, error_type == "validation_error"
- `test_authentication_error_has_401` - status_code == 401
- `test_authorization_error_has_403` - status_code == 403
- `test_exception_handler_returns_json_with_error_type` - 用 httpx.AsyncClient 测试 AppError → JSON 响应
- `test_exception_handler_returns_500_for_unexpected` - 未知异常 → 500 + server_error

**测试方式**: 使用 `httpx.AsyncClient` + `ASGITransport` 直接测试 FastAPI 应用,无需启动服务器。

#### 1.3 创建 `tests/test_settings.py`

**目标**: 测试 `app/settings.py` 的校验逻辑 + 路径助手

**测试用例**:
- `test_secret_key_rejects_empty_in_production` - production + 空 key → ValueError
- `test_secret_key_rejects_weak_in_production` - production + "change-me" → ValueError
- `test_secret_key_allows_default_in_development` - development + "change-me" → 不报错
- `test_cors_origins_parses_comma_separated` - 环境变量逗号分隔 → list
- `test_cors_origins_accepts_list` - 直接传 list → 原样返回
- `test_space_db_path_returns_correct_path` - `spaces_data_dir / space_id / "space.db"`
- `test_space_notes_dir_returns_correct_path` - `spaces_data_dir / space_id / "notes"`

**TDD 注意**: conftest.py 的 `_isolate_env` fixture 会 reload settings,需要在其基础上额外设置环境变量。

### 阶段 2: HTTP 层测试 (middleware + logging + main)

#### 2.1 创建 `tests/test_middleware.py`

**目标**: 测试 `app/middleware.py` 的 RequestIdMiddleware

**测试用例**:
- `test_generates_uuid_when_no_header` - 无 x-request-id → 生成 UUID,响应头包含
- `test_reuses_incoming_header` - 有 x-request-id → 响应头原样返回
- `test_binds_request_id_to_context_var` - 中间件执行期间 request_id_var 被设置

**测试方式**: 构建最小 FastAPI app + RequestIdMiddleware,用 httpx.AsyncClient 发请求。

#### 2.2 创建 `tests/test_logging.py`

**目标**: 测试 `app/logging.py` 的 JsonFormatter + setup_logging

**测试用例**:
- `test_json_formatter_produces_valid_json` - format() 返回可解析的 JSON
- `test_json_formatter_includes_core_fields` - 包含 ts/level/logger/msg
- `test_json_formatter_includes_request_id_when_set` - request_id_var 设置后包含 request_id
- `test_json_formatter_omits_request_id_when_empty` - request_id_var 为空时不包含
- `test_setup_logging_is_idempotent` - 调用多次不叠加 handler

#### 2.3 创建 `tests/test_main.py`

**目标**: 测试 `app/main.py` 的 create_app() + 集成验证

**测试用例**:
- `test_create_app_returns_fastapi_instance` - 返回 FastAPI 对象
- `test_health_endpoint_returns_200` - GET /api/health → 200 + {"status": "ok"}
- `test_app_error_handler_registered` - 触发 NotFoundError → 404 JSON + error_type
- `test_request_id_middleware_registered` - x-request-id 头传播
- `test_cors_headers_present` - CORS 头存在

**测试方式**: 使用 `httpx.AsyncClient` + `ASGITransport(app=app)` 进行集成测试。需要 mock lifespan 或使用 TestClient。

### 阶段 3: DB 层测试 (session + deps 补全)

#### 3.1 创建 `tests/test_db_session.py`

**目标**: 测试 `app/db/session.py` 的引擎/会话工厂创建

**测试用例**:
- `test_create_engine_returns_async_engine` - 返回 AsyncEngine 实例
- `test_create_session_factory_returns_maker` - 返回 async_sessionmaker
- `test_create_session_factory_binds_engine` - factory 产生的 session 绑定到传入 engine
- `test_sqlite_engine_ignores_pool_size` - SQLite URL + pool_size → 不报错

#### 3.2 扩展 `tests/test_deps.py` (补充 DB 依赖测试)

**新增测试用例**:
- `test_get_meta_db_yields_session` - get_meta_db yield AsyncSession
- `test_get_space_db_yields_session` - get_space_db yield 绑定到空间 DB 的 AsyncSession
- `test_get_file_system_returns_filesystem_instance` - get_file_system 返回 FileSystem 实例(非 Path)

**TDD 注意**: Gate #10 要求 get_file_system 返回 FileSystem 实例。当前 deps.py 有 fallback 返回 Path 的逻辑,需验证在 file_system 可导入时是否正确返回 FileSystem 实例。这可能需要修复 deps.py 中的 get_file_system 实现。

### 阶段 4: file_system 子系统测试 (核心 + 全流程)

#### 4.1 创建 `tests/test_file_system/__init__.py`

空文件,标记为测试包。

#### 4.2 创建 `tests/test_file_system/conftest.py`

**fixture**:
- `fs_instance` - 初始化一个 FileSystemStorage 实例(tmp_path + index.db),yield 后 close

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

#### 4.3 创建 `tests/test_file_system/test_note_ops.py`

**目标**: 测试 note_ops.py 的 CRUD + batch read

**测试用例**:
- `test_create_note_returns_note_meta` - 创建笔记返回 NoteMeta,id 以 "n_" 开头
- `test_create_note_writes_md_file` - .md 文件实际写入磁盘
- `test_create_note_with_folder` - 指定 folder_id 创建(需先建 folder)
- `test_create_note_with_external_id` - 透传 external_id
- `test_create_note_duplicate_external_id_raises` - 重复 external_id → ValueError
- `test_read_note_returns_content` - 读取笔记内容
- `test_read_note_not_found_raises` - 不存在的 id → KeyError
- `test_read_note_meta_returns_metadata` - 读取元数据
- `test_edit_note_updates_content` - 编辑内容,content_hash 变化
- `test_edit_note_creates_version_backup` - 内容变化时创建版本备份
- `test_edit_note_meta_updates_title` - 修改标题,文件重命名
- `test_delete_note_moves_to_trash` - 删除后 .md 移到 .trash/,is_deleted=1
- `test_delete_note_not_found_raises` - 不存在 → KeyError
- `test_list_notes_returns_all_active` - 列出所有活跃笔记
- `test_list_notes_filters_by_folder` - 按 folder_id 过滤
- `test_read_notes_batch_returns_ordered_contents` - **Gate #7** 批量读取,顺序一致
- `test_read_notes_batch_empty_input_returns_empty` - 空列表 → 空列表
- `test_read_notes_batch_missing_note_returns_none` - 不存在的 id → None

#### 4.4 创建 `tests/test_file_system/test_folder_ops.py`

**测试用例**:
- `test_create_folder_returns_folder_meta` - 创建文件夹
- `test_create_folder_with_parent` - 嵌套文件夹
- `test_get_folder_returns_meta` - 查询文件夹
- `test_list_folders_by_parent` - 列出子文件夹
- `test_move_folder_changes_parent` - 移动文件夹
- `test_rename_folder_changes_name` - 重命名
- `test_delete_folder_removes_folder` - 删除文件夹
- `test_get_folder_path_returns_chain` - 获取文件夹路径链

#### 4.5 创建 `tests/test_file_system/test_search_ops.py`

**测试用例**:
- `test_search_returns_matching_notes` - FTS5 搜索匹配结果
- `search_in_folder_scopes_results` - 文件夹内搜索
- `test_search_short_query_uses_like_fallback` - 短查询(<3字符)走 LIKE 回退

#### 4.6 创建 `tests/test_file_system/test_trash_ops.py`

**测试用例**:
- `test_list_trash_returns_deleted_notes` - 列出回收站
- `test_restore_note_undoes_delete` - 恢复笔记
- `test_purge_note_permanently_deletes` - 彻底删除
- `test_empty_trash_clears_all` - 清空回收站

#### 4.7 创建 `tests/test_file_system/test_full_flow.py` (**Gate #6**)

**目标**: 端到端全流程集成测试

**测试用例**:
- `test_full_flow_create_read_search_delete`:
  1. 创建文件夹 → 创建笔记(指定文件夹) → 读取笔记内容 → 搜索笔记 → 编辑笔记 → 删除笔记 → 列出回收站 → 恢复笔记 → 验证全流程
- `test_full_flow_multiple_notes_batch_read`:
  1. 创建 3 个笔记 → read_notes_batch → 验证顺序和内容一致

#### 4.8 创建 `tests/test_file_system/test_schema.py`

**测试用例**:
- `test_init_database_creates_all_tables` - 8 张表全部创建
- `test_init_database_is_idempotent` - 多次调用不报错
- `test_schema_version_tracking` - schema_meta 表记录版本

### 阶段 5: 回归验证 + 修复

#### 5.1 运行全部测试

```bash
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend
uv run pytest -v
```

**预期**: 原 11 个 + 新增约 60-70 个测试全部通过。

#### 5.2 修复 TDD 发现的缺陷

在测试过程中可能发现的潜在缺陷:
- `deps.py` 的 `get_file_system` 可能未正确返回 FileSystem 实例(Gate #10)
- `settings.py` 的 cors_origins validator 可能不处理所有环境变量场景
- `errors.py` 的 catch-all handler 可能未正确记录日志

**修复原则**: 先写失败测试 → 修复代码 → 验证通过。不修改测试来迁就代码。

#### 5.3 验证 Phase A 门控标准

逐项验证 12 条门控标准,确保全部通过:
1. health 200 ✓ (test_main)
2. x-request-id 传播 ✓ (test_middleware)
3. NotFoundError 404 ✓ (test_errors)
4. production secret_key 报错 ✓ (test_settings)
5. file_system 导入 ✓ (test_file_system)
6. file_system 全流程 ✓ (test_full_flow)
7. read_notes_batch ✓ (test_note_ops)
8. alembic - 手动验证
9. docker - 手动验证
10. get_file_system 返回 FileSystem ✓ (test_deps)
11. ruff - 手动验证
12. 全部测试通过 ✓

## 假设与决策

### 假设
1. Phase A 代码功能正确,测试主要用于验证和加固
2. conftest.py 的 `_isolate_env` fixture 可用于所有新测试
3. file_system 的 `FileSystemStorage` 可在测试中独立初始化(不依赖 FastAPI)
4. httpx 已安装(pyproject.toml dev 依赖包含 httpx>=0.28)

### 决策
1. **测试文件命名**: `tests/test_{模块名}.py`,file_system 测试放 `tests/test_file_system/` 子目录
2. **TDD 策略**: 对已有代码写表征测试;发现 bug 时严格按 Red-Green-Refactor 修复
3. **不修改已有代码**: 除非测试发现明确的 bug
4. **不修改 conftest.py**: 现有 `_isolate_env` fixture 足够,如需额外 fixture 在各测试文件内定义
5. **file_system 测试用真实实例**: 不 mock sqlite3/文件系统,使用 tmp_path 隔离
6. **HTTP 集成测试用 ASGITransport**: 避免 mock,直接测试 FastAPI app

## 验证步骤

1. **逐文件 TDD**: 每个测试文件创建后立即运行 `uv run pytest tests/test_xxx.py -v`
2. **全量回归**: 每完成一个阶段运行 `uv run pytest -v` 确保无回归
3. **门控验证**: 全部测试完成后,逐项验证 12 条 Phase A 门控标准
4. **代码检查**: `uv run ruff check app/ --fix` 确保无 lint 错误
5. **最终统计**: 确认测试总数从 11 增长到 70+,全部通过
