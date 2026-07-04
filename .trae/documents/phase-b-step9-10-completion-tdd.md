# Phase B Step 9-10 完成 TDD 实施计划

## 摘要

Phase B Steps 3-8 已完成（65 测试全部通过），Step 9 有 36/45 测试通过、7 个失败。根因是 Task schema 包含 `folder_id` 字段但 Task ORM 模型无此列，导致 `Task(**data)` 抛出 `TypeError`。此外，trash 路由存在两个关联问题：回收站列表不显示硬删除实体的墓碑、`_ENTITY_MAP` 缺少 `"task"` 条目。本计划覆盖 Step 9 的 3 项修复（使 45/45 通过）和 Step 10 的 5 个集成/门禁测试。

## 当前状态分析

### 测试统计
- 总计 237 测试（230 通过，7 失败）
- 7 个失败全在 `tests/test_routes_v1.py`，根因统一为 `folder_id` 导致 Task 创建失败
- 服务层 0 处 FastAPI 导入（已通过代码审查确认）
- v1 路由 60 个（14 个路由文件，远超 40 的门禁阈值）

### 失败链路
`POST /api/v1/tasks` → `TaskCreate.model_dump()` 包含 `folder_id: None` → `Task(**data)` → `TypeError: 'folder_id' is an invalid keyword argument for Task` → 500 → 测试断言 201 失败

### 7 个失败测试的依赖关系
| 测试 | 依赖修复 | 原因 |
|------|---------|------|
| test_tasks_create_201 | Fix A | Task 创建失败 |
| test_tasks_list_filter_by_status | Fix A | Task 创建失败 |
| test_tasks_update_partial | Fix A | Task 创建失败 |
| test_tasks_delete_idempotent | Fix A | Task 创建失败 |
| test_stats_task_distribution | Fix A | Task 创建失败 |
| test_trash_list_after_delete | Fix A + Fix B | Task 创建 + 回收站列表不含墓碑 |
| test_trash_restore | Fix A + Fix C | Task 创建 + `_resolve_model("task")` 返回 422 |

## 实施步骤

### Step 9: 修复代码（Green 阶段）

测试已存在（Red 阶段完成），仅修改生产代码使测试通过。

#### Fix A: 移除 Task schema 中的 `folder_id`

**文件**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend\app\schemas\task.py`

**改动**:
1. TaskBase 第 26 行 — 删除 `folder_id: Optional[str] = Field(default=None, max_length=36)`
2. TaskUpdate 第 55 行 — 删除 `folder_id: Optional[str] = Field(default=None, max_length=36)`

**改动后 TaskBase 字段**:
```python
class TaskBase(BaseModel):
    title: str = Field(..., max_length=200)
    status: Literal["todo", "in_progress", "done", "archived"] = "todo"
    priority: Literal["low", "medium", "high", "urgent"] = "medium"
    tags: list[str] = []
    description: str = Field(default="", max_length=10000)
    plan: str = Field(default="", max_length=10000)
    completion: str = Field(default="", max_length=10000)
    due_date: Optional[str] = Field(default=None, max_length=32)
    estimated_pomodoros: int = 1
    # folder_id 已移除 — Task 模型无此列
```

**影响**: `TaskCreate.model_dump()` 不再含 `folder_id` → `Task(**data)` 成功 → 5 个测试恢复绿色。`Optional` 仍被 `due_date` 使用，无未使用导入。

#### Fix B: 回收站列表添加墓碑查询

**文件**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend\app\routes\v1\trash.py`

**根因**: `list_trash` 仅查询 Note/Folder/QuickNote 的 `trashed_at IS NOT NULL`。但 `TaskService.delete()` 执行硬删除 + 创建 Tombstone（Task 无 `trashed_at` 列）。删除 Task 后回收站列表查不到记录。

**改动**:
1. 添加导入: `from app.models.tombstone import Tombstone`
2. 在 `list_trash` 的 QuickNote 查询之后、`return items` 之前添加:
```python
    # Tombstones — hard-deleted entities (tasks, purged notes/folders).
    res = await db.execute(select(Tombstone))
    for t in res.scalars().all():
        items.append(
            {
                "entity_type": t.entity_type,
                "entity_id": t.entity_id,
                "title": f"(deleted {t.entity_type})",
                "deleted_at": t.deleted_at,
            }
        )
```

**去重确认**: 硬删除 = 行不存在（trashed_at 查询不命中）+ 有墓碑；软删除 = 行存在（trashed_at 查询命中）+ 无墓碑。两类查询不会产生重复。

#### Fix C: `_ENTITY_MAP` 添加 `"task"`

**文件**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend\app\routes\v1\trash.py`

**根因**: `test_trash_restore` 调用 `POST /api/v1/trash/task/{id}/restore`，但 `_ENTITY_MAP` 无 `"task"`。`_resolve_model("task")` 抛 `ValidationError`（422），测试期望 200 或 404。

**改动**:
1. 添加导入: `from app.models.task import Task`
2. `_ENTITY_MAP` 添加 `"task": Task`

**执行路径**（已删除的 Task）:
1. `db.get(Task, id)` → `None`（行已硬删除）
2. `raise NotFoundError` → 404
3. `obj.trashed_at = None` 永不执行（obj 为 None 时已抛异常）

测试断言 `in (200, 404)` → 404 通过。

#### Fix B + C 合并后的导入区

```python
from app.models.task import Task          # Fix C
from app.models.tombstone import Tombstone  # Fix B
```

#### Step 9 验证
```powershell
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend
uv run pytest tests/test_routes_v1.py -v
```
预期: 45/45 通过。

---

### Step 10: 集成测试 + 门禁检查

**文件**: `e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend\tests\test_integration.py`（新建）

5 个测试，复用 `test_routes_v1.py` 的 `_get_space_client` / `_auth` / `_items` helper 模式。

#### 测试 1: `test_full_lifecycle_space_token_task_session_stats`

端到端生命周期: setup → login → create_space → issue_token → create_task → create_session → stats_overview → delete_task → trash_list_shows_tombstone

关键断言:
- space 创建返回 201 + id
- space_token 签发成功
- task 创建 201
- session 创建 201
- stats/overview 返回 200 + dict
- task 删除 200
- trash 列表包含 `entity_type == "task"` 条目（依赖 Fix B）

#### 测试 2: `test_note_saga_end_to_end_consistency`

Note saga 一致性: create → get_meta（无 content）→ get_content（.md 正文）→ update_content → hash 变化 → delete → 404

关键断言:
- 创建响应有 `content_hash` + `word_count`，无 `content`
- GET 元数据无 `content`
- GET content 返回 .md 正文
- 更新 content 后 `content_hash != original_hash`
- 删除后 GET 返回 404

#### 测试 3: `test_cascade_folder_delete_integration`

级联软删除: root/child/grandchild + note → DELETE root → 全部 trashed + note unfiled

关键断言:
- 三层文件夹创建成功
- Note 创建在 grandchild 下（`folder_id: grandchild_id`）
- DELETE root 返回 200
- child/grandchild 的 `trashed_at` 非空（或 404）
- Note 的 `folder_id` 变为 None（CascadeService 清除引用）

#### 测试 4: `test_gate_services_do_not_import_fastapi`

AST 扫描 `app/services/*.py`，检查无 `import fastapi` 或 `from fastapi import` 语句。

实现: 用 `ast.parse` + `ast.walk` 检查 `ast.Import` 和 `ast.ImportFrom` 节点。不误报注释或字符串中的 "fastapi"。

当前状态: 10 个服务文件，0 处 FastAPI 导入。此测试为回归守护。

#### 测试 5: `test_gate_all_v1_routes_registered`

调用 `create_app()`，统计 `/api/v1` 下路由数 >= 40。

当前路由统计: 14 个路由文件共 60 个路由装饰器（auth 3, spaces 4, tasks 5, sessions 4, notes 6, folders 5, quick_notes 5, reflections 4, habits 6, schedules 4, time_blocks 4, trash 4, stats 4, settings 2）。

#### Step 10 验证
```powershell
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend
uv run pytest tests/test_integration.py -v
```
预期: 5/5 通过。

---

### 全量回归 + Lint

```powershell
cd e:\Development\MyAwesomeApp\pomodoroxi\PomodoroXII-rebuild\backend
uv run pytest -q
uv run ruff check app/ --fix
```
预期: ~242 测试全部通过，lint 无错误。

## 实施顺序

```
Fix A (task.py 移除 folder_id)     ← 独立
Fix C (trash.py 添加 task 到 MAP)   ← 与 Fix B 同文件，合并编辑
Fix B (trash.py 添加墓碑查询)       ← 与 Fix C 同文件，合并编辑
  ↓
验证 Step 9: pytest tests/test_routes_v1.py -v  (45/45)
  ↓
创建 tests/test_integration.py (5 测试)
  ↓
验证 Step 10: pytest tests/test_integration.py -v  (5/5)
  ↓
全量回归: pytest -q  (~242 全通过)
  ↓
Lint: ruff check app/ --fix
```

## 假设与决策

1. **Task 无 folder_id**: Task ORM 模型没有 `folder_id` 列，schema 不应包含模型不存在的字段。Note 有 `folder_id` 是因为 Note 模型有此列。
2. **墓碑作为回收站数据源**: 所有删除操作（Task/Note）都创建墓碑。硬删除后墓碑是唯一记录，将其纳入回收站列表是合理设计。
3. **`_ENTITY_MAP` 添加 task**: Task 虽无 `trashed_at`（不支持软删除恢复），但添加到 MAP 后 `db.get(Task, id)` 返回 None → 404，行为正确。`obj.trashed_at = None` 行永不执行。
4. **门禁阈值 40**: 当前 60 个路由，设 40 为下限留有余量。
5. **文件路径**: pomodoroxi（小写）在 TRAE 工作区外，修改时先写入临时目录再 `shutil.copy2` 到目标。但 `SearchReplace` 工具可直接编辑目标文件。
6. **TDD 纪律**: Step 9 的 Red 阶段已完成（测试已存在且失败），此步骤为 Green。Step 10 需先写测试（Red），再验证通过（Green）——但基础设施已就位，测试应立即通过。

## 改动清单

| 步骤 | 文件 | 类型 | 改动 |
|------|------|------|------|
| 9-A | `app/schemas/task.py` | 删除 2 行 | TaskBase + TaskUpdate 的 `folder_id` |
| 9-B | `app/routes/v1/trash.py` | 添加导入 + ~8 行 | 导入 Tombstone；list_trash 添加墓碑查询 |
| 9-C | `app/routes/v1/trash.py` | 添加导入 + 1 行 | 导入 Task；_ENTITY_MAP 添加 "task" |
| 10 | `tests/test_integration.py` | 新建 ~200 行 | 5 个集成/门禁测试 + helpers |
