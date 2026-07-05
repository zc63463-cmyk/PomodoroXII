# since_id 多页 Hotfix 验收报告

> **审查时间：** 2026-07-05 下午  
> **Hotfix 分支：** `codex/fix-sync-since-id-multipage`  
> **Commit：** `5f00b93` — `fix(sync): preserve since_id across same-timestamp pages`  
> **合并：** PR #8 → `main` @ `4ac3bdb`  
> **基线：** PR #7 `6ea4021`（`efa6af4` since_id 复合游标）  
> **审查结论：** ✅ **通过验收，已合并**

---

## TL;DR

PR #7 引入的 `since_id` 分页在「同 `updated_at` 超过两页」时存在 **page2 丢失 `next_since_id`** 的回归，导致 page3 跳过剩余数据。Hotfix 用 `latest_entity_ts` / `latest_entity_id` 独立追踪实体游标，修复根因。改动仅 2 文件，8 个 cursor 测试全绿，558 全量 pytest 通过。

---

## 一、缺陷复盘（PR #7）

### 原判定逻辑（有 bug）

```python
if max_ts != since_n:
    result["next_since_id"] = next_since_id
```

### 失败场景：5 条同 timestamp，`limit=2`

| 页 | `since` / `since_id` | 返回 | `max_ts` | `max_ts != since_n`? | `next_since_id` |
|----|----------------------|------|----------|----------------------|-----------------|
| 1 | `""` / `""` | s1, s2 | `ts` | ✅ | `s2` |
| 2 | `ts` / `s2` | s3, s4 | `ts` | ❌ | **丢失** |
| 3 | `ts` / `""`（退化） | — | — | — | **跳过 s5** |

**根因：** 用「全局 `max_ts` 是否前进」决定是否返回 `next_since_id`；同 timestamp 多页时 `max_ts` 不前进，游标断裂。

---

## 二、Hotfix 实现核验

### 核心改动（`backend/app/services/sync.py`）

```python
latest_entity_ts = ""
latest_entity_id = ""

# 实体循环：分别追踪 latest_entity_* 与 max_ts
for r in rows:
    ts = normalize_timestamp(r.updated_at or "")
    if ts and ts > max_ts:
        max_ts = ts
    if ts and (ts > latest_entity_ts or (ts == latest_entity_ts and r.id > latest_entity_id)):
        latest_entity_ts = ts
        latest_entity_id = r.id

# Tombstone 只推进 max_ts，不碰 latest_entity_*

result["next_since"] = max_ts
if latest_entity_ts and latest_entity_ts == max_ts:
    result["next_since_id"] = latest_entity_id
```

### 设计评价

| 设计点 | 评价 |
|--------|------|
| `latest_entity_*` 与 `max_ts` 分离 | ✅ 实体游标与全局时间戳解耦 |
| Tombstone 不参与 since_id | ✅ 仅当 `latest_entity_ts == max_ts` 才返回 |
| Page 2 同 ts 仍返回 `next_since_id` | ✅ 修复核心回归 |
| Tombstone 单独推后 `max_ts` | ✅ `next_since_id` 保持空，合理 |

### 修复后三页流程

| 页 | 断言 |
|----|------|
| Page 1 | s1, s2 → `next_since_id=s2`, `has_more=True` |
| Page 2 | s3, s4 → `next_since_id=s4`, `has_more=True` |
| Page 3 | s5 → `has_more=False` |

---

## 三、改动范围

| 文件 | 变更 |
|------|------|
| `backend/app/services/sync.py` | +29/-11 — `latest_entity_ts/id` 逻辑 |
| `backend/tests/test_sync_cursor_pagination.py` | +56 — 5 条 / 3 页回归测试 |

**未纳入 commit（正确）：** `uv.lock`、`.codebase-memory/`、`审计报告/`、`backend/.pytest-tmp/`

---

## 四、测试验证

| 命令 | 结果 |
|------|------|
| `pytest tests/test_sync_cursor_pagination.py` | **8 passed** |
| `pytest test_sync_service + routes + integration` | **59 passed** |
| `pytest tests/` | **558 passed** |
| `ruff check app tests` | **passed** |

### 新增测试

`test_pull_same_timestamp_5_rows_three_pages_with_since_id` — 5 条同 `updated_at`、`limit=2`、验证 page2 返回 `next_since_id=s4`、page3 拿到 `s5`。

### Cursor 本地复测

`test_sync_cursor_pagination.py` → **8 passed**（与报告一致）

---

## 五、验收清单

| 项 | 结果 |
|----|------|
| 范围仅 sync cursor | ✅ |
| 未碰 MCP/deploy/CI/前端 | ✅ |
| 修复 page2+ 丢 `next_since_id` | ✅ |
| Tombstone 不参与 since_id | ✅ |
| 向后兼容 | ✅ |
| CI 绿 + 已合并 main | ✅ PR #8 @ `4ac3bdb` |
| Codex 独立核验 | ✅ 一致：可合并 |

---

## 六、非阻塞 Follow-up

1. **全局单一 `since_id` 跨 14 entity 组** — 单类型多页已修好；跨类型同 ts 的绝对完美分页若需要，可能需 per-entity cursor（不阻塞）。
2. **Tombstone `(deleted_at, entity_id)` since_id** — 仍 Out of scope。
3. **客户端契约** — 必须持续回传 `(next_since, next_since_id)`，不可省略 `since_id`。

---

## 七、Phase C 进度更新

```
P0-2 毫秒归一化 + (updated_at,id) 排序   ✅ alembic 006
P0-2 since_id 复合游标                   ✅ PR #7 (efa6af4)
P0-2 同 ts 超过 2 页不丢游标             ✅ PR #8 (5f00b93) ← 本报告
Tombstone since_id 分页                  ⏳ follow-up
────────────────────────────────────────────
Phase C Sync 引擎                        ≈ 99%
```

---

## 八、合并轨迹

```
4ac3bdb  Merge PR #8  fix(sync): preserve since_id across same-timestamp pages
5f00b93  fix(sync): preserve since_id across same-timestamp pages
6ea4021  Merge PR #7  feat(sync): add since_id composite cursor
efa6af4  feat(sync): add since_id composite cursor for perfect pagination
```

---

## 九、裁定

| 维度 | 判定 |
|------|------|
| 代码正确性 | ✅ |
| 测试充分性 | ✅ |
| 范围控制 | ✅ |
| **合并状态** | ✅ **已合并 main** |

**一句话：** PR #7 的 since_id 在边界场景有真实数据丢失；本 hotfix 修对根因，Phase C cursor 分页（实体侧）可视为 **功能闭环**。

---

*Cursor Agent · 2026-07-05 · 与 Codex 核验结论一致*
