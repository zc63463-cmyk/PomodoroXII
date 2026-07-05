# tombstone_since_id 分页验收报告

> **审查时间：** 2026-07-05 下午  
> **分支：** `codex/sync-tombstone-since-id`  
> **PR：** [#13](https://github.com/zc63463-cmyk/PomodoroXII/pull/13)  
> **Commit：** `c065f19` — `feat(sync): add tombstone_since_id cursor for same-timestamp pagination`  
> **基线：** `main` @ `014ec05`（PR #11 gitignore、PR #12 fastmcp lock 已合并）  
> **规划依据：** Sync 收尾 Option 1 — 独立墓碑游标字段  
> **审查结论：** ✅ **已合并 main**（PR #13 @ `c53aad9`）

---

## TL;DR

为墓碑分页新增独立复合游标 `tombstone_since_id` / `next_tombstone_since_id`，与实体 `since_id` / `next_since_id` 互不污染。`_fetch_tombstones` 支持 `(deleted_at, entity_id)` 复合 WHERE；`full()` 保留 `tombstones_since_override=""` 向后兼容，同时在 `since` 被 bypass 时仍可用 `entity_id` 分页。5 文件改动，cursor 专项 10 passed，全量 **560 passed**，GitHub CI green。

---

## 一、问题背景

实体 pull 已有 `(since, since_id)` 复合游标（PR #7/#8），但墓碑仅按 `deleted_at > since` 过滤。当多条墓碑共享同一 `deleted_at` 且超过 `limit` 时，第 2 页起会跳过同时间戳剩余行。

**设计选择：** Option 1 — 请求/响应各增独立字段，不复用 `next_since_id`。

---

## 二、API 契约

### 2.1 新增字段

| 方向 | 字段 | 说明 |
|------|------|------|
| 请求 query | `tombstone_since_id` | 墓碑二级游标：同 `deleted_at` 内上一页最后 `entity_id` |
| 响应 | `next_tombstone_since_id` | 当墓碑 `deleted_at == next_since` 时返回最后 `entity_id`，否则 `""` |

`/pull` 与 `/full` 均暴露上述参数；`SyncPullResponse` / `SyncFullResponse` schema 已对齐。

### 2.2 向后兼容

- 省略 `tombstone_since_id`（默认 `""`）→ 行为与改动前一致
- `full()` 仍返回全部墓碑（`tombstones_since_override=""`），仅在同 ts 超限时需要传 `tombstone_since_id`

**非 Breaking change** — 旧客户端无需改动即可继续工作；同 ts 多页场景需升级游标逻辑。

---

## 三、实现核验

### 3.1 `_fetch_tombstones`（`backend/app/services/sync.py`）

```python
# since 非空：复合游标
(deleted_at > since) OR (deleted_at == since AND entity_id > since_id)

# since 为空但 since_id 非空（full 分页）：仅 entity_id
entity_id > since_id
```

排序：`deleted_at ASC, entity_id ASC`；`limit + 1` 检测 `has_more`。

### 3.2 `pull()` 游标追踪

| 变量 | 用途 |
|------|------|
| `latest_entity_ts/id` | 驱动 `next_since_id` |
| `latest_tomb_ts/id` | 驱动 `next_tombstone_since_id` |
| `max_ts` | 驱动 `next_since`（实体与墓碑共用） |

`next_tombstone_since_id` 仅在 `latest_tomb_ts == max_ts` 时暴露（与实体 `next_since_id` 对称）。

### 3.3 改动范围

```
backend/app/routes/v1/sync.py                +12
backend/app/schemas/sync.py                  +3
backend/app/services/sync.py                 +53/-11
backend/tests/test_sync_cursor_pagination.py +90
backend/tests/test_sync_service.py           +4/-1
```

未纳入：`uv.lock`（已在 PR #12 独立合并）、工具产物、计划文档。

---

## 四、测试验证

| 命令 | 结果 |
|------|------|
| `pytest tests/test_sync_cursor_pagination.py` | **10 passed** |
| `pytest tests/test_sync_cursor_pagination.py tests/test_sync_service.py` | **53 passed** |
| 全量 `pytest tests/` | **560 passed** |
| `ruff check`（改动文件） | passed |
| GitHub CI `Test & Lint`（PR #13） | ✅ passed |

### 核心新测

1. **`test_tombstones_same_timestamp_5_rows_three_pages_with_since_id`**  
   5 条同 `deleted_at`、limit=2 → 3 页（t1,t2 → t3,t4 → t5），`next_tombstone_since_id` 逐页传递。

2. **`test_tombstone_since_id_backward_compatible`**  
   省略参数时一次返回全部墓碑；仍返回 `next_tombstone_since_id` 供升级客户端使用。

### 非阻塞 follow-up

- `pull()` 增量路径（`since=ts, tombstone_since_id=...`）可补 1 个单测（逻辑已正确，当前新测走 `full()`）
- `pull()` 初始 `result` 字典可预置 `next_tombstone_since_id: ""`（与 `next_since_id` 一致，避免 service 层 `KeyError`）

---

## 五、验收清单

| 项 | 结果 |
|----|------|
| 独立游标，不污染 `next_since_id` | ✅ |
| `full()` 向后兼容 + 同 ts 分页 | ✅ |
| Schema / Route / Service 三层一致 | ✅ |
| TDD：RED → GREEN 流程 | ✅ |
| 未混 deps / gitignore 改动 | ✅（#11/#12 已独立合并） |
| Cursor 独立复测 | ✅ 560 passed |
| GitHub 推送 + CI | ✅ PR #13 open，checks green |

---

## 六、客户端迁移指南

```text
循环 GET /pull（或 /full）直到 has_more == false

每轮持久化并回传：
  since              ← response.next_since
  since_id           ← response.next_since_id
  tombstone_since_id ← response.next_tombstone_since_id
```

```javascript
// 伪代码
let since = "", sinceId = "", tombSinceId = "";
do {
  const r = await pull({ since, since_id: sinceId, tombstone_since_id: tombSinceId, limit });
  applyChanges(r);
  since = r.next_since;
  sinceId = r.next_since_id;
  tombSinceId = r.next_tombstone_since_id;
} while (r.has_more);
```

---

## 七、Sync 收尾 PR 批次状态

| PR | 分支 | 状态 |
|----|------|------|
| #11 | `chore/gitignore-tool-artifacts` @ `e18b5b7` | ✅ 已合并 main |
| #12 | `chore/deps-fastmcp-3` @ `b9cff2c` | ✅ 已合并 main |
| #13 | `codex/sync-tombstone-since-id` @ `c065f19` | ✅ 已合并 main `c53aad9` |

---

## 八、Phase C 进度

```
P0-2 cursor 毫秒 + 排序              ✅
P0-2 since_id 复合游标（实体）        ✅ PR #7
P0-2 同 ts 多页 hotfix（实体）        ✅ PR #8
P1-1 conflict_remote 重分类          ✅ PR #10
P0-2 tombstone_since_id 分页         ✅ 本 PR #13（待合并）
仓库卫生（gitignore / fastmcp lock）   ✅ PR #11/#12
────────────────────────────────────────────
Phase C Sync 引擎                    100%（#13 已合并）
```

---

## 九、裁定

| 维度 | 判定 |
|------|------|
| 正确性 | ✅ |
| 测试 | ✅ 560 passed + CI green |
| 范围 | ✅ |
| 向后兼容 | ✅ |
| **合并建议** | ✅ **已合并** |

---

*Cursor Agent · 2026-07-05*
