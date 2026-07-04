# PomodoroXI Sync 引擎深度审查与修复计划

## 概述

对 `pomodoroxi/backend` 的 sync 引擎 (`app/routes/sync.py`, 1046 行) 进行深度审查,发现 10 个潜在问题。本计划基于 TDD 方法论 (RED → GREEN → REFACTOR) 逐一修复。

**项目路径**: `e:\Development\MyAwesomeApp\pomodoroxi\backend`
**架构**: Vue3 + FastAPI, 单 SQLite 数据库 (WAL 模式), sync 逻辑全在路由层
**Python**: 3.10.11, pytest asyncio_mode=auto

---

## 当前状态分析

### 已有测试覆盖 (17 个 sync 测试文件)
- `test_sync.py` — 核心 CRUD + 冲突 + 批量
- `test_sync_pull_pagination.py` — 分页 (唯一时间戳,未覆盖重复时间戳)
- `test_sync_full_pagination.py` — full 分页
- `test_sync_tombstone_lifecycle.py` — IV-6 重建 + IV-5 TTL 守卫
- `test_sync_ttl_resurrection.py` — P3-3 create TTL 守卫
- `test_sync_folder_cycle.py` — P1-4 循环引用检测
- `test_sync_push_validation.py` — B3 输入验证 + G2/H2 schema 约束
- 以及 10 个实体级测试 (folder, habit, junction, session cascade 等)

### 关键架构约束
- **LWW 冲突解决**: 基于 `updated_at` 字符串比较 (毫秒精度, 无 Z 后缀)
- **Tombstone 防复活**: 90 天 TTL, 过期自动清理
- **SAVEPOINT 隔离**: 每个 push event 用 `db.begin_nested()` 隔离
- **ENTITY_REGISTRY**: 14 个同步实体, 驱动 pull/push/full/status
- **conftest.py**: 内存 SQLite + httpx AsyncClient + ASGITransport

---

## 问题清单与执行顺序

```
Task 0: P0-2 环境搭建 ──→ 所有 TDD 的前置条件
Task 1: P1-5 _normalize_timestamp 时区偏移 ──→ Task 2 依赖它
Task 2: P0-1 分页复合游标
Task 3: P1-3 push 验证绕过 ─┐
Task 4: P2-6 create 重建    ├─ 都改 sync_push, 区域不同
Task 5: P2-10 created_at 零时间 ─┘
Task 6: P2-8 + P2-9 _model_to_dict 统一 (同函数, 合并)
Task 7: P1-4 tombstone 清理阈值化
Task 8: P2-7 full tombstone 仅末页
Task 9: 全量回归验证
```

---

## 详细修复方案

### Task 0: 环境搭建 (P0-2)

**问题**: 无 `.venv`, `pyjwt` 未安装, `app/auth/security.py` import `jwt` 失败, 全部测试无法运行。

**修复**:
1. 在 `backend/` 下创建 `.venv` (Python 3.10.11)
2. `pip install -r requirements.txt`
3. 验证: `python -c "import jwt, bcrypt, slowapi, aiosqlite, fastapi, sqlalchemy"`
4. 跑基线: `pytest tests/ -q` 记录通过/失败集

---

### Task 1: `_normalize_timestamp` 时区偏移 (P1-5)

**问题**: 行 112 `ts.rstrip("Z")` 只去 `Z`, 不处理 `+00:00`。对无小数秒的带偏移输入 `2026-06-26T12:00:00+00:00`, 产出畸形 `2026-06-26T12:00:00+00:00.000`。

**RED**: 新建 `tests/test_normalize_timestamp.py`
```python
from app.routes.sync import _normalize_timestamp

def test_normalize_strips_offset_without_fraction():
    assert _normalize_timestamp("2026-06-26T12:00:00+00:00") == "2026-06-26T12:00:00.000"

def test_normalize_strips_offset_with_fraction():
    assert _normalize_timestamp("2026-06-26T12:00:00.123+00:00") == "2026-06-26T12:00:00.123"
```

**GREEN**: 用正则一次性剥离尾部时区标记:
```python
import re
_TZ_SUFFIX = re.compile(r"(Z|[+-]\d{2}:\d{2})$")

def _normalize_timestamp(ts: str | None) -> str | None:
    if not ts:
        return ts
    ts = _TZ_SUFFIX.sub("", ts)
    if "T" not in ts:
        return ts
    base, _, frac = ts.partition(".")
    if frac:
        frac = (frac + "000")[:3]
        return f"{base}.{frac}"
    return f"{base}.000"
```

**回归**: `test_time_helper.py`

---

### Task 2: 分页数据丢失 Bug — 复合游标 (P0-1)

**问题**: `sync_pull` (行 254-265) 和 `sync_full` (行 988-1002) 用单值游标 `next_since = last_updated`, 下一页 `WHERE updated_at > next_since`。当多个实体共享同一 `updated_at` 且该时间戳落在页边界, 同时间戳的未返回实体被永久跳过。

**RED**: 新建 `tests/test_sync_pagination_cursor.py`
- seed 6 条 note, 全部相同 `updated_at`, `limit=5`
- 第一页 5 条 + `has_more=True`
- 第二页用 `next_since` 请求, 断言跨两页累计 == 6 条, 无丢失
- 对 `sync_full` 建镜像测试

**GREEN**: 复合游标 `(updated_at, id)`:
1. `next_since` 改为 `"updated_at|id"` 复合字符串
2. `since` 入参兼容: `None`(首屏), 含 `|`(复合游标), 不含 `|`(旧客户端 `(ts, "")`)
3. 查询条件:
```python
from sqlalchemy import or_, and_
if since_ts:
    query = query.where(
        or_(
            model.updated_at > since_ts,
            and_(model.updated_at == since_ts, model.id > since_id),
        )
    )
query = query.order_by(model.updated_at, model.id).limit(limit + 1)
```
4. `next_since`: `min_next_since = min(min_next_since, f"{last.updated_at}|{last.id}")`

**REFACTOR**: 抽取 `_encode_cursor(updated_at, id)` / `_decode_cursor(since)` 辅助函数

**风险**: `next_since` 格式变化, 需确认前端 `useSync.ts` 透传 `next_since`。

---

### Task 3: sync_push 更新路径验证绕过 (P1-3)

**问题**: 行 531 `schema_cls(**entity_data)` 验证后丢弃; 行 685-687 用原始 `entity_data` 做 `setattr`。`*Update` schema 枚举字段是 `Optional[str]` 而非 `Literal`, 验证形同虚设。

**RED**: 扩展 `tests/test_sync_push_validation.py`
```python
async def test_push_update_invalid_mood_rejected(client, auth_headers):
    # create reflection, then update with garbage mood
    # ReflectionUpdate.mood 是 Optional[str] → 验证通过 → 静默写入
    # 断言 pull 返回的 mood != "garbage_value"
```

**GREEN**: 将 `*Update` schema 枚举字段改为 `Optional[Literal[...]]`:
- `TaskUpdate.status`, `TaskUpdate.priority`
- `SessionUpdate.type`, `SessionUpdate.mood`
- `ReflectionUpdate.mood`
- 核对 `QuickNoteUpdate.mood`, `ScheduleUpdate.priority`

---

### Task 4: create 动作缺失"删除后重建"逻辑 (P2-6)

**问题**: 行 493 `if action == "update" and ...` — IV-6 重建逻辑仅对 update 生效。

**RED**: 扩展 `tests/test_sync_tombstone_lifecycle.py`, 镜像重建测试但用 `create` 动作

**GREEN**: 行 493 条件改为 `if action in ("create", "update") and ...`

**回归**: `test_update_deleted_entity_without_recreate_returns_conflict`

---

### Task 5: 零时间 `created_at` 未被清理 (P2-10)

**问题**: 行 431-439 只清理 `updated_at` 零时间。TTL 守卫用 `created_at` 比较, 零时间 created_at 若 >90 天前会误判。

**RED**: 扩展 `tests/test_sync_ttl_resurrection.py`
```python
async def test_update_as_create_with_zero_time_old_created_at_not_blocked(client, auth_headers):
    old_zero = "2026-04-01T00:00:00.000"  # >90天 + 零时间
    # push update with old_zero created_at
    # 断言 applied == [0], conflicts == []
```

**GREEN**: 两处 TTL 守卫前加零时间跳过:
```python
if entity_created and not _is_zero_time(entity_created) and entity_created < ttl_cutoff:
    conflicts.append({...}); continue
```

**REFACTOR**: 抽 `_should_block_by_ttl(entity_created, ttl_cutoff) -> bool`

---

### Task 6: `_model_to_dict` 列定义分叉 + 缺 JSON Object 处理 (P2-8 + P2-9)

**P2-8**: 行 146-148 局部定义与行 175-179 模块级定义重复
**P2-9**: `_model_to_dict` 不解析 `cognitive_mark_summary` (JSON Object), 返回原始字符串

**RED**: 扩展 `tests/test_model_to_dict_none.py`
```python
def test_model_to_dict_parses_cognitive_mark_summary():
    s = Sess(id="s1", type="work", duration=25, ...,
             cognitive_mark_summary='{"focus": 3, "distraction": 1}', ...)
    d = _model_to_dict(s)
    assert d["cognitive_mark_summary"] == {"focus": 3, "distraction": 1}
```

**GREEN**:
1. 删除局部定义, 用模块级
2. 新增 JSON Object 分支:
```python
elif col.name in _JSON_OBJECT_COLUMNS and isinstance(val, str):
    try:
        val = json.loads(val)
    except (json.JSONDecodeError, ValueError):
        val = {}
    d[col.name] = val
```

---

### Task 7: sync_pull tombstone 清理阈值化 (P1-4)

**问题**: 行 323-338 每次 pull 无条件 DELETE + COMMIT 清理过期 tombstone。

**RED**: 新建 `tests/test_sync_pull_tombstone_cleanup.py`
```python
async def test_pull_does_not_cleanup_below_threshold(client, auth_headers):
    # seed 3 条过期 tombstone
    # pull
    # 断言 cnt == 3 (低于阈值不清理)
```

**GREEN**: 数量阈值门控:
```python
TOMBSTONE_CLEANUP_THRESHOLD = 500
tomb_count = (await db.execute(select(func.count(Tombstone.id)))).scalar() or 0
if tomb_count > TOMBSTONE_CLEANUP_THRESHOLD:
    # cleanup + commit
```

---

### Task 8: sync_full 每页返回全部 tombstone (P2-7)

**问题**: 行 1030-1034 无条件返回全部 tombstone, 不看 `has_more`。

**RED**: 扩展 `tests/test_sync_full_pagination.py`
```python
async def test_full_tombstones_only_on_last_page(client, auth_headers):
    # seed 12 notes (3 pages) + 4 tombstones
    # p1: has_more=True, tombstones=[]
    # p2: has_more=True, tombstones=[]
    # p3: has_more=False, tombstones=4
```

**GREEN**: 仅 `has_more == False` 时返回 tombstone

---

### Task 9: 全量回归验证

1. `pytest tests/ -q` 全量通过
2. 重点回归: test_sync.py, test_sync_pull/full_pagination, test_sync_push_validation, test_sync_tombstone_lifecycle, test_sync_ttl_resurrection, test_model_to_dict_none, test_time_helper
3. 确认无 import 错误、无 collection error

---

## 假设与决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| `next_since` 格式 | `ts\|id` 复合字符串 | 最小改动, 向后兼容裸时间戳 |
| tombstone 清理策略 | 数量阈值 (500) | 避免每次 pull 写库, TTL=90天滞留可接受 |
| `*Update` 枚举验证 | `Optional[Literal[...]]` | 最小修复, 不改写入路径结构 |
| `cognitive_mark_summary` 空串 | 解析为 `{}` | 空串=无标记, 空对象等价 |
| 零时间 `created_at` TTL | 跳过检查 | 与 W1-1 updated_at 零时间处理一致 |

## 前端联动风险

| 修复 | 契约变化 | 前端核对点 |
|------|----------|------------|
| Task 2 复合游标 | `next_since` 变为 `ts\|id` | 前端是否透传 (不解析当时间戳) |
| Task 8 tombstone 仅末页 | 非末页 `tombstones: []` | 前端是否"仅末页应用 tombstone" |
| Task 6 cognitive_mark_summary | pull 返回 dict | 前端是否 JSON.parse 该字段 |
