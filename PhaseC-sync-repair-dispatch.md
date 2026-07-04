# Phase C Sync 修复任务说明与派发 Prompt

日期：2026-07-04  
范围：`backend` 已跟踪代码。不要审查或修改另一个 agent 正在开发的 MCP WIP：

- `backend/app/mcp/`
- `backend/tests/test_mcp_server.py`

## 当前基线

- MCP：`codebase-memory-mcp` 可用，`PomodoroXII/backend` 索引状态 `ready`。
- Git：`main` 分支，除 MCP WIP 外无已跟踪代码差异。
- 测试：排除 MCP WIP 后通过。

```powershell
# 本机 uv trampoline 在 Codex 沙箱中会被拦截，审查时使用如下方式跑通：
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest --ignore=tests/test_mcp_server.py -q

# 结果：
# 406 passed, 1 warning in 366.26s
```

## P0-1：Note 正文不会通过 sync pull/full 下发

### 问题定位

`SyncService.pull()` 目前对所有实体统一执行 ORM 序列化：

- `backend/app/services/sync.py:449`：`serialized = [serialize_entity(r) for r in rows]`
- `backend/app/models/note.py`：`Note` ORM 明确不包含 `content` 字段，正文在 filesystem。
- `backend/app/services/sync.py:74` 注释写明 `fs` 应用于 pull/full 的 note content，但实际未读取 `self.fs`。

结果：设备 A push/REST 创建 Note 后，设备 B 通过 `/sync/pull` 只能获得 Note 元数据，拿不到 Markdown 正文。对于 Phase C 的“同步 + 双存储桥接”目标，这是 release blocker。

### 建议修复方向

确定方案：

1. 在 `SyncService.pull()` 中特殊处理 `etype == "note"` 或 `model is Note`。
2. 查询出 Note ORM rows 后，使用 `self.fs.read_notes_batch(note_ids)` 批量读取正文，避免 N+1 IO。
3. 将正文写入每个 note payload，例如：

```python
serialized = [serialize_entity(r) for r in rows]
if model is Note:
    if self.fs is None:
        # service 层调用方如果没有传 fs，需要明确失败或标记 content_missing
        ...
    contents = await self.fs.read_notes_batch([r.id for r in rows])
    for item, content in zip(serialized, contents, strict=False):
        item["content"] = content if content is not None else ""
        item["content_missing"] = content is None
```

4. `full()` 复用 `pull()`，修复后应自动包含 content。
5. 增加测试：
   - push note create 后 pull，`notes[0]["content"]` 等于原文。
   - REST note create 后 pull，`notes[0]["content"]` 等于原文。
   - filesystem 文件缺失时 pull 不应炸掉；应返回 `content_missing=True` 或进入 errors，需先定契约。

## P0-2：sync cursor 时间字符串格式会导致重复或跳过

### 问题定位

当前系统混用秒、毫秒、微秒字符串：

- `backend/app/services/time.py:12`：`utc_now_iso()` 返回秒精度 `YYYY-MM-DDTHH:MM:SSZ`。
- `backend/app/models/mixins.py:27-30`：`created_at/updated_at` 默认使用秒精度。
- `backend/app/services/sync_safety.py:24-39`：`normalize_timestamp()` 将秒精度转成 `.000Z`，但有小数点时原样返回。
- `backend/app/services/sync.py:443`：SQLite 查询使用原始字符串比较 `model.updated_at > since_n`。
- `backend/app/services/sync.py:481`：`next_since` 返回规范化后的时间。

字符串排序中：

```python
"2026-07-04T10:00:00Z" > "2026-07-04T10:00:00.000Z"  # True
"2026-07-04T10:00:00.123456Z" > "2026-07-04T10:00:00.123Z"  # False
```

结果：

- REST 创建的秒精度记录可能在下一轮 `pull(since=next_since)` 被重复返回。
- 同 timestamp 多行分页时，下一轮使用 `>` 可能跳过剩余同 timestamp 行。
- tombstones 也有同类风险，因为 `_fetch_tombstones()` 用 `deleted_at > since_n`。

### 建议修复方向

短期必须做两件事：

1. 统一持久化时间格式。建议全项目 sync 相关字段固定为毫秒精度 `YYYY-MM-DDTHH:MM:SS.mmmZ`，不要秒/毫秒/微秒混用。
2. 修正 cursor 分页，不要只用 timestamp 作为游标。

推荐实现路线：

- 修改时间工具：
  - `utc_now_iso()` 是否继续秒精度需要权衡测试影响。
  - 更稳的是新增或修正 `utc_now_iso_ms()`，真正返回 3 位毫秒。
  - SyncMixin、Tombstone、SyncAuditLog、SyncOutbox、CascadeService、BaseService 等 sync 相关写入统一使用毫秒函数。
- 修正 `normalize_timestamp()`：
  - 使用 `datetime.fromisoformat()` 解析，统一输出 3 位毫秒。
  - 对 `Z`、`+00:00`、秒精度、微秒精度都归一化。
- 数据迁移：
  - Alembic 增加迁移，将已有 `...SSZ` 更新成 `...SS.000Z`。
  - 覆盖 14 个 sync entities 的 `created_at/updated_at` 与 tombstones `deleted_at`。
- 分页契约：
  - 最稳方案：引入 opaque cursor，例如 `{entity_type, updated_at, id}` 或 per-collection cursor。
  - 如果暂不改 API，至少按 `(updated_at, id)` 排序，并新增 `since_id`/`cursor` 参数。单独 `since` 无法完美处理同 timestamp 跨页。

需要新增测试：

- 秒精度 DB 值 + `.000Z` cursor 不会重复。
- 同一 `updated_at` 下 3 条记录，`limit=2` 后下一页能拿到第 3 条。
- tombstones 同 timestamp 分页不重复、不跳过。

## P1-1：冲突事件也会进入 applied

### 问题定位

`SyncPushResponse.applied` 的 schema 注释是“successfully applied”，但代码将冲突事件也追加进去：

- Note 分支：`backend/app/services/sync.py:123-141`
- 通用实体分支：`backend/app/services/sync.py:165-189`

`conflict_local`、`conflict_tombstone`、`conflict_circular_ref` 都没有落库成功，却仍会出现在 `applied`。客户端可能因此删除本地重试队列，导致状态丢失。

### 建议修复方向

确定方案：

- 只有 `resolution == "ok"` 和 `resolution == "conflict_remote"` 才进入 `applied`。
- `conflict_remote` 表示远端赢并已应用，可以同时出现在 `conflicts` 和 `applied`，也可以改成只进 `applied` 并带 `resolution`，但需定 API 契约。
- `conflict_local`、`conflict_tombstone`、`conflict_circular_ref` 只进入 `conflicts`，不进入 `applied`。
- 增加 HTTP/service 测试：
  - REST delete 后 push create 同 id：`conflicts` 有 tombstone，`applied` 不含该 id。
  - older update：`conflicts` 有 local，`applied` 不含该 id。
  - folder cycle：`conflicts` 有 circular_ref，`applied` 不含该 id。

## P1-2：Meta registry 与 Sync entity_type 命名不一致

### 问题定位

`backend/app/registry/builtin.py:9` 说明 `name` 是用于 URL 和 sync events 的 entity_type，但 registry 暴露 snake_case：

- `quick_note`
- `habit_check_in`
- `time_block`
- `memo_comment`
- `session_quick_note`
- `schedule_quick_note`
- `task_quick_note`

而 `backend/app/services/sync.py:56-65` 接受 camelCase：

- `quickNote`
- `habitCheckIn`
- `timeBlock`
- `memoComment`
- `sessionQuickNote`
- `scheduleQuickNote`
- `taskQuickNote`

结果：客户端如果按 `/api/v1/meta/entities` 生成 sync payload，会被 `/sync/push` 以 `Unknown entity_type` 拒绝。

### 建议修复方向

两种可选路线：

方案 A（兼容优先，推荐短期）：

- 在 sync 层增加 alias map，接受 snake_case 与 camelCase。
- push 输入先 canonicalize 到内部 camelCase。
- tombstone 输出和 pull key 是否保持 camelCase，需要保持现有客户端兼容。
- 在 meta 输出中新增 `sync_entity_type` 字段，明确告诉客户端应使用哪个名称。

方案 B（长期统一）：

- 全项目只保留一种 canonical entity_type。
- 如果选择 snake_case，需要同步改 `ENTITY_REGISTRY`、tombstone entity_type、RelationService、测试和现有客户端。
- 这是 breaking change，不建议混在 P0 hotfix 中直接做。

短期测试：

- `POST /sync/push` 使用 `quick_note`、`habit_check_in` 等 snake_case 应成功或被规范化。
- `/meta/entities/quick_note` 返回 `sync_entity_type: quickNote`。

## P1-3：Note sync update 会覆盖 client timestamp

### 问题定位

`_push_note_event(update)` 明确写入 client timestamp：

- `backend/app/services/sync.py:388`：`update_data["updated_at"] = client_ts_n`

但进入 `NoteService.update()` 后：

- `backend/app/services/note.py:166`：`update_content()` 会设为 `utc_now_iso()`。
- `backend/app/services/note.py:168`：`update_metadata()` 调用 `BaseService.update()`。
- `backend/app/services/base.py:79-80`：先 setattr，再无条件 `obj.updated_at = utc_now_iso()`，覆盖 client timestamp。

结果：note create 的 client timestamp 有测试覆盖，但 note update 的 client timestamp 会丢失，LWW 后续判断可能错误。

### 建议修复方向

推荐做法：

- 给 `BaseService.update()` 增加可选参数，例如 `bump_updated_at: bool = True`，默认保持当前行为。
- `NoteService(sync_mode=True)` 更新时使用 `bump_updated_at=False`，并显式保留 `updated_at`。
- `update_content()` 也需要接受可选 `updated_at_override`，sync update 时同步设置 DB 与 frontmatter。
- 增加测试：
  - push note update with newer `client_updated_at` 后，DB `updated_at == client_updated_at`。
  - pull 返回该 note 的 `updated_at` 也是 client timestamp。

## P2-1：RelationService.link 在 service 层 rollback

### 问题定位

`backend/app/services/relation.py:78` 在 `IntegrityError` 处理中执行：

```python
await self.db.rollback()
```

这会回滚调用方同一个事务里已做的其他改动，违背“routes 管 commit/rollback，services 只 flush”的事务边界。

### 建议修复方向

- 使用 `async with self.db.begin_nested():` 将插入放到 SAVEPOINT 中。
- 捕获 `IntegrityError` 后只回滚 SAVEPOINT，再 re-query existing。
- 不要在 service 层对整个 session 执行 rollback。
- 增加测试：同一事务中先创建其他实体，再触发 relation duplicate race，确保其他实体未被回滚。

## P2-2：CI lint 不是有效门禁

### 问题定位

- `.github/workflows/ci.yml:71-72`：`uv run ruff check app tests || true`
- `backend/pyproject.toml:23-27`：dev extras 没有 `ruff`
- CI 注释仍写 `361 tests`，当前已是 406 tests（排除 MCP WIP）。

### 建议修复方向

- 在 `backend/pyproject.toml` 的 dev extras 增加 `ruff`。
- 移除 CI 中的 `|| true`，让 lint 成为阻塞门禁。
- 更新 CI 注释，不写死测试数量或改成当前数量。

## P2-3：运行时 schema 初始化未接入 Alembic 迁移

### 问题定位

- `backend/app/db/meta_session.py:48` 对 meta DB 使用 `Base.metadata.create_all`。
- `backend/app/space_manager.py:159` 对 space DB 使用 `Base.metadata.create_all`。
- Alembic 脚本存在并有测试，但运行时没有升级已有 DB 的路径。

### 建议修复方向

- 新库可以继续 `create_all`，但已有库升级必须接入 Alembic。
- 至少提供一个明确的 CLI / startup migration 流程：
  - meta DB target=`meta`
  - 每个 space DB target=`space`
- 不建议在本轮 P0 hotfix 中强行全做，但需要在上线前闭环。

## 推荐修复顺序

1. P0-1 Note content in pull/full。
2. P0-2 timestamp canonicalization + cursor contract。
3. P1-1 applied/conflicts 契约。
4. P1-3 note update timestamp preservation。
5. P1-2 registry/sync entity_type alias 或 meta 增补字段。
6. P2-1 relation rollback。
7. P2-2 CI lint。
8. P2-3 Alembic runtime migration 方案。

## 验收要求

最低验收：

- 不修改、不读取 MCP WIP 代码：`backend/app/mcp/`、`backend/tests/test_mcp_server.py`。
- 新增/更新针对每个修复点的测试。
- 跑通：

```powershell
cd backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest --ignore=tests/test_mcp_server.py -q
```

如在普通环境中 `uv` 可用，也可跑：

```powershell
cd backend
uv run pytest --ignore=tests/test_mcp_server.py -q
```

## 可复制派发 Prompt

```text
你正在修复 E:\Development\MyAwesomeApp\PomodoroXII 的 backend Phase C sync 问题。

重要约束：
- 不要审查、修改、格式化另一个 agent 的 MCP WIP：backend/app/mcp/ 和 backend/tests/test_mcp_server.py。
- 不要 git reset / checkout / revert 用户或其他 agent 的改动。
- 先阅读项目根目录的 PhaseC-sync-repair-dispatch.md。
- 保持现有架构铁律：routes commit，services flush，不在 services 引入 FastAPI。

优先任务：
1. 修复 Note 正文不随 /sync/pull 和 /sync/full 下发的问题。pull notes 时使用 filesystem read_notes_batch 批量补 content，并补测试。
2. 修复 sync timestamp/cursor 问题：统一 sync 时间持久化格式，修正 normalize_timestamp，并设计不会重复/跳过同 timestamp 记录的分页 cursor。补同 timestamp、秒精度/毫秒精度、tombstone 分页测试。
3. 修复 /sync/push 返回契约：local/tombstone/circular_ref 冲突不能进入 applied；remote wins 可以按明确契约处理。补 HTTP 与 service 测试。
4. 修复 Note sync update 覆盖 client_updated_at 的问题。sync_mode=True 时保留远端 timestamp，并同步 DB/frontmatter。补测试。
5. 处理 meta registry 与 sync entity_type 的 snake_case/camelCase 不一致。短期建议加 alias map 并在 meta 输出 sync_entity_type。补测试。
6. 修复 RelationService.link 的 service 层 rollback，改用 SAVEPOINT 或不污染外层事务的处理。补事务不被误回滚测试。
7. 修复 CI lint：dev extras 加 ruff，CI 移除 || true，并更新过时测试数量注释。

验收命令：
cd backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest --ignore=tests/test_mcp_server.py -q

交付：
- 简述改了哪些文件和每个问题的修复方式。
- 给出测试结果。
- 如果因为 API cursor 兼容性无法一次性完全修复，先实现不破坏现有客户端的兼容方案，并明确剩余迁移步骤。
```
