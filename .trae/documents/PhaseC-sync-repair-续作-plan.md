# Phase C Sync 修复 — 续作计划 (Task 4-7)

> **日期**: 2026-07-04
> **范围**: 续作 Task 4 (P1-3 验证) + Task 5 (P1-2) + Task 6 (P2-1) + Task 7 (P2-2)
> **基线**: 406 passed (排除 MCP WIP)
> **约束**: 不碰 `backend/app/mcp/` 和 `backend/tests/test_mcp_server.py`
> **方法**: 严格 TDD (Red → Verify Red → Green → Verify Green → Refactor)

---

## 当前状态分析

### Task 4 (P1-3) — 代码已应用,Green 验证待完成

**已完成的代码改动**:
1. [base.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/base.py#L75-L100) — `update()` 增加 `bump_updated_at: bool = True` 参数 + `elif "updated_at" not in data: obj.updated_at = original_ts` 防护 onupdate
2. [note.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/note.py#L115-L199) — `update_content`/`update_metadata`/`update` 均增加 `updated_at_override` 参数
3. [sync.py:399](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/sync.py#L399) — `_push_note_event` update 分支传 `updated_at_override=client_ts_n`

**已写的 3 个 Red 测试** (在 [test_sync_service.py:1153-1264](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_sync_service.py#L1153-L1264)):
- `test_push_note_update_preserves_client_updated_at` (content + metadata)
- `test_push_note_update_preserves_client_updated_at_metadata_only` (仅 metadata)
- `test_sync_mode_update_does_not_bump_updated_at_in_base_service` (BaseService 单元测试)

**关键风险点**: `SyncMixin.updated_at` 有 `onupdate=utc_now_iso_ms` ([mixins.py:35-37](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/models/mixins.py#L35-L37))。SQLAlchemy 行为: 当字段被显式 setattr 后,onupdate 不会触发。`update_content` 显式设 `obj.updated_at = updated_at_override`,应能阻断 onupdate。需验证。

### Task 5 (P1-2) — 部分基础设施已存在

**已存在**:
- [entities.py:73](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/entities.py#L73) — `EntitySpec` 有 `sync_entity_type: str | None = None` 字段
- [builtin.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/registry/builtin.py) — 7 个实体已填 `sync_entity_type` (quickNote/habitCheckIn/timeBlock/memoComment/sessionQuickNote/scheduleQuickNote/taskQuickNote)
- [test_parity_registry_sync.py](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/tests/test_parity_registry_sync.py) — 已验证 REGISTRY vs ENTITY_REGISTRY 一致性

**缺失**:
- sync.py push() 不接受 snake_case 别名 (quick_note 等会被拒)
- meta.py serialize() 不输出 `sync_entity_type` 字段
- schemas/meta.py `EntitySpecOut` 无 `sync_entity_type` 字段

### Task 6 (P2-1) — relation.py 仍有 service 层 rollback

[relation.py:78](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/app/services/relation.py#L78) `await self.db.rollback()` 违反"services 只 flush"铁律。

### Task 7 (P2-2) — CI lint 非阻塞

- [ci.yml:71-72](file:///e:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L71-L72) — `|| true` 使 lint 失效
- [ci.yml:11](file:///e:/Development/MyAwesomeApp/PomodoroXII/.github/workflows/ci.yml#L11) — 注释写 "361 tests" (实际 406)
- [pyproject.toml:23-28](file:///e:/Development/MyAwesomeApp/PomodoroXII/backend/pyproject.toml#L23-L28) — dev extras 无 ruff

---

## Proposed Changes

### Task 4: P1-3 Green 验证 (无需新代码,仅验证)

**步骤**:
1. 仅跑 3 个 Task 4 测试验证 Green (避免状态污染):
```powershell
cd e:\Development\MyAwesomeApp\PomodoroXII\backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at_metadata_only tests/test_sync_service.py::test_sync_mode_update_does_not_bump_updated_at_in_base_service -v --tb=short --no-header
```
2. 若全绿,跑 `test_note_service.py` + `test_base_service.py` 检查回归
3. 若 `test_push_note_update_preserves_client_updated_at` 仍失败 (content 路径),检查 `update_content` 的 `await self.db.refresh(obj)` 是否读回 onupdate 覆盖值。若如此,在 refresh 后重新 setattr `obj.updated_at = updated_at_override`

### Task 5: P1-2 Entity type alias map + meta sync_entity_type 字段

#### Red 阶段 — 写失败测试

**新建** `backend/tests/test_sync_entity_alias.py`:
```python
"""P1-2: sync entity_type snake_case/camelCase alias canonicalization."""
from __future__ import annotations
import pytest


def test_canonicalize_camel_case_passthrough():
    """camelCase entity_type 应原样通过。"""
    from app.services.sync_entity_types import canonicalize_entity_type
    assert canonicalize_entity_type("quickNote") == "quickNote"
    assert canonicalize_entity_type("task") == "task"


def test_canonicalize_snake_case_alias():
    """snake_case entity_type 应规范化为 camelCase。"""
    from app.services.sync_entity_types import canonicalize_entity_type
    assert canonicalize_entity_type("quick_note") == "quickNote"
    assert canonicalize_entity_type("habit_check_in") == "habitCheckIn"
    assert canonicalize_entity_type("time_block") == "timeBlock"
    assert canonicalize_entity_type("memo_comment") == "memoComment"
    assert canonicalize_entity_type("session_quick_note") == "sessionQuickNote"
    assert canonicalize_entity_type("schedule_quick_note") == "scheduleQuickNote"
    assert canonicalize_entity_type("task_quick_note") == "taskQuickNote"


def test_canonicalize_unknown_returns_none():
    """未知 entity_type 应返回 None。"""
    from app.services.sync_entity_types import canonicalize_entity_type
    assert canonicalize_entity_type("nonexistent") is None


@pytest.mark.asyncio
async def test_push_accepts_snake_case_entity_type(space_session):
    """sync push 使用 snake_case entity_type 应成功应用。"""
    from app.services.sync import SyncService
    from app.models.quick_note import QuickNote
    import uuid

    svc = SyncService(space_session)
    eid = uuid.uuid4().hex
    result = await svc.push([{
        "entity_type": "quick_note",  # snake_case
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid, "content": "test", "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert result["errors"] == []
    row = await space_session.get(QuickNote, eid)
    assert row is not None
```

**扩展** `backend/tests/test_routes_meta.py` 末尾追加:
```python
@pytest.mark.asyncio
async def test_meta_entity_includes_sync_entity_type(client):
    """P1-2: /meta/entities/{name} 应返回 sync_entity_type 字段。"""
    token = await _get_master_token(client)
    # quick_note 的 sync_entity_type 应为 quickNote
    resp = await client.get(
        "/api/v1/meta/entities/quick_note", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sync_entity_type"] == "quickNote"


@pytest.mark.asyncio
async def test_meta_entity_list_includes_sync_entity_type(client):
    """P1-2: /meta/entities 列表每项应含 sync_entity_type 字段。"""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    entities = resp.json()["entities"]
    # 找 quick_note
    qn = next(e for e in entities if e["name"] == "quick_note")
    assert qn["sync_entity_type"] == "quickNote"
    # task 无 alias,sync_entity_type 应为 None 或 "task"
    task = next(e for e in entities if e["name"] == "task")
    assert task["sync_entity_type"] in (None, "task")
```

**验证 Red**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py::test_meta_entity_includes_sync_entity_type tests/test_routes_meta.py::test_meta_entity_list_includes_sync_entity_type -v --tb=short --no-header
```
预期: 5 个测试全失败 (ModuleNotFoundError / 字段缺失)

#### Green 阶段 — 实现

**新建** `backend/app/services/sync_entity_types.py`:
```python
"""P1-2: Entity type alias map for snake_case ↔ camelCase canonicalization.

Meta registry 暴露 snake_case name (quick_note, habit_check_in, ...),
但 SyncService.ENTITY_REGISTRY 使用 camelCase (quickNote, habitCheckIn, ...).
此模块在 sync push 入口处将 snake_case 规范化为 camelCase,使客户端
可使用任一形式。
"""
from __future__ import annotations

# snake_case → camelCase alias map (与 ENTITY_REGISTRY keys 对齐)
_ALIAS_MAP: dict[str, str] = {
    "quick_note": "quickNote",
    "habit_check_in": "habitCheckIn",
    "time_block": "timeBlock",
    "memo_comment": "memoComment",
    "session_quick_note": "sessionQuickNote",
    "schedule_quick_note": "scheduleQuickNote",
    "task_quick_note": "taskQuickNote",
}


def canonicalize_entity_type(entity_type: str) -> str | None:
    """将 entity_type 规范化为 ENTITY_REGISTRY 中的 camelCase key。

    - camelCase 输入原样返回 (若是已知 key)
    - snake_case 输入映射为 camelCase
    - 未知输入返回 None
    """
    if entity_type in _ALIAS_MAP.values():
        return entity_type
    if entity_type in _ALIAS_MAP:
        return _ALIAS_MAP[entity_type]
    return None
```

**修改** `backend/app/services/sync.py` push() 方法 — 在 `etype not in ENTITY_REGISTRY` 检查前加 canonicalize:
```python
# 文件顶部 imports 区追加:
from app.services.sync_entity_types import canonicalize_entity_type

# push() 方法内,在 `etype = event.get("entity_type", "")` 之后:
etype_raw = event.get("entity_type", "")
etype = canonicalize_entity_type(etype_raw) or etype_raw
if etype not in ENTITY_REGISTRY:
    errors.append({
        "entity_type": etype_raw,
        "entity_id": eid,
        "error": f"Unknown entity_type: {etype_raw}",
    })
    continue
```

**修改** `backend/app/services/meta.py` serialize() — 增加 sync_entity_type 输出:
```python
@staticmethod
def serialize(spec: EntitySpec) -> dict[str, Any]:
    return {
        "name": spec.name,
        "model_path": spec.model_path,
        "table_name": spec.table_name,
        "storage_type": spec.storage_type.value,
        "category": spec.category.value,
        "sync_enabled": spec.sync_enabled,
        "soft_delete": spec.soft_delete,
        "primary_key": spec.primary_key,
        "description": spec.description,
        "sync_entity_type": spec.sync_entity_type,  # P1-2 新增
        "fields": [MetaService._field_dict(f) for f in spec.fields],
    }
```

**修改** `backend/app/schemas/meta.py` `EntitySpecOut` — 增加字段:
```python
class EntitySpecOut(BaseModel):
    name: str
    model_path: str
    table_name: str
    storage_type: StorageType
    category: EntityCategory
    sync_enabled: bool
    soft_delete: bool
    primary_key: str = "id"
    description: str = ""
    sync_entity_type: str | None = None  # P1-2 新增
    fields: list[FieldSpecOut]
    model_config = {"from_attributes": True}
```

**验证 Green**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py::test_meta_entity_includes_sync_entity_type tests/test_routes_meta.py::test_meta_entity_list_includes_sync_entity_type -v --tb=short --no-header
```

### Task 6: P2-1 RelationService.link 改用 SAVEPOINT

#### Red 阶段 — 写失败测试

**扩展** `backend/tests/test_relation_service.py` 末尾追加:
```python
@pytest.mark.asyncio
async def test_link_savepoint_does_not_rollback_outer_changes(space_session):
    """P2-1: link() 触发 IntegrityError 时不应回滚外层事务的其他改动。"""
    from app.services.relation import RelationService
    from app.models.task import Task
    from sqlalchemy import select

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    # Step 1: 在同一事务中先创建一个 Task (外层改动)
    task = Task(
        id=task_id, title="Outer Task", status="todo",
        priority="medium", tags="[]",
    )
    space_session.add(task)
    await space_session.flush()

    # Step 2: link 同一对 (task_id, qn_id) 两次,第二次触发 IntegrityError
    await svc.link("task", task_id, qn_id)
    # 强制制造 IntegrityError: 直接插入重复行
    from app.models.task_quick_note import TaskQuickNote
    dup = TaskQuickNote(task_id=task_id, quick_note_id=qn_id)
    space_session.add(dup)
    # link() 内部会捕获 IntegrityError 并 re-query
    await svc.link("task", task_id, qn_id)

    # Step 3: 外层 Task 应仍然存在 (未被 rollback)
    res = await space_session.execute(
        select(Task).where(Task.id == task_id)
    )
    assert res.scalar_one_or_none() is not None, (
        "Outer Task was rolled back — SAVEPOINT isolation failed"
    )


@pytest.mark.asyncio
async def test_link_savepoint_returns_existing_on_race(space_session):
    """P2-1: link() 在 SAVEPOINT 回滚后应返回已存在的行。"""
    from app.services.relation import RelationService

    svc = RelationService(space_session)
    task_id = uuid.uuid4().hex
    qn_id = uuid.uuid4().hex

    # 第一次 link 成功
    first = await svc.link("task", task_id, qn_id)
    assert first is not None

    # 模拟并发: 手动插入重复行后 link,应触发 IntegrityError → SAVEPOINT 回滚 → re-query
    # 这里用直接 link 两次来测试幂等路径 (不触发 IntegrityError)
    second = await svc.link("task", task_id, qn_id)
    assert second.id == first.id
```

**验证 Red**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py::test_link_savepoint_does_not_rollback_outer_changes tests/test_relation_service.py::test_link_savepoint_returns_existing_on_race -v --tb=short --no-header
```
预期: `test_link_savepoint_does_not_rollback_outer_changes` 失败 (rollback 撤销了外层 Task)

#### Green 阶段 — 实现

**修改** `backend/app/services/relation.py` `link()` 方法:
```python
async def link(self, kind: str, parent_id: str, quick_note_id: str) -> Any:
    """Create a junction row.  Idempotent -- returns existing if present.

    P2-1: 使用 SAVEPOINT 隔离 IntegrityError,避免污染外层事务。
    """
    model, parent_col = self._resolve(kind)
    res = await self.db.execute(
        select(model).where(
            getattr(model, parent_col) == parent_id,
            model.quick_note_id == quick_note_id,
        )
    )
    existing = res.scalar_one_or_none()
    if existing is not None:
        return existing
    row = model(**{parent_col: parent_id, "quick_note_id": quick_note_id})
    self.db.add(row)
    try:
        async with self.db.begin_nested():
            await self.db.flush()
        await self.db.refresh(row)
        return row
    except IntegrityError:
        # SAVEPOINT 已回滚;re-query existing
        res = await self.db.execute(
            select(model).where(
                getattr(model, parent_col) == parent_id,
                model.quick_note_id == quick_note_id,
            )
        )
        existing = res.scalar_one_or_none()
        if existing is not None:
            return existing
        raise
```

**验证 Green**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py -v --tb=short --no-header
```

### Task 7: P2-2 CI lint 修复

**修改** `backend/pyproject.toml` dev extras 加 ruff:
```toml
[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-asyncio>=0.24",
    "httpx>=0.28",
    "ruff>=0.8",
]
```

**修改** `.github/workflows/ci.yml`:
- 第 11 行注释: `#   1. test   — pytest + ruff lint` (移除写死的测试数量)
- 第 71-72 行: 移除 `|| true`,改为 `uv run ruff check app tests`
- 第 74 行注释: `# Run pytest` (移除写死的测试数量)

**验证 lint**:
```powershell
cd e:\Development\MyAwesomeApp\PomodoroXII\backend
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path
$env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m ruff check app tests
```
若发现 lint 错误,逐个修复 (不自动 `--fix`,手动审查)。

---

## Assumptions & Decisions

1. **Task 4 不需新代码**: 已应用的 base.py/note.py/sync.py 改动应能通过 3 个 Red 测试。若 `update_content` 路径仍失败,需在 `await self.db.refresh(obj)` 后重新 setattr。
2. **Task 5 alias map 是单向的**: 只接受 snake_case → camelCase,不反向。pull_key 和 tombstone entity_type 保持 camelCase 不变,避免破坏现有客户端。
3. **Task 5 meta serialize 输出 `sync_entity_type`**: 即使为 None 也输出,让客户端明确知道字段存在。
4. **Task 6 SAVEPOINT 嵌套**: `begin_nested()` 在已存在的事务中创建 SAVEPOINT,IntegrityError 只回滚 SAVEPOINT,不影响外层。
5. **Task 7 ruff 配置**: 使用 ruff 默认规则集,不引入 `[tool.ruff]` 自定义配置 (保持简单)。若默认规则过严导致大量误报,再考虑加 `[tool.ruff.lint]` 忽略规则。
6. **不碰 MCP WIP**: 所有改动避开 `backend/app/mcp/` 和 `backend/tests/test_mcp_server.py`。

---

## Verification Steps

### 阶段性验证 (每个 Task 完成后)

**Task 4**:
```powershell
cd e:\Development\MyAwesomeApp\PomodoroXII\backend
$env:TEMP = (Resolve-Path .tmp).Path; $env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path; $env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at tests/test_sync_service.py::test_push_note_update_preserves_client_updated_at_metadata_only tests/test_sync_service.py::test_sync_mode_update_does_not_bump_updated_at_in_base_service tests/test_note_service.py tests/test_base_service.py -v --tb=short --no-header
```

**Task 5**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_sync_entity_alias.py tests/test_routes_meta.py -v --tb=short --no-header
```

**Task 6**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest tests/test_relation_service.py -v --tb=short --no-header
```

**Task 7**:
```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m ruff check app tests
```

### 全量回归 (所有 Task 完成后)

```powershell
cd e:\Development\MyAwesomeApp\PomodoroXII\backend
$env:TEMP = (Resolve-Path .tmp).Path; $env:TMP = $env:TEMP
$site = (Resolve-Path .venv\Lib\site-packages).Path; $env:PYTHONPATH = ".;$site"
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m pytest --ignore=tests/test_mcp_server.py -q
```

**预期结果**: 406 baseline + Task 4 (3) + Task 5 (5) + Task 6 (2) = 416 passed, 0 failed

### Lint 验证 (最后一步)

```powershell
& 'C:\Users\20564\.workbuddy\binaries\python\versions\3.13.12\python.exe' -m ruff check app tests
```
预期: All checks passed (或修复后通过)

---

## 执行顺序

1. **Task 4 Green 验证** (无需新代码,仅跑测试)
2. **Task 5 Red** (写 test_sync_entity_alias.py + 扩展 test_routes_meta.py)
3. **Task 5 Green** (新建 sync_entity_types.py + 修改 sync.py/meta.py/schemas/meta.py)
4. **Task 6 Red** (扩展 test_relation_service.py)
5. **Task 6 Green** (修改 relation.py)
6. **Task 7** (修改 pyproject.toml + ci.yml + 跑 ruff check + 修复 lint)
7. **全量回归** (排除 MCP WIP,预期 416 passed)
